import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  evaluateGvp0Admission,
  runGvp0Gate,
  validateReceiptBundle,
} from '../gvp-0-gate.mjs';

const pocRoot = path.resolve(import.meta.dirname, '..');
const repoRoot = path.resolve(pocRoot, '..', '..', '..');
const candidateRoot = path.join(pocRoot, '.candidate', 'source');
const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function copyInputs() {
  const target = mkdtempSync(path.join(os.tmpdir(), 'superwagie-gvp0-inputs-'));
  for (const name of ['source-lock.json', 'patch-ledger.json', 'package-lock.json']) {
    cpSync(path.join(pocRoot, name), path.join(target, name));
  }
  cpSync(path.join(pocRoot, 'baseline-evidence'), path.join(target, 'baseline-evidence'), { recursive: true });
  return target;
}

function reindexBaseline(root) {
  const baseline = path.join(root, 'baseline-evidence');
  const indexPath = path.join(baseline, 'index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  for (const entry of index.artifacts) {
    entry.sha256 = sha256(readFileSync(path.join(baseline, entry.logical_name)));
  }
  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
}

async function invoke(overrides = {}) {
  const outputRoot = mkdtempSync(path.join(os.tmpdir(), 'superwagie-gvp0-output-'));
  const artifactsDir = path.join(outputRoot, 'artifacts');
  mkdirSync(artifactsDir);
  return runGvp0Gate({
    candidateRoot,
    fixture: 'GVP-0-CORE-001',
    platform: 'macos-15-arm64',
    resultsPath: path.join(outputRoot, 'results.json'),
    artifactsDir,
    pocRoot,
    repoRoot,
    issuedAt: '2026-09-04T12:00:00.000Z',
    ...overrides,
  });
}

test('missing, relative, and symlink candidate roots are environment/input failures', async () => {
  const missing = await invoke({ candidateRoot: '' });
  assert.equal(missing.exitCode, 2);
  assert.equal(missing.code, 'GVP0_CANDIDATE_ROOT_REQUIRED');

  const relative = await invoke({ candidateRoot: 'relative/candidate' });
  assert.equal(relative.exitCode, 2);
  assert.equal(relative.code, 'GVP0_CANDIDATE_ROOT_ABSOLUTE_REQUIRED');

  const target = mkdtempSync(path.join(os.tmpdir(), 'superwagie-gvp0-candidate-'));
  const link = path.join(path.dirname(target), `${path.basename(target)}-link`);
  symlinkSync(target, link);
  const symlink = await invoke({ candidateRoot: link });
  assert.equal(symlink.exitCode, 2);
  assert.equal(symlink.code, 'GVP0_CANDIDATE_ROOT_SYMLINK_REJECTED');
});

test('platform mismatch is an environment failure', async () => {
  const actual = await invoke({ platform: 'windows-11-x64' });
  assert.equal(actual.exitCode, 2);
  assert.equal(actual.code, 'GVP0_PLATFORM_MISMATCH');
});

test('wrong source commit or source hash is an acceptance failure', async () => {
  for (const mutation of ['commit', 'source_tree_sha256']) {
    const root = copyInputs();
    const sourceLockPath = path.join(root, 'source-lock.json');
    const sourceLock = JSON.parse(readFileSync(sourceLockPath, 'utf8'));
    sourceLock[mutation] = mutation === 'commit' ? 'a'.repeat(40) : 'b'.repeat(64);
    writeFileSync(sourceLockPath, `${JSON.stringify(sourceLock, null, 2)}\n`);
    const actual = await invoke({ pocRoot: root });
    assert.equal(actual.exitCode, 1, mutation);
    assert.match(actual.code, /SOURCE_IDENTITY_REJECTED/, mutation);
  }
});

test('a declared patch missing from disk is an acceptance failure', async () => {
  const root = copyInputs();
  const ledgerPath = path.join(root, 'patch-ledger.json');
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  ledger.patches = [{ patch_id: 'isolate-pdf', file: 'patches/isolate-pdf.patch', sha256: `sha256:${'a'.repeat(64)}` }];
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  const actual = await invoke({ pocRoot: root });
  assert.equal(actual.exitCode, 1);
  assert.equal(actual.code, 'GVP0_PATCH_FILE_MISSING');
});

test('stale baseline evidence is rejected before fresh probes run', async () => {
  const root = copyInputs();
  const decisionPath = path.join(root, 'baseline-evidence', 'admission-decision.json');
  const decision = JSON.parse(readFileSync(decisionPath, 'utf8'));
  decision.forbidden_runtime_edges = 0;
  writeFileSync(decisionPath, `${JSON.stringify(decision, null, 2)}\n`);
  const actual = await invoke({ pocRoot: root });
  assert.equal(actual.exitCode, 1);
  assert.equal(actual.code, 'GVP0_BASELINE_EVIDENCE_STALE');
});

test('an unsigned PoC manifest cannot claim production loadability', async () => {
  const root = copyInputs();
  const manifestPath = path.join(root, 'baseline-evidence', 'manifests', 'viewer-base.chunk-manifest.poc.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.production_loadable = true;
  manifest.signature_state = 'signed';
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  reindexBaseline(root);
  const actual = await invoke({ pocRoot: root });
  assert.equal(actual.exitCode, 1);
  assert.equal(actual.code, 'GVP0_PRODUCTION_MANIFEST_CLAIM_REJECTED');
});

const completeOutputRoot = mkdtempSync(path.join(os.tmpdir(), 'superwagie-gvp0-complete-'));
const completeArtifactsDir = path.join(completeOutputRoot, 'artifacts');
mkdirSync(completeArtifactsDir);
const completeResultsPath = path.join(completeOutputRoot, 'results.json');
const completeRun = spawnSync(process.execPath, [
  path.join(pocRoot, 'gvp-0-gate.mjs'),
  '--platform', 'macos-15-arm64',
  '--fixture', 'GVP-0-CORE-001',
  '--candidate-root', candidateRoot,
  '--results-json', completeResultsPath,
  '--artifacts-dir', completeArtifactsDir,
], { cwd: repoRoot, encoding: 'utf8' });

test('the complete current local CLI fixture emits a schema-valid NO_GO receipt and exit 1', () => {
  assert.equal(completeRun.status, 1, completeRun.stderr || completeRun.stdout);
  assert.match(completeRun.stdout, /GVP0_ACCEPTANCE_NO_GO/);
  const receipt = JSON.parse(readFileSync(completeResultsPath, 'utf8'));
  assert.equal(receipt.verdict, 'NO_GO');
  assert.equal(receipt.gate_id, 'GVP-0');
  assert.equal(receipt.corpus_id, 'GVP-0-CORE-001');
  const validation = validateReceiptBundle({ resultsPath: completeResultsPath });
  assert.deepEqual(validation.errors, []);
  const summary = JSON.parse(readFileSync(path.join(completeArtifactsDir, 'acceptance-summary.json'), 'utf8'));
  assert.equal(summary.scope, 'disposable-admission-poc');
  assert.equal(summary.production_registry_admitted, false);
  assert.equal(summary.production_chunk_signed, false);
  assert.equal(summary.release_admission, 'NO_GO');
  assert.deepEqual(summary.remaining_gates, ['GVP-1', 'GVP-2', 'GVP-3', 'GVP-4', 'GVP-5']);
  assert.equal(summary.metrics.forbidden_runtime_edges, 8);
});

test('schema-invalid receipts and changed bound artifacts fail validation', () => {
  const invalidReceiptRoot = mkdtempSync(path.join(os.tmpdir(), 'superwagie-gvp0-invalid-receipt-'));
  cpSync(completeOutputRoot, invalidReceiptRoot, { recursive: true });
  const invalidResults = path.join(invalidReceiptRoot, 'results.json');
  const receipt = JSON.parse(readFileSync(invalidResults, 'utf8'));
  receipt.release_admission = 'GO';
  writeFileSync(invalidResults, `${JSON.stringify(receipt, null, 2)}\n`);
  assert.match(validateReceiptBundle({ resultsPath: invalidResults }).errors.join('\n'), /schema/i);

  const changedRoot = mkdtempSync(path.join(os.tmpdir(), 'superwagie-gvp0-changed-artifact-'));
  cpSync(completeOutputRoot, changedRoot, { recursive: true });
  writeFileSync(path.join(changedRoot, 'artifacts', 'acceptance-summary.json'), '{}\n');
  assert.match(validateReceiptBundle({ resultsPath: path.join(changedRoot, 'results.json') }).errors.join('\n'), /hash mismatch/i);
});

test('CONDITIONAL_GO is never classified as a release pass', () => {
  const conditional = evaluateGvp0Admission({
    forbiddenRuntimeEdges: 0,
    evidenceValid: true,
    behaviorPass: true,
    requestedVerdict: 'CONDITIONAL_GO',
  });
  assert.equal(conditional.verdict, 'NO_GO');
  assert.equal(conditional.exitCode, 1);
  assert.equal(conditional.releaseAdmission, 'NO_GO');
});

test('only a complete zero-edge GVP-0 acceptance outcome maps to exit 0', () => {
  const accepted = evaluateGvp0Admission({
    forbiddenRuntimeEdges: 0,
    evidenceValid: true,
    behaviorPass: true,
    requestedVerdict: 'GO',
  });
  assert.equal(accepted.verdict, 'GO');
  assert.equal(accepted.exitCode, 0);
  assert.equal(accepted.releaseAdmission, 'NO_GO');
});
