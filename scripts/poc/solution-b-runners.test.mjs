import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..', '..');

function run(relativeScript, fixture, extraArgs = []) {
  const dir = mkdtempSync(join(tmpdir(), 'superwagie-solution-b-'));
  const resultsPath = join(dir, 'results.json');
  try {
    execFileSync(process.execPath, [
      resolve(root, relativeScript), '--fixture', fixture, '--results-json', resultsPath,
      '--artifacts-dir', join(dir, 'artifacts'),
      ...extraArgs,
    ], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    if (!error || ![1, 2].includes(error.status)) throw error;
  }
  return JSON.parse(readFileSync(resultsPath, 'utf8'));
}

const sha256 = (bytes) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

test('dependency runner enforces the four-tier ownership model', () => {
  const result = run('scripts/poc/gate-0/deps-gate.mjs', 'G0-DEPS-001');
  assert.equal(result.evidence_revision, 'solution-b-v1');
  assert.equal(Object.keys(result.metrics.tier_summary).length, 4);
  assert.equal(result.metrics.signed_runtime_system_fallback, false);
  assert.equal(result.metrics.user_extension_can_satisfy_core, false);
  assert.equal(result.decision_hint, 'CONDITIONAL_GO');
  assert.equal(result.pass, true);
});

test('dependency runner verifies candidate runtime content and rejects tampering', () => {
  const candidate = mkdtempSync(join(tmpdir(), 'superwagie-runtime-candidate-'));
  const matrix = JSON.parse(readFileSync(resolve(root, 'fixtures/gate-0/G0-DEPS-001/dependencies.json'), 'utf8'));
  const entries = matrix.tiers.signed_runtime.map((dependency) => {
    const absolute = join(candidate, dependency.relative_path);
    mkdirSync(absolute, { recursive: true });
    const payload = `${dependency.id}\n`;
    writeFileSync(join(absolute, 'identity.txt'), payload);
    const treeDigest = sha256(`identity.txt\0${sha256(payload)}\n`);
    return { id: dependency.id, relative_path: dependency.relative_path, sha256: treeDigest };
  });
  writeFileSync(join(candidate, 'runtime-manifest.json'), `${JSON.stringify({ entries }, null, 2)}\n`);

  const valid = run('scripts/poc/gate-0/deps-gate.mjs', 'G0-DEPS-001', ['--candidate-root', candidate]);
  assert.equal(valid.metrics.candidate_runtime_verified, true);
  assert.equal(valid.pass, true);

  writeFileSync(join(candidate, 'runtime', 'node', 'identity.txt'), 'tampered\n');
  const tampered = run('scripts/poc/gate-0/deps-gate.mjs', 'G0-DEPS-001', ['--candidate-root', candidate]);
  assert.equal(tampered.metrics.candidate_runtime_verified, false);
  assert.equal(tampered.pass, false);
  assert.equal(tampered.decision_hint, 'NO_GO');
});

test('thread runner exercises the current nine-state lifecycle', () => {
  const result = run('scripts/poc/gate-2/thread-gate.mjs', 'G2-THREAD-001');
  assert.equal(result.evidence_revision, 'solution-b-v1');
  assert.equal(result.metrics.states_covered, 9);
  assert.equal(result.metrics.archive_restore_verified, true);
  assert.equal(result.pass, true);
});

test('workflow runner separates all three human gate mechanisms', () => {
  const result = run('scripts/poc/gate-2/workflow-gate.mjs', 'G2-WORKFLOW-001');
  assert.equal(result.evidence_revision, 'solution-b-v1');
  assert.equal(result.metrics.gate_mechanisms, 3);
  assert.equal(result.metrics.risk_kinds, 4);
  assert.equal(result.metrics.local_invalidation_verified, true);
  assert.equal(result.pass, true);
});

test('host runner keeps effect authority in Product Core and isolates the worker', () => {
  const result = run('scripts/poc/gate-2/host-gate.mjs', 'G2-HOST-001');
  assert.equal(result.evidence_revision, 'solution-b-v1');
  assert.equal(result.metrics.core_effect_journal, true);
  assert.equal(result.metrics.host_worker_isolated, true);
  assert.equal(result.metrics.one_time_worker_identity, true);
  assert.equal(result.pass, true);
});

test('facade runner covers the complete machine-readable public method catalog', () => {
  const catalog = JSON.parse(readFileSync(resolve(root, 'docs/contracts/v1/public-capability-methods.json'), 'utf8'));
  const result = run('scripts/poc/gate-5/facade-gate.mjs', 'G5-FACADE-001');
  assert.equal(result.evidence_revision, 'solution-b-v1');
  assert.equal(result.metrics.methods_covered, catalog.methods.length);
  assert.equal(result.metrics.trusted_context_forgery_rejected, true);
  assert.equal(result.metrics.caller_kinds_compared, 2);
  assert.equal(result.metrics.payload_result_schemas_resolved, true);
  assert.equal(result.metrics.input_schema_validations, catalog.methods.length * 2);
  assert.equal(result.metrics.output_schema_validations, catalog.methods.length * 2);
  assert.equal(result.metrics.schema_negative_cases_rejected, catalog.methods.length);
  assert.equal(result.decision_hint, 'CONDITIONAL_GO');
  assert.doesNotMatch(result.limitation, /payload\/result Schema/);
  assert.match(result.limitation, /handler.*Worker/i);
  assert.match(result.limitation, /Network Broker.*DNS\/IP\/redirect\/localhost.*每跳/);
  assert.equal(result.pass, true);
});

test('attack runner covers the new trust and receipt boundaries', () => {
  const result = run('scripts/poc/gate-5/attack-gate.mjs', 'G5-ATTACK-001');
  assert.equal(result.evidence_revision, 'solution-b-v1');
  assert.equal(result.metrics.trusted_context_forgery_rejected, true);
  assert.equal(result.metrics.resource_audience_transfer_rejected, true);
  assert.equal(result.metrics.gate_receipt_forgery_rejected, true);
  assert.equal(result.metrics.process_boundary_escape_rejected, true);
  assert.equal(result.pass, true);
});

test('extension runner binds installation to an Install Gate receipt', () => {
  const result = run('scripts/poc/gate-5/ext-gate.mjs', 'G5-EXT-001');
  assert.equal(result.evidence_revision, 'solution-b-v1');
  assert.equal(result.metrics.install_gate_binding_verified, true);
  assert.equal(result.metrics.install_gate_trusted_source_verified, true);
  assert.equal(result.metrics.public_facade_only, true);
  assert.equal(result.decision_hint, 'CONDITIONAL_GO');
  assert.match(result.limitation, /真实签名 Installer\/Extension Worker/);
  assert.equal(result.pass, true);
});
