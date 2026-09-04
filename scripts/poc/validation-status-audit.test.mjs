import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  EXPECTED_FIXTURES,
  auditValidationStatus,
  projectFormatAdmissionState,
} from './validation-status-audit.mjs';

const EXPECTED_IDS = [
  'CF-PROTOCOL-002',
  'G0-SHELL-002',
  'G0-ISOLATION-001',
  'G0-DEPS-001',
  'G1-WORKSPACE-001',
  'G1-CRASH-001',
  'G1-MARKDOWN-001',
  'G1-TASK-001',
  'G1-DIAGRAM-001',
  'G2-THREAD-001',
  'G2-AGENT-001',
  'G2-WORKFLOW-001',
  'G2-HOST-001',
  'G2-CONTINUITY-001',
  'G3-PPT-001',
  'G3-WRITER-001',
  'G3-REVIEW-001',
  'G3-REVIEW-002',
  'G3-HTML-001',
  'G4-VIDEO-001',
  'G4-VIDEO-002',
  'G4-VIDEO-003',
  'G4-VIDEO-004',
  'G4-VIDEO-005',
  'G5-EXT-001',
  'G5-ATTACK-001',
  'G5-FACADE-001',
  'G5-CONNECTOR-001',
  'G5-MEMORY-001',
  'G6-BILLING-001',
  'G6-PACKAGE-001',
  'GVP-0',
  'GVP-1',
  'GVP-2',
  'GVP-3',
  'GVP-4',
  'GVP-5',
];

function writeEvidence(root, gate, run, result, decision = null) {
  const directory = join(root, 'evidence', gate, run);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'results.json'), `${JSON.stringify(result)}\n`);
  if (decision !== null) {
    writeFileSync(join(directory, 'decision.md'), decision);
  }
}

function boundSignedDecision({ gate, fixture, platform, result }) {
  const serialized = `${JSON.stringify(result)}\n`;
  const digest = createHash('sha256').update(serialized).digest('hex');
  return [
    '# Decision', '',
    '- signed decision: GO',
    `- gate: ${gate}`,
    `- fixture: ${fixture}`,
    `- platform: ${platform}`,
    `- evidence_sha256: sha256:${digest}`,
    '- owner role: Desktop Runtime',
    '- signed_at: 2026-09-01T00:00:00Z', '',
  ].join('\n');
}

test('registry contains every authoritative fixture exactly once', () => {
  const actual = EXPECTED_FIXTURES.map(({ fixture }) => fixture);
  assert.deepEqual([...actual].sort(), [...EXPECTED_IDS].sort());
  assert.equal(new Set(actual).size, EXPECTED_IDS.length);
});

test('all Universal Viewer gates begin RESEARCH_REQUIRED', () => {
  const viewer = EXPECTED_FIXTURES.filter(({ fixture }) => fixture.startsWith('GVP-'));
  assert.equal(viewer.length, 6);
  assert.ok(viewer.every(({ technical_state }) => technical_state === 'RESEARCH_REQUIRED'));
  assert.deepEqual(Object.fromEntries(viewer.map(({ fixture, meaning }) => [fixture, meaning])), {
    'GVP-0': 'Contract + Provenance',
    'GVP-1': 'Office Fidelity',
    'GVP-2': 'Per-format Corpus',
    'GVP-3': 'Isolation + Malicious Files',
    'GVP-4': 'Package + Performance',
    'GVP-5': 'Product Integration + Recovery',
  });
  assert.deepEqual(viewer.map(({ gate }) => gate), ['gvp-0', 'gvp-1', 'gvp-2', 'gvp-3', 'gvp-4', 'gvp-5']);
});

function writeViewerReceipt(root, { verdict = 'NO_GO', platform = 'macos-15-arm64' } = {}) {
  const directory = join(root, 'evidence', 'gvp-0', '20260904T120000000Z-1-aabbccddeeff0011');
  mkdirSync(join(directory, 'artifacts'), { recursive: true });
  const summary = {
    scope: 'disposable-admission-poc', production_registry_admitted: false,
    production_chunk_signed: false, release_admission: 'NO_GO',
    remaining_gates: ['GVP-1', 'GVP-2', 'GVP-3', 'GVP-4', 'GVP-5'],
  };
  const summaryBytes = `${JSON.stringify(summary, null, 2)}\n`;
  writeFileSync(join(directory, 'artifacts', 'acceptance-summary.json'), summaryBytes);
  const manifest = {
    schema_id: 'superwagie.gvp-0-evidence-manifest.v1', gate_id: 'GVP-0',
    corpus_id: 'GVP-0-CORE-001', platform_id: platform,
    chunk_manifest_set_sha256: `sha256:${'b'.repeat(64)}`,
    artifacts: [{ path: 'artifacts/acceptance-summary.json', sha256: `sha256:${createHash('sha256').update(summaryBytes).digest('hex')}` }],
  };
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(join(directory, 'artifacts', 'evidence-manifest.json'), manifestBytes);
  const result = {
    receipt_id: `gvp0-core-macos-${verdict.toLowerCase().replace('_', '-')}`,
    gate_id: 'GVP-0', format_variant_id: 'universal.viewer.core', viewer_id: 'omni-viewer-core',
    viewer_version: '0.16.0+ffdcda3eea83527380996ac935605f1422e43d3b', platform_id: platform,
    verdict, corpus_id: 'GVP-0-CORE-001', corpus_sha256: `sha256:${'a'.repeat(64)}`,
    chunk_manifest_sha256: manifest.chunk_manifest_set_sha256,
    evidence_sha256: `sha256:${createHash('sha256').update(manifestBytes).digest('hex')}`,
    issued_at: '2026-09-04T12:00:00.000Z',
  };
  writeFileSync(join(directory, 'results.json'), `${JSON.stringify(result, null, 2)}\n`);
}

test('GVP receipts are audited only from their own namespace and remain non-admitting', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-gvp-status-'));
  writeViewerReceipt(root);
  writeEvidence(root, 'gate-3', '20260904T120000001Z-2', {
    gate: 'gate-3', fixture: 'G3-REVIEW-001', gate_id: 'GVP-0', platform: 'windows-11-x64',
    pass: true, decision_hint: 'GO',
  });
  const entry = auditValidationStatus({ repoRoot: root }).fixtures.find(({ fixture }) => fixture === 'GVP-0');
  assert.equal(entry.execution, 'no_go');
  assert.equal(entry.technical_state, 'RESEARCH_REQUIRED');
  assert.equal(entry.admission, 'not_ready');
  assert.deepEqual(entry.platforms_seen, ['macos-15-arm64']);
  assert.deepEqual(entry.platforms_go, []);
  assert.deepEqual(entry.missing_platforms, ['windows-11-x64']);
});

test('CONDITIONAL_GO Viewer evidence never counts as GO coverage', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-gvp-status-'));
  writeViewerReceipt(root, { verdict: 'CONDITIONAL_GO' });
  const entry = auditValidationStatus({ repoRoot: root }).fixtures.find(({ fixture }) => fixture === 'GVP-0');
  assert.equal(entry.execution, 'conditional_go');
  assert.deepEqual(entry.platforms_go, []);
  assert.equal(entry.admission, 'not_ready');
});

test('a gate-wide GVP-0 receipt cannot promote a format ledger record', () => {
  const ledger = {
    records: [{
      format_variant_id: 'office.docx.ooxml', current_state: 'RESEARCH_REQUIRED',
      required_platforms: ['macos-15-arm64', 'windows-11-x64'],
      required_gates: ['GVP-0', 'GVP-1', 'GVP-2', 'GVP-3', 'GVP-4', 'GVP-5'],
      admission_receipt_refs: [],
    }],
  };
  const projection = projectFormatAdmissionState(ledger);
  assert.equal(projection.records, 1);
  assert.equal(projection.research_required, 1);
  assert.equal(projection.complete_record_receipts, 0);
  assert.equal(projection.release_admission, 'NO_GO');
});

test('solution B fixtures require the current evidence revision', () => {
  const byFixture = new Map(EXPECTED_FIXTURES.map((entry) => [entry.fixture, entry]));
  for (const fixture of [
    'G0-ISOLATION-001',
    'G0-DEPS-001',
    'G2-THREAD-001',
    'G2-WORKFLOW-001',
    'G2-HOST-001',
    'G3-REVIEW-001',
    'G3-REVIEW-002',
    'G4-VIDEO-001',
    'G4-VIDEO-002',
    'G4-VIDEO-003',
    'G4-VIDEO-004',
    'G4-VIDEO-005',
    'G5-EXT-001',
    'G5-ATTACK-001',
    'G5-FACADE-001',
    'G6-PACKAGE-001',
  ]) {
    assert.equal(byFixture.get(fixture)?.evidence_revision, 'solution-b-v1', fixture);
  }
});

test('audit fails closed when a results-bound parity artifact is tampered', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-validation-artifact-binding-'));
  const directory = join(root, 'evidence', 'gate-5', '20260101T000000Z-1');
  mkdirSync(join(directory, 'artifacts'), { recursive: true });
  const artifact = `${JSON.stringify({ methods_covered: 34 })}\n`;
  const artifactHash = `sha256:${createHash('sha256').update(artifact).digest('hex')}`;
  const result = {
    gate: 'gate-5', fixture: 'G5-FACADE-001', evidence_revision: 'solution-b-v1',
    pass: true, decision_hint: 'CONDITIONAL_GO', limitation: 'handlers pending',
    facade_parity_evidence: {
      artifact: 'artifacts/facade-parity.json', sha256: artifactHash, summary: { methods_covered: 34 },
    },
  };
  writeFileSync(join(directory, 'artifacts', 'facade-parity.json'), artifact);
  writeFileSync(join(directory, 'results.json'), `${JSON.stringify(result)}\n`);
  let report = auditValidationStatus({ repoRoot: root });
  assert.equal(report.fixtures.find(({ fixture }) => fixture === 'G5-FACADE-001').execution, 'conditional_go');

  writeFileSync(join(directory, 'artifacts', 'facade-parity.json'), `${artifact}tampered\n`);
  report = auditValidationStatus({ repoRoot: root });
  assert.equal(report.fixtures.find(({ fixture }) => fixture === 'G5-FACADE-001').execution, 'invalid_evidence');
});

function writerResultWithArtifacts(files, platform = 'macos-15-arm64') {
  const artifacts = Object.entries(files).map(([path, bytes]) => ({
    path,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }));
  return {
    schema_id: 'superwagie.g3-writer-gate-result.v1', schema_version: 1,
    gate: 'gate-3', fixture: 'G3-WRITER-001', platform,
    pass: true, status: 'passed', decision_hint: 'GO', reasons: [], limitations: [],
    evidence_binding: {
      evaluation_sha256: 'a'.repeat(64), human_receipt_sha256: 'b'.repeat(64),
      artifact_set_sha256: createHash('sha256').update(JSON.stringify(artifacts)).digest('hex'),
      generation_receipt_sha256: 'c'.repeat(64), wps_renderer_identity_sha256: 'd'.repeat(64),
      wps_session_id: 'session-1', artifacts,
    },
  };
}

test('Writer platform coverage excludes each candidate whose own artifact binding is invalid', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-writer-platform-audit-'));
  const macResult = {
    schema_id: 'superwagie.g3-writer-gate-result.v1', schema_version: 1,
    gate: 'gate-3', fixture: 'G3-WRITER-001', platform: 'macos-15-arm64',
    pass: true, status: 'passed', decision_hint: 'GO', reasons: [], limitations: [],
    evidence_binding: {
      evaluation_sha256: 'a'.repeat(64), human_receipt_sha256: 'b'.repeat(64),
      artifact_set_sha256: 'c'.repeat(64),
    },
  };
  writeEvidence(root, 'gate-3', '20260101T000000Z-1', macResult,
    boundSignedDecision({ gate: 'gate-3', fixture: 'G3-WRITER-001', platform: 'macos-15-arm64', result: macResult }));

  const windowsDirectory = join(root, 'evidence', 'gate-3', '20260101T000001Z-2');
  const evidenceBytes = Buffer.from('valid Windows Writer evidence\n');
  mkdirSync(join(windowsDirectory, 'artifacts'), { recursive: true });
  writeFileSync(join(windowsDirectory, 'artifacts', 'evaluation.json'), evidenceBytes);
  const windowsResult = writerResultWithArtifacts(
    { 'artifacts/evaluation.json': evidenceBytes },
    'windows-11-x64',
  );
  writeEvidence(root, 'gate-3', '20260101T000001Z-2', windowsResult,
    boundSignedDecision({ gate: 'gate-3', fixture: 'G3-WRITER-001', platform: 'windows-11-x64', result: windowsResult }));

  const entry = auditValidationStatus({ repoRoot: root }).fixtures.find(({ fixture }) => fixture === 'G3-WRITER-001');
  assert.deepEqual(entry.platforms_go, ['windows-11-x64']);
  assert.deepEqual(entry.platforms_signed, ['windows-11-x64']);
  assert.deepEqual(entry.platforms_without_go, ['macos-15-arm64']);
  assert.equal(entry.admission, 'unsigned');
});

test('Writer GO without a complete published artifact manifest is invalid evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-writer-audit-'));
  writeEvidence(root, 'gate-3', '20260101T000000Z-1', {
    schema_id: 'superwagie.g3-writer-gate-result.v1', schema_version: 1,
    gate: 'gate-3', fixture: 'G3-WRITER-001', platform: 'macos-15-arm64',
    pass: true, status: 'passed', decision_hint: 'GO', reasons: [], limitations: [],
    evidence_binding: { evaluation_sha256: 'a'.repeat(64), human_receipt_sha256: 'b'.repeat(64), artifact_set_sha256: 'c'.repeat(64) },
  });
  const entry = auditValidationStatus({ repoRoot: root }).fixtures.find(({ fixture }) => fixture === 'G3-WRITER-001');
  assert.equal(entry.execution, 'invalid_evidence');
  assert.match(entry.validation_error, /Writer.*artifact|manifest|binding/i);
});

test('Writer GO becomes invalid when a bound artifact is missing, changed, symlinked, or an extra file appears', () => {
  for (const attack of ['missing', 'changed', 'symlink', 'extra']) {
    const root = mkdtempSync(join(tmpdir(), 'superwagie-writer-audit-'));
    const directory = join(root, 'evidence', 'gate-3', '20260101T000000Z-1');
    const fileBytes = Buffer.from('bound Writer evidence\n');
    mkdirSync(join(directory, 'artifacts'), { recursive: true });
    if (attack !== 'missing' && attack !== 'symlink') writeFileSync(join(directory, 'artifacts', 'evaluation.json'), attack === 'changed' ? 'tampered\n' : fileBytes);
    if (attack === 'symlink') {
      writeFileSync(join(directory, 'outside.json'), fileBytes);
      symlinkSync(join(directory, 'outside.json'), join(directory, 'artifacts', 'evaluation.json'));
    }
    if (attack === 'extra') writeFileSync(join(directory, 'artifacts', 'unbound.txt'), 'extra\n');
    const result = writerResultWithArtifacts({ 'artifacts/evaluation.json': fileBytes });
    writeFileSync(join(directory, 'results.json'), `${JSON.stringify(result)}\n`);
    const entry = auditValidationStatus({ repoRoot: root }).fixtures.find(({ fixture }) => fixture === 'G3-WRITER-001');
    assert.equal(entry.execution, 'invalid_evidence', attack);
  }
});

test('audit separates execution outcome from signed admission', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-validation-audit-'));
  writeEvidence(
    root,
    'gate-0',
    '20260101T000000Z-1',
    {
      gate: 'gate-0',
      fixture: 'G0-SHELL-002',
      pass: true,
      decision_hint: 'GO',
    },
    '# Decision (draft)\n\n- draft decision: GO (待所有者角色签署后生效)\n',
  );
  writeEvidence(
    root,
    'gate-0',
    '20260101T000001Z-2',
    {
      gate: 'gate-0',
      fixture: 'G0-ISOLATION-001',
      evidence_revision: 'solution-b-v1',
      pass: true,
      decision_hint: 'CONDITIONAL_GO',
      limitations: ['runtime comparison pending'],
    },
  );
  writeEvidence(
    root,
    'gate-0',
    '20260101T000002Z-3',
    {
      gate: 'gate-0',
      fixture: 'G0-DEPS-001',
      evidence_revision: 'solution-b-v1',
      pass: false,
      status: 'blocked',
      decision_hint: 'BLOCKED_ENVIRONMENT',
      reasons: ['WINDOWS_REQUIRED'],
    },
  );

  const report = auditValidationStatus({
    repoRoot: root,
    generatedAt: '2026-09-01T00:00:00.000Z',
  });
  const byFixture = new Map(report.fixtures.map((entry) => [entry.fixture, entry]));

  assert.equal(byFixture.get('G0-SHELL-002').execution, 'go');
  assert.equal(byFixture.get('G0-SHELL-002').admission, 'unsigned');
  assert.equal(byFixture.get('G0-ISOLATION-001').execution, 'conditional_go');
  assert.equal(byFixture.get('G0-ISOLATION-001').admission, 'not_ready');
  assert.deepEqual(byFixture.get('G0-ISOLATION-001').limitations, ['runtime comparison pending']);
  assert.equal(byFixture.get('G0-DEPS-001').execution, 'blocked_environment');
  assert.deepEqual(byFixture.get('G0-DEPS-001').reasons, ['WINDOWS_REQUIRED']);
  assert.equal(byFixture.get('G6-PACKAGE-001').execution, 'missing');
  assert.equal(report.summary.expected, 37);
  assert.equal(report.summary.go, 1);
  assert.equal(report.summary.conditional_go, 1);
  assert.equal(report.summary.blocked_environment, 1);
  assert.equal(report.summary.missing, 28);
  assert.equal(report.summary.signed_go, 0);
  assert.equal(report.production_implementation_admission, 'NO_GO');
});

test('evidence from a superseded architecture revision is never admitted', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-validation-audit-'));
  writeEvidence(root, 'gate-2', '20260101T000000Z-1', {
    gate: 'gate-2',
    fixture: 'G2-THREAD-001',
    evidence_revision: 'legacy-tauri-v1',
    pass: true,
    decision_hint: 'GO',
  }, '# Decision\n\n- signed decision: GO\n- owner role: Agent Session\n- signed_at: 2026-01-01T00:00:00Z\n');

  const report = auditValidationStatus({ repoRoot: root });
  const entry = report.fixtures.find(({ fixture }) => fixture === 'G2-THREAD-001');
  assert.equal(entry.execution, 'superseded_evidence');
  assert.equal(entry.admission, 'not_ready');
  assert.equal(entry.evidence, null);
  assert.equal(entry.superseded_evidence.length, 1);
  assert.equal(report.summary.superseded_evidence, 1);
  assert.equal(report.summary.go, 0);
  assert.equal(report.summary.signed_go, 0);
});

test('newest malformed or mismatched evidence fails closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-validation-audit-'));
  writeEvidence(root, 'gate-1', '20260101T000000Z-1', {
    gate: 'gate-1',
    fixture: 'G1-WORKSPACE-001',
    pass: true,
    decision_hint: 'GO',
  });
  writeEvidence(root, 'gate-1', '20260101T000001Z-2', {
    gate: 'gate-9',
    fixture: 'G1-WORKSPACE-001',
    pass: true,
    decision_hint: 'GO',
  });

  const report = auditValidationStatus({ repoRoot: root });
  const entry = report.fixtures.find(({ fixture }) => fixture === 'G1-WORKSPACE-001');
  assert.equal(entry.execution, 'invalid_evidence');
  assert.equal(entry.admission, 'not_ready');
  assert.match(entry.validation_error, /gate mismatch/);
});

test('legacy macos-arm64 evidence is normalized to the canonical platform id', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-validation-audit-'));
  writeEvidence(root, 'gate-0', '20260101T000000Z-1', {
    gate: 'gate-0',
    fixture: 'G0-DEPS-001',
    evidence_revision: 'solution-b-v1',
    pass: true,
    decision_hint: 'GO',
  });
  const directory = join(root, 'evidence', 'gate-0', '20260101T000000Z-1');
  writeFileSync(join(directory, 'manifest.json'), `${JSON.stringify({ platform: 'macos-arm64' })}\n`);

  const report = auditValidationStatus({ repoRoot: root });
  const entry = report.fixtures.find(({ fixture }) => fixture === 'G0-DEPS-001');
  assert.deepEqual(entry.platforms_seen, ['macos-15-arm64']);
  assert.deepEqual(entry.platforms_go, ['macos-15-arm64']);
  assert.deepEqual(entry.missing_platforms, ['windows-11-x64']);
  assert.deepEqual(entry.platforms_without_go, ['windows-11-x64']);
});

test('conditional platform evidence is seen but cannot satisfy signed GO coverage', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-validation-audit-'));
  writeEvidence(root, 'gate-0', '20260101T000000Z-1', {
    gate: 'gate-0',
    fixture: 'G0-ISOLATION-001',
    evidence_revision: 'solution-b-v1',
    platform: 'macos-15-arm64',
    pass: true,
    decision_hint: 'CONDITIONAL_GO',
  });
  const report = auditValidationStatus({ repoRoot: root });
  const entry = report.fixtures.find(({ fixture }) => fixture === 'G0-ISOLATION-001');
  assert.deepEqual(entry.platforms_seen, ['macos-15-arm64']);
  assert.deepEqual(entry.platforms_go, []);
  assert.deepEqual(entry.missing_platforms, ['windows-11-x64']);
  assert.deepEqual(entry.platforms_without_go, ['macos-15-arm64', 'windows-11-x64']);
  assert.equal(entry.admission, 'not_ready');
});

test('every required platform needs its own signed GO evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-validation-audit-'));
  const macResult = {
    gate: 'gate-0', fixture: 'G0-SHELL-002', platform: 'macos-15-arm64',
    pass: true, decision_hint: 'GO',
  };
  const windowsResult = {
    gate: 'gate-0', fixture: 'G0-SHELL-002', platform: 'windows-11-x64',
    pass: true, decision_hint: 'GO',
  };
  const macSigned = boundSignedDecision({ gate: 'gate-0', fixture: 'G0-SHELL-002', platform: 'macos-15-arm64', result: macResult });
  const windowsSigned = boundSignedDecision({ gate: 'gate-0', fixture: 'G0-SHELL-002', platform: 'windows-11-x64', result: windowsResult });
  writeEvidence(root, 'gate-0', '20260101T000000Z-1', macResult);
  writeEvidence(root, 'gate-0', '20260101T000001Z-2', windowsResult, windowsSigned);

  let report = auditValidationStatus({ repoRoot: root });
  let entry = report.fixtures.find(({ fixture }) => fixture === 'G0-SHELL-002');
  assert.deepEqual(entry.platforms_signed, ['windows-11-x64']);
  assert.equal(entry.admission, 'unsigned');

  writeFileSync(join(root, 'evidence', 'gate-0', '20260101T000000Z-1', 'decision.md'), macSigned);
  report = auditValidationStatus({ repoRoot: root });
  entry = report.fixtures.find(({ fixture }) => fixture === 'G0-SHELL-002');
  assert.deepEqual(entry.platforms_signed, ['macos-15-arm64', 'windows-11-x64']);
  assert.equal(entry.admission, 'signed_go');
});

test('an unbound or copied decision text cannot create signed admission', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-validation-audit-'));
  const result = {
    gate: 'gate-1', fixture: 'G1-TASK-001', platform: 'macos-15-arm64',
    pass: true, decision_hint: 'GO',
  };
  writeEvidence(root, 'gate-1', '20260101T000000Z-1', result,
    '# Decision\n\n- signed decision: GO\n- owner role: Tasks\n- signed_at: 2026-09-01T00:00:00Z\n');
  let report = auditValidationStatus({ repoRoot: root });
  let entry = report.fixtures.find(({ fixture }) => fixture === 'G1-TASK-001');
  assert.equal(entry.admission, 'unsigned');

  writeFileSync(
    join(root, 'evidence', 'gate-1', '20260101T000000Z-1', 'decision.md'),
    boundSignedDecision({ gate: 'gate-1', fixture: 'G1-TASK-001', platform: 'macos-15-arm64', result }),
  );
  report = auditValidationStatus({ repoRoot: root });
  entry = report.fixtures.find(({ fixture }) => fixture === 'G1-TASK-001');
  assert.equal(entry.admission, 'signed_go');
});

test('newer platform evidence supersedes older GO and signature coverage', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-validation-audit-'));
  const oldResult = {
    gate: 'gate-0', fixture: 'G0-DEPS-001', evidence_revision: 'solution-b-v1',
    platform: 'macos-15-arm64', pass: true, decision_hint: 'GO',
  };
  writeEvidence(
    root, 'gate-0', '20260101T000000Z-1', oldResult,
    boundSignedDecision({ gate: 'gate-0', fixture: 'G0-DEPS-001', platform: 'macos-15-arm64', result: oldResult }),
  );
  writeEvidence(root, 'gate-0', '20260101T000001Z-2', {
    gate: 'gate-0', fixture: 'G0-DEPS-001', evidence_revision: 'solution-b-v1',
    platform: 'macos-15-arm64', pass: true, decision_hint: 'CONDITIONAL_GO',
  });

  const report = auditValidationStatus({ repoRoot: root });
  const entry = report.fixtures.find(({ fixture }) => fixture === 'G0-DEPS-001');
  assert.equal(entry.execution, 'conditional_go');
  assert.deepEqual(entry.platforms_seen, ['macos-15-arm64']);
  assert.deepEqual(entry.platforms_go, []);
  assert.deepEqual(entry.platforms_signed, []);
  assert.deepEqual(entry.platforms_without_go, ['macos-15-arm64', 'windows-11-x64']);
});
