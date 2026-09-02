import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  attestIsolationResult,
  compareIsolationSnapshots,
  validateIsolationEvidence
} from './isolation-evidence.mjs';

test('strict versioned isolation evidence validates its complete artifact hash chain', async () => {
  const fixture = await evidenceFixture();
  const validated = await validateIsolationEvidence(fixture.results, fixture.root, {
    scenario: 'codex-never-installed', platform: 'macos-15-arm64'
  });
  assert.equal(validated.attestation.algorithm, 'sha256');
  assert.equal(validated.precondition.verified, true);
  assert.equal(validated.snapshot.preview_hashes[0].page_id, 'pdf:page-1');
});

test('bare labels, stale evidence, relocation, and mutated referenced artifacts never validate', async () => {
  const fixture = await evidenceFixture();
  const bare = path.join(fixture.root, 'bare.json');
  await writeFile(bare, JSON.stringify({ fixture: 'G3-REVIEW-002', scenario: 'codex-never-installed', pass: true, decision_hint: 'GO' }));
  await assert.rejects(validateIsolationEvidence(bare, fixture.root, { scenario: 'codex-never-installed', platform: 'macos-15-arm64' }));

  const outside = path.join(await mkdtemp(path.join(tmpdir(), 'superwagie-isolation-outside-')), 'results.json');
  await writeFile(outside, await readFile(fixture.results));
  await assert.rejects(validateIsolationEvidence(outside, fixture.root, { scenario: 'codex-never-installed', platform: 'macos-15-arm64' }));

  await writeFile(path.join(fixture.root, 'artifacts', 'capture.json'), '{"mutated":true}\n');
  await assert.rejects(validateIsolationEvidence(fixture.results, fixture.root, { scenario: 'codex-never-installed', platform: 'macos-15-arm64' }));

  const staleFixture = await evidenceFixture('2000-01-01T00:00:00.000Z');
  await assert.rejects(validateIsolationEvidence(staleFixture.results, staleFixture.root, { scenario: 'codex-never-installed', platform: 'macos-15-arm64' }));
});

test('rehashing artifacts and reattesting the result cannot hide contradictory referenced content', async () => {
  for (const mutate of [
    (documents) => { documents.capture.snapshot.binary_sha256 = 'f'.repeat(64); },
    (documents) => { documents.renderer.binding.session_id = 'session-other'; },
    (documents) => { documents.metrics.renderer_environment_sha256 = 'e'.repeat(64); },
    (documents) => { documents.complete.preview_hashes.reverse(); }
  ]) {
    const fixture = await evidenceFixture();
    const result = JSON.parse(await readFile(fixture.results, 'utf8'));
    const documents = await readEvidenceDocuments(fixture.root);
    mutate(documents);
    for (const [key, name] of Object.entries(artifactNames())) {
      const documentKey = key === 'renderer_provenance' ? 'renderer' : key === 'review_automation_metrics' ? 'metrics' : key === 'automation_complete' ? 'complete' : key;
      const bytes = `${JSON.stringify(documents[documentKey], null, 2)}\n`;
      await writeFile(path.join(fixture.root, 'artifacts', name), bytes);
      result.artifacts[key].sha256 = sha256(bytes);
    }
    const { attestation: _old, ...unsigned } = result;
    await writeFile(fixture.results, `${JSON.stringify(attestIsolationResult(unsigned), null, 2)}\n`);
    await assert.rejects(validateIsolationEvidence(fixture.results, fixture.root, {
      scenario: 'codex-never-installed', platform: 'macos-15-arm64'
    }), /binding|content|renderer|preview|snapshot|metrics/i);
  }
});

test('preview records preserve declared order so a reversal fails comparison', async () => {
  const fixture = await evidenceFixture();
  const baseline = JSON.parse(await readFile(fixture.results, 'utf8'));
  const current = structuredClone(baseline);
  current.scenario = 'codex-running';
  current.precondition.kind = 'codex-running';
  current.precondition.application_inventory.codex_state = 'installed-running';
  current.snapshot.preview_hashes.reverse();
  assert.deepEqual(compareIsolationSnapshots(baseline.snapshot, current.snapshot), {
    equal: false,
    reasons: ['PREVIEW_HASH_ORDER_MISMATCH']
  });
});

async function evidenceFixture(capturedAt = new Date().toISOString()) {
  const root = await mkdtemp(path.join(tmpdir(), 'superwagie-isolation-evidence-'));
  const artifactsRoot = path.join(root, 'artifacts');
  await mkdir(artifactsRoot);
  const sessionId = 'session-fixture-a';
  const manifestSha256 = '9'.repeat(64);
  const binding = { fixture: 'G3-REVIEW-002', scenario: 'codex-never-installed', platform: 'macos-15-arm64', run_id: 'run-fixture-a', session_id: sessionId, manifest_sha256: manifestSha256 };
  const precondition = {
    kind: 'codex-never-installed', verified: true,
    application_inventory: { codex_state: 'never-installed-attested', digest_sha256: 'a'.repeat(64) },
    process_state: { codex_running: false, digest_sha256: 'b'.repeat(64) },
    fixture_mutation: { applied: false, digest_sha256: null },
    attestation: { required: true, verified: true, digest_sha256: 'c'.repeat(64) }
  };
  const snapshot = {
    binary_sha256: '1'.repeat(64), dependency_manifest_sha256: '2'.repeat(64),
    renderer_manifest_sha256: '3'.repeat(64),
    preview_hashes: [
      { page_id: 'pdf:page-1', sha256: '4'.repeat(64) },
      { page_id: 'docx:page-1', sha256: '5'.repeat(64) }
    ], probes: { process: probe('6'), paths: probe('7'), network: probe('8') }
  };
  const renderer = {
      schema_id: 'superwagie.review-renderer-provenance.v1', schema_version: 1, binding,
      platform: 'macos-15-arm64', machine: { profile_id: 'mac-reference-v1', representative: true },
      wps: { application: 'WPS', exact_version: '12.1.0.17900', bridge_identity: `sha256:${'f'.repeat(64)}`, application_identity: { target_kind: 'macos-app-bundle', executable_sha256: 'd'.repeat(64), bundle_manifest_sha256: 'e'.repeat(64), bridge_sha256: 'f'.repeat(64) } },
      python_executable_sha256: '0'.repeat(64), wpscomposer_source_sha256: 'a'.repeat(64),
      font_manifest_sha256: 'b'.repeat(64), render_options: { quality: 'authoritative' },
      renderer_environment_sha256: ''
  };
  renderer.renderer_environment_sha256 = rendererIdentityHash(renderer);
  snapshot.renderer_manifest_sha256 = renderer.renderer_environment_sha256;
  const documents = {
    capture: { schema_id: 'superwagie.g3-review-capture.v1', schema_version: 1, binding, captured_at: capturedAt, precondition, snapshot },
    renderer,
    metrics: {
      schema_id: 'superwagie.g3-review-metrics.v1', schema_version: 1, binding,
      renderer_environment_sha256: snapshot.renderer_manifest_sha256,
      metrics_document: metricsDocument(binding, snapshot.renderer_manifest_sha256, capturedAt)
    }
  };
  const artifacts = {};
  for (const [key, name] of Object.entries(artifactNames()).filter(([key]) => key !== 'automation_complete')) {
    const documentKey = key === 'renderer_provenance' ? 'renderer' : key === 'review_automation_metrics' ? 'metrics' : key;
    const bytes = `${JSON.stringify(documents[documentKey], null, 2)}\n`;
    await writeFile(path.join(artifactsRoot, name), bytes);
    artifacts[key] = {
      relative_path: `artifacts/${name}`,
      sha256: sha256(bytes)
    };
  }
  documents.complete = {
    schema_id: 'superwagie.g3-review-completion.v1', schema_version: 1, binding,
    captured_at: capturedAt, renderer_environment_sha256: snapshot.renderer_manifest_sha256,
    metrics_sha256: artifacts.review_automation_metrics.sha256,
    preview_hashes: snapshot.preview_hashes,
    completion: { fixture: 'G3-REVIEW-001', session_id: sessionId, manifest_sha256: manifestSha256, metrics_file: 'review-automation-metrics.json', completed_at: capturedAt },
    trusted: true
  };
  const completeBytes = `${JSON.stringify(documents.complete, null, 2)}\n`;
  await writeFile(path.join(artifactsRoot, artifactNames().automation_complete), completeBytes);
  artifacts.automation_complete = { relative_path: `artifacts/${artifactNames().automation_complete}`, sha256: sha256(completeBytes) };
  const unsigned = {
    schema_id: 'superwagie.g3-review-isolation-result.v1',
    schema_version: 1,
    gate: 'gate-3', fixture: 'G3-REVIEW-002', scenario: 'codex-never-installed',
    platform: 'macos-15-arm64', run_id: 'run-fixture-a', session_id: sessionId,
    manifest_sha256: manifestSha256, captured_at: capturedAt,
    pass: true, status: 'passed', decision_hint: 'GO', reasons: [],
    precondition, snapshot,
    artifacts
  };
  const result = attestIsolationResult(unsigned);
  const results = path.join(root, 'results.json');
  await writeFile(results, `${JSON.stringify(result, null, 2)}\n`);
  return { root, results };
}

function artifactNames() {
  return { capture: 'capture.json', renderer_provenance: 'renderer-provenance.json', review_automation_metrics: 'review-automation-metrics.json', automation_complete: 'automation-complete.json' };
}

async function readEvidenceDocuments(root) {
  const names = artifactNames();
  return {
    capture: JSON.parse(await readFile(path.join(root, 'artifacts', names.capture), 'utf8')),
    renderer: JSON.parse(await readFile(path.join(root, 'artifacts', names.renderer_provenance), 'utf8')),
    metrics: JSON.parse(await readFile(path.join(root, 'artifacts', names.review_automation_metrics), 'utf8')),
    complete: JSON.parse(await readFile(path.join(root, 'artifacts', names.automation_complete), 'utf8'))
  };
}

function metricsDocument(binding, rendererHash, capturedAt) {
  return {
    metrics: {
      progress_visible_ms: 20, cached_first_page_p95_ms: 200,
      authoritative_first_reviewable_page_ms: 600, interaction_p95_ms: 30,
      peak_rss_bytes: 1000000, cache_bytes: 2000000, reanchor_resolved: 1,
      reanchor_unresolved: 1, reanchor_silent_misplaced: 0, visual_diff_ratio: 0.01
    },
    provenance: {
      fixture: 'G3-REVIEW-001', session_id: binding.session_id,
      manifest_sha256: binding.manifest_sha256, captured_at: capturedAt,
      representative_machine: true, renderer_environment_sha256: rendererHash,
      host_measurements: { source: 'trusted-native-host', peak_rss_bytes: 1000000, cache_bytes: 2000000 },
      correctness_counters: { acceptance: false, basis: 'task-9-required' },
      samples: { progress: 1, cached_first_page: 5, authoritative_first_page: 3, interactions: 20 }
    }
  };
}

function probe(hex) {
  return { checked: true, sample_count: 1, evidence_sha256: hex.repeat(64), forbidden_matches: [] };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function rendererIdentityHash(document) {
  const identity = {
    platform: document.platform, machine: document.machine, wps: document.wps,
    python_executable_sha256: document.python_executable_sha256,
    wpscomposer_source_sha256: document.wpscomposer_source_sha256,
    font_manifest_sha256: document.font_manifest_sha256, render_options: document.render_options
  };
  return sha256(JSON.stringify(stable(identity)));
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
