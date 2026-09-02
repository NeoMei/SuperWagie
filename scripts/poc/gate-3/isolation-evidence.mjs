import { createHash, timingSafeEqual } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

const HASH = /^[0-9a-f]{64}$/;
const SCHEMA_KEYS = ['schema_id', 'schema_version', 'gate', 'fixture', 'scenario', 'platform', 'run_id', 'session_id', 'manifest_sha256', 'captured_at', 'pass', 'status', 'decision_hint', 'reasons', 'precondition', 'snapshot', 'artifacts', 'attestation'];
const ARTIFACT_KEYS = ['capture', 'renderer_provenance', 'review_automation_metrics', 'automation_complete'];
const SCENARIOS = new Set(['codex-never-installed', 'codex-installed-not-running', 'codex-running', 'codex-config-mutated']);
const BINDING_KEYS = ['fixture', 'scenario', 'platform', 'run_id', 'session_id', 'manifest_sha256'];
const METRIC_KEYS = ['progress_visible_ms', 'cached_first_page_p95_ms', 'authoritative_first_reviewable_page_ms', 'interaction_p95_ms', 'peak_rss_bytes', 'cache_bytes', 'reanchor_resolved', 'reanchor_unresolved', 'reanchor_silent_misplaced', 'visual_diff_ratio'];
const METRIC_PROVENANCE_KEYS = ['captured_at', 'correctness_counters', 'fixture', 'host_measurements', 'manifest_sha256', 'renderer_environment_sha256', 'representative_machine', 'samples', 'session_id'];

function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function attestIsolationResult(unsigned) {
  if (Object.hasOwn(unsigned, 'attestation')) throw new Error('result already attested');
  return {
    ...unsigned,
    attestation: { algorithm: 'sha256', canonical_sha256: digest(JSON.stringify(stable(unsigned))) }
  };
}

function validateProbe(value) {
  return exact(value, ['checked', 'sample_count', 'evidence_sha256', 'forbidden_matches'])
    && value.checked === true && Number.isSafeInteger(value.sample_count) && value.sample_count >= 0
    && HASH.test(value.evidence_sha256) && Array.isArray(value.forbidden_matches)
    && value.forbidden_matches.length === 0;
}

function validateSnapshot(value) {
  if (!exact(value, ['binary_sha256', 'dependency_manifest_sha256', 'renderer_manifest_sha256', 'preview_hashes', 'probes'])
    || !HASH.test(value.binary_sha256) || !HASH.test(value.dependency_manifest_sha256)
    || !HASH.test(value.renderer_manifest_sha256) || !Array.isArray(value.preview_hashes)
    || value.preview_hashes.length === 0 || !exact(value.probes, ['process', 'paths', 'network'])) return false;
  if (value.preview_hashes.some((record) => !exact(record, ['page_id', 'sha256'])
    || !/^[A-Za-z0-9:_-]{1,128}$/.test(record.page_id) || !HASH.test(record.sha256))) return false;
  if (new Set(value.preview_hashes.map(({ page_id }) => page_id)).size !== value.preview_hashes.length) return false;
  return ['process', 'paths', 'network'].every((name) => validateProbe(value.probes[name]));
}

function validatePrecondition(value, scenario) {
  if (!exact(value, ['kind', 'verified', 'application_inventory', 'process_state', 'fixture_mutation', 'attestation'])
    || value.kind !== scenario || value.verified !== true
    || !exact(value.application_inventory, ['codex_state', 'digest_sha256'])
    || !HASH.test(value.application_inventory.digest_sha256)
    || !exact(value.process_state, ['codex_running', 'digest_sha256'])
    || typeof value.process_state.codex_running !== 'boolean' || !HASH.test(value.process_state.digest_sha256)
    || !exact(value.fixture_mutation, ['applied', 'digest_sha256'])
    || typeof value.fixture_mutation.applied !== 'boolean'
    || !(value.fixture_mutation.digest_sha256 === null || HASH.test(value.fixture_mutation.digest_sha256))
    || !exact(value.attestation, ['required', 'verified', 'digest_sha256'])
    || typeof value.attestation.required !== 'boolean' || typeof value.attestation.verified !== 'boolean'
    || !(value.attestation.digest_sha256 === null || HASH.test(value.attestation.digest_sha256))) return false;
  const expected = {
    'codex-never-installed': ['never-installed-attested', false, false, true],
    'codex-installed-not-running': ['installed-not-running', false, false, false],
    'codex-running': ['installed-running', true, false, false],
    'codex-config-mutated': ['installed-config-mutated', false, true, false]
  }[scenario];
  return Boolean(expected) && value.application_inventory.codex_state === expected[0]
    && value.process_state.codex_running === expected[1]
    && value.fixture_mutation.applied === expected[2]
    && value.attestation.required === expected[3]
    && value.attestation.verified === (expected[3] ? true : false)
    && (expected[2] ? HASH.test(value.fixture_mutation.digest_sha256) : value.fixture_mutation.digest_sha256 === null)
    && (expected[3] ? HASH.test(value.attestation.digest_sha256) : value.attestation.digest_sha256 === null);
}

function sameHash(actual, expected) {
  return HASH.test(actual) && HASH.test(expected)
    && timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

function sameDocument(actual, expected) {
  return JSON.stringify(stable(actual)) === JSON.stringify(stable(expected));
}

function validateBinding(value, result) {
  return exact(value, BINDING_KEYS) && value.fixture === result.fixture && value.scenario === result.scenario
    && value.platform === result.platform && value.run_id === result.run_id && value.session_id === result.session_id
    && value.manifest_sha256 === result.manifest_sha256;
}

function fresh(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && Math.abs(Date.now() - timestamp) <= 24 * 60 * 60 * 1000;
}

function rendererIdentityDigest(document) {
  return digest(JSON.stringify(stable({
    platform: document.platform, machine: document.machine, wps: document.wps,
    python_executable_sha256: document.python_executable_sha256,
    wpscomposer_source_sha256: document.wpscomposer_source_sha256,
    font_manifest_sha256: document.font_manifest_sha256,
    render_options: document.render_options
  })));
}

function validateRendererDocument(value, result) {
  const keys = ['schema_id', 'schema_version', 'binding', 'platform', 'machine', 'wps', 'python_executable_sha256', 'wpscomposer_source_sha256', 'font_manifest_sha256', 'render_options', 'renderer_environment_sha256'];
  return exact(value, keys) && value.schema_id === 'superwagie.review-renderer-provenance.v1' && value.schema_version === 1
    && validateBinding(value.binding, result) && value.platform === result.platform
    && exact(value.machine, ['profile_id', 'representative']) && /^[A-Za-z0-9_.:-]{1,128}$/.test(value.machine.profile_id ?? '') && value.machine.representative === true
    && exact(value.wps, ['application', 'exact_version', 'bridge_identity', 'application_identity'])
    && value.wps.application === 'WPS' && typeof value.wps.exact_version === 'string' && value.wps.exact_version.length > 0
    && exact(value.wps.application_identity, ['target_kind', 'executable_sha256', 'bundle_manifest_sha256', 'bridge_sha256'])
    && (result.platform.startsWith('macos-') ? value.wps.application_identity.target_kind === 'macos-app-bundle' : value.wps.application_identity.target_kind === 'windows-executable')
    && [value.wps.application_identity.executable_sha256, value.wps.application_identity.bundle_manifest_sha256, value.wps.application_identity.bridge_sha256,
      value.python_executable_sha256, value.wpscomposer_source_sha256, value.font_manifest_sha256, value.renderer_environment_sha256].every((hash) => HASH.test(hash))
    && value.wps.bridge_identity === `sha256:${value.wps.application_identity.bridge_sha256}`
    && value.renderer_environment_sha256 === result.snapshot.renderer_manifest_sha256
    && sameHash(value.renderer_environment_sha256, rendererIdentityDigest(value))
    && value.render_options && typeof value.render_options === 'object' && !Array.isArray(value.render_options);
}

function validateMetricsPayload(value, result, rendererHash) {
  if (!exact(value, ['metrics', 'provenance']) || !exact(value.metrics, METRIC_KEYS)
    || METRIC_KEYS.some((key) => typeof value.metrics[key] !== 'number' || !Number.isFinite(value.metrics[key]) || value.metrics[key] < 0)) return false;
  const provenance = value.provenance;
  return exact(provenance, METRIC_PROVENANCE_KEYS) && provenance.fixture === 'G3-REVIEW-001'
    && provenance.session_id === result.session_id && provenance.manifest_sha256 === result.manifest_sha256
    && provenance.renderer_environment_sha256 === rendererHash && provenance.representative_machine === true
    && fresh(provenance.captured_at)
    && exact(provenance.host_measurements, ['source', 'peak_rss_bytes', 'cache_bytes'])
    && provenance.host_measurements.source === 'trusted-native-host'
    && provenance.host_measurements.peak_rss_bytes === value.metrics.peak_rss_bytes
    && provenance.host_measurements.cache_bytes === value.metrics.cache_bytes
    && value.metrics.peak_rss_bytes > 0 && value.metrics.cache_bytes > 0
    && exact(provenance.correctness_counters, ['acceptance', 'basis'])
    && typeof provenance.correctness_counters.acceptance === 'boolean'
    && ['task-9-required', 'task-9-validated'].includes(provenance.correctness_counters.basis)
    && provenance.correctness_counters.acceptance === (provenance.correctness_counters.basis === 'task-9-validated')
    && exact(provenance.samples, ['progress', 'cached_first_page', 'authoritative_first_page', 'interactions'])
    && Object.values(provenance.samples).every((sample) => Number.isSafeInteger(sample) && sample >= 1);
}

function validateReferencedDocuments(documents, result) {
  const capture = documents.capture;
  if (!exact(capture, ['schema_id', 'schema_version', 'binding', 'captured_at', 'precondition', 'snapshot'])
    || capture.schema_id !== 'superwagie.g3-review-capture.v1' || capture.schema_version !== 1
    || !validateBinding(capture.binding, result) || capture.captured_at !== result.captured_at || !fresh(capture.captured_at)
    || !sameDocument(capture.precondition, result.precondition) || !sameDocument(capture.snapshot, result.snapshot)) throw new Error('capture content or snapshot binding mismatch');
  if (!validateRendererDocument(documents.renderer_provenance, result)) throw new Error('renderer content or identity binding mismatch');
  const metrics = documents.review_automation_metrics;
  if (!exact(metrics, ['schema_id', 'schema_version', 'binding', 'renderer_environment_sha256', 'metrics_document'])
    || metrics.schema_id !== 'superwagie.g3-review-metrics.v1' || metrics.schema_version !== 1
    || !validateBinding(metrics.binding, result) || metrics.renderer_environment_sha256 !== result.snapshot.renderer_manifest_sha256
    || !validateMetricsPayload(metrics.metrics_document, result, metrics.renderer_environment_sha256)) throw new Error('metrics content or binding mismatch');
  const completion = documents.automation_complete;
  if (!exact(completion, ['schema_id', 'schema_version', 'binding', 'captured_at', 'renderer_environment_sha256', 'metrics_sha256', 'preview_hashes', 'completion', 'trusted'])
    || completion.schema_id !== 'superwagie.g3-review-completion.v1' || completion.schema_version !== 1
    || !validateBinding(completion.binding, result) || completion.captured_at !== result.captured_at || !fresh(completion.captured_at)
    || completion.renderer_environment_sha256 !== result.snapshot.renderer_manifest_sha256
    || completion.metrics_sha256 !== result.artifacts.review_automation_metrics.sha256
    || !sameDocument(completion.preview_hashes, result.snapshot.preview_hashes)
    || !exact(completion.completion, ['fixture', 'session_id', 'manifest_sha256', 'metrics_file', 'completed_at'])
    || completion.completion.fixture !== 'G3-REVIEW-001' || completion.completion.session_id !== result.session_id
    || completion.completion.manifest_sha256 !== result.manifest_sha256 || completion.completion.metrics_file !== 'review-automation-metrics.json'
    || !fresh(completion.completion.completed_at)
    || completion.completion.completed_at !== documents.review_automation_metrics.metrics_document.provenance.captured_at
    || completion.trusted !== true) throw new Error('completion content, metrics, or preview binding mismatch');
}

export async function validateIsolationEvidence(resultsFile, evidenceRoot, expected = {}) {
  if (!path.isAbsolute(resultsFile) || !path.isAbsolute(evidenceRoot)) throw new Error('evidence paths must be absolute');
  const root = await realpath(evidenceRoot);
  const resultPath = await realpath(resultsFile);
  const resultMetadata = await lstat(resultsFile);
  if (resultMetadata.isSymbolicLink() || !resultMetadata.isFile()) throw new Error('result must be a regular non-symlink file');
  if (resultPath !== root && !resultPath.startsWith(`${root}${path.sep}`)) throw new Error('result relocated outside evidence root');
  const value = JSON.parse(await readFile(resultPath, 'utf8'));
  if (!exact(value, SCHEMA_KEYS) || value.schema_id !== 'superwagie.g3-review-isolation-result.v1'
    || value.schema_version !== 1 || value.gate !== 'gate-3' || value.fixture !== 'G3-REVIEW-002'
    || !SCENARIOS.has(value.scenario) || (expected.scenario && value.scenario !== expected.scenario)
    || !/^[A-Za-z0-9_-]{1,128}$/.test(value.platform) || (expected.platform && value.platform !== expected.platform)
    || !/^[A-Za-z0-9_-]{1,128}$/.test(value.run_id)
    || !/^[A-Za-z0-9_-]{1,128}$/.test(value.session_id) || !HASH.test(value.manifest_sha256)
    || !Number.isFinite(Date.parse(value.captured_at)) || Math.abs(Date.now() - Date.parse(value.captured_at)) > 24 * 60 * 60 * 1000
    || value.pass !== true || value.status !== 'passed' || value.decision_hint !== 'GO'
    || !Array.isArray(value.reasons) || value.reasons.length !== 0
    || !validatePrecondition(value.precondition, value.scenario) || !validateSnapshot(value.snapshot)
    || !exact(value.artifacts, ARTIFACT_KEYS)
    || !exact(value.attestation, ['algorithm', 'canonical_sha256']) || value.attestation.algorithm !== 'sha256'
    || !HASH.test(value.attestation.canonical_sha256)) throw new Error('isolation evidence schema or decision invalid');
  const { attestation, ...unsigned } = value;
  if (!sameHash(attestation.canonical_sha256, digest(JSON.stringify(stable(unsigned))))) throw new Error('isolation attestation mismatch');
  const documents = {};
  for (const key of ARTIFACT_KEYS) {
    const record = value.artifacts[key];
    if (!exact(record, ['relative_path', 'sha256']) || !HASH.test(record.sha256)
      || typeof record.relative_path !== 'string' || record.relative_path.length === 0
      || path.isAbsolute(record.relative_path) || record.relative_path.split(/[\\/]/).includes('..')) throw new Error('artifact reference invalid');
    const artifact = await realpath(path.resolve(root, record.relative_path));
    if (!artifact.startsWith(`${root}${path.sep}`)) throw new Error('artifact relocated outside evidence root');
    const metadata = await lstat(path.resolve(root, record.relative_path));
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error('artifact must be a regular non-symlink file');
    const bytes = await readFile(artifact);
    if (!sameHash(digest(bytes), record.sha256)) throw new Error('artifact hash mismatch');
    try { documents[key] = JSON.parse(bytes); } catch { throw new Error(`artifact content invalid: ${key}`); }
  }
  validateReferencedDocuments(documents, value);
  return value;
}

export function compareIsolationSnapshots(baseline, current) {
  const reasons = [];
  for (const key of ['binary_sha256', 'dependency_manifest_sha256', 'renderer_manifest_sha256']) {
    if (baseline?.[key] !== current?.[key]) reasons.push(`${key.replace('_sha256', '').toUpperCase()}_MISMATCH`);
  }
  if (JSON.stringify(baseline?.preview_hashes) !== JSON.stringify(current?.preview_hashes)) reasons.push('PREVIEW_HASH_ORDER_MISMATCH');
  return { equal: reasons.length === 0, reasons };
}
