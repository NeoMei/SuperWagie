import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { canonicalJson } from '../src/core-client.mjs';
import { secureAtomicWrite, secureCopyByFd } from '../src/secure-files.mjs';
import { joinRuntimePath, runtimePlatform } from '../src/runtime-platform.mjs';

const spikeRoot = resolve(import.meta.dirname, '..');
const electron = joinRuntimePath(spikeRoot, runtimePlatform().developmentElectron);
const worker = join(spikeRoot, 'src', 'render-worker-host.mjs');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function baseManifest(root) {
  const html = readFileSync(join(root, 'inputs', 'composition.html'));
  const script = readFileSync(join(root, 'inputs', 'composition.js'));
  const asset = readFileSync(join(root, 'inputs', 'asset.bin'));
  const font = readFileSync(join(root, 'inputs', 'font.bin'));
  return {
    schema_version: 'solution-b-execution-v1', job_id: 'security-test', request_id: '1'.repeat(32),
    run_nonce: '2'.repeat(32), audience: 'render_worker', revision: 1, attempt: 1,
    composition: { html_path: 'inputs/composition.html', script_path: 'inputs/composition.js',
      html_sha256: sha256(html), script_sha256: sha256(script), bundle_sha256: sha256(Buffer.concat([html, script])) },
    assets: { hashes: [{ path: 'inputs/asset.bin', sha256: sha256(asset) }] },
    fonts: { hashes: [{ path: 'inputs/font.bin', sha256: sha256(font) }], glyph_rendering: false },
    runtime: { electron_executable_sha256: sha256(readFileSync(electron)), electron_version: '44.1.0' },
    frames: { start: 0, end: 0, indices: [0] },
    resource_limits: { max_frames: 1, max_frame_bytes: 1_000_000, max_output_bytes: 1_000_000, max_process_tree_rss_bytes: 1_000_000_000 },
    checkpoint: { path: 'state/checkpoint.json', job_id: 'security-test', revision: 1, initial_sha256: null },
    output_authorization: { directory: 'outputs/frames', result_path: 'outputs/result.json', job_id: 'security-test', revision: 1, frame_pattern: 'frame-%04d.png' },
    crash_injection_after_frames: 0,
    crash_injection_mode: 'none',
  };
}

function prepare() {
  const root = mkdtempSync(join(tmpdir(), 'solution-b-security-'));
  for (const path of ['inputs', 'state', 'outputs', 'outputs/frames']) mkdirSync(join(root, path), { mode: 0o700 });
  for (const name of ['composition.html', 'composition.js']) writeFileSync(join(root, 'inputs', name), readFileSync(join(spikeRoot, 'src', 'static', name)), { mode: 0o600 });
  writeFileSync(join(root, 'inputs', 'asset.bin'), 'asset-fixture', { mode: 0o600 });
  writeFileSync(join(root, 'inputs', 'font.bin'), 'font-fixture', { mode: 0o600 });
  return root;
}

function runManifest(root, manifest, key = 'job-key-security-test') {
  writeFileSync(join(root, 'execution-manifest.json'), `${JSON.stringify({ manifest, mac: createHmac('sha256', key).update(canonicalJson(manifest)).digest('hex') })}\n`, { mode: 0o600 });
  return spawnSync(electron, [worker, '--job-file', 'execution-manifest.json'], {
    cwd: root, encoding: 'utf8', timeout: 20_000,
    env: { LANG: 'C', LC_ALL: 'C', SUPERWAGIE_JOB_KEY: key },
  });
}

test('worker profile path is a launcher-owned relative leaf', () => {
  const root = prepare();
  const run = spawnSync(electron, [worker, '--job-file', 'execution-manifest.json'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      LANG: 'C', LC_ALL: 'C', SUPERWAGIE_JOB_KEY: 'job-key-security-test',
      SUPERWAGIE_WORKER_USER_DATA: '../../outside-profile',
    },
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /WORKER_USER_DATA_INVALID/);
  assert.equal(existsSync(join(root, '..', 'outside-profile')), false);
});

test('whole execution manifest rejects path tampering before any output write', () => {
  const root = prepare();
  const manifest = baseManifest(root);
  const wrapper = { manifest, mac: createHmac('sha256', 'job-key-security-test').update(canonicalJson(manifest)).digest('hex') };
  wrapper.manifest.output_authorization.result_path = '../../outside.json';
  writeFileSync(join(root, 'execution-manifest.json'), JSON.stringify(wrapper));
  const run = spawnSync(electron, [worker, '--job-file', 'execution-manifest.json'], {
    cwd: root, encoding: 'utf8', timeout: 20_000, env: { LANG: 'C', LC_ALL: 'C', SUPERWAGIE_JOB_KEY: 'job-key-security-test' },
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /EXECUTION_MANIFEST_MAC_INVALID/, JSON.stringify({ status: run.status, signal: run.signal, error: run.error?.message }));
  assert.equal(existsSync(join(root, '..', 'outside.json')), false);
});

test('worker and secure fd copy reject source and intermediate symlinks', () => {
  const root = prepare();
  const outside = join(root, 'outside.html');
  writeFileSync(outside, readFileSync(join(root, 'inputs', 'composition.html')));
  symlinkSync(outside, join(root, 'inputs', 'linked.html'));
  const manifest = baseManifest(root);
  manifest.composition.html_path = 'inputs/linked.html';
  const run = runManifest(root, manifest);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /SYMLINK_FORBIDDEN/);

  const destination = mkdtempSync(join(tmpdir(), 'solution-b-copy-'));
  assert.throws(() => secureCopyByFd(root, 'inputs/composition.html\0suffix', destination, 'copied.html'), /RELATIVE_PATH_REQUIRED/);
  assert.throws(() => secureAtomicWrite(destination, 'atomic.json\0suffix', Buffer.from('blocked')), /RELATIVE_PATH_REQUIRED/);
  assert.throws(() => secureCopyByFd(root, 'inputs/linked.html', destination, 'copied.html'), /SYMLINK_FORBIDDEN|ELOOP/);
  mkdirSync(join(destination, 'real'), { mode: 0o700 });
  symlinkSync(join(destination, 'real'), join(destination, 'redirect'));
  assert.throws(() => secureCopyByFd(root, 'inputs/composition.html', destination, 'redirect/copied.html'), /SYMLINK_FORBIDDEN/);
  writeFileSync(join(destination, 'occupied.html'), 'attacker');
  assert.throws(() => secureCopyByFd(root, 'inputs/composition.html', destination, 'occupied.html'), /EEXIST/);

  const swapSource = join(root, 'swap-source.txt');
  writeFileSync(swapSource, 'trusted-original');
  secureCopyByFd(root, 'swap-source.txt', destination, 'swap-copy.txt', {
    afterSourceOpen: () => {
      renameSync(swapSource, join(root, 'opened-original.txt'));
      writeFileSync(swapSource, 'attacker-replacement');
    },
  });
  assert.equal(readFileSync(join(destination, 'swap-copy.txt'), 'utf8'), 'trusted-original');
  writeFileSync(join(destination, 'atomic.json.tmp'), 'preempted');
  secureAtomicWrite(destination, 'atomic.json', Buffer.from('committed'));
  assert.equal(readFileSync(join(destination, 'atomic.json'), 'utf8'), 'committed');
  assert.equal(readFileSync(join(destination, 'atomic.json.tmp'), 'utf8'), 'preempted');
});

test('secure file operations hold intermediate directory identities across path replacement', () => {
  const source = prepare();
  const destination = mkdtempSync(join(tmpdir(), 'solution-b-component-race-'));
  mkdirSync(join(destination, 'trusted'), { mode: 0o700 });
  mkdirSync(join(destination, 'attacker'), { mode: 0o700 });
  let copyHookRan = false;
  secureCopyByFd(source, 'inputs/composition.html', destination, 'trusted/copied.html', {
    afterDestinationDirectoryOpen: () => {
      copyHookRan = true;
      renameSync(join(destination, 'trusted'), join(destination, 'held-trusted'));
      symlinkSync(join(destination, 'attacker'), join(destination, 'trusted'));
    },
  });
  assert.equal(copyHookRan, true);
  assert.equal(existsSync(join(destination, 'held-trusted', 'copied.html')), true);
  assert.equal(existsSync(join(destination, 'attacker', 'copied.html')), false);

  const atomicRoot = mkdtempSync(join(tmpdir(), 'solution-b-atomic-component-race-'));
  mkdirSync(join(atomicRoot, 'trusted'), { mode: 0o700 });
  mkdirSync(join(atomicRoot, 'attacker'), { mode: 0o700 });
  let atomicHookRan = false;
  secureAtomicWrite(atomicRoot, 'trusted/committed.json', Buffer.from('trusted'), {
    afterDestinationDirectoryOpen: () => {
      atomicHookRan = true;
      renameSync(join(atomicRoot, 'trusted'), join(atomicRoot, 'held-trusted'));
      symlinkSync(join(atomicRoot, 'attacker'), join(atomicRoot, 'trusted'));
    },
  });
  assert.equal(atomicHookRan, true);
  assert.equal(readFileSync(join(atomicRoot, 'held-trusted', 'committed.json'), 'utf8'), 'trusted');
  assert.equal(existsSync(join(atomicRoot, 'attacker', 'committed.json')), false);
});

test('recovery manifest binds the checkpoint root and completed frames must decode as PNG', () => {
  const originalRoot = prepare();
  const crashManifest = baseManifest(originalRoot);
  crashManifest.frames = { start: 0, end: 2, indices: [0, 1, 2] };
  crashManifest.resource_limits.max_frames = 3;
  crashManifest.crash_injection_after_frames = 1;
  crashManifest.crash_injection_mode = 'sigkill';
  const originalCrash = runManifest(originalRoot, crashManifest);
  assert.equal(process.platform === 'win32' ? originalCrash.status !== 0 : originalCrash.signal === 'SIGKILL', true);
  const checkpointPath = join(originalRoot, 'state', 'checkpoint.json');
  const originalCheckpoint = readFileSync(checkpointPath);
  const firstPng = join(originalRoot, 'outputs', 'frames', 'frame-0000.png');
  const checkpoint = JSON.parse(originalCheckpoint);
  writeFileSync(firstPng, 'not-a-png-attacker-controlled');
  checkpoint.completed['0'] = sha256(readFileSync(firstPng));
  writeFileSync(checkpointPath, JSON.stringify(checkpoint));
  const recovery = { ...crashManifest, attempt: 2, crash_injection_after_frames: 0, crash_injection_mode: 'none',
    checkpoint: { ...crashManifest.checkpoint, initial_sha256: sha256(originalCheckpoint) } };
  const rootMismatch = runManifest(originalRoot, recovery);
  assert.notEqual(rootMismatch.status, 0);
  assert.match(rootMismatch.stderr, /CHECKPOINT_ROOT_MISMATCH/);

  const invalidPngRoot = prepare();
  const invalidCrash = baseManifest(invalidPngRoot);
  invalidCrash.frames = { start: 0, end: 2, indices: [0, 1, 2] };
  invalidCrash.resource_limits.max_frames = 3;
  invalidCrash.crash_injection_after_frames = 1;
  invalidCrash.crash_injection_mode = 'sigkill';
  const invalidCrashRun = runManifest(invalidPngRoot, invalidCrash);
  assert.equal(process.platform === 'win32' ? invalidCrashRun.status !== 0 : invalidCrashRun.signal === 'SIGKILL', true);
  const invalidCheckpointPath = join(invalidPngRoot, 'state', 'checkpoint.json');
  const invalidCheckpoint = JSON.parse(readFileSync(invalidCheckpointPath));
  const invalidPng = join(invalidPngRoot, 'outputs', 'frames', 'frame-0000.png');
  writeFileSync(invalidPng, 'not-a-png-but-signed-by-a-buggy-scheduler');
  invalidCheckpoint.completed['0'] = sha256(readFileSync(invalidPng));
  writeFileSync(invalidCheckpointPath, JSON.stringify(invalidCheckpoint));
  const signedBadCheckpoint = readFileSync(invalidCheckpointPath);
  const invalidRecovery = { ...invalidCrash, attempt: 2, crash_injection_after_frames: 0, crash_injection_mode: 'none',
    checkpoint: { ...invalidCrash.checkpoint, initial_sha256: sha256(signedBadCheckpoint) } };
  const invalidPngRun = runManifest(invalidPngRoot, invalidRecovery);
  assert.notEqual(invalidPngRun.status, 0);
  assert.match(invalidPngRun.stderr, /CHECKPOINT_PNG_INVALID/);
});

test('execution manifest validates every nested schema and verifies every claimed input identity', () => {
  const cases = [
    ['unknown nested field', (m) => { m.composition.ignored = true; }, /EXECUTION_MANIFEST_SCHEMA_INVALID/],
    ['bundle hash mismatch', (m) => { m.composition.bundle_sha256 = '0'.repeat(64); }, /EXECUTION_INPUT_HASH_MISMATCH/],
    ['asset hash mismatch', (m) => { m.assets.hashes[0].sha256 = '0'.repeat(64); }, /EXECUTION_INPUT_HASH_MISMATCH/],
    ['font hash mismatch', (m) => { m.fonts.hashes[0].sha256 = '0'.repeat(64); }, /EXECUTION_INPUT_HASH_MISMATCH/],
    ['runtime version mismatch', (m) => { m.runtime.electron_version = '999.0.0'; }, /EXECUTION_RUNTIME_IDENTITY_MISMATCH/],
    ['duplicate frame', (m) => { m.frames.indices = [0, 0]; }, /EXECUTION_MANIFEST_BOUNDS_INVALID/],
    ['negative frame', (m) => { m.frames = { start: -1, end: -1, indices: [-1] }; }, /EXECUTION_MANIFEST_BOUNDS_INVALID/],
    ['unused frame pattern', (m) => { m.output_authorization.frame_pattern = 'ignored-%s.png'; }, /EXECUTION_MANIFEST_DOMAIN_INVALID/],
    ['invalid resource limit', (m) => { m.resource_limits.max_output_bytes = -1; }, /EXECUTION_MANIFEST_BOUNDS_INVALID/],
  ];
  for (const [name, mutate, expected] of cases) {
    const root = prepare();
    const manifest = baseManifest(root);
    mutate(manifest);
    const run = runManifest(root, manifest);
    assert.notEqual(run.status, 0, name);
    assert.match(run.stderr, expected, name);
  }
});
