import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  EXPECTED_FIXTURES,
  auditValidationStatus,
  projectFormatAdmissionState,
  writeAuditedStatusUpdate,
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

function writeBlockedGvp0Attempt(root, overrides = {}) {
  const runId = overrides.runId ?? '20260904T034857351Z-60679-f08a44596f5ea1e0ff3d5560';
  const directory = join(root, 'evidence', 'gvp-0', runId);
  mkdirSync(join(directory, 'artifacts'), { recursive: true });
  const manifest = {
    gate: 'gvp-0', fixture: 'GVP-0-CORE-001', platform: 'macos-15-arm64', run_id: runId,
    operator: 'test-operator', started_at: '2026-09-04T03:48:57.352Z', finished_at: '2026-09-04T03:49:12.600Z',
    ...overrides.manifest,
  };
  const environment = {
    os: 'darwin', arch: 'arm64', release: '25.6.0', node: '24.18.0', captured_at: manifest.started_at,
    ...overrides.environment,
  };
  const error = {
    code: 'GVP0_LIVE_AUDIT_UNAVAILABLE',
    error: 'poc-production-audit did not complete within the bounded environment contract',
    ...overrides.error,
  };
  const command = overrides.command ?? 'gate:gvp-0 platform:macos-15-arm64 fixture:GVP-0-CORE-001 candidate-root-sha256:60ced8b96685268cff32a9b82e54f3d0fa8794e566fce39f06d10ad7b4f888d9\n';
  const decision = overrides.decision ?? [
    '# Decision (draft)', '',
    '- gate: GVP-0',
    '- fixture: GVP-0-CORE-001',
    '- platform: macos-15-arm64',
    '- evidence_sha256: unavailable',
    '- outcome: verification failed',
    '- draft decision: BLOCKED_ENVIRONMENT (待所有者角色签署后生效)',
    `- limitation: ${error.error}`, '',
    '签署规则见 docs/技术可行性/技术验证执行计划.md §7。', '',
  ].join('\n');
  writeFileSync(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(directory, 'environment.json'), `${JSON.stringify(environment, null, 2)}\n`);
  writeFileSync(join(directory, 'command.txt'), command);
  writeFileSync(join(directory, 'stderr.log'), `${JSON.stringify(error)}\n`);
  writeFileSync(join(directory, 'stdout.log'), '');
  writeFileSync(join(directory, 'decision.md'), decision);
  writeFileSync(join(directory, 'results.json'), overrides.results ?? '');
  writeFileSync(join(directory, 'artifacts', 'evidence-manifest.json'), overrides.evidenceManifest ?? '');
  writeFileSync(join(directory, 'artifacts', 'acceptance-summary.json'), overrides.acceptanceSummary ?? '');
  return { runId, directory, manifest };
}

const REVIEWED_ATTEMPT_ROLES = Object.freeze([
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

function writeReviewedGvp0Attempt(root, overrides = {}) {
  const platform = overrides.platform ?? 'macos-15-arm64';
  const identity = platform === 'windows-11-x64'
    ? { os: 'win32', arch: 'x64', release: '10.0.26100' }
    : { os: 'darwin', arch: 'arm64', release: '25.6.0' };
  const runId = overrides.runId ?? (platform === 'windows-11-x64'
    ? '20260905T010000000Z-2-aabbccddeeff0011'
    : '20260904T034857351Z-1-f08a44596f5ea1e0');
  const directory = join(root, 'fixtures', 'gvp-0', 'GVP-0-CORE-001', 'environment-attempts', runId);
  mkdirSync(join(directory, 'artifacts'), { recursive: true });
  const manifest = {
    gate: 'gvp-0', fixture: 'GVP-0-CORE-001', platform, run_id: runId,
    operator: 'repository-review', started_at: '2026-09-04T03:48:57.352Z', finished_at: '2026-09-04T03:48:57.534Z',
    ...overrides.manifest,
  };
  const environment = {
    ...identity, node: '24.18.0', captured_at: manifest.started_at, ...overrides.environment,
  };
  const error = {
    code: 'GVP0_LIVE_AUDIT_UNAVAILABLE',
    error: 'poc-production-audit did not complete within the bounded environment contract',
    ...overrides.error,
  };
  const command = overrides.command ?? `gate:gvp-0 platform:${platform} fixture:GVP-0-CORE-001 candidate-root-sha256:${'a'.repeat(64)}\n`;
  const decision = overrides.decision ?? [
    '# Decision (draft)', '', '- gate: GVP-0', '- fixture: GVP-0-CORE-001', `- platform: ${platform}`,
    '- evidence_sha256: unavailable', '- outcome: verification failed',
    '- draft decision: BLOCKED_ENVIRONMENT (待所有者角色签署后生效)', `- limitation: ${error.error}`, '',
  ].join('\n');
  const files = new Map([
    ['manifest.json', `${JSON.stringify(manifest, null, 2)}\n`],
    ['environment.json', `${JSON.stringify(environment, null, 2)}\n`],
    ['command.txt', command], ['stderr.log', `${JSON.stringify(error)}\n`], ['stdout.log', ''],
    ['decision.md', decision], ['results.json', overrides.results ?? ''],
    ['artifacts/evidence-manifest.json', overrides.evidenceManifest ?? ''],
    ['artifacts/acceptance-summary.json', overrides.acceptanceSummary ?? ''],
  ]);
  for (const [path, bytes] of files) writeFileSync(join(directory, path), bytes);
  const artifacts = REVIEWED_ATTEMPT_ROLES.map(([role, path]) => ({
    role, path, sha256: `sha256:${createHash('sha256').update(files.get(path)).digest('hex')}`,
  }));
  const index = {
    schema_id: 'superwagie.gvp0-reviewed-environment-attempt.v1', schema_version: 1,
    gate_id: 'GVP-0', fixture: 'GVP-0-CORE-001', platform_id: platform, run_id: runId,
    review_state: 'repository_reviewed_observation', execution: 'BLOCKED_ENVIRONMENT', exit_code: 2,
    reason_code: error.code, receipt: null, artifacts,
  };
  writeFileSync(join(directory, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  if (overrides.track !== false) {
    spawnSync('git', ['init', '-q'], { cwd: root });
    spawnSync('git', ['add', '--', 'fixtures/gvp-0/GVP-0-CORE-001/environment-attempts'], { cwd: root });
  }
  return { runId, directory, manifest, index };
}

test('ignored runner evidence never becomes status until promoted into a reviewed tracked bundle', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-gvp-status-ignored-'));
  writeBlockedGvp0Attempt(root);
  const entry = auditValidationStatus({ repoRoot: root }).fixtures.find(({ fixture }) => fixture === 'GVP-0');
  assert.equal(entry.execution, 'research_required');
  assert.equal(entry.latest_attempt, undefined);
});

test('a reviewed-looking but untracked bundle cannot become status', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-gvp-status-untracked-'));
  writeReviewedGvp0Attempt(root, { track: false });
  const entry = auditValidationStatus({ repoRoot: root }).fixtures.find(({ fixture }) => fixture === 'GVP-0');
  assert.equal(entry.execution, 'research_required');
});

test('reviewed macOS and Windows attempt bundles require exact platform identities and remain receiptless', () => {
  for (const [platform, os, arch] of [
    ['macos-15-arm64', 'darwin', 'arm64'],
    ['windows-11-x64', 'win32', 'x64'],
  ]) {
    const root = mkdtempSync(join(tmpdir(), `superwagie-gvp-reviewed-${platform}-`));
    const reviewed = writeReviewedGvp0Attempt(root, { platform });
    const report = auditValidationStatus({ repoRoot: root });
    const entry = report.fixtures.find(({ fixture }) => fixture === 'GVP-0');
    assert.equal(entry.execution, 'blocked_environment');
    assert.equal(entry.receipt, null);
    assert.equal(entry.latest_attempt.platform_id, platform);
    assert.equal(entry.latest_attempt.bundle, `fixtures/gvp-0/GVP-0-CORE-001/environment-attempts/${reviewed.runId}`);
    assert.match(entry.latest_attempt.index_sha256, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(entry.latest_attempt.artifacts.length, 9);

    const wrongRoot = mkdtempSync(join(tmpdir(), `superwagie-gvp-reviewed-wrong-${platform}-`));
    writeReviewedGvp0Attempt(wrongRoot, { platform, environment: { os: `${os}-wrong`, arch } });
    assert.throws(
      () => auditValidationStatus({ repoRoot: wrongRoot }),
      /INVALID_TRACKED_GVP0_ENVIRONMENT_ATTEMPT/u,
    );
  }
});

test('reviewed attempt discovery preserves per-platform observations and selects the newest attempt', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-gvp-reviewed-both-'));
  writeReviewedGvp0Attempt(root);
  const windows = writeReviewedGvp0Attempt(root, { platform: 'windows-11-x64' });
  const entry = auditValidationStatus({ repoRoot: root }).fixtures.find(({ fixture }) => fixture === 'GVP-0');
  assert.deepEqual(entry.platforms_seen, ['macos-15-arm64', 'windows-11-x64']);
  assert.equal(entry.latest_attempt.run_id, windows.runId);
  assert.equal(entry.environment_attempts.length, 2);
  assert.ok(entry.environment_attempts.every(({ receipt }) => receipt === null));
});

test('a newer tracked invalid bundle fails closed and leaves the previous status bytes unchanged', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-gvp-reviewed-invalid-newest-'));
  writeReviewedGvp0Attempt(root);
  const statusPath = join(root, 'status.json');
  writeAuditedStatusUpdate({ repoRoot: root, statusPath });
  const before = readFileSync(statusPath, 'utf8');
  const newer = writeReviewedGvp0Attempt(root, {
    runId: '20990101T000000000Z-9-deadbeefdeadbeef',
  });
  writeFileSync(join(newer.directory, 'command.txt'), 'tampered after index\n');

  assert.throws(
    () => auditValidationStatus({ repoRoot: root }),
    /INVALID_TRACKED_GVP0_ENVIRONMENT_ATTEMPT.*20990101T000000000Z-9-deadbeefdeadbeef/u,
  );
  assert.throws(
    () => writeAuditedStatusUpdate({ repoRoot: root, statusPath }),
    /INVALID_TRACKED_GVP0_ENVIRONMENT_ATTEMPT.*20990101T000000000Z-9-deadbeefdeadbeef/u,
  );
  assert.equal(readFileSync(statusPath, 'utf8'), before);
});

test('tracked symlink, nested, and unsafe-name bundle candidates fail closed while tracked README is ignored', () => {
  for (const attack of ['symlink', 'nested', 'unsafe-name']) {
    const root = mkdtempSync(join(tmpdir(), `superwagie-gvp-reviewed-${attack}-`));
    const old = writeReviewedGvp0Attempt(root);
    const attemptsRoot = join(root, 'fixtures', 'gvp-0', 'GVP-0-CORE-001', 'environment-attempts');
    writeFileSync(join(attemptsRoot, 'README.md'), 'non-bundle documentation\n');
    if (attack === 'symlink') {
      symlinkSync(old.directory, join(attemptsRoot, '20990101T000000000Z-8-feedfacefeedface'));
    } else if (attack === 'nested') {
      const nested = join(attemptsRoot, '20990101T000000000Z-8-feedfacefeedface', 'nested');
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(nested, 'index.json'), '{}\n');
    } else {
      writeReviewedGvp0Attempt(root, { runId: 'not-a-timestamp' });
    }
    spawnSync('git', ['add', '--', 'fixtures/gvp-0/GVP-0-CORE-001/environment-attempts'], { cwd: root });
    assert.throws(
      () => auditValidationStatus({ repoRoot: root }),
      /INVALID_TRACKED_GVP0_ENVIRONMENT_ATTEMPT/u,
      attack,
    );
  }

  const control = mkdtempSync(join(tmpdir(), 'superwagie-gvp-reviewed-readme-'));
  writeReviewedGvp0Attempt(control);
  const controlRoot = join(control, 'fixtures', 'gvp-0', 'GVP-0-CORE-001', 'environment-attempts');
  writeFileSync(join(controlRoot, 'README.md'), 'non-bundle documentation\n');
  spawnSync('git', ['add', '--', 'fixtures/gvp-0/GVP-0-CORE-001/environment-attempts/README.md'], { cwd: control });
  assert.equal(
    auditValidationStatus({ repoRoot: control }).fixtures.find(({ fixture }) => fixture === 'GVP-0').execution,
    'blocked_environment',
  );
});

test('tracked reviewed bundle is sufficient in a clean-checkout-style copy and explicit CLI import is callable', () => {
  const source = mkdtempSync(join(tmpdir(), 'superwagie-gvp-reviewed-source-'));
  const reviewed = writeReviewedGvp0Attempt(source, { platform: 'windows-11-x64' });
  const clean = mkdtempSync(join(tmpdir(), 'superwagie-gvp-reviewed-clean-'));
  const relativeBundle = `fixtures/gvp-0/GVP-0-CORE-001/environment-attempts/${reviewed.runId}`;
  mkdirSync(join(clean, relativeBundle, '..'), { recursive: true });
  cpSync(reviewed.directory, join(clean, relativeBundle), { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: clean });
  spawnSync('git', ['add', '--', relativeBundle], { cwd: clean });
  const statusPath = join(clean, 'status.json');
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('./validation-status-audit.mjs', import.meta.url)),
    '--repo-root', clean, '--environment-attempt-bundle', relativeBundle, '--update-status', statusPath,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const gvp0 = JSON.parse(readFileSync(statusPath, 'utf8')).fixtures.find(({ fixture }) => fixture === 'GVP-0');
  assert.equal(gvp0.latest_attempt.platform_id, 'windows-11-x64');
  assert.equal(gvp0.receipt, null);
});

test('audited writer rejects a malformed unrelated fixture before writing status', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-gvp-status-malformed-'));
  writeReviewedGvp0Attempt(root);
  const statusPath = join(root, 'status.json');
  const seed = auditValidationStatus({ repoRoot: root, generatedAt: '2026-09-03T00:00:00.000Z' });
  delete seed.fixtures.find(({ fixture }) => fixture === 'G2-THREAD-001').admission;
  const before = `${JSON.stringify(seed, null, 2)}\n`;
  writeFileSync(statusPath, before);
  assert.throws(() => writeAuditedStatusUpdate({ repoRoot: root, statusPath }), /fixture.*G2-THREAD-001|status document/iu);
  assert.equal(readFileSync(statusPath, 'utf8'), before);
});

test('a verified exit-2 GVP-0 environment attempt projects BLOCKED_ENVIRONMENT without a receipt', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-gvp-status-environment-'));
  const { runId } = writeReviewedGvp0Attempt(root);
  const report = auditValidationStatus({ repoRoot: root, generatedAt: '2026-09-04T03:49:12.600Z' });
  const entry = report.fixtures.find(({ fixture }) => fixture === 'GVP-0');
  assert.equal(entry.technical_state, 'RESEARCH_REQUIRED');
  assert.equal(entry.execution, 'blocked_environment');
  assert.equal(entry.admission, 'not_ready');
  assert.equal(entry.evidence, null);
  assert.equal(entry.receipt, null);
  assert.equal(entry.latest_attempt.run_id, runId);
  assert.equal(entry.latest_attempt.execution, 'BLOCKED_ENVIRONMENT');
  assert.equal(entry.latest_attempt.exit_code, 2);
  assert.equal(entry.latest_attempt.reason_code, 'GVP0_LIVE_AUDIT_UNAVAILABLE');
  assert.equal(entry.latest_attempt.receipt, null);
  assert.deepEqual(entry.platforms_seen, ['macos-15-arm64']);
  assert.deepEqual(entry.platforms_go, []);
  assert.deepEqual(entry.missing_platforms, ['windows-11-x64']);
  assert.equal(entry.latest_attempt.artifacts.length, 9);
  assert.ok(entry.latest_attempt.artifacts.every(({ sha256 }) => /^sha256:[a-f0-9]{64}$/.test(sha256)));
  assert.equal(report.summary.blocked_environment, 1);
  assert.equal(report.summary.research_required, 5);
  assert.equal(report.production_implementation_admission, 'NO_GO');
});

test('a reviewed public-runner platform mismatch projects the exact receiptless blocker', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-gvp-status-platform-mismatch-'));
  const error = {
    code: 'GVP0_PLATFORM_MISMATCH',
    error: 'requested platform macos-15-arm64 does not match this host',
  };
  const { runId } = writeReviewedGvp0Attempt(root, { error });
  const report = auditValidationStatus({ repoRoot: root });
  const entry = report.fixtures.find(({ fixture }) => fixture === 'GVP-0');
  assert.equal(entry.execution, 'blocked_environment');
  assert.equal(entry.receipt, null);
  assert.equal(entry.latest_attempt.run_id, runId);
  assert.equal(entry.latest_attempt.reason_code, error.code);
  assert.equal(entry.latest_attempt.limitation, error.error);
});

test('malformed or receipt-shaped reviewed GVP-0 bundles cannot count as BLOCKED_ENVIRONMENT', () => {
  const attacks = [
    { manifest: { gate: 'gate-0' } },
    { manifest: { operator: 'C:\\Users\\someone' } },
    { manifest: { fixture: 'GVP-0' } },
    { manifest: { platform: 'windows-11-x64' } },
    { manifest: { run_id: 'another-run' } },
    { environment: { arch: 'x64' } },
    { error: { code: 'SOME_OTHER_ERROR' } },
    { error: { error: 'some other timeout' } },
    { command: 'gate:gvp-0 platform:macos-15-arm64 fixture:GVP-0-CORE-001 candidate-root-sha256:not-a-hash\n' },
    { decision: '# Decision (draft)\n\n- draft decision: BLOCKED_ENVIRONMENT\n' },
    { decision: '# Decision (draft)\n\n- gate: GVP-0\n- fixture: GVP-0-CORE-001\n- platform: macos-15-arm64\n- evidence_sha256: unavailable\n- outcome: verification failed\n- draft decision: BLOCKED_ENVIRONMENT (待所有者角色签署后生效)\n- limitation: poc-production-audit did not complete within the bounded environment contract\n- leaked: /Users/someone/work\n' },
    { results: '{}\n' },
    { evidenceManifest: '{}\n' },
    { acceptanceSummary: '{}\n' },
  ];
  for (const [index, attack] of attacks.entries()) {
    const root = mkdtempSync(join(tmpdir(), `superwagie-gvp-status-environment-${index}-`));
    writeReviewedGvp0Attempt(root, attack);
    assert.throws(
      () => auditValidationStatus({ repoRoot: root }),
      /INVALID_TRACKED_GVP0_ENVIRONMENT_ATTEMPT/u,
      `attack ${index}`,
    );
  }
});

test('the audited status updater is deterministic and preserves blocked technical/production state', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-gvp-status-update-'));
  writeReviewedGvp0Attempt(root);
  const statusPath = join(root, 'status.json');
  const first = writeAuditedStatusUpdate({ repoRoot: root, statusPath });
  const firstBytes = readFileSync(statusPath, 'utf8');
  const second = writeAuditedStatusUpdate({ repoRoot: root, statusPath });
  assert.equal(readFileSync(statusPath, 'utf8'), firstBytes);
  assert.deepEqual(second, first);
  assert.equal(first.generated_at, '2026-09-04T03:48:57.534Z');
  assert.equal(first.fixtures.find(({ fixture }) => fixture === 'GVP-0').execution, 'blocked_environment');
  assert.equal(first.production_implementation_admission, 'NO_GO');
  assert.equal(first.format_admission_ledger.release_admission, 'NO_GO');
});

test('the audited status updater changes only GVP-0 and derived summary fields', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-gvp-status-preserve-'));
  writeReviewedGvp0Attempt(root);
  const statusPath = join(root, 'status.json');
  const seed = auditValidationStatus({ repoRoot: root, generatedAt: '2026-09-03T00:00:00.000Z' });
  const unrelated = seed.fixtures.find(({ fixture }) => fixture === 'G2-THREAD-001');
  unrelated.execution = 'conditional_go';
  unrelated.reasons = ['preserve-this-receipt-derived-state'];
  seed.summary.missing -= 1;
  seed.summary.conditional_go += 1;
  writeFileSync(statusPath, `${JSON.stringify(seed, null, 2)}\n`);
  const updated = writeAuditedStatusUpdate({ repoRoot: root, statusPath });
  assert.deepEqual(
    updated.fixtures.find(({ fixture }) => fixture === 'G2-THREAD-001'),
    unrelated,
  );
  assert.equal(updated.summary.conditional_go, 1);
  assert.equal(updated.summary.blocked_environment, 1);
});

test('the status CLI rejects a hand-copied BLOCKED_ENVIRONMENT attempt hash', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-gvp-status-copied-'));
  writeReviewedGvp0Attempt(root);
  const statusPath = join(root, 'status.json');
  const status = writeAuditedStatusUpdate({ repoRoot: root, statusPath });
  status.fixtures.find(({ fixture }) => fixture === 'GVP-0').latest_attempt.artifacts[0].sha256 = `sha256:${'0'.repeat(64)}`;
  writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`);
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('./validation-status-audit.mjs', import.meta.url)),
    '--repo-root', root,
    '--status', statusPath,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /latest_attempt must exactly match/u);
});

test('a self-consistent one-artifact GVP receipt is invalid and legacy evidence stays excluded', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-gvp-status-'));
  writeViewerReceipt(root);
  writeEvidence(root, 'gate-3', '20260904T120000001Z-2', {
    gate: 'gate-3', fixture: 'G3-REVIEW-001', gate_id: 'GVP-0', platform: 'windows-11-x64',
    pass: true, decision_hint: 'GO',
  });
  const entry = auditValidationStatus({ repoRoot: root }).fixtures.find(({ fixture }) => fixture === 'GVP-0');
  assert.equal(entry.execution, 'invalid_evidence');
  assert.equal(entry.technical_state, 'RESEARCH_REQUIRED');
  assert.equal(entry.admission, 'not_ready');
  assert.deepEqual(entry.platforms_seen, ['macos-15-arm64']);
  assert.deepEqual(entry.platforms_go, []);
  assert.deepEqual(entry.missing_platforms, ['windows-11-x64']);
});

test('a minimal CONDITIONAL_GO Viewer receipt is invalid and never counts as GO coverage', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-gvp-status-'));
  writeViewerReceipt(root, { verdict: 'CONDITIONAL_GO' });
  const entry = auditValidationStatus({ repoRoot: root }).fixtures.find(({ fixture }) => fixture === 'GVP-0');
  assert.equal(entry.execution, 'invalid_evidence');
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

test('twelve nonexistent receipt references cannot promote a format ledger record', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-ledger-receipts-'));
  const refs = [];
  for (const gate of ['GVP-0', 'GVP-1', 'GVP-2', 'GVP-3', 'GVP-4', 'GVP-5']) {
    for (const platform of ['macos-15-arm64', 'windows-11-x64']) {
      refs.push({
        receipt_id: `receipt-${gate.toLowerCase()}-${platform}`,
        gate_id: gate,
        platform_id: platform,
        receipt_path: `receipts/${gate.toLowerCase()}-${platform}.json`,
        receipt_sha256: `sha256:${'a'.repeat(64)}`,
      });
    }
  }
  const projection = projectFormatAdmissionState({
    records: [{
      format_variant_id: 'office.docx.ooxml', extensions: ['docx'], container: 'zip-ooxml',
      target_support_modes: ['visual'], current_state: 'PROVEN_POC',
      required_platforms: ['macos-15-arm64', 'windows-11-x64'],
      required_gates: ['GVP-0', 'GVP-1', 'GVP-2', 'GVP-3', 'GVP-4', 'GVP-5'],
      corpus_id: 'GVP-CORPUS-OFFICE-DOCX-001', descriptor_id: 'viewer.office.docx',
      candidate_id: 'omni-viewer-core', candidate_version: '0.16.0+frozen',
      chunk_manifest_sha256: `sha256:${'b'.repeat(64)}`, admission_receipt_refs: refs,
    }],
  }, { repoRoot: root });
  assert.equal(projection.complete_record_receipts, 0);
  assert.equal(projection.invalid_receipt_refs, 12);
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
