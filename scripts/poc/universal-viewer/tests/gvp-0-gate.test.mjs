import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  admittedNpmCommand,
  evaluateGvp0Admission,
  runGvp0Gate,
  sanitizeDiagnostic,
  npmRuntimeIdentityForPlatform,
  validateReceiptBundle,
} from '../gvp-0-gate.mjs';

const pocRoot = path.resolve(import.meta.dirname, '..');
const repoRoot = path.resolve(pocRoot, '..', '..', '..');
const candidateRoot = path.join(pocRoot, '.candidate', 'source');
const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const FIXED_NOW = '2026-09-04T12:00:00.000Z';

test('live supply-chain probes bind the admitted canonical npm CLI identity', () => {
  const npm = admittedNpmCommand();
  assert.equal(npm.executable, process.execPath);
  assert.equal(npm.identity, 'npm@11.16.0#sha256:0434cdfe04030cc02943f27eb1cd958414f1092dcd18df610e571e443a9140e5');
  assert.equal(npm.tree_sha256, '0434cdfe04030cc02943f27eb1cd958414f1092dcd18df610e571e443a9140e5');
  assert.equal(path.isAbsolute(npm.cli), true);
  assert.equal(realpathSync(npm.cli), npm.cli);
  assert.equal(
    npmRuntimeIdentityForPlatform('windows-11-x64'),
    'npm@11.16.0#sha256:8f6d14c6934a5b0a55e8464ef12bd7d5fc3d24f36d2d4d1a12c5fe44265ecdde',
  );
});

function deterministicSupplyChainExecutor({ args, cwd }) {
  const logicalName = args[0] === 'sbom'
    ? 'source-sbom.cdx.json'
    : path.resolve(cwd) === candidateRoot
      ? 'candidate-npm-audit.raw.json'
      : 'npm-audit.raw.json';
  return {
    status: 0,
    stdout: readFileSync(path.join(pocRoot, 'baseline-evidence', logicalName), 'utf8'),
    stderr: '',
    capturedAt: FIXED_NOW,
  };
}

function hashTree(root) {
  const digest = createHash('sha256');
  const visit = (directory, relativeDirectory = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (relativeDirectory === '' && entry.name === '.git') continue;
      const relative = path.posix.join(relativeDirectory, entry.name);
      const absolute = path.join(directory, entry.name);
      digest.update(relative);
      digest.update('\0');
      if (entry.isDirectory()) visit(absolute, relative);
      else digest.update(readFileSync(absolute));
      digest.update('\0');
    }
  };
  visit(root);
  return digest.digest('hex');
}

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
  const result = await runGvp0Gate({
    candidateRoot,
    fixture: 'GVP-0-CORE-001',
    platform: 'macos-15-arm64',
    resultsPath: path.join(outputRoot, 'results.json'),
    artifactsDir,
    pocRoot,
    repoRoot,
    issuedAt: FIXED_NOW,
    now: () => FIXED_NOW,
    supplyChainExecutor: deterministicSupplyChainExecutor,
    ...overrides,
  });
  return { ...result, outputRoot, artifactsDir };
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

test('missing generated chunk output is an environment failure without a receipt', async (t) => {
  const root = copyInputs();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const actual = await invoke({ pocRoot: root });
  assert.equal(actual.exitCode, 2);
  assert.equal(actual.code, 'GVP0_CHUNK_OUTPUT_MISSING');
  assert.equal(actual.receipt, undefined);
  assert.match(actual.error, /^required evidence is unavailable: /u);
  assert.doesNotMatch(actual.error, /Users|\\|\.worktrees/u);
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
  decision.forbidden_runtime_edges = 1;
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
const completeRun = runGvp0Gate({
  candidateRoot,
  fixture: 'GVP-0-CORE-001',
  platform: 'macos-15-arm64',
  resultsPath: completeResultsPath,
  artifactsDir: completeArtifactsDir,
  pocRoot,
  repoRoot,
  issuedAt: FIXED_NOW,
  now: () => FIXED_NOW,
  supplyChainExecutor: deterministicSupplyChainExecutor,
});

test('the complete current local fixture emits a schema-valid GVP-0 GO receipt', async () => {
  const actual = await completeRun;
  assert.equal(actual.exitCode, 0);
  assert.ok(actual.receipt, JSON.stringify({ code: actual.code, error: actual.error }));
  const receipt = JSON.parse(readFileSync(completeResultsPath, 'utf8'));
  assert.equal(receipt.verdict, 'GO');
  assert.equal(receipt.gate_id, 'GVP-0');
  assert.equal(receipt.corpus_id, 'GVP-0-CORE-001');
  const validation = validateReceiptBundle({ resultsPath: completeResultsPath, now: FIXED_NOW });
  assert.deepEqual(validation.errors, []);
  const summary = JSON.parse(readFileSync(path.join(completeArtifactsDir, 'acceptance-summary.json'), 'utf8'));
  assert.equal(summary.scope, 'disposable-admission-poc');
  assert.equal(summary.production_registry_admitted, false);
  assert.equal(summary.production_chunk_signed, false);
  assert.equal(summary.release_admission, 'NO_GO');
  assert.deepEqual(summary.remaining_gates, ['GVP-1', 'GVP-2', 'GVP-3', 'GVP-4', 'GVP-5']);
  assert.equal(summary.metrics.forbidden_runtime_edges, 0);
});

test('schema-invalid receipts and changed bound artifacts fail validation', async () => {
  await completeRun;
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

function rewriteBundle(root, mutate) {
  const resultsPath = path.join(root, 'results.json');
  const manifestPath = path.join(root, 'artifacts', 'evidence-manifest.json');
  const summaryPath = path.join(root, 'artifacts', 'acceptance-summary.json');
  const receipt = JSON.parse(readFileSync(resultsPath, 'utf8'));
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  mutate({ receipt, manifest, summary });
  const summaryBytes = `${JSON.stringify(summary, null, 2)}\n`;
  writeFileSync(summaryPath, summaryBytes);
  const summaryBinding = manifest.artifacts.find(({ path: logicalPath }) => logicalPath === 'artifacts/acceptance-summary.json');
  summaryBinding.sha256 = sha256(summaryBytes);
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(manifestPath, manifestBytes);
  receipt.evidence_sha256 = sha256(manifestBytes);
  writeFileSync(resultsPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return resultsPath;
}

test('a self-consistent one-artifact receipt cannot satisfy the exact GVP-0 fixture contract', async () => {
  await completeRun;
  const root = path.join(mkdtempSync(path.join(os.tmpdir(), 'superwagie-gvp0-one-artifact-')), 'run');
  mkdirSync(path.join(root, 'artifacts'), { recursive: true });
  const summaryBytes = readFileSync(path.join(completeArtifactsDir, 'acceptance-summary.json'));
  writeFileSync(path.join(root, 'artifacts', 'acceptance-summary.json'), summaryBytes);
  const receipt = JSON.parse(readFileSync(completeResultsPath, 'utf8'));
  const sourceManifest = JSON.parse(readFileSync(path.join(completeArtifactsDir, 'evidence-manifest.json'), 'utf8'));
  sourceManifest.artifacts = [{ path: 'artifacts/acceptance-summary.json', sha256: sha256(summaryBytes) }];
  const manifestBytes = `${JSON.stringify(sourceManifest, null, 2)}\n`;
  writeFileSync(path.join(root, 'artifacts', 'evidence-manifest.json'), manifestBytes);
  receipt.evidence_sha256 = sha256(manifestBytes);
  writeFileSync(path.join(root, 'results.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  const validation = validateReceiptBundle({ resultsPath: path.join(root, 'results.json'), repoRoot, now: FIXED_NOW });
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join('\n'), /required artifact set/i);
});

test('a coherently rebound legacy 50-artifact bundle cannot satisfy the 56-role contract', async () => {
  await completeRun;
  const root = path.join(mkdtempSync(path.join(os.tmpdir(), 'superwagie-gvp0-fifty-artifacts-')), 'run');
  cpSync(completeOutputRoot, root, { recursive: true });
  const removed = [
    'artifacts/fresh/candidate-npm-audit.raw.json',
    'artifacts/fresh/npm-audit.raw.json',
    'artifacts/fresh/source-sbom.raw.cdx.json',
    'artifacts/fresh/supply-chain-freshness.json',
    'artifacts/run-context.json',
    'artifacts/source/candidate-package-lock.json',
  ];
  const manifestPath = path.join(root, 'artifacts', 'evidence-manifest.json');
  const resultsPath = path.join(root, 'results.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.artifacts.length, 56);
  manifest.artifacts = manifest.artifacts.filter(binding => !removed.includes(binding.path));
  for (const relative of removed) rmSync(path.join(root, relative));
  assert.equal(manifest.artifacts.length, 50);
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(manifestPath, manifestBytes);
  const receipt = JSON.parse(readFileSync(resultsPath, 'utf8'));
  receipt.evidence_sha256 = sha256(manifestBytes);
  receipt.receipt_id = `gvp0-core-${receipt.platform_id}-${receipt.evidence_sha256.slice(7, 23)}`;
  writeFileSync(resultsPath, `${JSON.stringify(receipt, null, 2)}\n`);

  const validation = validateReceiptBundle({ resultsPath, repoRoot, now: FIXED_NOW });
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join('\n'), /required artifact set/i);
});

test('coherently rewritten receipt bundles cannot forge a different GVP-0 authority', async () => {
  await completeRun;
  const mutations = [
    ['corpus', ({ receipt, manifest, summary }) => {
      receipt.corpus_id = 'GVP-0-OTHER-001'; manifest.corpus_id = receipt.corpus_id; summary.fixture = receipt.corpus_id;
    }],
    ['viewer', ({ receipt, summary }) => { receipt.viewer_id = 'other-viewer'; summary.candidate_id = receipt.viewer_id; }],
    ['version', ({ receipt, summary }) => { receipt.viewer_version = '0.16.1+other'; summary.candidate_version = receipt.viewer_version; }],
    ['platform', ({ receipt, manifest, summary }) => {
      receipt.platform_id = 'windows-11-x64'; manifest.platform_id = receipt.platform_id; summary.platform = receipt.platform_id;
    }],
    ['candidate', ({ receipt, summary }) => {
      receipt.viewer_version = `0.16.0+${'a'.repeat(40)}`; summary.candidate_commit = 'a'.repeat(40); summary.candidate_version = receipt.viewer_version;
    }],
    ['timestamp', ({ receipt, summary }) => { receipt.issued_at = '2026-09-01T00:00:00.000Z'; summary.captured_at = receipt.issued_at; }],
    ['summary decision', ({ receipt, summary }) => {
      receipt.verdict = 'NO_GO'; summary.decision_hint = 'NO_GO'; summary.acceptance_pass = false; summary.metrics.forbidden_runtime_edges = 1;
    }],
  ];
  for (const [label, mutate] of mutations) {
    const root = path.join(mkdtempSync(path.join(os.tmpdir(), `superwagie-gvp0-${label.replace(' ', '-')}-`)), 'run');
    cpSync(completeOutputRoot, root, { recursive: true });
    const validation = validateReceiptBundle({ resultsPath: rewriteBundle(root, mutate), repoRoot, now: FIXED_NOW });
    assert.equal(validation.valid, false, label);
  }
});

test('fresh supply-chain probes are bound and a newly disclosed vulnerability blocks acceptance', async () => {
  const accepted = await invoke();
  assert.equal(accepted.exitCode, 0);
  assert.ok(accepted.receipt, JSON.stringify({ code: accepted.code, error: accepted.error }));
  assert.ok(readFileSync(path.join(accepted.artifactsDir, 'fresh', 'npm-audit.raw.json')).length > 0);
  assert.ok(readFileSync(path.join(accepted.artifactsDir, 'fresh', 'candidate-npm-audit.raw.json')).length > 0);
  assert.ok(readFileSync(path.join(accepted.artifactsDir, 'fresh', 'source-sbom.raw.cdx.json')).length > 0);
  assert.ok(readFileSync(path.join(accepted.artifactsDir, 'fresh', 'supply-chain-freshness.json')).length > 0);

  const vulnerableExecutor = input => {
    const result = deterministicSupplyChainExecutor(input);
    if (input.args[0] !== 'audit' || path.resolve(input.cwd) === candidateRoot) return result;
    const document = JSON.parse(result.stdout);
    document.metadata.vulnerabilities.moderate = 1;
    document.metadata.vulnerabilities.total = 1;
    return { ...result, status: 1, stdout: `${JSON.stringify(document)}\n` };
  };
  const vulnerable = await invoke({ supplyChainExecutor: vulnerableExecutor });
  assert.equal(vulnerable.exitCode, 1);
  assert.equal(vulnerable.code, 'GVP0_LIVE_VULNERABILITY_REJECTED');
  assert.equal(JSON.parse(readFileSync(path.join(vulnerable.artifactsDir, 'fresh', 'npm-audit.raw.json'), 'utf8')).metadata.vulnerabilities.moderate, 1);
  assert.equal(JSON.parse(readFileSync(path.join(vulnerable.artifactsDir, 'fresh', 'supply-chain-freshness.json'), 'utf8')).checks.poc_production_audit, 'NO_GO');
});

test('a coherently rebound freshness attestation cannot change the production probe commands', async () => {
  await completeRun;
  const root = path.join(mkdtempSync(path.join(os.tmpdir(), 'superwagie-gvp0-probe-command-')), 'run');
  cpSync(completeOutputRoot, root, { recursive: true });
  const freshnessPath = path.join(root, 'artifacts', 'fresh', 'supply-chain-freshness.json');
  const manifestPath = path.join(root, 'artifacts', 'evidence-manifest.json');
  const resultsPath = path.join(root, 'results.json');
  const freshness = JSON.parse(readFileSync(freshnessPath, 'utf8'));
  freshness.probes[0].command = 'npm audit --json';
  const freshnessBytes = `${JSON.stringify(freshness, null, 2)}\n`;
  writeFileSync(freshnessPath, freshnessBytes);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.artifacts.find(binding => binding.path === 'artifacts/fresh/supply-chain-freshness.json').sha256 = sha256(freshnessBytes);
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(manifestPath, manifestBytes);
  const receipt = JSON.parse(readFileSync(resultsPath, 'utf8'));
  receipt.evidence_sha256 = sha256(manifestBytes);
  receipt.receipt_id = `gvp0-core-${receipt.platform_id}-${receipt.evidence_sha256.slice(7, 23)}`;
  writeFileSync(resultsPath, `${JSON.stringify(receipt, null, 2)}\n`);

  const validation = validateReceiptBundle({ resultsPath, repoRoot, now: FIXED_NOW });
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join('\n'), /probe command/i);
});

test('a coherently rebound 56-artifact bundle cannot contain an undeclared secret', async () => {
  await completeRun;
  const root = path.join(mkdtempSync(path.join(os.tmpdir(), 'superwagie-gvp0-secret-')), 'run');
  cpSync(completeOutputRoot, root, { recursive: true });
  const freshnessPath = path.join(root, 'artifacts', 'fresh', 'supply-chain-freshness.json');
  const manifestPath = path.join(root, 'artifacts', 'evidence-manifest.json');
  const resultsPath = path.join(root, 'results.json');
  const freshness = JSON.parse(readFileSync(freshnessPath, 'utf8'));
  freshness.api_token = 'ghp_FAKE_SECRET_12345678901234567890';
  const freshnessBytes = `${JSON.stringify(freshness, null, 2)}\n`;
  writeFileSync(freshnessPath, freshnessBytes);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.artifacts.length, 56);
  manifest.artifacts.find(binding => binding.path === 'artifacts/fresh/supply-chain-freshness.json').sha256 = sha256(freshnessBytes);
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(manifestPath, manifestBytes);
  const receipt = JSON.parse(readFileSync(resultsPath, 'utf8'));
  receipt.evidence_sha256 = sha256(manifestBytes);
  receipt.receipt_id = `gvp0-core-${receipt.platform_id}-${receipt.evidence_sha256.slice(7, 23)}`;
  writeFileSync(resultsPath, `${JSON.stringify(receipt, null, 2)}\n`);

  const validation = validateReceiptBundle({ resultsPath, repoRoot, now: FIXED_NOW });
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join('\n'), /secret|undeclared/i);
});

test('a coherently rebound acceptance summary cannot add a nested metrics apiKey', async () => {
  await completeRun;
  const root = path.join(mkdtempSync(path.join(os.tmpdir(), 'superwagie-gvp0-nested-schema-')), 'run');
  cpSync(completeOutputRoot, root, { recursive: true });
  const summaryPath = path.join(root, 'artifacts', 'acceptance-summary.json');
  const manifestPath = path.join(root, 'artifacts', 'evidence-manifest.json');
  const resultsPath = path.join(root, 'results.json');
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  summary.metrics.apiKey = 'ordinary-reviewer-value';
  const summaryBytes = `${JSON.stringify(summary, null, 2)}\n`;
  writeFileSync(summaryPath, summaryBytes);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.artifacts.find(binding => binding.path === 'artifacts/acceptance-summary.json').sha256 = sha256(summaryBytes);
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(manifestPath, manifestBytes);
  const receipt = JSON.parse(readFileSync(resultsPath, 'utf8'));
  receipt.evidence_sha256 = sha256(manifestBytes);
  receipt.receipt_id = `gvp0-core-${receipt.platform_id}-${receipt.evidence_sha256.slice(7, 23)}`;
  writeFileSync(resultsPath, `${JSON.stringify(receipt, null, 2)}\n`);

  const validation = validateReceiptBundle({ resultsPath, repoRoot, now: FIXED_NOW });
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join('\n'), /secret-bearing key|metrics.*exact|nested.*schema/i);
});

test('unavailable or stale live supply-chain evidence is an environment failure', async () => {
  const unavailable = await invoke({
    supplyChainExecutor: () => ({ status: null, stdout: '', stderr: 'timed out', error: { code: 'ETIMEDOUT' } }),
  });
  assert.equal(unavailable.exitCode, 2);
  assert.equal(unavailable.code, 'GVP0_LIVE_AUDIT_UNAVAILABLE');

  const invalidAuditExit = await invoke({
    supplyChainExecutor(definition) {
      const result = deterministicSupplyChainExecutor(definition);
      return { ...result, status: definition.args[0] === 'audit' ? 2 : result.status };
    },
  });
  assert.equal(invalidAuditExit.exitCode, 2);
  assert.equal(invalidAuditExit.code, 'GVP0_LIVE_AUDIT_UNAVAILABLE');
  assert.equal(invalidAuditExit.receipt, undefined);

  const stale = await invoke({ issuedAt: '2026-09-01T00:00:00.000Z' });
  assert.equal(stale.exitCode, 2);
  assert.equal(stale.code, 'GVP0_LIVE_EVIDENCE_STALE');
});

test('subprocess failures never disclose secrets, environment values, or absolute paths', async () => {
  const safeProse = 'The token parser remained offline.';
  const actual = await invoke({
    supplyChainExecutor: () => {
      throw new Error(`${safeProse} token=ordinary-token-value authToken=ordinary-auth-value github_token=ordinary-github-value ＴＯＫＥＮ=ordinary-fullwidth-value env.session_token=ordinary-session-value client-secret="ordinary-quoted-client-value" https://example.invalid/check?access_token=ordinary-query-value apiKey=ordinary-api-value refresh_token:ordinary-refresh accessToken=ordinary-access clientSecret=ordinary-client password=ordinary-password credential=ordinary-credential Authorization=ordinary-authorization Cookie=ordinary-cookie privateKey=ordinary-private Bearer abcdefghijklmnopqrstuvwxyz API_TOKEN=ghp_FAKE_SECRET_12345678901234567890 ${candidateRoot}`);
    },
  });
  assert.equal(actual.exitCode, 2);
  assert.equal(actual.code, 'GVP0_ENVIRONMENT_FAILURE');
  assert.doesNotMatch(actual.error, /ordinary-|Bearer|ghp_|API_TOKEN|apiKey|refresh_token|accessToken|clientSecret|client-secret|password|credential|Authorization|Cookie|privateKey|authToken|github_token|ＴＯＫＥＮ|session_token|access_token|\/Users\/|candidate\/source/iu);
  assert.match(actual.error, new RegExp(safeProse.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'));
  assert.match(actual.error, /REDACTED/iu);
});

test('diagnostic redaction preserves package assignments while removing credential cookies', () => {
  const actual = sanitizeDiagnostic('tough-cookie: 4.1.4 tough-cookie=4.1.4 cookie-parser: 1.4.7 cookie=secret session_cookie=secret auth-cookie=secret access.cookie=secret refreshCookie=secret client_cookie=secret');
  assert.equal(actual, 'tough-cookie: 4.1.4 tough-cookie=4.1.4 cookie-parser: 1.4.7 [REDACTED_SECRET] [REDACTED_SECRET] [REDACTED_SECRET] [REDACTED_SECRET] [REDACTED_SECRET] [REDACTED_SECRET]');
});

test('receipt validation diagnostics never disclose the evidence root or filesystem stack paths', async () => {
  await completeRun;
  const root = path.join(mkdtempSync(path.join(os.tmpdir(), 'superwagie-gvp0-validation-redaction-')), 'run');
  cpSync(completeOutputRoot, root, { recursive: true });
  rmSync(path.join(root, 'artifacts', 'run-context.json'));

  const validation = validateReceiptBundle({ resultsPath: path.join(root, 'results.json'), repoRoot, now: FIXED_NOW });
  assert.equal(validation.valid, false);
  assert.doesNotMatch(validation.errors.join('\n'), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'));
  assert.doesNotMatch(validation.errors.join('\n'), /(?:\/private)?\/var\/folders|\/Users\/|node:fs|\bat \w/iu);
});

test('output paths reject dot-dot, symlink parents, source .git, and hardlink aliases before execution', async () => {
  const gitArtifacts = path.join(candidateRoot, '.git', 'gvp0-output-regression');
  mkdirSync(gitArtifacts);
  try {
    const inGit = await invoke({ artifactsDir: gitArtifacts });
    assert.equal(inGit.exitCode, 2);
    assert.equal(inGit.code, 'GVP0_OUTPUT_ALIASES_SOURCE');
    assert.deepEqual(readdirSync(gitArtifacts), []);
  } finally {
    rmSync(gitArtifacts, { recursive: true, force: true });
  }

  const realParent = mkdtempSync(path.join(os.tmpdir(), 'superwagie-gvp0-real-parent-'));
  const linkedParent = `${realParent}-link`;
  symlinkSync(realParent, linkedParent);
  const linkedArtifacts = path.join(realParent, 'artifacts');
  mkdirSync(linkedArtifacts);
  const throughLink = await invoke({ artifactsDir: path.join(linkedParent, 'artifacts') });
  assert.equal(throughLink.exitCode, 2);
  assert.equal(throughLink.code, 'GVP0_OUTPUT_SYMLINK_REJECTED');

  const dotParent = mkdtempSync(path.join(os.tmpdir(), 'superwagie-gvp0-dotdot-'));
  const dotArtifacts = path.join(dotParent, 'artifacts');
  mkdirSync(dotArtifacts);
  const dotDot = await invoke({ artifactsDir: `${dotParent}/child/../artifacts` });
  assert.equal(dotDot.exitCode, 2);
  assert.equal(dotDot.code, 'GVP0_OUTPUT_DOT_SEGMENT_REJECTED');

  const linkedResultRoot = mkdtempSync(path.join(os.tmpdir(), 'superwagie-gvp0-hardlink-'));
  const linkedResult = path.join(linkedResultRoot, 'results.json');
  linkSync(path.join(pocRoot, 'source-lock.json'), linkedResult);
  const hardlink = await invoke({ resultsPath: linkedResult });
  assert.equal(hardlink.exitCode, 2);
  assert.equal(hardlink.code, 'GVP0_OUTPUT_ALIASES_SOURCE');
});

test('renaming the checked run root to a symlink during a probe never writes into the candidate', async () => {
  const outputRoot = mkdtempSync(path.join(os.tmpdir(), 'superwagie-gvp0-output-swap-'));
  const displacedRoot = `${outputRoot}-displaced`;
  const artifactsDir = path.join(outputRoot, 'artifacts');
  const resultsPath = path.join(outputRoot, 'results.json');
  const candidateArtifacts = path.join(candidateRoot, 'artifacts');
  assert.equal(existsSync(candidateArtifacts), false, 'test requires a pristine candidate without an artifacts directory');
  mkdirSync(artifactsDir);
  const candidateHashBefore = hashTree(candidateRoot);
  let swapped = false;
  const swappingExecutor = input => {
    if (!swapped) {
      renameSync(outputRoot, displacedRoot);
      symlinkSync(candidateRoot, outputRoot, 'dir');
      swapped = true;
    }
    return deterministicSupplyChainExecutor(input);
  };
  try {
    const actual = await runGvp0Gate({
      candidateRoot,
      fixture: 'GVP-0-CORE-001',
      platform: 'macos-15-arm64',
      resultsPath,
      artifactsDir,
      pocRoot,
      repoRoot,
      issuedAt: FIXED_NOW,
      now: () => FIXED_NOW,
      supplyChainExecutor: swappingExecutor,
    });
    assert.equal(actual.exitCode, 2);
    assert.equal(actual.code, 'GVP0_OUTPUT_IDENTITY_CHANGED');
    assert.equal(hashTree(candidateRoot), candidateHashBefore);
    for (const relative of [
      'fresh/npm-audit.raw.json',
      'fresh/candidate-npm-audit.raw.json',
      'fresh/source-sbom.raw.cdx.json',
      'fresh/supply-chain-freshness.json',
    ]) assert.equal(existsSync(path.join(candidateArtifacts, relative)), false, relative);
  } finally {
    if (existsSync(outputRoot)) unlinkSync(outputRoot);
    rmSync(displacedRoot, { recursive: true, force: true });
    rmSync(candidateArtifacts, { recursive: true, force: true });
  }
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
