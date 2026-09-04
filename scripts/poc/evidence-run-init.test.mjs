import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const script = path.resolve(import.meta.dirname, 'evidence-run-init.mjs');

function initialize(root, runId) {
  return spawnSync(process.execPath, [
    script,
    '--evidence-root', root,
    '--gate', 'gate-1',
    '--fixture', 'G1-MARKDOWN-001',
    '--platform', 'macos-15-arm64',
    '--run-id', runId,
    '--release', 'test-kernel'
  ], { encoding: 'utf8' });
}

function initializeGvp(root, gate, runId) {
  return spawnSync(process.execPath, [
    script,
    '--evidence-root', root,
    '--gate', gate,
    '--fixture', 'GVP-0-CORE-001',
    '--platform', 'macos-15-arm64',
    '--run-id', runId,
    '--release', 'test-kernel'
  ], { encoding: 'utf8' });
}

test('evidence run initialization is exclusive and never reuses a pre-created directory', function () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'superwagie-evidence-init-'));
  const runId = '20260901T210000000Z-1234-aabbccddeeff0011';
  const runRoot = path.join(root, 'gate-1', runId);
  fs.mkdirSync(runRoot, { recursive: true });
  const sentinel = path.join(runRoot, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'must survive\n');

  const actual = initialize(root, runId);
  assert.equal(actual.status, 2, actual.stderr || actual.stdout);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'must survive\n');
  assert.deepEqual(fs.readdirSync(runRoot), ['sentinel.txt']);
});

test('a fresh evidence run atomically creates exclusive initial metadata files', function () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'superwagie-evidence-init-'));
  const runId = '20260901T210000001Z-1234-1122334455667788';
  const actual = initialize(root, runId);
  assert.equal(actual.status, 0, actual.stderr || actual.stdout);
  const runRoot = actual.stdout.trim();
  assert.equal(runRoot, path.join(root, 'gate-1', runId));
  assert.deepEqual(fs.readdirSync(runRoot).sort(), ['artifacts', 'environment.json', 'manifest.json', 'screenshots']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(runRoot, 'manifest.json'), 'utf8')).run_id, runId);

  const manifestBefore = fs.readFileSync(path.join(runRoot, 'manifest.json'));
  const collision = initialize(root, runId);
  assert.equal(collision.status, 2, collision.stderr || collision.stdout);
  assert.deepEqual(fs.readFileSync(path.join(runRoot, 'manifest.json')), manifestBefore);
});

test('evidence initialization registers every GVP namespace without widening it', function () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'superwagie-evidence-gvp-'));
  for (let index = 0; index <= 5; index += 1) {
    const runId = `20260904T21000000${index}Z-1234-aabbccddeeff00${index}${index}`;
    const actual = initializeGvp(root, `gvp-${index}`, runId);
    assert.equal(actual.status, 0, actual.stderr || actual.stdout);
    assert.equal(JSON.parse(fs.readFileSync(path.join(actual.stdout.trim(), 'manifest.json'), 'utf8')).gate, `gvp-${index}`);
  }
  const rejected = initializeGvp(root, 'gvp-6', '20260904T210000009Z-1234-aabbccddeeff0099');
  assert.equal(rejected.status, 2, rejected.stderr || rejected.stdout);
});
