import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  validateCandidateClosure,
  runIsolationMatrix,
  runBoundaryAttacks,
  runExtensionLifecycle,
} from '../src/task5-lib.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../../../..');
const candidateRoot = join(repositoryRoot, 'evidence/gate-0/solution-b-v1-ac43a9a9bf75/candidate-root');

test('G0-DEPS fails closed for byte tamper, missing runtime, and PATH fallback', { timeout: 180_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-task5-deps-'));
  const result = await validateCandidateClosure({ candidateRoot, workRoot: root, exerciseAttacks: true });
  assert.equal(result.pass, true);
  assert.equal(result.manifest_sha256, 'c3d0db24041780cd8bc4f7298eb145cb95e86f12d03919b32f31ad427eb1bc78');
  assert.deepEqual(result.attacks, { tamper_rejected: true, missing_rejected: true, path_fallback_rejected: true });
});

test('G0-ISOLATION produces zero-diff behavior across all three host scenarios', { timeout: 360_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-task5-isolation-'));
  const result = await runIsolationMatrix({ candidateRoot, workRoot: root });
  assert.equal(result.pass, true);
  assert.equal(result.scenarios.length, 3);
  assert.equal(result.zero_diff, true);
  assert.equal(result.external_canary_observations, 0);
});

test('G5-ATTACK exercises actual Main Core Surface Worker boundaries', { timeout: 240_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-task5-attack-'));
  const actualResultPath = join(repositoryRoot, 'evidence/gate-0/solution-b-v1-ac43a9a9bf75/raw-run/actual-electron-result.json');
  const result = await runBoundaryAttacks({ candidateRoot, workRoot: join(root, 'attack'), actualResultPath });
  assert.equal(result.pass, true);
  assert.equal(Object.values(result.attack_receipts).every(Boolean), true);
});

test('G5-EXT runs temporary Installer and Extension Worker lifecycle through only the facade', { timeout: 180_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-task5-ext-'));
  const result = await runExtensionLifecycle({ candidateRoot, workRoot: root });
  assert.equal(result.pass, true);
  assert.deepEqual(result.transitions, ['install-v1', 'enable-v1', 'update-v2', 'disable-v2', 'rollback-v1', 'enable-v1', 'remove']);
  assert.equal(result.public_facade_only, true);
  assert.equal(result.network_denied, true);
  assert.equal(result.outside_file_denied, true);
});
