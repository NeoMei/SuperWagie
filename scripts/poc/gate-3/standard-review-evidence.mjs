import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const SHA256 = /^[0-9a-f]{64}$/;
const AUTOMATION_SESSION = /^[0-9a-f]{32}$/;
const MAX_FRESHNESS_MS = 24 * 60 * 60 * 1000;

const REQUIRED_METRICS = [
  'progress_visible_ms', 'cached_first_page_p95_ms',
  'authoritative_first_reviewable_page_ms', 'interaction_p95_ms',
  'peak_rss_bytes', 'cache_bytes', 'reanchor_resolved', 'reanchor_unresolved',
  'reanchor_silent_misplaced', 'visual_diff_ratio'
];
const PROVENANCE_KEYS = [
  'captured_at', 'correctness_counters', 'fixture', 'host_measurements',
  'manifest_sha256', 'renderer_environment_sha256', 'representative_machine',
  'samples', 'session_id'
];
const SAMPLE_KEYS = ['authoritativeFirstPage', 'cachedFirstPage', 'interactions', 'progress'];
const RESULT_KEYS = [
  'automation', 'decision_hint', 'fixture', 'gate', 'limitations', 'metrics',
  'metrics_provenance', 'pass', 'reasons', 'schema_version', 'status'
];
const COMPLETION_KEYS = [
  'completed_at', 'fixture', 'manifest_sha256', 'metrics_file', 'preview_hashes',
  'session_id'
];
const FAILURE_KEYS = [
  'error_code', 'failed_at', 'fixture', 'manifest_sha256',
  'renderer_environment_sha256', 'schema_id', 'schema_version', 'session_id',
  'state'
];
const AUTOMATION_FAILURE_PAIRS = new Set([
  'dependency_missing\0SW_REVIEW_RENDER_DEPENDENCY_MISSING',
  'failed_recoverable\0SW_REVIEW_RENDER_STAGING_FAILED',
  'failed_recoverable\0SW_REVIEW_RENDER_SOURCE_FAILED',
  'failed_recoverable\0SW_REVIEW_RENDER_WORKER_FAILED',
  'failed_recoverable\0SW_REVIEW_RENDER_PUBLICATION_FAILED',
  'failed_terminal\0SW_REVIEW_CACHE_IMMUTABLE_CONFLICT',
  'failed_terminal\0SW_REVIEW_PREVIEW_REVISION_ID_INVALID',
  'failed_terminal\0SW_REVIEW_AUTOMATION_BOOTSTRAP_FAILED',
  'failed_terminal\0SW_REVIEW_AUTOMATION_PROGRESS_FAILED',
  'failed_terminal\0SW_REVIEW_AUTOMATION_PDF_AUTHORITATIVE_FAILED',
  'failed_terminal\0SW_REVIEW_AUTOMATION_PDF_ASSET_URL_FAILED',
  'failed_terminal\0SW_REVIEW_AUTOMATION_PDF_ASSET_FETCH_FAILED',
  'failed_terminal\0SW_REVIEW_AUTOMATION_PDF_DOCUMENT_LOAD_FAILED',
  'failed_terminal\0SW_REVIEW_AUTOMATION_PDF_MANIFEST_BUILD_FAILED',
  'failed_terminal\0SW_REVIEW_AUTOMATION_PDF_MANIFEST_PAGES_FAILED',
  'failed_terminal\0SW_REVIEW_AUTOMATION_PDF_MANIFEST_SOURCE_FAILED',
  'failed_terminal\0SW_REVIEW_AUTOMATION_PDF_MANIFEST_HASHES_FAILED',
  'failed_terminal\0SW_REVIEW_AUTOMATION_PDF_MANIFEST_REVISION_FAILED',
  'failed_terminal\0SW_REVIEW_AUTOMATION_PDF_MANIFEST_REVISION_ID_FAILED',
  'failed_terminal\0SW_REVIEW_AUTOMATION_PDF_MANIFEST_SESSION_FAILED',
  'failed_terminal\0SW_REVIEW_AUTOMATION_PDF_PRESENT_FAILED',
  'failed_terminal\0SW_REVIEW_AUTOMATION_PDF_CACHED_PAGE_FAILED',
  'failed_terminal\0SW_REVIEW_AUTOMATION_PDF_ACTIONS_FAILED',
  'failed_terminal\0SW_REVIEW_AUTOMATION_DOCX_FAST_FAILED',
  'failed_terminal\0SW_REVIEW_AUTOMATION_DOCX_AUTHORITATIVE_FAILED',
  'failed_terminal\0SW_REVIEW_AUTOMATION_PPTX_AUTHORITATIVE_FAILED',
  'failed_terminal\0SW_REVIEW_AUTOMATION_PERSISTENCE_FAILED',
  'failed_terminal\0SW_REVIEW_AUTOMATION_METRICS_FAILED'
]);
const EXPECTED_PREVIEW_PAGE_IDS = ['pdf:page-1', 'docx:page-1', 'pptx:page-1'];

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function canonicalSha256(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function canonicalInstant(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value ? timestamp : null;
}

function freshInstant(value, now = Date.now()) {
  const timestamp = canonicalInstant(value);
  return timestamp !== null && Math.abs(now - timestamp) <= MAX_FRESHNESS_MS;
}

function validateMetricsDocument(document, expected = {}) {
  const errors = [];
  if (!exactKeys(document, ['metrics', 'provenance'])) {
    return { errors: ['METRICS_SCHEMA_MISMATCH'] };
  }
  if (!exactKeys(document.metrics, REQUIRED_METRICS)) errors.push('METRICS_SCHEMA_MISMATCH');
  for (const key of REQUIRED_METRICS) {
    const value = document.metrics?.[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      errors.push(`METRIC_INVALID_${key.toUpperCase()}`);
    }
  }
  for (const key of ['peak_rss_bytes', 'cache_bytes']) {
    if (!Number.isSafeInteger(document.metrics?.[key]) || document.metrics[key] <= 0) {
      errors.push(`METRIC_INVALID_${key.toUpperCase()}`);
    }
  }
  for (const key of ['reanchor_resolved', 'reanchor_unresolved', 'reanchor_silent_misplaced']) {
    if (!Number.isSafeInteger(document.metrics?.[key])) errors.push(`METRIC_INVALID_${key.toUpperCase()}`);
  }
  if (typeof document.metrics?.visual_diff_ratio === 'number' && document.metrics.visual_diff_ratio > 1) {
    errors.push('METRIC_INVALID_VISUAL_DIFF_RATIO');
  }

  const provenance = document.provenance;
  if (!exactKeys(provenance, PROVENANCE_KEYS)
    || provenance.fixture !== expected.fixture
    || !/^[A-Za-z0-9_-]{1,64}$/.test(provenance.session_id ?? '')
    || !SHA256.test(provenance.manifest_sha256 ?? '')
    || (expected.manifestSha256 && provenance.manifest_sha256 !== expected.manifestSha256)
    || provenance.representative_machine !== true
    || !SHA256.test(provenance.renderer_environment_sha256 ?? '')
    || (expected.rendererEnvironmentSha256 && provenance.renderer_environment_sha256 !== expected.rendererEnvironmentSha256)
    || !exactKeys(provenance.host_measurements, ['source', 'peak_rss_bytes', 'cache_bytes'])
    || provenance.host_measurements.source !== 'trusted-native-host'
    || provenance.host_measurements.peak_rss_bytes !== document.metrics?.peak_rss_bytes
    || provenance.host_measurements.cache_bytes !== document.metrics?.cache_bytes
    || !Number.isSafeInteger(provenance.host_measurements.peak_rss_bytes)
    || !Number.isSafeInteger(provenance.host_measurements.cache_bytes)
    || provenance.host_measurements.peak_rss_bytes <= 0
    || provenance.host_measurements.cache_bytes <= 0
    || !exactKeys(provenance.correctness_counters, ['acceptance', 'basis'])
    || typeof provenance.correctness_counters.acceptance !== 'boolean'
    || !['task-9-required', 'task-9-validated'].includes(provenance.correctness_counters.basis)
    || provenance.correctness_counters.acceptance !== (provenance.correctness_counters.basis === 'task-9-validated')
    || !exactKeys(provenance.samples, SAMPLE_KEYS)) {
    errors.push('METRICS_PROVENANCE_INVALID');
  }
  if (expected.sessionId && provenance?.session_id !== expected.sessionId) errors.push('METRICS_SESSION_MISMATCH');
  if (!freshInstant(provenance?.captured_at, expected.now)) errors.push('METRICS_STALE');
  for (const key of SAMPLE_KEYS) {
    if (!Number.isSafeInteger(provenance?.samples?.[key]) || provenance.samples[key] < 1) {
      errors.push('METRICS_SAMPLE_PROVENANCE_INVALID');
    }
  }
  return { errors: [...new Set(errors)] };
}

function metricDecision(metrics) {
  const correctness = [];
  const performance = [];
  if (metrics.reanchor_silent_misplaced !== 0) correctness.push('SILENT_ANNOTATION_MISPLACEMENT');
  if (metrics.progress_visible_ms > 300) performance.push('PROGRESS_THRESHOLD_EXCEEDED');
  if (metrics.cached_first_page_p95_ms > 1000) performance.push('CACHED_FIRST_PAGE_THRESHOLD_EXCEEDED');
  if (metrics.authoritative_first_reviewable_page_ms > 5000) performance.push('AUTHORITATIVE_FIRST_PAGE_THRESHOLD_EXCEEDED');
  if (metrics.interaction_p95_ms > 100) performance.push('INTERACTION_THRESHOLD_EXCEEDED');
  return { correctness, performance };
}

function deriveReviewOutcome({ checklistPresent, termsApproved, sourceRecorded, isolationPassed, performanceReasons, correctnessAccepted }) {
  const reasons = [];
  const limitations = [];
  if (!checklistPresent) {
    reasons.push('MANUAL_CHECKLIST_REQUIRED');
    limitations.push('G3-REVIEW-001 has no valid manual visual checklist.');
  }
  if (!termsApproved || !sourceRecorded) {
    reasons.push('WPS_TERMS_REVIEW_REQUIRED');
    limitations.push('WPS commercial-use/redistribution terms and WPSComposer source identity require review.');
  }
  if (!isolationPassed) {
    reasons.push('CODEX_NEVER_INSTALLED_EVIDENCE_REQUIRED');
    limitations.push('A passing G3-REVIEW-002 codex-never-installed result is required before GO.');
  }
  if (performanceReasons.length > 0) {
    reasons.push(...performanceReasons, 'PERFORMANCE_FALLBACK_REQUIRED');
    limitations.push('Use external/side-by-side WPS Review until the embedded performance thresholds pass.');
  }
  if (!correctnessAccepted) {
    reasons.push('CORRECTNESS_COUNTERS_NON_ACCEPTANCE');
    limitations.push('Correctness counters are diagnostic only until Task 9 validation.');
  }
  return {
    decision: reasons.length === 0 ? 'GO' : 'CONDITIONAL_GO',
    reasons: [...new Set(reasons)].sort(),
    limitations
  };
}

function validateAutomationCompletion(document, expected) {
  const errors = [];
  if (!exactKeys(document, COMPLETION_KEYS)) return { errors: ['AUTOMATION_COMPLETION_SCHEMA_INVALID'] };
  if (document.fixture !== expected.fixture
    || document.session_id !== expected.sessionId
    || !AUTOMATION_SESSION.test(document.session_id ?? '')
    || document.manifest_sha256 !== expected.manifestSha256
    || document.metrics_file !== 'review-automation-metrics.json'
    || document.completed_at !== expected.capturedAt
    || !freshInstant(document.completed_at, expected.now)
    || (expected.notBefore !== undefined && Date.parse(document.completed_at) < expected.notBefore)) {
    errors.push('AUTOMATION_COMPLETION_IDENTITY_INVALID');
  }
  if (!Array.isArray(document.preview_hashes)
    || document.preview_hashes.length !== EXPECTED_PREVIEW_PAGE_IDS.length
    || document.preview_hashes.some((record) => !exactKeys(record, ['pageId', 'sha256'])
      || typeof record.pageId !== 'string' || record.pageId.length === 0 || record.pageId.length > 128
      || !SHA256.test(record.sha256 ?? ''))
    || new Set(document.preview_hashes.map(({ pageId }) => pageId)).size !== document.preview_hashes.length) {
    errors.push('AUTOMATION_COMPLETION_PREVIEWS_INVALID');
  } else if (!document.preview_hashes.every(({ pageId }, index) => pageId === EXPECTED_PREVIEW_PAGE_IDS[index])) {
    errors.push('AUTOMATION_COMPLETION_PREVIEW_ORDER_INVALID');
  }
  return { errors: [...new Set(errors)] };
}

function validateAutomationFailure(document, expected) {
  const errors = [];
  if (!exactKeys(document, FAILURE_KEYS)
    || document.schema_id !== 'superwagie.review-automation-failure.v1'
    || document.schema_version !== 1) {
    return { errors: ['AUTOMATION_FAILURE_SCHEMA_INVALID'] };
  }
  if (document.fixture !== expected.fixture
    || document.session_id !== expected.sessionId
    || !AUTOMATION_SESSION.test(document.session_id ?? '')
    || document.manifest_sha256 !== expected.manifestSha256
    || !SHA256.test(document.manifest_sha256 ?? '')
    || document.renderer_environment_sha256 !== expected.rendererEnvironmentSha256
    || !SHA256.test(document.renderer_environment_sha256 ?? '')) {
    errors.push('AUTOMATION_FAILURE_IDENTITY_INVALID');
  }
  if (!Number.isSafeInteger(document.failed_at) || document.failed_at <= 0
    || Math.abs((expected.now ?? Date.now()) - document.failed_at) > MAX_FRESHNESS_MS
    || (expected.notBefore !== undefined && document.failed_at < expected.notBefore)) {
    errors.push('AUTOMATION_FAILURE_STALE');
  }
  if (!AUTOMATION_FAILURE_PAIRS.has(`${document.state}\0${document.error_code}`)) {
    errors.push('AUTOMATION_FAILURE_STATE_INVALID');
  }
  return { errors: [...new Set(errors)] };
}

function validateStandardReviewEvidence({ result, metrics, completion }, expected = {}) {
  const fixture = expected.fixture ?? 'G3-REVIEW-001';
  if (!SHA256.test(expected.manifestSha256 ?? '')
    || !SHA256.test(expected.rendererEnvironmentSha256 ?? '')) {
    throw new Error('standard review trusted expected manifest and renderer identity required');
  }
  if (!exactKeys(metrics, ['metrics', 'provenance'])) throw new Error('standard review metrics schema invalid');
  const metricsValidation = validateMetricsDocument(metrics, {
    fixture,
    manifestSha256: expected.manifestSha256,
    rendererEnvironmentSha256: expected.rendererEnvironmentSha256,
    sessionId: metrics.provenance?.session_id,
    now: expected.now
  });
  if (metricsValidation.errors.length > 0) {
    throw new Error(`standard review metrics invalid: ${metricsValidation.errors.join(',')}`);
  }
  if (!AUTOMATION_SESSION.test(metrics.provenance.session_id)) throw new Error('standard review automation session invalid');

  if (!exactKeys(result, RESULT_KEYS)) throw new Error('standard review result schema invalid');
  if (result.schema_version !== 1 || result.gate !== 'gate-3' || result.fixture !== fixture
    || result.pass !== true || result.status !== 'passed') {
    throw new Error('standard review result identity invalid');
  }
  if (!['GO', 'CONDITIONAL_GO'].includes(result.decision_hint)) throw new Error('standard review result decision invalid');
  try { assert.deepStrictEqual(result.metrics, metrics.metrics); } catch { throw new Error('standard review embedded metrics mismatch'); }
  try { assert.deepStrictEqual(result.metrics_provenance, metrics.provenance); } catch { throw new Error('standard review embedded provenance mismatch'); }
  if (!exactKeys(result.automation, ['manifest_sha256', 'trusted_completion'])
    || result.automation.manifest_sha256 !== metrics.provenance.manifest_sha256
    || result.automation.trusted_completion !== true) {
    throw new Error('standard review automation identity invalid');
  }

  const thresholds = metricDecision(metrics.metrics);
  if (thresholds.correctness.length > 0) throw new Error('standard review correctness threshold invalid');
  const outcome = deriveReviewOutcome({
    checklistPresent: false,
    termsApproved: false,
    sourceRecorded: false,
    isolationPassed: false,
    performanceReasons: thresholds.performance,
    correctnessAccepted: metrics.provenance.correctness_counters.acceptance
  });
  if (result.decision_hint !== outcome.decision) throw new Error('standard review result decision invalid');
  try { assert.deepStrictEqual(result.reasons, outcome.reasons); } catch { throw new Error('standard review result reasons invalid'); }
  try { assert.deepStrictEqual(result.limitations, outcome.limitations); } catch { throw new Error('standard review result limitations invalid'); }

  const completionValidation = validateAutomationCompletion(completion, {
    fixture,
    sessionId: metrics.provenance.session_id,
    manifestSha256: expected.manifestSha256,
    capturedAt: metrics.provenance.captured_at,
    now: expected.now
  });
  if (completionValidation.errors.length > 0) {
    const reason = completionValidation.errors.includes('AUTOMATION_COMPLETION_PREVIEW_ORDER_INVALID')
      ? 'standard review completion preview order invalid'
      : completionValidation.errors.includes('AUTOMATION_COMPLETION_SCHEMA_INVALID')
        ? 'standard review completion schema invalid'
        : 'standard review completion invalid';
    throw new Error(`${reason}: ${completionValidation.errors.join(',')}`);
  }
  return {
    decision: result.decision_hint,
    fixture,
    manifestSha256: expected.manifestSha256,
    rendererEnvironmentSha256: expected.rendererEnvironmentSha256,
    sessionId: metrics.provenance.session_id,
    capturedAt: metrics.provenance.captured_at,
    completedAt: completion.completed_at,
    peakRssBytes: metrics.metrics.peak_rss_bytes,
    cacheBytes: metrics.metrics.cache_bytes,
    previewHashes: structuredClone(completion.preview_hashes)
  };
}

function buildStandardReviewEvidenceBinding({
  validated, resultSha256, metricsSha256, completionSha256,
  rendererProvenanceSha256
}) {
  for (const [label, value] of [
    ['result', resultSha256], ['metrics', metricsSha256], ['completion', completionSha256],
    ['renderer provenance', rendererProvenanceSha256]
  ]) if (!SHA256.test(value ?? '')) throw new Error(`${label} SHA-256 invalid`);
  const binding = canonical({
    schema_id: 'superwagie.standard-review-evidence-binding.v2',
    schema_version: 2,
    fixture: validated.fixture,
    result: { gate: 'gate-3', fixture: validated.fixture, decision: validated.decision, schema_version: 1 },
    metrics: {
      fixture: validated.fixture,
      session_id: validated.sessionId,
      manifest_sha256: validated.manifestSha256,
      renderer_environment_sha256: validated.rendererEnvironmentSha256,
      captured_at: validated.capturedAt
    },
    completion: {
      fixture: validated.fixture,
      session_id: validated.sessionId,
      manifest_sha256: validated.manifestSha256,
      metrics_file: 'review-automation-metrics.json',
      completed_at: validated.completedAt,
      preview_hashes: validated.previewHashes
    },
    trusted_expected: {
      fixture_manifest_sha256: validated.manifestSha256,
      renderer_environment_sha256: validated.rendererEnvironmentSha256,
      renderer_provenance_sha256: rendererProvenanceSha256
    },
    files: {
      result_sha256: resultSha256,
      metrics_sha256: metricsSha256,
      completion_sha256: completionSha256,
      renderer_provenance_sha256: rendererProvenanceSha256
    }
  });
  return { ...binding, canonical_sha256: canonicalSha256(binding) };
}

export {
  REQUIRED_METRICS,
  buildStandardReviewEvidenceBinding,
  deriveReviewOutcome,
  metricDecision,
  validateAutomationCompletion,
  validateAutomationFailure,
  validateMetricsDocument,
  validateStandardReviewEvidence
};
