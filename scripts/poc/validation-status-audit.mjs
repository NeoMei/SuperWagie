#!/usr/bin/env node

import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateReceiptBundle } from './universal-viewer/gvp-0-gate.mjs';

const MACOS = 'macos-15-arm64';
const WINDOWS = 'windows-11-x64';

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

function validateCandidate(expected, candidate) {
  try {
    if (expected.technical_state === 'RESEARCH_REQUIRED') {
      if (candidate.result.gate_id !== expected.fixture) {
        throw new Error(`Viewer gate mismatch: expected ${expected.fixture}, got ${candidate.result.gate_id}`);
      }
      const receiptValidation = validateReceiptBundle({ resultsPath: candidate.resultsPath });
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
  if (expected.technical_state === 'RESEARCH_REQUIRED' && allCandidates.length === 0) {
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
    .map(([platform, candidate]) => ({ platform, ...candidate, validation: validateCandidate(expected, candidate) }));
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

  const latestValidation = validateCandidate(expected, latest);
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

export function projectFormatAdmissionState(ledger) {
  const records = Array.isArray(ledger?.records) ? ledger.records : [];
  let completeRecordReceipts = 0;
  for (const record of records) {
    const pairs = new Set((record.admission_receipt_refs ?? []).map((ref) => `${ref.platform_id}:${ref.gate_id}`));
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
    release_admission: everyRecordAdmitted ? 'GO' : 'NO_GO',
  };
}

export function auditValidationStatus({ repoRoot = process.cwd(), generatedAt = new Date().toISOString() } = {}) {
  const absoluteRoot = resolve(repoRoot);
  const fixtures = EXPECTED_FIXTURES.map((expected) => auditFixture(absoluteRoot, expected));
  let formatAdmissionLedger = { records: 0, research_required: 0, complete_record_receipts: 0, release_admission: 'NO_GO' };
  try {
    formatAdmissionLedger = projectFormatAdmissionState(readJsonFile(resolve(absoluteRoot, 'docs/contracts/v1/format-admission-ledger.json')));
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

function parseCli(argv) {
  const options = { repoRoot: process.cwd(), output: null, status: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--repo-root' && argv[index + 1]) {
      options.repoRoot = argv[++index];
    } else if (token === '--output' && argv[index + 1]) {
      options.output = argv[++index];
    } else if (token === '--status' && argv[index + 1]) {
      options.status = argv[++index];
    } else {
      throw new Error('usage: validation-status-audit.mjs [--repo-root PATH] [--output FILE] [--status FILE]');
    }
  }
  return options;
}

function main() {
  const options = parseCli(process.argv.slice(2));
  if (options.status) {
    const status = readJsonFile(resolve(options.status));
    const gvp = Array.isArray(status.fixtures) ? status.fixtures.filter(entry => /^GVP-[0-5]$/u.test(entry.fixture)) : [];
    const errors = [];
    if (gvp.length !== 6) errors.push(`expected 6 GVP fixtures, got ${gvp.length}`);
    if (gvp.some(entry => entry.technical_state !== 'RESEARCH_REQUIRED' || entry.execution !== 'research_required')) errors.push('all GVP fixtures must remain RESEARCH_REQUIRED');
    for (const entry of gvp) if (entry.meaning !== GVP_MEANINGS[entry.fixture]) errors.push(`${entry.fixture} meaning must match Viewer design §12.5`);
    for (const id of ['G3-REVIEW-001', 'G3-REVIEW-002']) {
      const entry = status.fixtures?.find(candidate => candidate.fixture === id);
      if (entry?.admission_scope !== 'historical-g3-review-only') errors.push(`${id} must be historical-g3-review-only`);
    }
    try {
      const ledger = readJsonFile(resolve('docs/contracts/v1/format-admission-ledger.json'));
      const projection = projectFormatAdmissionState(ledger);
      if (projection.research_required !== projection.records || projection.complete_record_receipts !== 0 || projection.release_admission !== 'NO_GO') {
        errors.push('Format Admission Ledger must remain entirely RESEARCH_REQUIRED without bound receipt sets');
      }
    } catch (error) {
      errors.push(`Format Admission Ledger audit failed: ${error.message}`);
    }
    if (errors.length) { errors.forEach(error => console.error(`FAIL ${error}`)); process.exitCode = 1; return; }
    console.log('PASS validation status GVP=6 research_required=6 historical_g3_review=2');
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
