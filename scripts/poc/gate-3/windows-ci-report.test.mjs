import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { attestIsolationResult } from './isolation-evidence.mjs';
import {
  buildPathFreeProvenance,
  rendererEnvironmentSha256
} from './review-provenance.mjs';
import { buildToolchainIdentity } from './windows-toolchain-identity.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const reportCli = path.join(here, 'windows-ci-report.mjs');
const SESSION = '0123456789abcdef0123456789abcdef';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const repeatedHash = (character) => character.repeat(64);

test('Windows report main accepts controlled standard evidence and fails closed after every content rewrite', async () => {
  const fixture = await reportFixture();
  let completed = runReport(fixture, 'positive.json');
  assert.equal(completed.status, 0, completed.stderr);
  const report = JSON.parse(await readFile(path.join(fixture.root, 'positive.json'), 'utf8'));
  assert.equal(report.standard_review_executor.decision, 'CONDITIONAL_GO');
  assert.equal(report.schema_version, 4);
  assert.match(report.standard_review_executor.evidence_binding.canonical_sha256, /^[0-9a-f]{64}$/);
  assert.match(report.standard_review_executor.metrics_sha256, /^[0-9a-f]{64}$/);
  assert.equal(report.standard_review_executor.fixture_manifest_sha256, fixture.manifestSha256);
  assert.equal(report.standard_review_executor.verified_renderer_environment_sha256, fixture.renderer.renderer_environment_sha256);
  assert.equal(report.standard_review_executor.renderer_provenance_sha256, hash(`${JSON.stringify(fixture.renderer, null, 2)}\n`));
  assert.equal(report.standard_review_executor.evidence_binding.files.renderer_provenance_sha256,
    report.standard_review_executor.renderer_provenance_sha256);
  assert.doesNotMatch(JSON.stringify(report), /[A-Za-z]:\\|\/Users\/|file:\/\//);

  completed = runReport(fixture, 'positive-explicit-manifest.json', fixture.manifestPath);
  assert.equal(completed.status, 0, completed.stderr);

  const cases = [
    ['result embedded metrics', ({ result }) => { result.metrics.interaction_p95_ms += 1; }],
    ['result provenance', ({ result }) => { result.metrics_provenance.renderer_environment_sha256 = repeatedHash('9'); }],
    ['metrics renderer', ({ metrics }) => {
      metrics.provenance.renderer_environment_sha256 = repeatedHash('8');
    }],
    ['metrics native RSS', ({ metrics }) => {
      metrics.metrics.peak_rss_bytes = 1.5;
      metrics.provenance.host_measurements.peak_rss_bytes = 1.5;
    }],
    ['metrics samples', ({ metrics }) => {
      metrics.provenance.samples.interactions = 0;
    }],
    ['metrics extra key', ({ metrics }) => { metrics.extra = true; }],
    ['completion fixture', ({ completion }) => { completion.fixture = 'G3-REVIEW-002'; }],
    ['completion stale', ({ completion }) => { completion.completed_at = '2000-01-01T00:00:00.000Z'; }],
    ['completion preview order', ({ completion }) => { completion.preview_hashes.reverse(); }],
    ['completion duplicate preview', ({ completion }) => { completion.preview_hashes[1].pageId = 'pdf:page-1'; }],
    ['completion extra key', ({ completion }) => { completion.extra = true; }],
    ['coordinated manifest rewrite', ({ result, metrics, completion }) => {
      const rewritten = repeatedHash('9');
      metrics.provenance.manifest_sha256 = rewritten;
      result.metrics_provenance = structuredClone(metrics.provenance);
      result.automation.manifest_sha256 = rewritten;
      completion.manifest_sha256 = rewritten;
    }],
    ['fixture manifest content drift', ({ result, metrics, completion }) => {
      const drifted = hash(Buffer.concat([fixture.manifestBytes, Buffer.from('\n') ]));
      metrics.provenance.manifest_sha256 = drifted;
      result.metrics_provenance = structuredClone(metrics.provenance);
      result.automation.manifest_sha256 = drifted;
      completion.manifest_sha256 = drifted;
    }],
    ['coordinated renderer rewrite', ({ result, metrics }) => {
      metrics.provenance.renderer_environment_sha256 = repeatedHash('8');
      result.metrics_provenance = structuredClone(metrics.provenance);
    }],
    ['renderer provenance self reported digest', ({ renderer }) => {
      renderer.renderer_environment_sha256 = repeatedHash('7');
    }],
    ['renderer provenance identity rewrite and rehash', ({ renderer }) => {
      renderer.wps.exact_version = '12.1.0.18000';
      renderer.renderer_environment_sha256 = rendererEnvironmentSha256(rendererIdentity(renderer));
    }]
  ];
  for (const [name, mutate] of cases) {
    const evidence = standardReviewDocuments(fixture.manifestSha256, fixture.renderer);
    mutate(evidence);
    await writeReviewDocuments(fixture.reviewRoot, evidence);
    completed = runReport(fixture, `${name.replaceAll(' ', '-')}.json`);
    assert.notEqual(completed.status, 0, `${name} rewrite unexpectedly passed\n${completed.stdout}\n${completed.stderr}`);
  }

  const manifestSymlink = path.join(fixture.root, 'fixture-manifest-link.json');
  await symlink(fixture.manifestPath, manifestSymlink);
  completed = runReport(fixture, 'manifest-symlink.json', manifestSymlink);
  assert.notEqual(completed.status, 0, 'fixture manifest symlink unexpectedly passed');

  const rendererPath = path.join(fixture.reviewRoot, 'artifacts/renderer-provenance.json');
  const rendererTarget = path.join(fixture.root, 'renderer-provenance-target.json');
  await writeFile(rendererTarget, `${JSON.stringify(fixture.renderer, null, 2)}\n`);
  await unlink(rendererPath);
  await symlink(rendererTarget, rendererPath);
  completed = runReport(fixture, 'renderer-provenance-symlink.json');
  assert.notEqual(completed.status, 0, 'renderer provenance symlink unexpectedly passed');
});

function runReport(fixture, outputName, fixtureManifest) {
  const args = [
    reportCli,
    '--review-root', fixture.reviewRoot,
    '--isolation-root', fixture.isolationRoot,
    '--toolchain-identity', fixture.toolchainFile,
    '--output', path.join(fixture.root, outputName)
  ];
  if (fixtureManifest) args.push('--fixture-manifest', fixtureManifest);
  return spawnSync(process.execPath, args, { cwd: repo, encoding: 'utf8' });
}

async function reportFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'superwagie-windows-report-'));
  const reviewRoot = path.join(root, 'review');
  await mkdir(path.join(reviewRoot, 'artifacts'), { recursive: true });
  const manifestPath = path.join(repo, 'fixtures/gate-3/G3-REVIEW-001/fixture-manifest.json');
  const manifestBytes = await readFile(manifestPath);
  const manifestSha256 = hash(manifestBytes);
  const renderer = controlledRendererProvenance();
  await writeReviewDocuments(reviewRoot, standardReviewDocuments(manifestSha256, renderer));
  const isolationRoot = await writeIsolationEvidence(path.join(root, 'isolation'));
  const packageLockSha256 = hash(await readFile(path.join(repo, 'scripts/poc/gate-3/package-lock.json')));
  const cargoLockSha256 = hash(await readFile(path.join(repo, 'scripts/poc/gate-3/reviewer-shell/Cargo.lock')));
  const toolchain = buildToolchainIdentity({
    platform: 'win32', arch: 'x64', packageLockSha256, cargoLockSha256,
    versions: {
      node: 'v24.18.0', npm: '12.0.1', python: 'Python 3.13.7',
      rustc: 'rustc 1.97.1 (8bab26f4f 2026-07-14)\nbinary: rustc\ncommit-hash: 8bab26f4f68e0e26f0bb7960be334d5b520ea452\ncommit-date: 2026-07-14\nhost: x86_64-pc-windows-msvc\nrelease: 1.97.1\nLLVM version: 22.1.6',
      cargo: 'cargo 1.97.1 (c980f4866 2026-06-30)\nrelease: 1.97.1\ncommit-hash: c980f4866141969fab6254a680546a277789d6f0\ncommit-date: 2026-06-30\nhost: x86_64-pc-windows-msvc\nlibgit2: 1.9.2'
    }
  });
  const toolchainFile = path.join(root, 'toolchain-identity.json');
  await writeFile(toolchainFile, `${JSON.stringify(toolchain, null, 2)}\n`);
  return { root, reviewRoot, isolationRoot, toolchainFile, manifestPath, manifestBytes, manifestSha256, renderer };
}

function standardReviewDocuments(manifestSha256, renderer = controlledRendererProvenance()) {
  const capturedAt = new Date().toISOString();
  const metrics = {
    metrics: {
      progress_visible_ms: 20, cached_first_page_p95_ms: 200,
      authoritative_first_reviewable_page_ms: 600, interaction_p95_ms: 30,
      peak_rss_bytes: 1_000_000, cache_bytes: 2_000_000,
      reanchor_resolved: 0, reanchor_unresolved: 0,
      reanchor_silent_misplaced: 0, visual_diff_ratio: 0
    },
    provenance: {
      fixture: 'G3-REVIEW-001', session_id: SESSION,
      manifest_sha256: manifestSha256, captured_at: capturedAt,
      representative_machine: true, renderer_environment_sha256: renderer.renderer_environment_sha256,
      host_measurements: { source: 'trusted-native-host', peak_rss_bytes: 1_000_000, cache_bytes: 2_000_000 },
      correctness_counters: { acceptance: false, basis: 'task-9-required' },
      samples: { progress: 1, cachedFirstPage: 20, authoritativeFirstPage: 3, interactions: 20 }
    }
  };
  const result = {
    schema_version: 1, gate: 'gate-3', fixture: 'G3-REVIEW-001', pass: true,
    status: 'passed', decision_hint: 'CONDITIONAL_GO',
    reasons: [
      'CODEX_NEVER_INSTALLED_EVIDENCE_REQUIRED', 'CORRECTNESS_COUNTERS_NON_ACCEPTANCE',
      'MANUAL_CHECKLIST_REQUIRED', 'WPS_TERMS_REVIEW_REQUIRED'
    ],
    limitations: [
      'G3-REVIEW-001 has no valid manual visual checklist.',
      'WPS commercial-use/redistribution terms and WPSComposer source identity require review.',
      'A passing G3-REVIEW-002 codex-never-installed result is required before GO.',
      'Correctness counters are diagnostic only until Task 9 validation.'
    ],
    metrics: structuredClone(metrics.metrics), metrics_provenance: structuredClone(metrics.provenance),
    automation: { manifest_sha256: manifestSha256, trusted_completion: true }
  };
  const completion = {
    session_id: SESSION, fixture: 'G3-REVIEW-001', manifest_sha256: manifestSha256,
    metrics_file: 'review-automation-metrics.json', completed_at: capturedAt,
    preview_hashes: [
      { pageId: 'pdf:page-1', sha256: repeatedHash('3') },
      { pageId: 'docx:page-1', sha256: repeatedHash('4') },
      { pageId: 'pptx:page-1', sha256: repeatedHash('5') }
    ]
  };
  return { result, metrics, completion, renderer: structuredClone(renderer) };
}

async function writeReviewDocuments(root, documents) {
  await writeFile(path.join(root, 'results.json'), `${JSON.stringify(documents.result, null, 2)}\n`);
  await writeFile(path.join(root, 'artifacts/review-automation-metrics.json'), `${JSON.stringify(documents.metrics, null, 2)}\n`);
  await writeFile(path.join(root, 'artifacts/automation-complete.json'), `${JSON.stringify(documents.completion, null, 2)}\n`);
  await writeFile(path.join(root, 'artifacts/renderer-provenance.json'), `${JSON.stringify(documents.renderer, null, 2)}\n`);
}

function controlledRendererProvenance() {
  const bridgeSha256 = repeatedHash('f');
  return buildPathFreeProvenance({
    platform: 'windows-11-x64',
    machineProfileId: 'windows-2022-contract-v1',
    representative: true,
    wpsVersion: '12.1.0.17900',
    bridgeIdentity: `sha256:${bridgeSha256}`,
    wpsApplicationIdentity: {
      target_kind: 'windows-executable',
      executable_sha256: repeatedHash('d'),
      bundle_manifest_sha256: repeatedHash('e'),
      bridge_sha256: bridgeSha256
    },
    pythonBytes: Buffer.from('controlled-python-3.13.7'),
    wpsComposerFiles: [{ identity: 'skills/WPSComposer/__init__.py', bytes: Buffer.from('controlled-wpscomposer') }],
    fontRecords: [{ family: 'Arial', style: 'Regular', version: `1.0;sha256:${repeatedHash('b')}` }],
    renderOptions: { quality: 'authoritative' }
  });
}

function rendererIdentity(document) {
  return {
    platform: document.platform,
    machine: document.machine,
    wps: document.wps,
    python_executable_sha256: document.python_executable_sha256,
    wpscomposer_source_sha256: document.wpscomposer_source_sha256,
    font_manifest_sha256: document.font_manifest_sha256,
    render_options: document.render_options
  };
}

async function writeIsolationEvidence(root) {
  const artifactsRoot = path.join(root, 'artifacts');
  await mkdir(artifactsRoot, { recursive: true });
  const capturedAt = new Date().toISOString();
  const binding = {
    fixture: 'G3-REVIEW-002', scenario: 'codex-never-installed', platform: 'windows-11-x64',
    run_id: 'run-fixture-windows', session_id: SESSION, manifest_sha256: repeatedHash('1')
  };
  const precondition = {
    kind: 'codex-never-installed', verified: true,
    application_inventory: { codex_state: 'never-installed-attested', digest_sha256: repeatedHash('a') },
    process_state: { codex_running: false, digest_sha256: repeatedHash('b') },
    fixture_mutation: { applied: false, digest_sha256: null },
    attestation: { required: true, verified: true, digest_sha256: repeatedHash('c') }
  };
  const renderer = {
    schema_id: 'superwagie.review-renderer-provenance.v1', schema_version: 1, binding,
    platform: 'windows-11-x64', machine: { profile_id: 'windows-2022-contract-v1', representative: true },
    wps: {
      application: 'WPS', exact_version: '12.1.0.17900', bridge_identity: `sha256:${repeatedHash('f')}`,
      application_identity: {
        target_kind: 'windows-executable', executable_sha256: repeatedHash('d'),
        bundle_manifest_sha256: repeatedHash('e'), bridge_sha256: repeatedHash('f')
      }
    },
    python_executable_sha256: repeatedHash('0'), wpscomposer_source_sha256: repeatedHash('a'),
    font_manifest_sha256: repeatedHash('b'), render_options: { quality: 'authoritative' },
    renderer_environment_sha256: ''
  };
  renderer.renderer_environment_sha256 = rendererIdentityHash(renderer);
  const snapshot = {
    binary_sha256: repeatedHash('1'), dependency_manifest_sha256: repeatedHash('2'),
    renderer_manifest_sha256: renderer.renderer_environment_sha256,
    preview_hashes: [
      { page_id: 'pdf:page-1', sha256: repeatedHash('3') },
      { page_id: 'docx:page-1', sha256: repeatedHash('4') }
    ],
    probes: { process: probe('6'), paths: probe('7'), network: probe('8') }
  };
  const metricsDocument = {
    metrics: {
      progress_visible_ms: 20, cached_first_page_p95_ms: 200,
      authoritative_first_reviewable_page_ms: 600, interaction_p95_ms: 30,
      peak_rss_bytes: 1_000_000, cache_bytes: 2_000_000,
      reanchor_resolved: 0, reanchor_unresolved: 0, reanchor_silent_misplaced: 0,
      visual_diff_ratio: 0
    },
    provenance: {
      fixture: 'G3-REVIEW-001', session_id: SESSION, manifest_sha256: repeatedHash('1'),
      captured_at: capturedAt, representative_machine: true,
      renderer_environment_sha256: renderer.renderer_environment_sha256,
      host_measurements: { source: 'trusted-native-host', peak_rss_bytes: 1_000_000, cache_bytes: 2_000_000 },
      correctness_counters: { acceptance: false, basis: 'task-9-required' },
      samples: { progress: 1, cached_first_page: 5, authoritative_first_page: 3, interactions: 20 }
    }
  };
  const documents = {
    capture: { schema_id: 'superwagie.g3-review-capture.v1', schema_version: 1, binding, captured_at: capturedAt, precondition, snapshot },
    renderer,
    metrics: {
      schema_id: 'superwagie.g3-review-metrics.v1', schema_version: 1, binding,
      renderer_environment_sha256: renderer.renderer_environment_sha256,
      metrics_document: metricsDocument
    }
  };
  const names = {
    capture: 'capture.json', renderer_provenance: 'renderer-provenance.json',
    review_automation_metrics: 'review-automation-metrics.json', automation_complete: 'automation-complete.json'
  };
  const artifacts = {};
  for (const [key, documentKey] of [
    ['capture', 'capture'], ['renderer_provenance', 'renderer'], ['review_automation_metrics', 'metrics']
  ]) {
    const bytes = `${JSON.stringify(documents[documentKey], null, 2)}\n`;
    await writeFile(path.join(artifactsRoot, names[key]), bytes);
    artifacts[key] = { relative_path: `artifacts/${names[key]}`, sha256: hash(bytes) };
  }
  const completion = {
    schema_id: 'superwagie.g3-review-completion.v1', schema_version: 1, binding,
    captured_at: capturedAt, renderer_environment_sha256: renderer.renderer_environment_sha256,
    metrics_sha256: artifacts.review_automation_metrics.sha256,
    preview_hashes: snapshot.preview_hashes,
    completion: {
      fixture: 'G3-REVIEW-001', session_id: SESSION, manifest_sha256: repeatedHash('1'),
      metrics_file: 'review-automation-metrics.json', completed_at: capturedAt
    },
    trusted: true
  };
  const completionBytes = `${JSON.stringify(completion, null, 2)}\n`;
  await writeFile(path.join(artifactsRoot, names.automation_complete), completionBytes);
  artifacts.automation_complete = { relative_path: `artifacts/${names.automation_complete}`, sha256: hash(completionBytes) };
  const unsigned = {
    schema_id: 'superwagie.g3-review-isolation-result.v1', schema_version: 1,
    gate: 'gate-3', fixture: 'G3-REVIEW-002', scenario: 'codex-never-installed',
    platform: 'windows-11-x64', run_id: binding.run_id, session_id: SESSION,
    manifest_sha256: repeatedHash('1'), captured_at: capturedAt,
    pass: true, status: 'passed', decision_hint: 'GO', reasons: [],
    precondition, snapshot, artifacts
  };
  await writeFile(path.join(root, 'results.json'), `${JSON.stringify(attestIsolationResult(unsigned), null, 2)}\n`);
  return root;
}

function probe(character) {
  return { checked: true, sample_count: 1, evidence_sha256: repeatedHash(character), forbidden_matches: [] };
}

function rendererIdentityHash(document) {
  return hash(JSON.stringify(stable({
    platform: document.platform, machine: document.machine, wps: document.wps,
    python_executable_sha256: document.python_executable_sha256,
    wpscomposer_source_sha256: document.wpscomposer_source_sha256,
    font_manifest_sha256: document.font_manifest_sha256, render_options: document.render_options
  })));
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}
