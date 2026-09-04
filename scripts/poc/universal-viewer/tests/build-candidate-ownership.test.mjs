import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import * as candidateBuild from '../build-candidate.mjs';

const MARKER = '.superwagie-viewer-poc-owned';
const MARKER_CONTENT = 'superwagie-viewer-poc-owned-v1\n';

function sandbox(t) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'superwagie-viewer-owned-root-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function prepare(root, protectedRoots = []) {
  return candidateBuild.prepareOwnedRoot(root, 'test output root', {
    allowedRoot: root,
    protectedRoots,
  });
}

test('owned-root cleanup requires an exact regular versioned marker', (t) => {
  assert.equal(typeof candidateBuild.prepareOwnedRoot, 'function');
  for (const markerKind of ['wrong-content', 'directory', 'symlink']) {
    const parent = sandbox(t);
    const root = path.join(parent, markerKind);
    mkdirSync(root);
    writeFileSync(path.join(root, 'must-survive.txt'), markerKind);
    const marker = path.join(root, MARKER);
    if (markerKind === 'wrong-content') writeFileSync(marker, 'not-an-ownership-capability\n');
    if (markerKind === 'directory') mkdirSync(marker);
    if (markerKind === 'symlink') {
      const target = path.join(parent, `${markerKind}-target`);
      writeFileSync(target, MARKER_CONTENT);
      symlinkSync(target, marker);
    }

    assert.throws(() => prepare(root), /marker.*regular|marker.*content|marker-owned/iu, markerKind);
    assert.equal(readFileSync(path.join(root, 'must-survive.txt'), 'utf8'), markerKind);
  }
});

test('owned-root cleanup rejects root and parent symlinks before deletion', (t) => {
  assert.equal(typeof candidateBuild.prepareOwnedRoot, 'function');
  const parent = sandbox(t);
  const realRoot = path.join(parent, 'real-root');
  mkdirSync(realRoot);
  writeFileSync(path.join(realRoot, MARKER), MARKER_CONTENT);
  writeFileSync(path.join(realRoot, 'must-survive.txt'), 'root-target');
  const rootLink = path.join(parent, 'root-link');
  symlinkSync(realRoot, rootLink, 'dir');
  assert.throws(
    () => candidateBuild.prepareOwnedRoot(rootLink, 'test output root', { allowedRoot: rootLink, protectedRoots: [] }),
    /symlink|identity|real directory/iu,
  );
  assert.equal(readFileSync(path.join(realRoot, 'must-survive.txt'), 'utf8'), 'root-target');

  const realParent = path.join(parent, 'real-parent');
  mkdirSync(realParent);
  const parentLink = path.join(parent, 'parent-link');
  symlinkSync(realParent, parentLink, 'dir');
  const nested = path.join(parentLink, 'nested-output');
  assert.throws(
    () => candidateBuild.prepareOwnedRoot(nested, 'test output root', { allowedRoot: nested, protectedRoots: [] }),
    /parent.*symlink|safe boundary/iu,
  );
  assert.equal(existsSync(path.join(realParent, 'nested-output')), false);
});

test('staged output promotion replaces only a completed marker-owned tree', (t) => {
  const parent = sandbox(t);
  const output = path.join(parent, 'dist');
  const staging = path.join(parent, 'dist.staging-test');
  prepare(output);
  prepare(staging);
  writeFileSync(path.join(output, 'version.txt'), 'old');
  writeFileSync(path.join(staging, 'version.txt'), 'new');

  candidateBuild.promoteOwnedRoot(staging, output, { allowedRoot: output });
  assert.equal(readFileSync(path.join(output, 'version.txt'), 'utf8'), 'new');
  assert.equal(existsSync(staging), false);
});

test('invalid staged output cannot empty the current canonical dist', (t) => {
  const parent = sandbox(t);
  const output = path.join(parent, 'dist');
  const staging = path.join(parent, 'dist.staging-invalid');
  prepare(output);
  mkdirSync(staging);
  writeFileSync(path.join(output, 'version.txt'), 'must-survive');
  writeFileSync(path.join(staging, 'version.txt'), 'incomplete');

  assert.throws(
    () => candidateBuild.promoteOwnedRoot(staging, output, { allowedRoot: output }),
    /marker-owned/iu,
  );
  assert.equal(readFileSync(path.join(output, 'version.txt'), 'utf8'), 'must-survive');
});

test('multi-root promotion rolls back dist and baseline together on a partial rename failure', (t) => {
  const parent = sandbox(t);
  const outputs = ['dist', 'baseline-evidence'].map((name) => ({
    outputRoot: path.join(parent, name),
    stagingRoot: path.join(parent, `${name}.staging-test`),
  }));
  for (const entry of outputs) {
    prepare(entry.outputRoot);
    prepare(entry.stagingRoot);
    writeFileSync(path.join(entry.outputRoot, 'version.txt'), `old-${path.basename(entry.outputRoot)}`);
    writeFileSync(path.join(entry.stagingRoot, 'version.txt'), `new-${path.basename(entry.outputRoot)}`);
  }
  let renameCalls = 0;
  assert.throws(
    () => candidateBuild.promoteOwnedRoots(
      outputs.map((entry) => ({ ...entry, allowedRoot: entry.outputRoot })),
      {
        rename(from, to) {
          renameCalls += 1;
          if (renameCalls === 4) throw Object.assign(new Error('injected rename failure'), { code: 'EIO' });
          renameSync(from, to);
        },
      },
    ),
    /promotion failed.*EIO/iu,
  );
  for (const entry of outputs) {
    assert.equal(
      readFileSync(path.join(entry.outputRoot, 'version.txt'), 'utf8'),
      `old-${path.basename(entry.outputRoot)}`,
    );
  }
});

test('a committed one-root journal is recovered before a later two-root promotion', (t) => {
  const parent = sandbox(t);
  const dist = path.join(parent, 'dist');
  const baseline = path.join(parent, 'baseline-evidence');
  const universe = [dist, baseline];
  const firstBaselineStaging = path.join(parent, 'baseline-evidence.staging-first');
  for (const output of universe) {
    prepare(output);
    writeFileSync(path.join(output, 'version.txt'), `old-${path.basename(output)}`);
  }
  prepare(firstBaselineStaging);
  writeFileSync(path.join(firstBaselineStaging, 'version.txt'), 'first-baseline');

  candidateBuild.promoteOwnedRoots(
    [{ stagingRoot: firstBaselineStaging, outputRoot: baseline, allowedRoot: baseline }],
    {
      recoveryAllowedOutputs: universe,
      remove() { throw new Error('injected backup cleanup failure'); },
    },
  );
  assert.equal(readFileSync(path.join(baseline, 'version.txt'), 'utf8'), 'first-baseline');

  const next = universe.map((outputRoot) => ({
    outputRoot,
    stagingRoot: `${outputRoot}.staging-second`,
    allowedRoot: outputRoot,
  }));
  for (const entry of next) {
    prepare(entry.stagingRoot);
    writeFileSync(path.join(entry.stagingRoot, 'version.txt'), `second-${path.basename(entry.outputRoot)}`);
  }
  candidateBuild.promoteOwnedRoots(next, { recoveryAllowedOutputs: universe });
  for (const output of universe) {
    assert.equal(readFileSync(path.join(output, 'version.txt'), 'utf8'), `second-${path.basename(output)}`);
  }
  assert.equal(readdirSync(parent).some((name) => name.includes('promotion-') || name.includes('.backup-')), false);
});

test('a prepared one-root crash is recovered before a later two-root promotion', (t) => {
  const parent = sandbox(t);
  const dist = path.join(parent, 'dist');
  const baseline = path.join(parent, 'baseline-evidence');
  const universe = [dist, baseline];
  const firstStaging = `${baseline}.staging-crash`;
  for (const output of universe) {
    prepare(output);
    writeFileSync(path.join(output, 'version.txt'), `old-${path.basename(output)}`);
  }
  prepare(firstStaging);
  writeFileSync(path.join(firstStaging, 'version.txt'), 'interrupted-baseline');

  const moduleUrl = new URL('../build-candidate.mjs', import.meta.url).href;
  const crash = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { renameSync } from 'node:fs';
    import { promoteOwnedRoots } from ${JSON.stringify(moduleUrl)};
    let calls = 0;
    promoteOwnedRoots(
      [${JSON.stringify({ stagingRoot: firstStaging, outputRoot: baseline, allowedRoot: baseline })}],
      {
        recoveryAllowedOutputs: ${JSON.stringify(universe)},
        rename(from, to) {
          renameSync(from, to);
          calls += 1;
          if (calls === 1) process.exit(77);
        },
      },
    );
  `], { encoding: 'utf8' });
  assert.equal(crash.status, 77);

  const next = universe.map((outputRoot) => ({
    outputRoot,
    stagingRoot: `${outputRoot}.staging-after-crash`,
    allowedRoot: outputRoot,
  }));
  for (const entry of next) {
    prepare(entry.stagingRoot);
    writeFileSync(path.join(entry.stagingRoot, 'version.txt'), `recovered-${path.basename(entry.outputRoot)}`);
  }
  candidateBuild.promoteOwnedRoots(next, { recoveryAllowedOutputs: universe });
  for (const output of universe) {
    assert.equal(readFileSync(path.join(output, 'version.txt'), 'utf8'), `recovered-${path.basename(output)}`);
  }
  assert.equal(readdirSync(parent).some((name) => name.includes('promotion') || name.includes('.backup-') || name.includes('.staging-crash')), false);
});

test('a live promotion owns the domain exclusively and a later run recovers after its crash', async (t) => {
  const parent = sandbox(t);
  const dist = path.join(parent, 'dist');
  const baseline = path.join(parent, 'baseline-evidence');
  const universe = [dist, baseline];
  const childStaging = `${baseline}.staging-live-owner`;
  const readyPath = path.join(parent, 'owner-ready');
  for (const output of universe) {
    prepare(output);
    writeFileSync(path.join(output, 'version.txt'), `old-${path.basename(output)}`);
  }
  prepare(childStaging);
  writeFileSync(path.join(childStaging, 'version.txt'), 'live-owner-baseline');

  const moduleUrl = new URL('../build-candidate.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { renameSync, writeFileSync } from 'node:fs';
    import { promoteOwnedRoots } from ${JSON.stringify(moduleUrl)};
    let calls = 0;
    promoteOwnedRoots(
      [${JSON.stringify({ stagingRoot: childStaging, outputRoot: baseline, allowedRoot: baseline })}],
      {
        recoveryAllowedOutputs: ${JSON.stringify(universe)},
        rename(from, to) {
          renameSync(from, to);
          calls += 1;
          if (calls === 1) {
            writeFileSync(${JSON.stringify(readyPath)}, 'ready');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
          }
        },
      },
    );
  `], { stdio: 'ignore' });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  for (let attempt = 0; attempt < 200 && !existsSync(readyPath); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(existsSync(readyPath), true, 'first promotion must reach its prepared rename');

  const next = universe.map((outputRoot) => ({
    outputRoot,
    stagingRoot: `${outputRoot}.staging-contender`,
    allowedRoot: outputRoot,
  }));
  for (const entry of next) {
    prepare(entry.stagingRoot);
    writeFileSync(path.join(entry.stagingRoot, 'version.txt'), `contender-${path.basename(entry.outputRoot)}`);
  }
  assert.throws(
    () => candidateBuild.promoteOwnedRoots(next, { recoveryAllowedOutputs: universe }),
    /promotion domain.*active/iu,
  );

  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('close', resolve));
  candidateBuild.promoteOwnedRoots(next, { recoveryAllowedOutputs: universe });
  for (const output of universe) {
    assert.equal(readFileSync(path.join(output, 'version.txt'), 'utf8'), `contender-${path.basename(output)}`);
  }
  assert.equal(readdirSync(parent).some((name) => name.includes('promotion') || name.includes('.backup-') || name.includes('.staging-live-owner')), false);
});

test('promotion syncs every staged file and directory before publishing a prepared journal', (t) => {
  const parent = sandbox(t);
  const output = path.join(parent, 'dist');
  const staging = path.join(parent, 'dist.staging-sync');
  prepare(output);
  prepare(staging);
  mkdirSync(path.join(staging, 'nested'));
  writeFileSync(path.join(staging, 'nested', 'artifact.bin'), 'durable');
  const events = [];

  candidateBuild.promoteOwnedRoots(
    [{ stagingRoot: staging, outputRoot: output, allowedRoot: output }],
    {
      sync(target) { events.push(`sync:${path.relative(parent, target)}`); },
      rename(from, to) {
        events.push(`rename:${path.relative(parent, from)}->${path.relative(parent, to)}`);
        renameSync(from, to);
      },
    },
  );

  const firstJournalSync = events.findIndex((event) => event.includes('.superwagie-viewer-promotion'));
  assert.ok(firstJournalSync > 0);
  for (const relative of [
    'dist.staging-sync/.superwagie-viewer-poc-owned',
    'dist.staging-sync/nested/artifact.bin',
    'dist.staging-sync/nested',
    'dist.staging-sync',
  ]) {
    const syncIndex = events.indexOf(`sync:${relative}`);
    assert.ok(syncIndex >= 0, `${relative} must be synced`);
    assert.ok(syncIndex < firstJournalSync, `${relative} must be durable before the prepared journal`);
  }
});

test('sandbox helper binds compilation and provenance to one resolved compiler', (t) => {
  const parent = sandbox(t);
  const developer = path.join(parent, 'developer');
  const sdk = path.join(developer, 'SDKs', 'MacOSX.sdk');
  const compiler = path.join(parent, 'fake-clang');
  mkdirSync(sdk, { recursive: true });
  writeFileSync(path.join(sdk, 'SDKSettings.json'), '{"Version":"test"}\n');
  writeFileSync(compiler, `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'fake clang 1.0'; exit 0; fi
out=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then shift; out="$1"; fi
  shift
done
printf '#!/bin/sh\\nexit 0\\n' > "$out"
chmod 700 "$out"
`);
  chmodSync(compiler, 0o700);
  const calls = [];
  const result = candidateBuild.compileSandboxFingerprintHelper(parent, {
    spawnCommand(command, args, options) {
      calls.push(command);
      if (command === '/usr/bin/xcode-select') return { status: 0, stdout: `${developer}\n`, stderr: '' };
      if (command === '/usr/bin/xcrun' && args.includes('--show-sdk-path')) {
        return { status: 0, stdout: `${sdk}\n`, stderr: '' };
      }
      if (command === '/usr/bin/xcrun') return { status: 0, stdout: `${compiler}\n`, stderr: '' };
      return spawnSync(command, args, options);
    },
  });
  assert.deepEqual(calls, ['/usr/bin/xcode-select', '/usr/bin/xcrun', '/usr/bin/xcrun', compiler, compiler]);
  assert.equal(result.identity.compiler_version, 'fake clang 1.0');
  assert.equal(result.identity.sdk_version, 'test');
});

test('sandbox helper rejects a compiler identity change during compilation', (t) => {
  const parent = sandbox(t);
  const developer = path.join(parent, 'developer');
  const sdk = path.join(developer, 'SDKs', 'MacOSX.sdk');
  const compiler = path.join(parent, 'mutable-clang');
  mkdirSync(sdk, { recursive: true });
  writeFileSync(path.join(sdk, 'SDKSettings.json'), '{"Version":"test"}\n');
  writeFileSync(compiler, '#!/bin/sh\nexit 0\n');
  chmodSync(compiler, 0o700);
  let directCalls = 0;
  assert.throws(
    () => candidateBuild.compileSandboxFingerprintHelper(parent, {
      spawnCommand(command, args) {
        if (command === '/usr/bin/xcode-select') return { status: 0, stdout: `${developer}\n`, stderr: '' };
        if (command === '/usr/bin/xcrun' && args.includes('--show-sdk-path')) {
          return { status: 0, stdout: `${sdk}\n`, stderr: '' };
        }
        if (command === '/usr/bin/xcrun') return { status: 0, stdout: `${compiler}\n`, stderr: '' };
        directCalls += 1;
        if (directCalls === 1) return { status: 0, stdout: 'mutable clang 1.0\n', stderr: '' };
        writeFileSync(compiler, '#!/bin/sh\n# changed\nexit 0\n');
        writeFileSync(path.join(parent, 'sandbox-fingerprint'), '#!/bin/sh\nexit 0\n');
        return { status: 0, stdout: '', stderr: '' };
      },
    }),
    /compiler identity changed/iu,
  );
});

test('owned-root cleanup rejects protected roots even when explicitly allowed', (t) => {
  assert.equal(typeof candidateBuild.prepareOwnedRoot, 'function');
  const root = sandbox(t);
  writeFileSync(path.join(root, MARKER), MARKER_CONTENT);
  writeFileSync(path.join(root, 'must-survive.txt'), 'protected');

  assert.throws(
    () => candidateBuild.prepareOwnedRoot(root, 'test output root', { allowedRoot: root, protectedRoots: [root] }),
    /protected/iu,
  );
  assert.equal(readFileSync(path.join(root, 'must-survive.txt'), 'utf8'), 'protected');
});

test('owned-root cleanup only resets the exact explicitly allowed root', (t) => {
  assert.equal(typeof candidateBuild.prepareOwnedRoot, 'function');
  const parent = sandbox(t);
  const allowed = path.join(parent, 'allowed');
  const other = path.join(parent, 'other');
  for (const root of [allowed, other]) {
    mkdirSync(root);
    writeFileSync(path.join(root, MARKER), MARKER_CONTENT);
    writeFileSync(path.join(root, 'old.txt'), path.basename(root));
  }

  assert.throws(
    () => candidateBuild.prepareOwnedRoot(other, 'test output root', { allowedRoot: allowed, protectedRoots: [] }),
    /safe boundary|allowed/iu,
  );
  assert.equal(readFileSync(path.join(other, 'old.txt'), 'utf8'), 'other');
  candidateBuild.prepareOwnedRoot(allowed, 'test output root', { allowedRoot: allowed, protectedRoots: [] });
  assert.equal(existsSync(path.join(allowed, 'old.txt')), false);
  assert.equal(readFileSync(path.join(allowed, MARKER), 'utf8'), MARKER_CONTENT);
});

test('candidate subprocess runner fails closed when a live command exceeds its bound', (t) => {
  const root = sandbox(t);
  assert.equal(typeof candidateBuild.runCandidateCommand, 'function');
  const started = Date.now();
  assert.throws(
    () => candidateBuild.runCandidateCommand(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1_000)'],
      root,
      { timeoutMs: 75, allowNonzero: true },
    ),
    /timed out after 75 ms/iu,
  );
  assert.ok(Date.now() - started < 2_000, 'the bounded child must not keep the build hung');
});

test('developer cache is materialized from committed source through the production helper', (t) => {
  assert.equal(typeof candidateBuild.prepareDeveloperCache, 'function');
  const parent = sandbox(t);
  const sourceRoot = path.join(parent, 'candidate');
  const outputRoot = path.join(parent, 'output');
  mkdirSync(sourceRoot);
  mkdirSync(outputRoot);
  candidateBuild.runCandidateCommand('git', ['init'], sourceRoot);
  writeFileSync(path.join(sourceRoot, 'committed.txt'), 'frozen\n');
  writeFileSync(path.join(sourceRoot, 'untracked.txt'), 'excluded\n');
  candidateBuild.runCandidateCommand('git', ['add', 'committed.txt'], sourceRoot);
  candidateBuild.runCandidateCommand(
    'git',
    ['-c', 'user.name=SuperWagie Test', '-c', 'user.email=test@superwagie.invalid', 'commit', '-m', 'fixture'],
    sourceRoot,
  );

  const developerRoot = candidateBuild.prepareDeveloperCache(sourceRoot, outputRoot);
  t.after(() => rmSync(developerRoot, { recursive: true, force: true }));
  assert.equal(readFileSync(path.join(developerRoot, 'committed.txt'), 'utf8'), 'frozen\n');
  assert.equal(existsSync(path.join(developerRoot, 'untracked.txt')), false);
  assert.equal(existsSync(path.join(outputRoot, '.developer-cache.tar')), false);
});

test('developer cache cleanup covers materialization failures', (t) => {
  const sourceRoot = sandbox(t);
  const outputRoot = sandbox(t);
  const temporaryRoot = realpathSync(tmpdir());
  const before = readdirSync(temporaryRoot).filter((name) => name.startsWith('superwagie-viewer-developer-')).sort();
  assert.throws(
    () => candidateBuild.prepareDeveloperCache(sourceRoot, outputRoot),
    /git archive.*failed/iu,
  );
  const after = readdirSync(temporaryRoot).filter((name) => name.startsWith('superwagie-viewer-developer-')).sort();
  assert.deepEqual(after, before);
});

test('upstream Frozen Core install and verification are bounded without mutating source', () => {
  assert.deepEqual(candidateBuild.UPSTREAM_INSTALL_ARGS, ['ci', '--ignore-scripts', '--no-audit', '--prefer-offline']);
  assert.equal(Object.isFrozen(candidateBuild.UPSTREAM_INSTALL_ARGS), true);
  assert.deepEqual(candidateBuild.UPSTREAM_TEST_ARGS, ['test', '--', '--testTimeout=15000']);
  assert.equal(Object.isFrozen(candidateBuild.UPSTREAM_TEST_ARGS), true);
});

test('candidate subprocess runner applies explicit deterministic test environment overrides', (t) => {
  const root = sandbox(t);
  const result = candidateBuild.runCandidateCommand(
    process.execPath,
    ['-e', 'process.stdout.write(`${process.env.VITEST_MIN_WORKERS}/${process.env.VITEST_MAX_WORKERS}`)'],
    root,
    { envOverrides: { VITEST_MIN_WORKERS: '1', VITEST_MAX_WORKERS: '1' } },
  );
  assert.equal(result.stdout, '1/1');
});

test('candidate subprocess runner does not inherit host credentials', (t) => {
  const root = sandbox(t);
  const result = candidateBuild.runCandidateCommand(
    process.execPath,
    ['-e', "process.stdout.write(String(Object.hasOwn(process.env, 'ANTHROPIC_AUTH_TOKEN')))"],
    root,
  );
  assert.equal(result.stdout, 'false');
});

test('fresh supply-chain mode rejects an ambient offline configuration before spawning', (t) => {
  const root = sandbox(t);
  const previous = process.env.NPM_CONFIG_OFFLINE;
  process.env.NPM_CONFIG_OFFLINE = 'true';
  t.after(() => {
    if (previous === undefined) delete process.env.NPM_CONFIG_OFFLINE;
    else process.env.NPM_CONFIG_OFFLINE = previous;
  });
  assert.throws(
    () => candidateBuild.runCandidateCommand(process.execPath, ['--version'], root, { requireFreshNetwork: true }),
    /rejects ambient offline or cache-only mode/iu,
  );
});

test('fresh supply-chain evidence accepts only npm audit exit zero or one', () => {
  for (const exitCode of [0, 1]) {
    assert.equal(candidateBuild.requireAdmittedAuditExit({ exit_code: exitCode }, 'test audit').exit_code, exitCode);
  }
  for (const exitCode of [2, 7, null]) {
    assert.throws(
      () => candidateBuild.requireAdmittedAuditExit({ exit_code: exitCode }, 'test audit'),
      /outside the admitted npm audit status set/iu,
    );
  }
});

test('isolated candidate command denies host-home reads and network access', async (t) => {
  const root = sandbox(t);
  const sibling = sandbox(t);
  const siblingSecret = path.join(sibling, 'secret.txt');
  writeFileSync(siblingSecret, 'SIBLING_SECRET');
  const protectedPath = path.resolve(import.meta.dirname, '..', '..', '..', '..', 'AGENTS.md');
  const script = `
    const fs = require('node:fs');
    let homeReadDenied = false;
    try { fs.readFileSync(process.argv[1]); } catch (error) { homeReadDenied = error.code === 'EPERM'; }
    let siblingReadDenied = false;
    let siblingWriteDenied = false;
    try { fs.readFileSync(process.argv[2]); } catch (error) { siblingReadDenied = error.code === 'EPERM'; }
    try { fs.writeFileSync(process.argv[2], 'WRITTEN'); } catch (error) { siblingWriteDenied = error.code === 'EPERM'; }
    fetch('https://example.com/').then(
      () => process.exit(9),
      () => process.stdout.write(JSON.stringify({ homeReadDenied, siblingReadDenied, siblingWriteDenied, networkDenied: true })),
    );
  `;
  const result = await candidateBuild.runIsolatedCandidateCommand(
    process.execPath,
    ['-e', script, protectedPath, siblingSecret],
    root,
    { timeoutMs: 2_000 },
  );
  assert.deepEqual(JSON.parse(result.stdout), {
    homeReadDenied: true,
    siblingReadDenied: true,
    siblingWriteDenied: true,
    networkDenied: true,
  });
  assert.equal(readFileSync(siblingSecret, 'utf8'), 'SIBLING_SECRET');
  assert.equal(result.isolation, 'macos-seatbelt-no-network-home-denied');
});

test('isolated candidate command has a whole-process wall-clock deadline', async (t) => {
  const root = sandbox(t);
  const pidPath = path.join(root, 'detached.pid');
  const started = Date.now();
  await assert.rejects(
    candidateBuild.runIsolatedCandidateCommand(
      process.execPath,
      ['-e', `
        const { spawn } = require('node:child_process');
        const { writeFileSync } = require('node:fs');
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          detached: true,
          stdio: 'ignore',
        });
        child.unref();
        writeFileSync(process.argv[1], String(child.pid));
        setInterval(() => {}, 1000);
      `, pidPath],
      root,
      { timeoutMs: 250 },
    ),
    /timed out after 250 ms/iu,
  );
  assert.ok(Date.now() - started < 2_000);
  const detachedPid = Number(readFileSync(pidPath, 'utf8'));
  let childAlive = true;
  for (let attempt = 0; attempt < 20 && childAlive; attempt += 1) {
    try { process.kill(detachedPid, 0); }
    catch { childAlive = false; }
    if (childAlive) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(childAlive, false, 'detached descendants must not survive the candidate deadline');
});

test('isolated candidate cleanup finds an immediately orphaned child by inherited OS sandbox identity', async (t) => {
  const root = sandbox(t);
  const pidPath = path.join(root, 'orphan.pid');
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  unrelated.unref();
  t.after(() => {
    try { process.kill(unrelated.pid, 'SIGKILL'); } catch {}
  });

  const result = await candidateBuild.runIsolatedCandidateCommand(
    process.execPath,
    ['-e', `
      const { spawn } = require('node:child_process');
      const { writeFileSync } = require('node:fs');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true,
        stdio: 'ignore',
        env: { PATH: process.env.PATH },
      });
      child.unref();
      writeFileSync(process.argv[1], String(child.pid));
    `, pidPath],
    root,
    { timeoutMs: 2_000 },
  );
  assert.equal(result.exit_code, 0);
  const orphanPid = Number(readFileSync(pidPath, 'utf8'));
  let orphanAlive = true;
  for (let attempt = 0; attempt < 20 && orphanAlive; attempt += 1) {
    try { process.kill(orphanPid, 0); }
    catch { orphanAlive = false; }
    if (orphanAlive) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(orphanAlive, false, 'token-free immediately orphaned descendants must not survive normal close');
  assert.doesNotThrow(() => process.kill(unrelated.pid, 0), 'cleanup must not signal unrelated processes');
});
