#!/usr/bin/env node

import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateReceiptBundle } from './universal-viewer/gvp-0-gate.mjs';
import { auditViewerReceiptBindings, createSafeReceiptResolver } from './viewer-ledger-audit.mjs';

const MACOS = 'macos-15-arm64';
const WINDOWS = 'windows-11-x64';
const GVP0_BLOCKED_REASON = Object.freeze({
  code: 'GVP0_LIVE_AUDIT_UNAVAILABLE',
  error: 'poc-production-audit did not complete within the bounded environment contract',
  exit_code: 2,
});
const GVP0_REVIEWED_ATTEMPTS_ROOT = 'fixtures/gvp-0/GVP-0-CORE-001/environment-attempts';
const GVP0_ATTEMPT_ROLES = Object.freeze([
  ['manifest', 'manifest.json'],
  ['environment', 'environment.json'],
  ['command', 'command.txt'],
  ['stderr', 'stderr.log'],
  ['stdout', 'stdout.log'],
  ['decision', 'decision.md'],
  ['results', 'results.json'],
  ['evidence_manifest', 'artifacts/evidence-manifest.json'],
  ['acceptance_summary', 'artifacts/acceptance-summary.json'],
]);
const PLATFORM_IDENTITIES = Object.freeze({
  [MACOS]: Object.freeze({ os: 'darwin', arch: 'arm64' }),
  [WINDOWS]: Object.freeze({ os: 'win32', arch: 'x64' }),
});

function fixture(gate, id, requiredPlatforms = [], evidenceRevision = null) {
  return Object.freeze({
    gate,
    fixture: id,
    required_platforms: requiredPlatforms,
    ...(evidenceRevision === null ? {} : { evidence_revision: evidenceRevision }),
  });
}

const GVP_MEANINGS = Object.freeze({
  'GVP-0': 'Contract + Provenance',
  'GVP-1': 'Office Fidelity',
  'GVP-2': 'Per-format Corpus',
  'GVP-3': 'Isolation + Malicious Files',
  'GVP-4': 'Package + Performance',
  'GVP-5': 'Product Integration + Recovery',
});

function viewerFixture(id) {
  return Object.freeze({
    gate: id.toLowerCase(),
    fixture: id,
    required_platforms: [MACOS, WINDOWS],
    technical_state: 'RESEARCH_REQUIRED',
    meaning: GVP_MEANINGS[id],
  });
}

const SOLUTION_B = 'solution-b-v1';

export const EXPECTED_FIXTURES = Object.freeze([
  fixture('contract-foundation', 'CF-PROTOCOL-002'),
  fixture('gate-0', 'G0-SHELL-002', [MACOS, WINDOWS]),
  fixture('gate-0', 'G0-ISOLATION-001', [MACOS, WINDOWS], SOLUTION_B),
  fixture('gate-0', 'G0-DEPS-001', [MACOS, WINDOWS], SOLUTION_B),
  fixture('gate-1', 'G1-WORKSPACE-001', [MACOS, WINDOWS]),
  fixture('gate-1', 'G1-CRASH-001', [MACOS, WINDOWS]),
  fixture('gate-1', 'G1-MARKDOWN-001', [MACOS, WINDOWS]),
  fixture('gate-1', 'G1-TASK-001'),
  fixture('gate-1', 'G1-DIAGRAM-001', [MACOS, WINDOWS]),
  fixture('gate-2', 'G2-THREAD-001', [], SOLUTION_B),
  fixture('gate-2', 'G2-AGENT-001'),
  fixture('gate-2', 'G2-WORKFLOW-001', [], SOLUTION_B),
  fixture('gate-2', 'G2-HOST-001', [], SOLUTION_B),
  fixture('gate-2', 'G2-CONTINUITY-001'),
  fixture('gate-3', 'G3-PPT-001', [MACOS, WINDOWS]),
  fixture('gate-3', 'G3-WRITER-001', [MACOS, WINDOWS]),
  fixture('gate-3', 'G3-REVIEW-001', [MACOS, WINDOWS], SOLUTION_B),
  fixture('gate-3', 'G3-REVIEW-002', [MACOS, WINDOWS], SOLUTION_B),
  fixture('gate-3', 'G3-HTML-001', [MACOS, WINDOWS]),
  fixture('gate-4', 'G4-VIDEO-001', [MACOS, WINDOWS], SOLUTION_B),
  fixture('gate-4', 'G4-VIDEO-002', [MACOS, WINDOWS], SOLUTION_B),
  fixture('gate-4', 'G4-VIDEO-003', [MACOS, WINDOWS], SOLUTION_B),
  fixture('gate-4', 'G4-VIDEO-004', [MACOS, WINDOWS], SOLUTION_B),
  fixture('gate-4', 'G4-VIDEO-005', [MACOS, WINDOWS], SOLUTION_B),
  fixture('gate-5', 'G5-EXT-001', [MACOS, WINDOWS], SOLUTION_B),
  fixture('gate-5', 'G5-ATTACK-001', [MACOS, WINDOWS], SOLUTION_B),
  fixture('gate-5', 'G5-FACADE-001', [], SOLUTION_B),
  fixture('gate-5', 'G5-CONNECTOR-001'),
  fixture('gate-5', 'G5-MEMORY-001'),
  fixture('gate-6', 'G6-BILLING-001'),
  fixture('gate-6', 'G6-PACKAGE-001', [MACOS, WINDOWS], SOLUTION_B),
  viewerFixture('GVP-0'),
  viewerFixture('GVP-1'),
  viewerFixture('GVP-2'),
  viewerFixture('GVP-3'),
  viewerFixture('GVP-4'),
  viewerFixture('GVP-5'),
]);

function readJsonFile(path) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('evidence document must be a regular non-symlink file');
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readRegularFile(path) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('attempt artifact must be a regular non-symlink file');
  }
  return readFileSync(path);
}

function hasExactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function repoRelative(root, path) {
  return relative(root, path).split('\\').join('/');
}

function sha256Binding(role, repoRoot, path) {
  const bytes = readRegularFile(path);
  return {
    role,
    path: repoRelative(repoRoot, path),
    sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  };
}

function validateGvp0BlockedEnvironmentAttempt(repoRoot, runDirectory, runId) {
  try {
    const reviewedRoot = resolve(repoRoot, GVP0_REVIEWED_ATTEMPTS_ROOT);
    const runMetadata = lstatSync(runDirectory);
    if (!runMetadata.isDirectory() || runMetadata.isSymbolicLink()
      || !isContained(reviewedRoot, runDirectory)
      || relative(reviewedRoot, runDirectory) !== runId
      || !isContained(realpathSync(reviewedRoot), realpathSync(runDirectory))) return null;
    const paths = Object.freeze(Object.fromEntries(
      GVP0_ATTEMPT_ROLES.map(([role, path]) => [role, resolve(runDirectory, path)]),
    ));
    const indexPath = resolve(runDirectory, 'index.json');
    const trackedPaths = [indexPath, ...GVP0_ATTEMPT_ROLES.map(([, path]) => resolve(runDirectory, path))]
      .map((path) => repoRelative(repoRoot, path))
      .sort();
    const tracked = spawnSync('git', ['-C', repoRoot, 'ls-files', '--', ...trackedPaths], { encoding: 'utf8' });
    const actualTracked = tracked.status === 0
      ? tracked.stdout.split(/\r?\n/u).filter(Boolean).sort()
      : [];
    if (JSON.stringify(actualTracked) !== JSON.stringify(trackedPaths)) return null;
    const indexBytes = readRegularFile(indexPath);
    const index = JSON.parse(indexBytes.toString('utf8'));
    if (!hasExactKeys(index, [
      'schema_id', 'schema_version', 'gate_id', 'fixture', 'platform_id', 'run_id',
      'review_state', 'execution', 'exit_code', 'reason_code', 'receipt', 'artifacts',
    ]) || index.schema_id !== 'superwagie.gvp0-reviewed-environment-attempt.v1'
      || index.schema_version !== 1 || index.gate_id !== 'GVP-0'
      || index.fixture !== 'GVP-0-CORE-001' || !PLATFORM_IDENTITIES[index.platform_id]
      || index.run_id !== runId || index.review_state !== 'repository_reviewed_observation'
      || index.execution !== 'BLOCKED_ENVIRONMENT' || index.exit_code !== 2
      || index.reason_code !== GVP0_BLOCKED_REASON.code || index.receipt !== null
      || !Array.isArray(index.artifacts) || index.artifacts.length !== GVP0_ATTEMPT_ROLES.length) return null;
    for (const [position, [role, path]] of GVP0_ATTEMPT_ROLES.entries()) {
      const binding = index.artifacts[position];
      if (!hasExactKeys(binding, ['role', 'path', 'sha256']) || binding.role !== role || binding.path !== path
        || !/^sha256:[a-f0-9]{64}$/u.test(binding.sha256)) return null;
      const artifactPath = paths[role];
      if (!isContained(runDirectory, artifactPath)
        || !isContained(realpathSync(runDirectory), realpathSync(artifactPath))) return null;
      const actual = `sha256:${createHash('sha256').update(readRegularFile(artifactPath)).digest('hex')}`;
      if (binding.sha256 !== actual) return null;
    }
    const manifestBytes = readRegularFile(paths.manifest);
    const environmentBytes = readRegularFile(paths.environment);
    const commandBytes = readRegularFile(paths.command);
    const stderrBytes = readRegularFile(paths.stderr);
    const stdoutBytes = readRegularFile(paths.stdout);
    const decisionBytes = readRegularFile(paths.decision);
    const resultsBytes = readRegularFile(paths.results);
    const evidenceManifestBytes = readRegularFile(paths.evidence_manifest);
    const acceptanceSummaryBytes = readRegularFile(paths.acceptance_summary);

    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    const environment = JSON.parse(environmentBytes.toString('utf8'));
    const stderr = JSON.parse(stderrBytes.toString('utf8'));
    if (!hasExactKeys(manifest, ['gate', 'fixture', 'platform', 'run_id', 'operator', 'started_at', 'finished_at'])) return null;
    const startedAt = Date.parse(manifest.started_at);
    const finishedAt = Date.parse(manifest.finished_at);
    if (manifest.gate !== 'gvp-0' || manifest.fixture !== 'GVP-0-CORE-001'
      || manifest.platform !== index.platform_id || manifest.run_id !== runId
      || manifest.operator !== 'repository-review'
      || !Number.isFinite(startedAt) || !Number.isFinite(finishedAt)
      || finishedAt < startedAt) return null;
    const expectedIdentity = PLATFORM_IDENTITIES[index.platform_id];
    if (!hasExactKeys(environment, ['os', 'arch', 'release', 'node', 'captured_at'])
      || environment.os !== expectedIdentity.os || environment.arch !== expectedIdentity.arch
      || !/^[A-Za-z0-9._-]+$/u.test(environment.release || '')
      || /^0(?:\.0)*$/u.test(environment.release)
      || !/^\d+\.\d+\.\d+$/u.test(environment.node || '')
      || environment.captured_at !== manifest.started_at) return null;
    if (!hasExactKeys(stderr, ['code', 'error'])
      || stderr.code !== GVP0_BLOCKED_REASON.code || stderr.error !== GVP0_BLOCKED_REASON.error) return null;
    const command = commandBytes.toString('utf8');
    if (!new RegExp(`^gate:gvp-0 platform:${index.platform_id} fixture:GVP-0-CORE-001 candidate-root-sha256:[a-f0-9]{64}\\n$`, 'u').test(command)) return null;
    const decision = decisionBytes.toString('utf8');
    const requiredDecisionLines = [
      '# Decision (draft)',
      '- gate: GVP-0',
      '- fixture: GVP-0-CORE-001',
      `- platform: ${index.platform_id}`,
      '- evidence_sha256: unavailable',
      '- outcome: verification failed',
      '- draft decision: BLOCKED_ENVIRONMENT (待所有者角色签署后生效)',
      `- limitation: ${GVP0_BLOCKED_REASON.error}`,
    ];
    const decisionLines = decision.split(/\r?\n/u).filter((line) => line.length > 0);
    const optionalDecisionLine = '签署规则见 docs/技术可行性/技术验证执行计划.md §7。';
    const exactDecision = [...requiredDecisionLines];
    if (decisionLines.at(-1) === optionalDecisionLine) exactDecision.push(optionalDecisionLine);
    if (JSON.stringify(decisionLines) !== JSON.stringify(exactDecision)
      || /signed decision:/iu.test(decision)) return null;
    if (stdoutBytes.length !== 0 || resultsBytes.length !== 0
      || evidenceManifestBytes.length !== 0 || acceptanceSummaryBytes.length !== 0) return null;

    return {
      run_id: runId,
      gate_id: 'GVP-0',
      fixture: 'GVP-0-CORE-001',
      platform_id: index.platform_id,
      execution: 'BLOCKED_ENVIRONMENT',
      exit_code: GVP0_BLOCKED_REASON.exit_code,
      exit_code_source: 'public-runner-contract',
      reason_code: GVP0_BLOCKED_REASON.code,
      limitation: GVP0_BLOCKED_REASON.error,
      started_at: manifest.started_at,
      finished_at: manifest.finished_at,
      receipt: null,
      bundle: repoRelative(repoRoot, runDirectory),
      index_sha256: `sha256:${createHash('sha256').update(indexBytes).digest('hex')}`,
      artifacts: GVP0_ATTEMPT_ROLES.map(([role]) => sha256Binding(role, repoRoot, paths[role])),
    };
  } catch {
    return null;
  }
}

function reviewedGvp0BlockedEnvironmentAttempts(repoRoot) {
  const gateRoot = resolve(repoRoot, GVP0_REVIEWED_ATTEMPTS_ROOT);
  let entries;
  try {
    entries = readdirSync(gateRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .sort((left, right) => right.name.localeCompare(left.name))
    .map((entry) => validateGvp0BlockedEnvironmentAttempt(repoRoot, resolve(gateRoot, entry.name), entry.name))
    .filter(Boolean);
}

function latestGvp0BlockedEnvironmentAttempt(repoRoot) {
  return reviewedGvp0BlockedEnvironmentAttempts(repoRoot).at(0) ?? null;
}

function isContained(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('../') && rel !== '..' && !isAbsolute(rel));
}

export function verifyEvidenceArtifactBindings(resultsPath) {
  const errors = [];
  let results;
  try {
    results = readJsonFile(resultsPath);
  } catch (error) {
    return { valid: false, errors: [`results invalid: ${error.message}`], bindings_checked: 0 };
  }
  const evidenceRoot = resolve(dirname(resultsPath));
  let realEvidenceRoot;
  try {
    realEvidenceRoot = realpathSync(evidenceRoot);
  } catch (error) {
    return { valid: false, errors: [`evidence root invalid: ${error.message}`], bindings_checked: 0 };
  }
  const bindings = Object.entries(results)
    .filter(([key, value]) => key.endsWith('_evidence') && value && typeof value === 'object' && !Array.isArray(value));
  for (const [key, binding] of bindings) {
    if (typeof binding.artifact !== 'string' || binding.artifact.length === 0 || isAbsolute(binding.artifact)) {
      errors.push(`${key} artifact path must be a relative non-empty path`);
      continue;
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(binding.sha256 || '')) {
      errors.push(`${key} sha256 is invalid`);
      continue;
    }
    const artifactPath = resolve(evidenceRoot, binding.artifact);
    if (!isContained(evidenceRoot, artifactPath)) {
      errors.push(`${key} artifact escapes evidence directory`);
      continue;
    }
    try {
      const metadata = lstatSync(artifactPath);
      if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error('artifact must be a regular non-symlink file');
      const realArtifactPath = realpathSync(artifactPath);
      if (!isContained(realEvidenceRoot, realArtifactPath)) throw new Error('artifact realpath escapes evidence directory');
      const actual = `sha256:${createHash('sha256').update(readFileSync(realArtifactPath)).digest('hex')}`;
      if (actual !== binding.sha256) throw new Error(`artifact hash mismatch: expected ${binding.sha256}, got ${actual}`);
    } catch (error) {
      errors.push(`${key} ${error.message}`);
    }
  }
  let writerBindingsChecked = 0;
  const isWriterResult = results.schema_id === 'superwagie.g3-writer-gate-result.v1'
    && results.schema_version === 1 && results.fixture === 'G3-WRITER-001';
  const writerManifest = results.evidence_binding?.artifacts;
  if (isWriterResult && results.decision_hint === 'GO' && !Array.isArray(writerManifest)) {
    errors.push('Writer GO requires a complete published artifact manifest');
  }
  if (isWriterResult && Array.isArray(writerManifest)) {
    const expectedPaths = [];
    const seen = new Set();
    for (const [index, binding] of writerManifest.entries()) {
      const label = `Writer artifact manifest ${index + 1}`;
      if (!binding || typeof binding !== 'object' || Array.isArray(binding)
        || JSON.stringify(Object.keys(binding).sort()) !== JSON.stringify(['path', 'sha256'])) {
        errors.push(`${label} keys must be exactly path,sha256`); continue;
      }
      if (typeof binding.path !== 'string' || binding.path.length === 0 || isAbsolute(binding.path)
        || binding.path.split(/[\\/]/).some((part) => part === '' || part === '.' || part === '..')) {
        errors.push(`${label} path must be a contained relative path`); continue;
      }
      if (!/^[a-f0-9]{64}$/.test(binding.sha256 || '')) { errors.push(`${label} sha256 is invalid`); continue; }
      if (seen.has(binding.path)) { errors.push(`${label} path is duplicated`); continue; }
      seen.add(binding.path); expectedPaths.push(binding.path);
      const artifactPath = resolve(evidenceRoot, binding.path);
      if (!isContained(evidenceRoot, artifactPath)) { errors.push(`${label} escapes evidence directory`); continue; }
      try {
        const metadata = lstatSync(artifactPath);
        if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error('must be a regular non-symlink file');
        const realArtifactPath = realpathSync(artifactPath);
        if (!isContained(realEvidenceRoot, realArtifactPath)) throw new Error('realpath escapes evidence directory');
        const actual = createHash('sha256').update(readFileSync(realArtifactPath)).digest('hex');
        if (actual !== binding.sha256) throw new Error(`hash mismatch: expected ${binding.sha256}, got ${actual}`);
        writerBindingsChecked += 1;
      } catch (error) { errors.push(`${label} ${error.message}`); }
    }
    const sortedPaths = [...expectedPaths].sort();
    if (JSON.stringify(expectedPaths) !== JSON.stringify(sortedPaths)) errors.push('Writer artifact manifest paths must be sorted');
    const declaredSetHash = createHash('sha256').update(JSON.stringify(writerManifest)).digest('hex');
    if (results.evidence_binding?.artifact_set_sha256 !== declaredSetHash) errors.push('Writer artifact manifest set hash mismatch');
    const artifactRoots = new Set(sortedPaths.map((path) => path.split('/')[0]));
    if (artifactRoots.size !== 1) errors.push('Writer artifact manifest must use exactly one publication root');
    const artifactsRoot = resolve(evidenceRoot, [...artifactRoots][0] ?? 'artifacts');
    const actualPaths = [];
    const walk = (directory) => {
      const directoryStat = lstatSync(directory);
      if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) throw new Error('Writer artifacts root contains a non-directory or symlink');
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const child = resolve(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`Writer artifacts contain symlink: ${relative(evidenceRoot, child)}`);
        if (entry.isDirectory()) walk(child);
        else if (entry.isFile()) actualPaths.push(relative(evidenceRoot, child));
        else throw new Error(`Writer artifacts contain a non-regular entry: ${relative(evidenceRoot, child)}`);
      }
    };
    try {
      walk(artifactsRoot);
      actualPaths.sort();
      if (JSON.stringify(actualPaths) !== JSON.stringify(sortedPaths)) errors.push('Writer artifact manifest does not exactly match published artifacts (missing or extra file)');
    } catch (error) { errors.push(error.message); }
  }
  return { valid: errors.length === 0, errors, bindings_checked: bindings.length + writerBindingsChecked };
}

function arraysOfStrings(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
}

function executionFromResult(result) {
  if (typeof result.verdict === 'string') {
    if (result.verdict === 'GO') return 'go';
    if (result.verdict === 'CONDITIONAL_GO') return 'conditional_go';
    if (result.verdict === 'NO_GO') return 'no_go';
    if (result.verdict === 'BLOCKED_ENVIRONMENT') return 'blocked_environment';
    throw new Error('Viewer receipt verdict is not recognized');
  }
  if (typeof result.pass !== 'boolean') {
    throw new Error('pass must be boolean');
  }
  const hint = result.decision_hint;
  if (hint !== undefined && !['GO', 'CONDITIONAL_GO', 'NO_GO', 'BLOCKED_ENVIRONMENT'].includes(hint)) {
    throw new Error('decision_hint is not recognized');
  }
  if (result.pass) {
    if (hint === 'NO_GO' || hint === 'BLOCKED_ENVIRONMENT') {
      throw new Error('passing evidence has a failing decision_hint');
    }
    return hint === 'CONDITIONAL_GO' ? 'conditional_go' : 'go';
  }
  if (hint === 'BLOCKED_ENVIRONMENT' || result.status === 'blocked') return 'blocked_environment';
  return 'no_go';
}

function readSignedDecision(path, { gate, fixture, platform, resultsPath }) {
  try {
    const text = readFileSync(path, 'utf8');
    const resultsBytes = readFileSync(resultsPath);
    const evidenceSha256 = `sha256:${createHash('sha256').update(resultsBytes).digest('hex')}`;
    const decision = /^- signed decision: GO$/m.test(text);
    const role = /^- owner role: \S.+$/m.test(text);
    const timestamp = /^- signed_at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/m.test(text);
    const gateBinding = text.includes(`- gate: ${gate}`);
    const fixtureBinding = text.includes(`- fixture: ${fixture}`);
    const platformBinding = typeof platform === 'string' && text.includes(`- platform: ${platform}`);
    const evidenceBinding = text.includes(`- evidence_sha256: ${evidenceSha256}`);
    return decision && role && timestamp && gateBinding && fixtureBinding && platformBinding && evidenceBinding;
  } catch {
    return false;
  }
}

function candidateRuns(repoRoot, expected) {
  const gateRoot = resolve(repoRoot, 'evidence', expected.gate);
  let entries;
  try {
    entries = readdirSync(gateRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const resultsPath = resolve(gateRoot, entry.name, 'results.json');
    try {
      const result = readJsonFile(resultsPath);
      const fixtureIdentity = expected.technical_state === 'RESEARCH_REQUIRED'
        ? result.gate_id
        : result.fixture;
      if (fixtureIdentity === expected.fixture) {
        candidates.push({ run: entry.name, resultsPath, result });
      }
    } catch {
      // A malformed file without a readable fixture cannot be attributed safely.
    }
  }
  return candidates.sort((left, right) => left.run.localeCompare(right.run));
}

function platformForRun(repoRoot, resultsPath, result) {
  const normalize = (platform) => platform === 'macos-arm64' ? MACOS : platform;
  if (typeof result.platform_id === 'string') return normalize(result.platform_id);
  if (typeof result.platform === 'string') return normalize(result.platform);
  const manifestPath = resolve(resultsPath, '..', 'manifest.json');
  try {
    const manifest = readJsonFile(manifestPath);
    return typeof manifest.platform === 'string' ? normalize(manifest.platform) : null;
  } catch {
    return null;
  }
}

function validateCandidate(expected, candidate, repoRoot) {
  try {
    if (expected.technical_state === 'RESEARCH_REQUIRED') {
      if (candidate.result.gate_id !== expected.fixture) {
        throw new Error(`Viewer gate mismatch: expected ${expected.fixture}, got ${candidate.result.gate_id}`);
      }
      const receiptValidation = validateReceiptBundle({ resultsPath: candidate.resultsPath, repoRoot });
      if (!receiptValidation.valid) throw new Error(`Viewer receipt invalid: ${receiptValidation.errors.join('; ')}`);
      return { execution: executionFromResult(candidate.result), error: null };
    }
    if (candidate.result.gate !== expected.gate) {
      throw new Error(`gate mismatch: expected ${expected.gate}, got ${candidate.result.gate}`);
    }
    if (candidate.result.fixture !== expected.fixture) {
      throw new Error(`fixture mismatch: expected ${expected.fixture}, got ${candidate.result.fixture}`);
    }
    const artifactBindings = verifyEvidenceArtifactBindings(candidate.resultsPath);
    if (!artifactBindings.valid) throw new Error(`artifact binding invalid: ${artifactBindings.errors.join('; ')}`);
    return { execution: executionFromResult(candidate.result), error: null };
  } catch (error) {
    return { execution: 'invalid_evidence', error: error instanceof Error ? error.message : String(error) };
  }
}

function auditFixture(repoRoot, expected) {
  const allCandidates = candidateRuns(repoRoot, expected);
  const blockedEnvironmentAttempts = expected.fixture === 'GVP-0'
    ? reviewedGvp0BlockedEnvironmentAttempts(repoRoot)
    : [];
  const blockedEnvironmentAttempt = blockedEnvironmentAttempts.at(0) ?? null;
  const latestReceiptRun = allCandidates.at(-1)?.run ?? null;
  if (blockedEnvironmentAttempt !== null
    && (latestReceiptRun === null || blockedEnvironmentAttempt.run_id.localeCompare(latestReceiptRun) > 0)) {
    const latestByPlatform = new Map();
    for (const attempt of blockedEnvironmentAttempts) {
      if (!latestByPlatform.has(attempt.platform_id)) latestByPlatform.set(attempt.platform_id, attempt);
    }
    const environmentAttempts = [...latestByPlatform.values()]
      .sort((left, right) => left.platform_id.localeCompare(right.platform_id));
    const platformsSeen = [...latestByPlatform.keys()].sort();
    return {
      ...expected,
      execution: 'blocked_environment',
      admission: 'not_ready',
      evidence: null,
      receipt: null,
      latest_attempt: blockedEnvironmentAttempt,
      environment_attempts: environmentAttempts,
      superseded_evidence: [],
      platforms_seen: platformsSeen,
      platforms_go: [],
      platforms_signed: [],
      missing_platforms: expected.required_platforms.filter((platform) => !platformsSeen.includes(platform)),
      platforms_without_go: [MACOS, WINDOWS],
      reasons: [blockedEnvironmentAttempt.reason_code],
      limitations: [blockedEnvironmentAttempt.limitation],
    };
  }
  if (expected.technical_state === 'RESEARCH_REQUIRED' && allCandidates.length === 0) {
    if (expected.fixture !== 'GVP-0') {
      return {
        gate: 'universal-viewer',
        fixture: expected.fixture,
        required_platforms: [...expected.required_platforms],
        technical_state: expected.technical_state,
        execution: 'research_required',
        admission: 'not_ready',
        evidence: null,
        admission_scope: 'universal-viewer-only',
        meaning: expected.meaning,
      };
    }
    return {
      ...expected,
      execution: 'research_required',
      admission: 'not_ready',
      evidence: null,
      superseded_evidence: [],
      platforms_seen: [],
      platforms_go: [],
      platforms_signed: [],
      missing_platforms: [...expected.required_platforms],
      platforms_without_go: [...expected.required_platforms],
      reasons: ['GVP_EVIDENCE_NOT_YET_ADMITTED'],
      limitations: ['Old G3-REVIEW evidence is historical and cannot satisfy Universal Viewer admission.'],
    };
  }
  const candidates = expected.evidence_revision === undefined
    ? allCandidates
    : allCandidates.filter(({ result }) => result.evidence_revision === expected.evidence_revision);
  const superseded = expected.evidence_revision === undefined
    ? []
    : allCandidates.filter(({ result }) => result.evidence_revision !== expected.evidence_revision);
  const supersededEvidence = superseded.map(({ run, resultsPath, result }) => ({
    run,
    evidence: relative(repoRoot, resultsPath),
    evidence_revision: typeof result.evidence_revision === 'string'
      ? result.evidence_revision
      : null,
  }));
  if (candidates.length === 0) {
    return {
      ...expected,
      execution: superseded.length > 0 ? 'superseded_evidence' : 'missing',
      admission: 'not_ready',
      evidence: null,
      superseded_evidence: supersededEvidence,
      platforms_seen: [],
      platforms_go: [],
      platforms_signed: [],
      missing_platforms: [...expected.required_platforms],
      platforms_without_go: [...expected.required_platforms],
      reasons: [],
      limitations: [],
      ...(expected.fixture === 'G3-REVIEW-001' || expected.fixture === 'G3-REVIEW-002'
        ? { admission_scope: 'historical-g3-review-only' } : {}),
    };
  }

  const latest = candidates.at(-1);
  const latestByPlatform = new Map();
  for (const candidate of candidates) {
    const platform = platformForRun(repoRoot, candidate.resultsPath, candidate.result);
    if (platform) latestByPlatform.set(platform, candidate);
  }
  const platformCandidates = [...latestByPlatform.entries()]
    .map(([platform, candidate]) => ({ platform, ...candidate, validation: validateCandidate(expected, candidate, repoRoot) }));
  const platformsSeen = [...latestByPlatform.keys()].sort();
  const platformsGo = platformCandidates
    .filter(({ validation }) => validation.execution === 'go')
    .map(({ platform }) => platform)
    .sort();
  const platformsSigned = platformCandidates
    .filter(({ platform, resultsPath, validation }) => {
      return expected.technical_state !== 'RESEARCH_REQUIRED' && validation.execution === 'go' &&
        readSignedDecision(resolve(resultsPath, '..', 'decision.md'), {
          gate: expected.gate, fixture: expected.fixture, platform, resultsPath,
        });
    })
    .map(({ platform }) => platform)
    .sort();
  const missingPlatforms = expected.required_platforms.filter((platform) => !platformsSeen.includes(platform));
  const platformsWithoutGo = expected.required_platforms.filter((platform) => !platformsGo.includes(platform));

  const latestValidation = validateCandidate(expected, latest, repoRoot);
  const execution = latestValidation.execution;
  const validationError = latestValidation.error;

  const decisionPath = resolve(latest.resultsPath, '..', 'decision.md');
  const latestPlatform = platformForRun(repoRoot, latest.resultsPath, latest.result);
  const requiredPlatformsSigned = expected.required_platforms.length > 0
    ? expected.required_platforms.every((platform) => platformsSigned.includes(platform))
    : readSignedDecision(decisionPath, {
      gate: expected.gate, fixture: expected.fixture, platform: latestPlatform,
      resultsPath: latest.resultsPath,
    });
  const signed = execution === 'go' && platformsWithoutGo.length === 0 && requiredPlatformsSigned;
  let admission = 'not_ready';
  if (execution === 'go' && expected.technical_state !== 'RESEARCH_REQUIRED') admission = signed ? 'signed_go' : 'unsigned';

  return {
    ...expected,
    execution,
    admission,
    evidence: relative(repoRoot, latest.resultsPath),
    superseded_evidence: supersededEvidence,
    platforms_seen: platformsSeen,
    platforms_go: platformsGo,
    platforms_signed: platformsSigned,
    missing_platforms: missingPlatforms,
    platforms_without_go: platformsWithoutGo,
    reasons: arraysOfStrings(latest.result.reasons),
    limitations: arraysOfStrings(latest.result.limitations).length > 0
      ? arraysOfStrings(latest.result.limitations)
      : typeof latest.result.limitation === 'string' && latest.result.limitation.length > 0
        ? [latest.result.limitation]
        : [],
    ...(validationError === null ? {} : { validation_error: validationError }),
    ...(expected.fixture === 'G3-REVIEW-001' || expected.fixture === 'G3-REVIEW-002'
      ? { admission_scope: 'historical-g3-review-only' } : {}),
  };
}

const STATUS_ROOT_KEYS = Object.freeze([
  'schema_id', 'schema_version', 'generated_at', 'production_implementation_admission',
  'summary', 'format_admission_ledger', 'fixtures',
]);
const STATUS_SUMMARY_KEYS = Object.freeze([
  'expected', 'go', 'conditional_go', 'no_go', 'blocked_environment', 'invalid_evidence',
  'superseded_evidence', 'research_required', 'missing', 'signed_go',
]);
const STATUS_LEDGER_KEYS = Object.freeze([
  'records', 'research_required', 'complete_record_receipts', 'invalid_receipt_refs', 'release_admission',
]);
const STATUS_ARRAY_FIELDS = Object.freeze([
  'required_platforms', 'platforms_seen', 'platforms_go', 'platforms_signed',
  'missing_platforms', 'platforms_without_go', 'reasons', 'limitations',
]);
const STATUS_EXECUTIONS = new Set([
  'go', 'conditional_go', 'no_go', 'blocked_environment', 'invalid_evidence',
  'superseded_evidence', 'research_required', 'missing',
]);
const STATUS_ADMISSIONS = new Set(['signed_go', 'unsigned', 'not_ready']);

function validateAttemptProjectionShape(attempt, label, { allowLegacy = false } = {}) {
  const baseKeys = [
    'run_id', 'gate_id', 'fixture', 'platform_id', 'execution', 'exit_code', 'exit_code_source',
    'reason_code', 'limitation', 'started_at', 'finished_at', 'receipt', 'artifacts',
  ];
  const expectedKeys = allowLegacy && !Object.hasOwn(attempt ?? {}, 'bundle')
    ? baseKeys
    : [...baseKeys, 'bundle', 'index_sha256'];
  if (!hasExactKeys(attempt, expectedKeys) || typeof attempt.run_id !== 'string'
    || attempt.gate_id !== 'GVP-0' || attempt.fixture !== 'GVP-0-CORE-001'
    || !PLATFORM_IDENTITIES[attempt.platform_id] || attempt.execution !== 'BLOCKED_ENVIRONMENT'
    || attempt.exit_code !== 2 || attempt.exit_code_source !== 'public-runner-contract'
    || attempt.reason_code !== GVP0_BLOCKED_REASON.code || attempt.limitation !== GVP0_BLOCKED_REASON.error
    || !Number.isFinite(Date.parse(attempt.started_at)) || !Number.isFinite(Date.parse(attempt.finished_at))
    || attempt.receipt !== null || !Array.isArray(attempt.artifacts) || attempt.artifacts.length !== 9) {
    throw new Error(`${label} has an invalid reviewed environment-attempt structure`);
  }
  if (!allowLegacy || Object.hasOwn(attempt, 'bundle')) {
    if (attempt.bundle !== `${GVP0_REVIEWED_ATTEMPTS_ROOT}/${attempt.run_id}`
      || !/^sha256:[a-f0-9]{64}$/u.test(attempt.index_sha256)) {
      throw new Error(`${label} reviewed bundle binding is invalid`);
    }
  }
  for (const [position, [role]] of GVP0_ATTEMPT_ROLES.entries()) {
    const binding = attempt.artifacts[position];
    if (!hasExactKeys(binding, ['role', 'path', 'sha256']) || binding.role !== role
      || typeof binding.path !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(binding.sha256)) {
      throw new Error(`${label} artifact ${role} binding is invalid`);
    }
  }
}

function validateTechnicalStatusDocument(status) {
  if (!hasExactKeys(status, STATUS_ROOT_KEYS)
    || status.schema_id !== 'superwagie.technical-validation-status.v1'
    || status.schema_version !== 1 || !Number.isFinite(Date.parse(status.generated_at))
    || !['GO', 'NO_GO'].includes(status.production_implementation_admission)
    || !hasExactKeys(status.summary, STATUS_SUMMARY_KEYS)
    || !hasExactKeys(status.format_admission_ledger, STATUS_LEDGER_KEYS)
    || !Array.isArray(status.fixtures)) {
    throw new Error('existing status document is not a valid technical-validation-status v1 projection');
  }
  for (const key of STATUS_SUMMARY_KEYS) {
    if (!Number.isInteger(status.summary[key]) || status.summary[key] < 0) {
      throw new Error(`status summary ${key} must be a non-negative integer`);
    }
  }
  for (const key of STATUS_LEDGER_KEYS.filter((key) => key !== 'release_admission')) {
    if (!Number.isInteger(status.format_admission_ledger[key]) || status.format_admission_ledger[key] < 0) {
      throw new Error(`status format_admission_ledger ${key} must be a non-negative integer`);
    }
  }
  if (!['GO', 'NO_GO'].includes(status.format_admission_ledger.release_admission)) {
    throw new Error('status format_admission_ledger release_admission is invalid');
  }
  if (status.format_admission_ledger.research_required > status.format_admission_ledger.records
    || status.format_admission_ledger.complete_record_receipts > status.format_admission_ledger.records) {
    throw new Error('status format_admission_ledger counts are inconsistent');
  }
  const expectedById = new Map(EXPECTED_FIXTURES.map((entry) => [entry.fixture, entry]));
  if (status.fixtures.length !== expectedById.size
    || new Set(status.fixtures.map((entry) => entry?.fixture)).size !== expectedById.size) {
    throw new Error(`status fixtures must contain exactly ${expectedById.size} unique authoritative fixtures`);
  }
  for (const entry of status.fixtures) {
    const expected = expectedById.get(entry?.fixture);
    if (!expected) throw new Error(`status contains unknown fixture ${String(entry?.fixture)}`);
    if (/^GVP-[1-5]$/u.test(entry.fixture)) {
      if (!hasExactKeys(entry, [
        'gate', 'fixture', 'required_platforms', 'technical_state', 'execution',
        'admission', 'evidence', 'admission_scope', 'meaning',
      ]) || entry.gate !== 'universal-viewer'
        || JSON.stringify(entry.required_platforms) !== JSON.stringify(expected.required_platforms)
        || entry.technical_state !== 'RESEARCH_REQUIRED' || entry.execution !== 'research_required'
        || entry.admission !== 'not_ready' || entry.evidence !== null
        || entry.admission_scope !== 'universal-viewer-only' || entry.meaning !== expected.meaning) {
        throw new Error(`status fixture ${entry.fixture} has an invalid authoritative research-only structure`);
      }
      continue;
    }
    const requiredKeys = [
      'gate', 'fixture', 'required_platforms', 'execution', 'admission', 'evidence',
      'superseded_evidence', ...STATUS_ARRAY_FIELDS.slice(1),
    ];
    const allowedKeys = new Set([
      ...requiredKeys, 'evidence_revision', 'technical_state', 'meaning', 'admission_scope',
      'validation_error', 'receipt', 'latest_attempt', 'environment_attempts',
    ]);
    if (requiredKeys.some((key) => !Object.hasOwn(entry, key))
      || Object.keys(entry).some((key) => !allowedKeys.has(key))
      || entry.gate !== expected.gate || !STATUS_EXECUTIONS.has(entry.execution)
      || !STATUS_ADMISSIONS.has(entry.admission)
      || (entry.evidence !== null && typeof entry.evidence !== 'string')
      || !Array.isArray(entry.superseded_evidence)) {
      throw new Error(`status fixture ${entry.fixture} has an invalid authoritative structure`);
    }
    for (const field of STATUS_ARRAY_FIELDS) {
      if (!Array.isArray(entry[field]) || entry[field].some((value) => typeof value !== 'string')) {
        throw new Error(`status fixture ${entry.fixture} field ${field} must be a string array`);
      }
    }
    if (JSON.stringify(entry.required_platforms) !== JSON.stringify(expected.required_platforms)) {
      throw new Error(`status fixture ${entry.fixture} required_platforms do not match authority`);
    }
    if (expected.evidence_revision !== undefined && entry.evidence_revision !== expected.evidence_revision) {
      throw new Error(`status fixture ${entry.fixture} evidence_revision does not match authority`);
    }
    if (expected.evidence_revision === undefined && Object.hasOwn(entry, 'evidence_revision')) {
      throw new Error(`status fixture ${entry.fixture} has an unauthorized evidence_revision`);
    }
    if (expected.technical_state !== undefined
      && (entry.technical_state !== expected.technical_state || entry.meaning !== expected.meaning)) {
      throw new Error(`status fixture ${entry.fixture} Viewer authority fields are invalid`);
    }
    if (expected.technical_state === undefined
      && (Object.hasOwn(entry, 'technical_state') || Object.hasOwn(entry, 'meaning'))) {
      throw new Error(`status fixture ${entry.fixture} has unauthorized Viewer authority fields`);
    }
    if (['G3-REVIEW-001', 'G3-REVIEW-002'].includes(entry.fixture)) {
      if (entry.admission_scope !== 'historical-g3-review-only') {
        throw new Error(`status fixture ${entry.fixture} must remain historical-g3-review-only`);
      }
    } else if (Object.hasOwn(entry, 'admission_scope')) {
      throw new Error(`status fixture ${entry.fixture} has an unauthorized admission_scope`);
    }
    if (Object.hasOwn(entry, 'validation_error') && typeof entry.validation_error !== 'string') {
      throw new Error(`status fixture ${entry.fixture} validation_error must be a string`);
    }
    if (Object.hasOwn(entry, 'receipt') && (entry.fixture !== 'GVP-0' || entry.receipt !== null)) {
      throw new Error(`status fixture ${entry.fixture} receipt field is invalid`);
    }
    if (Object.hasOwn(entry, 'latest_attempt')) {
      if (entry.fixture !== 'GVP-0') throw new Error(`status fixture ${entry.fixture} cannot carry latest_attempt`);
      validateAttemptProjectionShape(entry.latest_attempt, 'status fixture GVP-0 latest_attempt', { allowLegacy: true });
    }
    if (Object.hasOwn(entry, 'environment_attempts')) {
      if (entry.fixture !== 'GVP-0' || !Array.isArray(entry.environment_attempts)
        || entry.environment_attempts.length < 1 || entry.environment_attempts.length > 2) {
        throw new Error('status fixture GVP-0 environment_attempts is invalid');
      }
      for (const attempt of entry.environment_attempts) {
        validateAttemptProjectionShape(attempt, 'status fixture GVP-0 environment_attempts entry');
      }
    }
    for (const superseded of entry.superseded_evidence) {
      if (!hasExactKeys(superseded, ['run', 'evidence', 'evidence_revision'])
        || typeof superseded.run !== 'string' || typeof superseded.evidence !== 'string'
        || (superseded.evidence_revision !== null && typeof superseded.evidence_revision !== 'string')) {
        throw new Error(`status fixture ${entry.fixture} superseded_evidence entry is invalid`);
      }
    }
  }
  const count = (field, value) => status.fixtures.filter((entry) => entry[field] === value).length;
  for (const [key, value] of Object.entries({
    expected: status.fixtures.length,
    go: count('execution', 'go'), conditional_go: count('execution', 'conditional_go'),
    no_go: count('execution', 'no_go'), blocked_environment: count('execution', 'blocked_environment'),
    invalid_evidence: count('execution', 'invalid_evidence'),
    superseded_evidence: count('execution', 'superseded_evidence'),
    research_required: count('execution', 'research_required'), missing: count('execution', 'missing'),
    signed_go: count('admission', 'signed_go'),
  })) {
    if (status.summary[key] !== value) throw new Error(`status summary ${key} is not fixture-derived`);
  }
}

export function projectFormatAdmissionState(ledger, { repoRoot = process.cwd(), receiptResolver } = {}) {
  const records = Array.isArray(ledger?.records) ? ledger.records : [];
  let completeRecordReceipts = 0;
  let invalidReceiptRefs = 0;
  const resolveReceipt = receiptResolver ?? createSafeReceiptResolver(repoRoot);
  for (const record of records) {
    const receiptAudit = auditViewerReceiptBindings(record, resolveReceipt);
    invalidReceiptRefs += receiptAudit.invalid_refs;
    const pairs = receiptAudit.validPairs;
    const complete = (record.required_platforms ?? []).every((platform) =>
      (record.required_gates ?? []).every((gate) => pairs.has(`${platform}:${gate}`)));
    if (complete && (record.required_platforms?.length ?? 0) > 0 && (record.required_gates?.length ?? 0) > 0) {
      completeRecordReceipts += 1;
    }
  }
  const researchRequired = records.filter((record) => record.current_state === 'RESEARCH_REQUIRED').length;
  const everyRecordAdmitted = records.length > 0
    && completeRecordReceipts === records.length
    && records.every((record) => String(record.current_state).startsWith('PROVEN_'));
  return {
    records: records.length,
    research_required: researchRequired,
    complete_record_receipts: completeRecordReceipts,
    invalid_receipt_refs: invalidReceiptRefs,
    release_admission: everyRecordAdmitted ? 'GO' : 'NO_GO',
  };
}

export function auditValidationStatus({ repoRoot = process.cwd(), generatedAt = new Date().toISOString() } = {}) {
  const absoluteRoot = resolve(repoRoot);
  const fixtures = EXPECTED_FIXTURES.map((expected) => auditFixture(absoluteRoot, expected));
  let formatAdmissionLedger = { records: 0, research_required: 0, complete_record_receipts: 0, invalid_receipt_refs: 0, release_admission: 'NO_GO' };
  try {
    formatAdmissionLedger = projectFormatAdmissionState(
      readJsonFile(resolve(absoluteRoot, 'docs/contracts/v1/format-admission-ledger.json')),
      { repoRoot: absoluteRoot },
    );
  } catch {
    // A missing ledger never upgrades admission; isolated audit tests intentionally omit repository documents.
  }
  const count = (field, value) => fixtures.filter((entry) => entry[field] === value).length;
  const summary = {
    expected: fixtures.length,
    go: count('execution', 'go'),
    conditional_go: count('execution', 'conditional_go'),
    no_go: count('execution', 'no_go'),
    blocked_environment: count('execution', 'blocked_environment'),
    invalid_evidence: count('execution', 'invalid_evidence'),
    superseded_evidence: count('execution', 'superseded_evidence'),
    research_required: count('execution', 'research_required'),
    missing: count('execution', 'missing'),
    signed_go: count('admission', 'signed_go'),
  };
  return {
    schema_id: 'superwagie.technical-validation-status.v1',
    schema_version: 1,
    generated_at: generatedAt,
    production_implementation_admission:
      summary.signed_go === summary.expected && formatAdmissionLedger.release_admission === 'GO' ? 'GO' : 'NO_GO',
    summary,
    format_admission_ledger: formatAdmissionLedger,
    fixtures,
  };
}

function validateRequestedEnvironmentAttemptBundle(repoRoot, bundlePath) {
  const reviewedRoot = resolve(repoRoot, GVP0_REVIEWED_ATTEMPTS_ROOT);
  const absoluteBundle = resolve(repoRoot, bundlePath);
  const runId = relative(reviewedRoot, absoluteBundle);
  if (isAbsolute(bundlePath) || runId === '' || runId.includes('/') || runId.includes('\\')
    || !isContained(reviewedRoot, absoluteBundle)) {
    throw new Error(`environment attempt bundle must be a direct child of ${GVP0_REVIEWED_ATTEMPTS_ROOT}`);
  }
  const attempt = validateGvp0BlockedEnvironmentAttempt(repoRoot, absoluteBundle, runId);
  if (attempt === null) throw new Error('environment attempt bundle failed reviewed artifact/schema/identity validation');
  return attempt;
}

export function writeAuditedStatusUpdate({ repoRoot = process.cwd(), statusPath, environmentAttemptBundle = null } = {}) {
  if (typeof statusPath !== 'string' || statusPath.length === 0) {
    throw new Error('statusPath is required');
  }
  const absoluteRoot = resolve(repoRoot);
  const absoluteStatusPath = resolve(absoluteRoot, statusPath);
  let previous = null;
  try {
    previous = readJsonFile(absoluteStatusPath);
    validateTechnicalStatusDocument(previous);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (environmentAttemptBundle !== null) {
    if (typeof environmentAttemptBundle !== 'string' || environmentAttemptBundle.length === 0) {
      throw new Error('environmentAttemptBundle must be a non-empty relative path');
    }
    validateRequestedEnvironmentAttemptBundle(absoluteRoot, environmentAttemptBundle);
  }
  const attempt = latestGvp0BlockedEnvironmentAttempt(absoluteRoot);
  if (attempt === null) {
    throw new Error('no reviewed GVP-0 BLOCKED_ENVIRONMENT attempt bundle is available');
  }
  const freshProjection = auditValidationStatus({ repoRoot: absoluteRoot, generatedAt: attempt.finished_at });
  const projectedGvp0 = freshProjection.fixtures.find(({ fixture: fixtureId }) => fixtureId === 'GVP-0');
  if (previous === null) previous = freshProjection;
  const fixtures = previous.fixtures.map((entry) => entry.fixture === 'GVP-0' ? projectedGvp0 : entry);
  if (!fixtures.some(({ fixture: fixtureId }) => fixtureId === 'GVP-0')) fixtures.push(projectedGvp0);
  const count = (field, value) => fixtures.filter((entry) => entry[field] === value).length;
  const summary = {
    expected: fixtures.length,
    go: count('execution', 'go'),
    conditional_go: count('execution', 'conditional_go'),
    no_go: count('execution', 'no_go'),
    blocked_environment: count('execution', 'blocked_environment'),
    invalid_evidence: count('execution', 'invalid_evidence'),
    superseded_evidence: count('execution', 'superseded_evidence'),
    research_required: count('execution', 'research_required'),
    missing: count('execution', 'missing'),
    signed_go: count('admission', 'signed_go'),
  };
  const report = {
    ...previous,
    generated_at: attempt.finished_at,
    production_implementation_admission: 'NO_GO',
    summary,
    format_admission_ledger: freshProjection.format_admission_ledger,
    fixtures,
  };
  validateTechnicalStatusDocument(report);
  const gvp0 = report.fixtures.find(({ fixture: fixtureId }) => fixtureId === 'GVP-0');
  if (gvp0?.execution !== 'blocked_environment' || gvp0.receipt !== null
    || gvp0.latest_attempt?.run_id !== attempt.run_id) {
    throw new Error('verified GVP-0 environment attempt was not selected as current status');
  }
  writeFileSync(absoluteStatusPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

function parseCli(argv) {
  const options = { repoRoot: process.cwd(), output: null, status: null, updateStatus: null, environmentAttemptBundle: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--repo-root' && argv[index + 1]) {
      options.repoRoot = argv[++index];
    } else if (token === '--output' && argv[index + 1]) {
      options.output = argv[++index];
    } else if (token === '--status' && argv[index + 1]) {
      options.status = argv[++index];
    } else if (token === '--update-status' && argv[index + 1]) {
      options.updateStatus = argv[++index];
    } else if (token === '--environment-attempt-bundle' && argv[index + 1]) {
      options.environmentAttemptBundle = argv[++index];
    } else {
      throw new Error('usage: validation-status-audit.mjs [--repo-root PATH] [--output FILE] [--status FILE] [--update-status FILE] [--environment-attempt-bundle RELATIVE_DIR]');
    }
  }
  return options;
}

function main() {
  const options = parseCli(process.argv.slice(2));
  if (options.updateStatus) {
    const report = writeAuditedStatusUpdate({
      repoRoot: options.repoRoot,
      statusPath: options.updateStatus,
      environmentAttemptBundle: options.environmentAttemptBundle,
    });
    const gvp0 = report.fixtures.find(({ fixture: fixtureId }) => fixtureId === 'GVP-0');
    console.log(`UPDATED validation status GVP-0=${gvp0.execution} receipt=none run=${gvp0.latest_attempt.run_id}`);
    return;
  }
  if (options.status) {
    const status = readJsonFile(resolve(options.repoRoot, options.status));
    validateTechnicalStatusDocument(status);
    const gvp = Array.isArray(status.fixtures) ? status.fixtures.filter(entry => /^GVP-[0-5]$/u.test(entry.fixture)) : [];
    const errors = [];
    if (gvp.length !== 6) errors.push(`expected 6 GVP fixtures, got ${gvp.length}`);
    if (gvp.some(entry => entry.technical_state !== 'RESEARCH_REQUIRED')) errors.push('all GVP fixtures must remain technically RESEARCH_REQUIRED');
    const gvp0 = gvp.find(entry => entry.fixture === 'GVP-0');
    const verifiedAttempt = latestGvp0BlockedEnvironmentAttempt(resolve(options.repoRoot));
    const verifiedAttempts = reviewedGvp0BlockedEnvironmentAttempts(resolve(options.repoRoot));
    if (gvp0?.execution !== 'blocked_environment' || gvp0?.receipt !== null
      || gvp0?.latest_attempt?.execution !== 'BLOCKED_ENVIRONMENT'
      || gvp0?.latest_attempt?.exit_code !== 2) errors.push('GVP-0 must reflect a verified BLOCKED_ENVIRONMENT attempt without a receipt');
    if (verifiedAttempt === null
      || JSON.stringify(gvp0?.latest_attempt) !== JSON.stringify(verifiedAttempt)) {
      errors.push('GVP-0 latest_attempt must exactly match the newest verified environment attempt and its artifact hashes');
    }
    const latestByPlatform = new Map();
    for (const attempt of verifiedAttempts) if (!latestByPlatform.has(attempt.platform_id)) latestByPlatform.set(attempt.platform_id, attempt);
    const expectedEnvironmentAttempts = [...latestByPlatform.values()].sort((left, right) => left.platform_id.localeCompare(right.platform_id));
    if (JSON.stringify(gvp0?.environment_attempts) !== JSON.stringify(expectedEnvironmentAttempts)) {
      errors.push('GVP-0 environment_attempts must exactly match reviewed per-platform bundles');
    }
    if (gvp.filter(entry => entry.fixture !== 'GVP-0').some(entry => entry.execution !== 'research_required')) errors.push('GVP-1 through GVP-5 must remain RESEARCH_REQUIRED');
    if (status.production_implementation_admission !== 'NO_GO') errors.push('production implementation admission must remain NO_GO');
    for (const entry of gvp) if (entry.meaning !== GVP_MEANINGS[entry.fixture]) errors.push(`${entry.fixture} meaning must match Viewer design §12.5`);
    for (const id of ['G3-REVIEW-001', 'G3-REVIEW-002']) {
      const entry = status.fixtures?.find(candidate => candidate.fixture === id);
      if (entry?.admission_scope !== 'historical-g3-review-only') errors.push(`${id} must be historical-g3-review-only`);
    }
    try {
      const ledger = readJsonFile(resolve(options.repoRoot, 'docs/contracts/v1/format-admission-ledger.json'));
      const projection = projectFormatAdmissionState(ledger);
      if (projection.research_required !== projection.records || projection.complete_record_receipts !== 0 || projection.release_admission !== 'NO_GO') {
        errors.push('Format Admission Ledger must remain entirely RESEARCH_REQUIRED without bound receipt sets');
      }
    } catch (error) {
      errors.push(`Format Admission Ledger audit failed: ${error.message}`);
    }
    if (errors.length) { errors.forEach(error => console.error(`FAIL ${error}`)); process.exitCode = 1; return; }
    console.log('PASS validation status GVP=6 gvp0=blocked_environment receipt=none gvp1-5=research_required historical_g3_review=2');
    return;
  }
  const report = auditValidationStatus({ repoRoot: options.repoRoot });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) writeFileSync(resolve(options.output), serialized);
  process.stdout.write(serialized);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main();
}
