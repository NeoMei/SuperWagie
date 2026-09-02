import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

test('G5 facade validates real payload/result schemas, binds parity artifact, and stays conditional', async () => {
  const evidenceDir = mkdtempSync(path.join(tmpdir(), 'superwagie-g5-facade-test-'));
  const resultsPath = path.join(evidenceDir, 'results.json');
  execFileSync(process.execPath, [
    path.join(here, 'facade-gate.mjs'),
    '--fixture', 'G5-FACADE-001',
    '--results-json', resultsPath,
    '--artifacts-dir', path.join(evidenceDir, 'artifacts'),
  ], { encoding: 'utf8', stdio: 'pipe' });

  const results = JSON.parse(readFileSync(resultsPath, 'utf8'));
  assert.equal(results.pass, true);
  assert.equal(results.decision_hint, 'CONDITIONAL_GO');
  assert.equal(results.metrics.methods_covered, 35);
  assert.equal(results.metrics.payload_result_schemas_resolved, true);
  assert.equal(results.metrics.input_schema_validations, 70);
  assert.equal(results.metrics.output_schema_validations, 70);
  assert.equal(results.metrics.schema_negative_cases_rejected, 35);
  assert.doesNotMatch(results.limitation, /Schema|schema|payload\/result/);
  assert.match(results.limitation, /handler|worker/i);
  assert.match(results.limitation, /Network Broker/);
  assert.match(results.limitation, /DNS/);
  assert.match(results.limitation, /IP/);
  assert.match(results.limitation, /redirect/i);
  assert.match(results.limitation, /localhost/i);
  assert.match(results.limitation, /每跳/);

  const binding = results.facade_parity_evidence;
  assert.equal(binding.artifact, 'artifacts/facade-parity.json');
  const artifactPath = path.join(evidenceDir, binding.artifact);
  const artifactBytes = readFileSync(artifactPath);
  assert.equal(binding.sha256, `sha256:${createHash('sha256').update(artifactBytes).digest('hex')}`);
  assert.equal(binding.summary.methods_covered, 35);

  const auditModule = await import('../validation-status-audit.mjs');
  assert.equal(typeof auditModule.verifyEvidenceArtifactBindings, 'function');
  assert.equal(auditModule.verifyEvidenceArtifactBindings(resultsPath).valid, true);
  writeFileSync(artifactPath, Buffer.concat([artifactBytes, Buffer.from('\n')]));
  assert.equal(auditModule.verifyEvidenceArtifactBindings(resultsPath).valid, false);
});
