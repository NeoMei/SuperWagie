import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  buildStandardReviewEvidenceBinding,
  validateAutomationFailure,
  validateStandardReviewEvidence
} from './standard-review-evidence.mjs';

const HASH = (character) => character.repeat(64);
const SESSION = '0123456789abcdef0123456789abcdef';
const EXPECTED = {
  fixture: 'G3-REVIEW-001',
  manifestSha256: HASH('1'),
  rendererEnvironmentSha256: HASH('2')
};

function standardEvidence() {
  const capturedAt = new Date().toISOString();
  const metrics = {
    metrics: {
      progress_visible_ms: 20,
      cached_first_page_p95_ms: 200,
      authoritative_first_reviewable_page_ms: 600,
      interaction_p95_ms: 30,
      peak_rss_bytes: 1_000_000,
      cache_bytes: 2_000_000,
      reanchor_resolved: 0,
      reanchor_unresolved: 0,
      reanchor_silent_misplaced: 0,
      visual_diff_ratio: 0
    },
    provenance: {
      fixture: 'G3-REVIEW-001',
      session_id: SESSION,
      manifest_sha256: HASH('1'),
      captured_at: capturedAt,
      representative_machine: true,
      renderer_environment_sha256: HASH('2'),
      host_measurements: {
        source: 'trusted-native-host',
        peak_rss_bytes: 1_000_000,
        cache_bytes: 2_000_000
      },
      correctness_counters: { acceptance: false, basis: 'task-9-required' },
      samples: {
        progress: 1,
        cachedFirstPage: 20,
        authoritativeFirstPage: 3,
        interactions: 20
      }
    }
  };
  const result = {
    schema_version: 1,
    gate: 'gate-3',
    fixture: 'G3-REVIEW-001',
    pass: true,
    status: 'passed',
    decision_hint: 'CONDITIONAL_GO',
    reasons: [
      'CODEX_NEVER_INSTALLED_EVIDENCE_REQUIRED',
      'CORRECTNESS_COUNTERS_NON_ACCEPTANCE',
      'MANUAL_CHECKLIST_REQUIRED',
      'WPS_TERMS_REVIEW_REQUIRED'
    ],
    limitations: [
      'G3-REVIEW-001 has no valid manual visual checklist.',
      'WPS commercial-use/redistribution terms and WPSComposer source identity require review.',
      'A passing G3-REVIEW-002 codex-never-installed result is required before GO.',
      'Correctness counters are diagnostic only until Task 9 validation.'
    ],
    metrics: structuredClone(metrics.metrics),
    metrics_provenance: structuredClone(metrics.provenance),
    automation: { manifest_sha256: HASH('1'), trusted_completion: true }
  };
  const completion = {
    session_id: SESSION,
    fixture: 'G3-REVIEW-001',
    manifest_sha256: HASH('1'),
    metrics_file: 'review-automation-metrics.json',
    completed_at: capturedAt,
    preview_hashes: [
      { pageId: 'pdf:page-1', sha256: HASH('3') },
      { pageId: 'docx:page-1', sha256: HASH('4') },
      { pageId: 'pptx:page-1', sha256: HASH('5') }
    ]
  };
  return { result, metrics, completion };
}

function expectRejected(mutator, pattern = /standard review/i) {
  const evidence = standardEvidence();
  mutator(evidence);
  assert.throws(() => validateStandardReviewEvidence(evidence, EXPECTED), pattern);
}

function automationFailure() {
  return {
    schema_id: 'superwagie.review-automation-failure.v1', schema_version: 1,
    session_id: SESSION, fixture: 'G3-REVIEW-001', manifest_sha256: HASH('1'),
    renderer_environment_sha256: HASH('2'), failed_at: Date.now(),
    state: 'dependency_missing', error_code: 'SW_REVIEW_RENDER_DEPENDENCY_MISSING'
  };
}

test('strict standard review evidence accepts the controlled CONDITIONAL_GO chain', () => {
  const evidence = standardEvidence();
  const validated = validateStandardReviewEvidence(evidence, EXPECTED);
  assert.equal(validated.decision, 'CONDITIONAL_GO');
  assert.equal(validated.peakRssBytes, 1_000_000);
  assert.deepEqual(validated.previewHashes, evidence.completion.preview_hashes);
});

test('trusted automation failure accepts the exact client-stage pair only', () => {
  const failure = automationFailure();
  failure.state = 'failed_terminal';
  for (const errorCode of [
    'SW_REVIEW_AUTOMATION_DOCX_AUTHORITATIVE_FAILED',
    'SW_REVIEW_AUTOMATION_PDF_MANIFEST_PAGES_FAILED',
    'SW_REVIEW_AUTOMATION_PDF_MANIFEST_SOURCE_FAILED',
    'SW_REVIEW_AUTOMATION_PDF_MANIFEST_HASHES_FAILED',
    'SW_REVIEW_AUTOMATION_PDF_MANIFEST_REVISION_FAILED',
    'SW_REVIEW_AUTOMATION_PDF_MANIFEST_REVISION_ID_FAILED',
    'SW_REVIEW_AUTOMATION_PDF_MANIFEST_SESSION_FAILED'
  ]) {
    failure.error_code = errorCode;
    assert.deepEqual(validateAutomationFailure(failure, {
      fixture: 'G3-REVIEW-001', sessionId: SESSION,
      manifestSha256: HASH('1'), rendererEnvironmentSha256: HASH('2'),
      now: failure.failed_at, notBefore: failure.failed_at
    }).errors, []);
  }

  failure.error_code = 'SW_REVIEW_AUTOMATION_UNKNOWN_FAILED';
  assert.deepEqual(validateAutomationFailure(failure, {
    fixture: 'G3-REVIEW-001', sessionId: SESSION,
    manifestSha256: HASH('1'), rendererEnvironmentSha256: HASH('2'),
    now: failure.failed_at, notBefore: failure.failed_at
  }).errors, ['AUTOMATION_FAILURE_STATE_INVALID']);
});

test('strict standard review evidence requires externally trusted manifest and renderer expectations', () => {
  const evidence = standardEvidence();
  assert.throws(() => validateStandardReviewEvidence(evidence), /trusted expected/i);
  evidence.result.metrics_provenance.manifest_sha256 = HASH('9');
  evidence.metrics.provenance.manifest_sha256 = HASH('9');
  evidence.result.automation.manifest_sha256 = HASH('9');
  evidence.completion.manifest_sha256 = HASH('9');
  assert.throws(() => validateStandardReviewEvidence(evidence, EXPECTED), /metrics/i);
});

test('strict standard review result binds exact embedded metrics and provenance', () => {
  expectRejected(({ result }) => { result.metrics.interaction_p95_ms += 1; }, /embedded metrics/i);
  expectRejected(({ result }) => { result.metrics_provenance.renderer_environment_sha256 = HASH('9'); }, /embedded provenance/i);
  expectRejected(({ result }) => { result.extra = true; }, /result schema/i);
  expectRejected(({ result }) => { result.status = 'failed'; }, /result identity/i);
  expectRejected(({ result }) => { result.decision_hint = 'GO'; }, /result decision/i);
  expectRejected(({ result }) => { result.reasons.pop(); }, /result reasons/i);
  expectRejected(({ result }) => { result.limitations.reverse(); }, /result limitations/i);
});

test('strict standard metrics reject renderer, native RSS/cache, sample, and schema drift', () => {
  expectRejected(({ metrics }) => { metrics.provenance.renderer_environment_sha256 = HASH('8'); }, /metrics/i);
  expectRejected(({ metrics, result }) => {
    metrics.metrics.peak_rss_bytes = 1.5;
    metrics.provenance.host_measurements.peak_rss_bytes = 1.5;
    result.metrics = structuredClone(metrics.metrics);
    result.metrics_provenance = structuredClone(metrics.provenance);
  }, /metrics/i);
  expectRejected(({ metrics, result }) => {
    metrics.metrics.cache_bytes = 0;
    metrics.provenance.host_measurements.cache_bytes = 0;
    result.metrics = structuredClone(metrics.metrics);
    result.metrics_provenance = structuredClone(metrics.provenance);
  }, /metrics/i);
  expectRejected(({ metrics, result }) => {
    metrics.provenance.samples.interactions = 0;
    result.metrics_provenance = structuredClone(metrics.provenance);
  }, /metrics/i);
  expectRejected(({ metrics, result }) => {
    metrics.extra = true;
    result.metrics = structuredClone(metrics.metrics);
    result.metrics_provenance = structuredClone(metrics.provenance);
  }, /metrics schema/i);
});

test('strict completion rejects fixture, freshness, preview order/duplicates, and extra keys', () => {
  expectRejected(({ completion }) => { completion.fixture = 'G3-REVIEW-002'; }, /completion/i);
  expectRejected(({ completion }) => { completion.completed_at = '2000-01-01T00:00:00.000Z'; }, /completion/i);
  expectRejected(({ completion }) => { completion.preview_hashes.reverse(); }, /preview order/i);
  expectRejected(({ completion }) => { completion.preview_hashes[1].pageId = 'pdf:page-1'; }, /preview/i);
  expectRejected(({ completion }) => { completion.extra = true; }, /completion schema/i);
});

test('strict host failure artifact is exact, hash-bound, fresh, and closed to stable state/code pairs', () => {
  const expected = {
    ...EXPECTED, sessionId: SESSION, notBefore: Date.now() - 1000, now: Date.now()
  };
  assert.deepEqual(validateAutomationFailure(automationFailure(), expected), { errors: [] });
  for (const mutate of [
    (value) => { value.native_path = '/Users/private/document.docx'; },
    (value) => { value.session_id = 'ab'.repeat(16); },
    (value) => { value.manifest_sha256 = HASH('9'); },
    (value) => { value.renderer_environment_sha256 = HASH('8'); },
    (value) => { value.failed_at = Date.now() - 48 * 60 * 60 * 1000; },
    (value) => { value.failed_at = expected.notBefore - 1; },
    (value) => { value.error_code = 'WPS_RUNTIME_MISSING'; },
    (value) => { value.state = 'authoritative_ready'; }
  ]) {
    const value = automationFailure();
    mutate(value);
    assert.notEqual(validateAutomationFailure(value, expected).errors.length, 0);
  }
});

test('versioned binding digest covers canonical result, metrics, and completion identities and hashes', () => {
  const evidence = standardEvidence();
  const validated = validateStandardReviewEvidence(evidence, EXPECTED);
  const binding = buildStandardReviewEvidenceBinding({
    validated,
    resultSha256: HASH('a'),
    metricsSha256: HASH('b'),
    completionSha256: HASH('c'),
    rendererProvenanceSha256: HASH('d')
  });
  assert.equal(binding.schema_id, 'superwagie.standard-review-evidence-binding.v2');
  assert.equal(binding.schema_version, 2);
  assert.equal(binding.files.metrics_sha256, HASH('b'));
  assert.equal(binding.files.renderer_provenance_sha256, HASH('d'));
  assert.deepEqual(binding.trusted_expected, {
    fixture_manifest_sha256: HASH('1'),
    renderer_environment_sha256: HASH('2'),
    renderer_provenance_sha256: HASH('d')
  });
  const withoutDigest = { ...binding };
  delete withoutDigest.canonical_sha256;
  const expected = createHash('sha256').update(JSON.stringify(withoutDigest)).digest('hex');
  assert.equal(binding.canonical_sha256, expected);
  assert.doesNotMatch(JSON.stringify(binding), /[A-Za-z]:\\|\/Users\/|file:\/\//);
});
