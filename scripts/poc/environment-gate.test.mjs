import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const EXECUTOR = resolve('scripts/poc/environment-gate.mjs');

function run(gate, fixture) {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-environment-gate-'));
  const results = join(root, 'results.json');
  const completed = spawnSync(process.execPath, [
    EXECUTOR, '--gate', gate, '--fixture', fixture, '--platform', 'macos-15-arm64',
    '--results-json', results,
  ], { encoding: 'utf8' });
  return { completed, document: JSON.parse(readFileSync(results, 'utf8')) };
}

for (const [gate, fixture, reason] of [
  ['gate-0', 'G0-SHELL-002', 'SIGNED_ELECTRON_SOLUTION_B_SHELL_REQUIRED'],
  ['gate-3', 'G3-REVIEW-001', 'ELECTRON_ARTIFACT_PREVIEW_SURFACE_REQUIRED'],
  ['gate-3', 'G3-REVIEW-002', 'ELECTRON_PREVIEW_RECOVERY_HARNESS_REQUIRED'],
  ['gate-5', 'G5-CONNECTOR-001', 'REAL_AGENTWIKI_AUTHORIZED_INSTANCE_REQUIRED'],
  ['gate-6', 'G6-BILLING-001', 'REAL_BILLING_SANDBOX_REQUIRED'],
  ['gate-6', 'G6-PACKAGE-001', 'SIGNED_INSTALLABLE_BUILDS_AND_CLEAN_MACHINES_REQUIRED'],
]) {
  test(`${fixture} is explicit BLOCKED_ENVIRONMENT evidence`, () => {
    const result = run(gate, fixture);
    assert.equal(result.completed.status, 2);
    assert.equal(result.document.gate, gate);
    assert.equal(result.document.fixture, fixture);
    assert.equal(result.document.decision_hint, 'BLOCKED_ENVIRONMENT');
    assert.deepEqual(result.document.reasons, [reason]);
    assert.ok(result.document.limitations.length > 0);
    if (gate === 'gate-0' || gate === 'gate-3' || fixture === 'G6-PACKAGE-001') {
      assert.equal(result.document.evidence_revision, 'solution-b-v1');
    }
  });
}

test('unknown fixture is rejected without fabricating evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-environment-gate-'));
  const completed = spawnSync(process.execPath, [
    EXECUTOR, '--gate', 'gate-6', '--fixture', 'UNKNOWN', '--platform', 'macos-15-arm64',
    '--results-json', join(root, 'results.json'),
  ], { encoding: 'utf8' });
  assert.equal(completed.status, 1);
});
