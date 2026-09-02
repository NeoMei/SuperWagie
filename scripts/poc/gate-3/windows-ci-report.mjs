#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateIsolationEvidence } from './isolation-evidence.mjs';
import {
  buildStandardReviewEvidenceBinding,
  validateStandardReviewEvidence
} from './standard-review-evidence.mjs';
import { validateRendererProvenanceDocument } from './review-provenance.mjs';
import { validateToolchainIdentity } from './windows-toolchain-identity.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const SHA256 = /^[0-9a-f]{64}$/;
const DEFAULT_FIXTURE_MANIFEST = path.join(
  repo, 'fixtures/gate-3/G3-REVIEW-001/fixture-manifest.json'
);

function parse(argv) {
  const result = {};
  const names = new Map([
    ['--review-root', 'reviewRoot'], ['--isolation-root', 'isolationRoot'],
    ['--toolchain-identity', 'toolchainIdentity'], ['--output', 'output'],
    ['--fixture-manifest', 'fixtureManifest']
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = names.get(argv[index]);
    if (!key || index + 1 >= argv.length || result[key]) throw new Error(`invalid argument: ${argv[index]}`);
    const value = argv[++index];
    if (!path.isAbsolute(value)) throw new Error(`${argv[index - 1]} must be absolute`);
    result[key] = path.normalize(value);
  }
  if (!result.reviewRoot || !result.isolationRoot || !result.toolchainIdentity || !result.output) {
    throw new Error('report and toolchain identity paths required');
  }
  return result;
}

async function regularJson(file) {
  const bytes = await regularFileBytes(file, 'contract evidence');
  return { bytes, value: JSON.parse(bytes) };
}

async function trustedFixtureManifest(file = DEFAULT_FIXTURE_MANIFEST) {
  const fixtureRoot = await realpath(path.dirname(DEFAULT_FIXTURE_MANIFEST));
  const canonical = await realpath(file);
  const expected = path.join(fixtureRoot, path.basename(DEFAULT_FIXTURE_MANIFEST));
  if (canonical !== expected) throw new Error('fixture manifest escaped the repository-owned fixture identity');
  const bytes = await regularFileBytes(file, 'fixture manifest');
  return { bytes, sha256: digest(bytes) };
}

async function regularFileBytes(file, label) {
  const before = await lstat(file);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    const current = await lstat(file);
    if (!opened.isFile() || current.isSymbolicLink() || !current.isFile()
      || opened.dev !== before.dev || opened.ino !== before.ino
      || current.dev !== opened.dev || current.ino !== opened.ino) {
      throw new Error(`${label} changed during validation`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function assertSha256(value, label) {
  if (!SHA256.test(value)) throw new Error(`${label} SHA-256 invalid`);
}

export function buildWindowsContractReport({
  reviewDecision, reviewResultsSha256, reviewMetricsSha256, reviewEvidenceBinding,
  reviewRendererProvenanceSha256, fixtureManifestSha256,
  verifiedRendererEnvironmentSha256, isolationDecision, isolationResultsSha256,
  peakRssBytes, completionSha256,
  toolchainIdentity, toolchainIdentityFileSha256
}) {
  if (!['CONDITIONAL_GO', 'GO'].includes(reviewDecision)) throw new Error('review decision invalid');
  if (isolationDecision !== 'GO') throw new Error('isolation decision invalid');
  if (!Number.isSafeInteger(peakRssBytes) || peakRssBytes <= 0) throw new Error('peak RSS invalid');
  for (const [label, value] of [
    ['review results', reviewResultsSha256], ['review metrics', reviewMetricsSha256],
    ['review renderer provenance', reviewRendererProvenanceSha256],
    ['fixture manifest', fixtureManifestSha256],
    ['verified renderer environment', verifiedRendererEnvironmentSha256],
    ['review evidence binding', reviewEvidenceBinding?.canonical_sha256], ['isolation results', isolationResultsSha256],
    ['trusted completion', completionSha256], ['toolchain identity file', toolchainIdentityFileSha256]
  ]) assertSha256(value, label);
  if (reviewEvidenceBinding.schema_id !== 'superwagie.standard-review-evidence-binding.v2'
    || reviewEvidenceBinding.schema_version !== 2
    || reviewEvidenceBinding.files?.result_sha256 !== reviewResultsSha256
    || reviewEvidenceBinding.files?.metrics_sha256 !== reviewMetricsSha256
    || reviewEvidenceBinding.files?.completion_sha256 !== completionSha256
    || reviewEvidenceBinding.files?.renderer_provenance_sha256 !== reviewRendererProvenanceSha256
    || reviewEvidenceBinding.trusted_expected?.fixture_manifest_sha256 !== fixtureManifestSha256
    || reviewEvidenceBinding.trusted_expected?.renderer_environment_sha256 !== verifiedRendererEnvironmentSha256
    || reviewEvidenceBinding.trusted_expected?.renderer_provenance_sha256 !== reviewRendererProvenanceSha256
    || reviewEvidenceBinding.result?.decision !== reviewDecision) {
    throw new Error('review evidence binding invalid');
  }
  validateToolchainIdentity(toolchainIdentity);
  return {
    schema_id: 'superwagie.office-reviewer-windows-contract-report.v4',
    schema_version: 4,
    platform: 'windows-11-x64',
    runner: 'windows-2022',
    controlled_fake_wps: true,
    real_wps_started: false,
    toolchain_identity: toolchainIdentity,
    toolchain_identity_file_sha256: toolchainIdentityFileSha256,
    standard_review_executor: {
      decision: reviewDecision,
      results_sha256: reviewResultsSha256,
      metrics_sha256: reviewMetricsSha256,
      renderer_provenance_sha256: reviewRendererProvenanceSha256,
      fixture_manifest_sha256: fixtureManifestSha256,
      verified_renderer_environment_sha256: verifiedRendererEnvironmentSha256,
      evidence_binding: reviewEvidenceBinding
    },
    standard_isolation_executor: { decision: isolationDecision, results_sha256: isolationResultsSha256 },
    trusted_completion: { source: 'trusted-native-host', peak_rss_bytes: peakRssBytes, completion_sha256: completionSha256 },
    acceptance_boundary: 'executable-contract-only-task-10-real-windows-evidence-required'
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = parse(argv);
  const reviewResult = await regularJson(path.join(args.reviewRoot, 'results.json'));
  const reviewMetrics = await regularJson(path.join(args.reviewRoot, 'artifacts/review-automation-metrics.json'));
  const reviewCompletion = await regularJson(path.join(args.reviewRoot, 'artifacts/automation-complete.json'));
  const reviewRendererProvenance = await regularJson(path.join(args.reviewRoot, 'artifacts/renderer-provenance.json'));
  const fixtureManifest = await trustedFixtureManifest(args.fixtureManifest);
  const verifiedRenderer = validateRendererProvenanceDocument(reviewRendererProvenance.value, {
    platform: 'windows-11-x64', representative: true
  });
  const validatedReview = validateStandardReviewEvidence({
    result: reviewResult.value,
    metrics: reviewMetrics.value,
    completion: reviewCompletion.value
  }, {
    fixture: 'G3-REVIEW-001',
    manifestSha256: fixtureManifest.sha256,
    rendererEnvironmentSha256: verifiedRenderer.rendererEnvironmentSha256
  });
  const reviewResultsSha256 = digest(reviewResult.bytes);
  const reviewMetricsSha256 = digest(reviewMetrics.bytes);
  const completionSha256 = digest(reviewCompletion.bytes);
  const reviewRendererProvenanceSha256 = digest(reviewRendererProvenance.bytes);
  const reviewEvidenceBinding = buildStandardReviewEvidenceBinding({
    validated: validatedReview,
    resultSha256: reviewResultsSha256,
    metricsSha256: reviewMetricsSha256,
    completionSha256,
    rendererProvenanceSha256: reviewRendererProvenanceSha256
  });
  const isolationPath = path.join(args.isolationRoot, 'results.json');
  const isolationResult = await regularJson(isolationPath);
  const isolation = await validateIsolationEvidence(isolationPath, args.isolationRoot, {
    scenario: 'codex-never-installed', platform: 'windows-11-x64'
  });
  if (isolation.pass !== true || isolation.decision_hint !== 'GO') throw new Error('standard isolation evidence did not complete');

  const toolchain = await regularJson(args.toolchainIdentity);
  validateToolchainIdentity(toolchain.value, {
    packageLockSha256: digest(await readFile(path.join(repo, 'scripts/poc/gate-3/package-lock.json'))),
    cargoLockSha256: digest(await readFile(path.join(repo, 'scripts/poc/gate-3/reviewer-shell/Cargo.lock')))
  });
  const report = buildWindowsContractReport({
    reviewDecision: validatedReview.decision,
    reviewResultsSha256,
    reviewMetricsSha256,
    reviewEvidenceBinding,
    reviewRendererProvenanceSha256,
    fixtureManifestSha256: fixtureManifest.sha256,
    verifiedRendererEnvironmentSha256: verifiedRenderer.rendererEnvironmentSha256,
    isolationDecision: isolation.decision_hint,
    isolationResultsSha256: digest(isolationResult.bytes),
    peakRssBytes: validatedReview.peakRssBytes,
    completionSha256,
    toolchainIdentity: toolchain.value,
    toolchainIdentityFileSha256: digest(toolchain.bytes)
  });
  await mkdir(path.dirname(args.output), { recursive: true });
  await writeFile(args.output, `${JSON.stringify(report, null, 2)}\n`);
  console.log('windows-ci-report: standard review/renderer/isolation/trusted completion/toolchain contract verified');
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  await main();
}

export { main, trustedFixtureManifest };
