import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  access,
  copyFile,
  cp,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  inspectZipMetadata,
  runMaliciousCorpus,
  runWorkerProbe,
  sanitizeMarkup
} from '../malicious-corpus.mjs';

const POC_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(POC_ROOT, '..', '..', '..');
const FIXTURE_ROOT = path.join(POC_ROOT, 'fixtures', 'malicious');
const ACCEPTANCE_PATH = path.join(REPO_ROOT, 'fixtures', 'gvp-0', 'GVP-0-CORE-001', 'acceptance.json');
const CANDIDATE_ROOT = path.join(POC_ROOT, '.candidate', 'source');
const EXPECTED_THRESHOLDS = {
  external_processes: 0,
  network_requests: 0,
  filesystem_paths_exposed: 0,
  source_mutations: 0,
  moderate_or_higher_reachable_vulnerabilities: 0,
  forbidden_runtime_edges: 0,
  unexpected_fixture_outcomes: 0,
  base_office_compressed_max_bytes: 20_971_520,
  all_chunks_compressed_max_bytes: 52_428_800
};

async function acceptance() {
  return JSON.parse(await readFile(ACCEPTANCE_PATH, 'utf8'));
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function exists(target) {
  return access(target).then(() => true, () => false);
}

test('the machine acceptance manifest fixes every threshold and immutable fixture hash', async () => {
  const manifest = await acceptance();
  assert.deepEqual(manifest.thresholds, EXPECTED_THRESHOLDS);
  assert.equal(manifest.fixtures.length, 6);
  for (const fixture of manifest.fixtures) {
    const bytes = await readFile(path.join(FIXTURE_ROOT, fixture.file));
    assert.equal(sha256(bytes), fixture.sha256, fixture.fixture_id);
  }
});

test('ZIP central-directory inspection exposes traversal and bomb metadata without expanding entries', async () => {
  const traversal = inspectZipMetadata(await readFile(path.join(FIXTURE_ROOT, 'zip-path-traversal.zip')));
  assert.ok(traversal.entries.some((entry) => entry.unsafe_path === true));
  assert.equal(traversal.expanded_bytes, 0);

  const bomb = inspectZipMetadata(await readFile(path.join(FIXTURE_ROOT, 'zip-bomb-metadata.zip')));
  assert.ok(bomb.entries.some((entry) => entry.compression_ratio > 100));
  assert.equal(bomb.expanded_bytes, 0);
});

test('HTML and SVG sanitization removes scripts, events, active containers, and remote URLs while preserving text', async () => {
  for (const [file, kind, preserved] of [
    ['html-active-content.html', 'html', 'Safe HTML text'],
    ['svg-active-content.svg', 'svg', 'Safe SVG text']
  ]) {
    const source = await readFile(path.join(FIXTURE_ROOT, file), 'utf8');
    const result = sanitizeMarkup(source, kind);
    assert.equal(result.outcome, 'sanitized');
    assert.ok(result.removed_count > 0);
    assert.match(result.sanitized, new RegExp(preserved));
    assert.doesNotMatch(result.sanitized, /<\s*(?:script|iframe|object|embed|foreignObject|link|meta)\b/i);
    assert.doesNotMatch(result.sanitized, /\son[a-z]+\s*=/i);
    assert.doesNotMatch(result.sanitized, /(?:https?:|javascript:|file:|data:|\/\/fixture\.invalid)/i);
  }
});

test('sanitization fails closed on CSS, srcset, and SVG resource URL variants', () => {
  const html = sanitizeMarkup(`<!doctype html><html><head>
    <style>@IMPORT \"hTtPs&#58;//fixture.invalid/a.css\"; .x { background: uRl ( //fixture.invalid/a.png ) }</style>
    </head><body><img srcset="safe.png 1x, JAV&#x41;SCRIPT :alert(1) 2x" style="background:uRl(https://fixture.invalid/b)">
    <a ping="https://fixture.invalid/ping" href="java&#x09;script:alert(1)">Safe HTML text</a></body></html>`, 'html');
  const svg = sanitizeMarkup(`<svg xmlns="http://www.w3.org/2000/svg">
    <style>.x { filter: URL( hTtPs://fixture.invalid/filter ) }</style>
    <defs><filter id="safe"><feImage href="&#x68;ttps://fixture.invalid/pixel"/></filter></defs>
    <path class="x" fill="uRl( //fixture.invalid/fill )" stroke="url(&#x68;ttps://fixture.invalid/stroke)"
      filter="url(https://fixture.invalid/filter)" clip-path="url( https://fixture.invalid/clip )"
      mask="URL(//fixture.invalid/mask)" marker-start="url(javascript:alert(1))" style="fill:url(data:text/html,x)"/>
    <text>Safe SVG text</text></svg>`, 'svg');

  for (const result of [html, svg]) {
    assert.equal(result.outcome, 'sanitized');
    assert.doesNotMatch(result.sanitized, /<\s*style\b/i);
    assert.doesNotMatch(result.sanitized, /(?:https?\s*:|javascript\s*:|data\s*:|\/\/fixture\.invalid)/i);
    assert.doesNotMatch(result.sanitized, /(?:@import|\burl\s*\()/i);
    assert.doesNotMatch(result.sanitized, /\s(?:srcset|ping|fill|stroke|filter|clip-path|mask|marker-(?:start|mid|end)|style)\s*=/i);
  }
  assert.match(html.sanitized, /Safe HTML text/);
  assert.match(svg.sanitized, /Safe SVG text/);
});

test('sanitization enters HTML template content for the reviewer payload', () => {
  const result = sanitizeMarkup('<template><style>@import url(https://evil.invalid/x.css)</style><img srcset="https://evil.invalid/a.png 1x" onload="alert(1)"></template>', 'html');

  assert.equal(result.outcome, 'sanitized');
  assert.equal(result.diagnostic, 'VIEWER_ACTIVE_CONTENT_REMOVED');
  assert.equal(result.removed_count, 3);
  assert.doesNotMatch(result.sanitized, /evil\.invalid/i);
  assert.doesNotMatch(result.sanitized, /<\s*style\b|@import|\burl\s*\(|\ssrcset\s*=|\sonload\s*=/i);
});

test('sanitization recursively enters nested template fragments without skipping unsafe siblings', () => {
  const result = sanitizeMarkup(`<!doctype html><template id="outer">
    <style>@IMPORT "hTtPs://fixture.invalid/outer.css"; .x { background: uRl ( //fixture.invalid/outer.png ) }</style>
    <img srcset="safe.png 1x, JAV&#x41;SCRIPT :alert(1) 2x" ONLoAd="alert(2)">
    <template id="middle"><div style="background:uRl(&#x68;ttps://fixture.invalid/middle.png)">
      <template id="inner"><svg xmlns="http://www.w3.org/2000/svg">
        <path FILL="uRl(&#x68;ttps://fixture.invalid/fill)" stroke=" URL( //fixture.invalid/stroke ) "
          filter="url(https://fixture.invalid/filter)" clip-path="uRl( https://fixture.invalid/clip )"
          mask="URL(//fixture.invalid/mask)" marker-end="url(java&#x09;script:alert(3))"/>
        <a href="java&#x0a;script:alert(4)" oNcLiCk="alert(5)"><text>Safe inner text</text></a>
      </svg></template>
    </div><img src="HTTPS : //fixture.invalid/after.png" onerror="alert(6)"></template>
    <p>Safe outer text</p>
  </template>`, 'html');

  assert.equal(result.outcome, 'sanitized');
  assert.equal(result.diagnostic, 'VIEWER_ACTIVE_CONTENT_REMOVED');
  assert.ok(result.removed_count >= 14, `removed_count=${result.removed_count}`);
  assert.match(result.sanitized, /Safe inner text/);
  assert.match(result.sanitized, /Safe outer text/);
  assert.doesNotMatch(result.sanitized, /(?:evil|fixture)\.invalid/i);
  assert.doesNotMatch(result.sanitized, /<\s*style\b|@import|\burl\s*\(/i);
  assert.doesNotMatch(result.sanitized, /\s(?:src|srcset|href|onload|onclick|onerror|style|fill|stroke|filter|clip-path|mask|marker-end)\s*=/i);
  assert.doesNotMatch(result.sanitized, /(?:https?\s*:|javascript\s*:|data\s*:|file\s*:|\/\/)/i);
});

test('offline corpus uses real child workers, preserves sources, and keeps behavior separate from NO_GO admission', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'superwagie-malicious-test-'));
  try {
    const output = path.join(temporary, 'result.json');
    const result = await runMaliciousCorpus({
      candidateRoot: CANDIDATE_ROOT,
      fixtureRoot: FIXTURE_ROOT,
      acceptancePath: ACCEPTANCE_PATH,
      output,
      offline: true
    });
    const persisted = JSON.parse(await readFile(output, 'utf8'));

    assert.equal(result.behavior.pass, true);
    assert.equal(result.behavior.status, 'passed');
    assert.equal(result.pass, false);
    assert.equal(result.status, 'failed');
    assert.equal(result.decision, 'NO_GO');
    assert.equal(result.metrics.forbidden_runtime_edges, 8);
    assert.equal(result.thresholds.forbidden_runtime_edges, 0);
    assert.equal(result.metrics.unexpected_fixture_outcomes, 0);
    assert.equal(result.metrics.network_requests, 0);
    assert.equal(result.metrics.external_processes, 0);
    assert.equal(result.metrics.source_mutations, 0);
    assert.equal(result.metrics.filesystem_paths_exposed, 0);
    const sourceLock = JSON.parse(await readFile(path.join(POC_ROOT, 'source-lock.json'), 'utf8'));
    const acquisitionReceipt = JSON.parse(await readFile(path.join(POC_ROOT, '.candidate', '.acquisition.json'), 'utf8'));
    assert.equal(result.candidate.commit, sourceLock.commit);
    assert.equal(result.candidate.tree, acquisitionReceipt.tree);
    assert.equal(result.candidate.archive_sha256, sourceLock.source_tree_sha256);
    assert.equal(result.candidate.materialized_tree_sha256, acquisitionReceipt.materialized_tree_sha256);
    assert.equal(result.candidate.pristine_before, true);
    assert.equal(result.candidate.pristine_after, true);
    assert.equal(result.source_integrity.post_atomic_write_recheck_required_for_successful_runner_return, true);
    assert.equal(result.fixtures.length, 6);
    assert.deepEqual(result.fixtures.map((item) => item.sha256).sort(), (await acceptance()).fixtures.map((item) => item.sha256).sort());
    assert.ok(result.fixtures.every((item) => item.pass && item.source_hash_unchanged));
    assert.ok(result.fixtures.every((item) => item.process_tree.collector_basename === 'ps' && item.process_tree.group_isolated));
    assert.ok(result.fixtures.every((item) => item.process_tree.observed.every((process) =>
      /^[^/\\]+$/.test(process.executable_basename) && /^[a-f0-9]{64}$/.test(process.executable_sha256)
    )));
    assert.equal(result.deadline_probe.timed_out, true);
    assert.equal(result.deadline_probe.killed, true);
    assert.equal(result.deadline_probe.child_alive_after_kill, false);
    assert.equal(result.deadline_probe.process_tree.group_isolated, true);
    assert.deepEqual(persisted, result);
    assert.equal(
      await readFile(`${output}.superwagie-viewer-malicious-output-owned`, 'utf8'),
      'superwagie-viewer-malicious-output-v1\n'
    );
    assert.deepEqual(
      (await readdir(temporary)).sort(),
      ['result.json', 'result.json.superwagie-viewer-malicious-output-owned']
    );

    const serialized = JSON.stringify(result);
    for (const secretPath of [CANDIDATE_ROOT, FIXTURE_ROOT, output, temporary, os.homedir()]) {
      assert.equal(serialized.includes(secretPath), false, secretPath);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('offline hooks fail closed on real child fetch, XHR, WebSocket, DNS, socket, and asset URL attempts', async () => {
  for (const hook of [
    'fetch', 'xhr', 'websocket', 'dns', 'socket', 'asset-url',
    'window-xhr', 'window-websocket', 'window-asset-url'
  ]) {
    const result = await runWorkerProbe({ kind: 'network-attempt', hook, offline: true, deadlineMs: 1000 });
    assert.equal(result.pass, false, hook);
    assert.equal(result.network_requests, 1, hook);
    assert.equal(result.failure_code, 'VIEWER_NETWORK_ATTEMPT_BLOCKED', hook);
    assert.equal(result.blocked_hook, hook);
    assert.equal(result.observed_hook, hook);
  }
});

test('actual process-tree sampling rejects a prohibited shell child without exposing its path', async () => {
  const result = await runWorkerProbe({ kind: 'prohibited-process', offline: true, deadlineMs: 1000 });
  assert.equal(result.pass, false);
  assert.ok(result.external_processes >= 1);
  // macOS may report /bin/sh by its symlink name (`sh`) or underlying image
  // name (`bash`) depending on the exact ps sampling instant.
  assert.ok(result.forbidden_processes.some((process) => ['sh', 'bash'].includes(process.executable_basename)));
  assert.equal(JSON.stringify(result).includes('/bin/sh'), false);
});

test('the supervisor hard-kills a hung parser child by deadline', async () => {
  const started = Date.now();
  const result = await runWorkerProbe({ kind: 'hung-parser', offline: true, deadlineMs: 150 });
  assert.equal(result.timed_out, true);
  assert.equal(result.killed, true);
  assert.equal(result.child_alive_after_kill, false);
  assert.ok(Date.now() - started < 1500);
});

test('the supervisor observes and rejects a short-lived real descendant', async () => {
  const result = await runWorkerProbe({ kind: 'short-lived-descendant', offline: true, deadlineMs: 1000 });
  assert.equal(result.pass, false);
  assert.ok(result.external_processes >= 1);
  assert.ok(result.process_tree.observed.some((process) => process.executable_basename === 'sleep'));
  assert.equal(result.process_tree.known_descendant_survivors_after_cleanup, 0);
});

test('the supervisor group-kills a detached descendant and proves no known survivor remains', async () => {
  // This probe must first execute far enough to spawn the adversarial child;
  // the separate hung-parser test owns the 150/250 ms startup-inclusive SLA.
  const result = await runWorkerProbe({ kind: 'detached-survivor', offline: true, deadlineMs: 1000 });
  assert.equal(result.pass, false);
  assert.equal(result.timed_out, true);
  assert.equal(result.killed, true);
  assert.ok(result.external_processes >= 1);
  assert.equal(result.process_tree.process_group_survivors_after_cleanup, 0);
  assert.equal(result.process_tree.known_descendant_survivors_after_cleanup, 0);
  assert.equal(result.process_tree.claim_scope, 'observed_process_group_and_known_descendants_only');
  assert.ok(result.process_tree.detection_limitations.length > 0);
});

test('the supervisor cleans an observed detached descendant after a normal worker result', async () => {
  const result = await runWorkerProbe({ kind: 'detached-ready-descendant', offline: true, deadlineMs: 1000 });
  assert.equal(result.pass, false);
  assert.equal(result.timed_out, false);
  assert.ok(result.external_processes >= 1);
  assert.equal(result.process_tree.cleanup_signaled, true);
  assert.equal(result.process_tree.process_group_survivors_after_cleanup, 0);
  assert.equal(result.process_tree.known_descendant_survivors_after_cleanup, 0);
});

test('rejects an evidence output inside the candidate or fixture source trees before mutation', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'superwagie-output-boundary-'));
  try {
    const candidateRoot = path.join(temporary, 'candidate');
    const fixtureRoot = path.join(temporary, 'fixtures');
    await mkdir(candidateRoot);
    await cp(FIXTURE_ROOT, fixtureRoot, { recursive: true });
    await assert.rejects(
      runMaliciousCorpus({
        candidateRoot,
        fixtureRoot,
        acceptancePath: ACCEPTANCE_PATH,
        output: path.join(fixtureRoot, 'evidence.json'),
        offline: true
      }),
      /output must be outside candidate, fixture, and acceptance sources/
    );
    assert.deepEqual((await readdir(fixtureRoot)).sort(), (await readdir(FIXTURE_ROOT)).sort());
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('rejects normalized acceptance aliases before overwrite', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'superwagie-acceptance-alias-'));
  try {
    const acceptancePath = path.join(temporary, 'acceptance.json');
    const original = await readFile(ACCEPTANCE_PATH);
    await copyFile(ACCEPTANCE_PATH, acceptancePath);
    await mkdir(path.join(temporary, 'nested'));
    const aliasedOutput = `${temporary}${path.sep}nested${path.sep}..${path.sep}acceptance.json`;
    await assert.rejects(
      runMaliciousCorpus({
        candidateRoot: CANDIDATE_ROOT,
        fixtureRoot: FIXTURE_ROOT,
        acceptancePath,
        output: aliasedOutput,
        offline: true
      }),
      /output must be outside candidate, fixture, and acceptance sources/
    );
    assert.deepEqual(await readFile(acceptancePath), original);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('rejects a symlink alias into the fixture tree before write or worker spawn', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'superwagie-fixture-alias-'));
  try {
    const fixtureRoot = path.join(temporary, 'fixtures');
    const alias = path.join(temporary, 'fixture-alias');
    await cp(FIXTURE_ROOT, fixtureRoot, { recursive: true });
    await symlink(fixtureRoot, alias, 'dir');
    const output = path.join(alias, 'evidence.json');
    await assert.rejects(
      runMaliciousCorpus({
        candidateRoot: CANDIDATE_ROOT,
        fixtureRoot,
        acceptancePath: ACCEPTANCE_PATH,
        output,
        offline: true
      }),
      /output must be outside candidate, fixture, and acceptance sources/
    );
    assert.equal(await exists(path.join(fixtureRoot, 'evidence.json')), false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('rejects a hard-linked acceptance output by inode before overwrite', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'superwagie-output-inode-'));
  try {
    const acceptancePath = path.join(temporary, 'acceptance.json');
    const hardLinkOutput = path.join(temporary, 'acceptance-evidence.json');
    await copyFile(ACCEPTANCE_PATH, acceptancePath);
    await link(acceptancePath, hardLinkOutput);
    await assert.rejects(
      runMaliciousCorpus({
        candidateRoot: CANDIDATE_ROOT,
        fixtureRoot: FIXTURE_ROOT,
        acceptancePath,
        output: hardLinkOutput,
        offline: true
      }),
      /output must be outside candidate, fixture, and acceptance sources/
    );

  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('rejects an existing output without the PoC ownership marker', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'superwagie-output-owner-'));
  try {
    const unownedOutput = path.join(temporary, 'unowned.json');
    await writeFile(unownedOutput, 'do not overwrite');
    await assert.rejects(
      runMaliciousCorpus({
        candidateRoot: CANDIDATE_ROOT,
        fixtureRoot: FIXTURE_ROOT,
        acceptancePath: ACCEPTANCE_PATH,
        output: unownedOutput,
        offline: true
      }),
      /output is not marker-owned/
    );
    assert.equal(await readFile(unownedOutput, 'utf8'), 'do not overwrite');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('rejects an empty temporary candidate before evidence write or fixture worker spawn', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'superwagie-candidate-empty-'));
  try {
    const emptyCache = path.join(temporary, 'empty-cache');
    const emptyCandidate = path.join(emptyCache, 'source');
    const emptyOutput = path.join(temporary, 'empty-result.json');
    await mkdir(emptyCandidate, { recursive: true });
    await assert.rejects(
      runMaliciousCorpus({
        candidateRoot: emptyCandidate,
        fixtureRoot: FIXTURE_ROOT,
        acceptancePath: ACCEPTANCE_PATH,
        output: emptyOutput,
        offline: true
      }),
      /candidate source and acquisition receipt must both exist/
    );
    assert.equal(await exists(emptyOutput), false);

  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('rejects a dirty candidate with a copied receipt before evidence write or fixture worker spawn', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'superwagie-candidate-spoof-'));
  try {
    const spoofCache = path.join(temporary, 'spoof-cache');
    const spoofedCandidate = path.join(spoofCache, 'source');
    const spoofedOutput = path.join(temporary, 'spoofed-result.json');
    await mkdir(spoofCache);
    await cp(CANDIDATE_ROOT, spoofedCandidate, { recursive: true });
    await writeFile(path.join(spoofedCandidate, 'SPOOFED'), 'not part of the locked tree');
    await copyFile(path.join(POC_ROOT, '.candidate', '.acquisition.json'), path.join(spoofCache, '.acquisition.json'));
    await assert.rejects(
      runMaliciousCorpus({
        candidateRoot: spoofedCandidate,
        fixtureRoot: FIXTURE_ROOT,
        acceptancePath: ACCEPTANCE_PATH,
        output: spoofedOutput,
        offline: true
      }),
      /Frozen Core acquisition rejected: dirty source tree detected/
    );
    assert.equal(await exists(spoofedOutput), false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
