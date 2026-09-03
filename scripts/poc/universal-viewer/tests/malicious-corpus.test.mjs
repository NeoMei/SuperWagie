import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
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
    assert.equal(result.fixtures.length, 6);
    assert.deepEqual(result.fixtures.map((item) => item.sha256).sort(), (await acceptance()).fixtures.map((item) => item.sha256).sort());
    assert.ok(result.fixtures.every((item) => item.pass && item.source_hash_unchanged));
    assert.ok(result.fixtures.every((item) => item.process_tree.collector_basename === 'ps'));
    assert.ok(result.fixtures.every((item) => item.process_tree.observed.every((process) =>
      /^[^/\\]+$/.test(process.executable_basename) && /^[a-f0-9]{64}$/.test(process.executable_sha256)
    )));
    assert.equal(result.deadline_probe.timed_out, true);
    assert.equal(result.deadline_probe.killed, true);
    assert.equal(result.deadline_probe.child_alive_after_kill, false);
    assert.deepEqual(persisted, result);

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
      /output must be outside candidate and fixture source trees/
    );
    assert.deepEqual((await readdir(fixtureRoot)).sort(), (await readdir(FIXTURE_ROOT)).sort());
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
