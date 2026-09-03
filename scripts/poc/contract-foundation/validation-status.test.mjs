import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('cross-language consumers and resolved public method schemas make Contract Foundation GO', () => {
  const dir = mkdtempSync(join(tmpdir(), 'superwagie-contract-status-'));
  const resultsPath = join(dir, 'results.json');
  execFileSync(process.execPath, [
    fileURLToPath(new URL('./validate.mjs', import.meta.url)),
    '--fixture', 'CF-PROTOCOL-002', '--results-json', resultsPath,
  ], { encoding: 'utf8', stdio: 'pipe' });
  const result = JSON.parse(readFileSync(resultsPath, 'utf8'));
  assert.equal(result.pass, true);
  assert.equal(result.decision_hint, 'GO');
  assert.equal(result.consumer_parity.node_ajv, 'passed');
  assert.equal(result.consumer_parity.rust, 'passed');
  assert.equal(result.consumer_parity.typescript, 'passed');
  assert.equal(result.consumer_parity.python, 'passed');
  assert.equal(result.consumer_parity.public_method_schemas, 'resolved');
  assert.equal(result.limitation, null);
  assert.equal(result.public_method_schemas.catalog_methods, 34);
  assert.equal(result.public_method_schemas.resolved_schemas, 68);
  assert.equal(result.public_method_schemas.valid_minimal_fixtures, 68);
  assert.equal(result.public_method_schemas.rejected_negative_fixtures, 68);
  assert.equal(result.public_method_schemas.semantic_directions_reviewed, 68);
  assert.equal(result.public_method_schemas.semantic_rules_checked, 2);
  assert.equal(result.public_method_schemas.semantic_mutations_rejected, 2);

  const artifactPath = join(dir, result.consumer_parity_evidence.artifact);
  const artifactBytes = readFileSync(artifactPath);
  assert.equal(
    result.consumer_parity_evidence.sha256,
    `sha256:${createHash('sha256').update(artifactBytes).digest('hex')}`,
  );
  const parity = JSON.parse(artifactBytes);
  assert.equal(parity.pass, true);
  assert.deepEqual(parity.consumers.map(({ consumer }) => consumer), ['typescript', 'python', 'rust']);
  assert.equal(parity.summary.fixture_cases, 46);
  assert.equal(parity.summary.agreed_cases, 46);
});
