import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');

test('TypeScript, Python, and Rust independently agree on every CF-PROTOCOL-002 fixture', () => {
  const requiredSources = [
    'consumer-parity.mjs',
    'consumers/typescript-consumer.ts',
    'consumers/python-consumer/pyproject.toml',
    'consumers/python-consumer/uv.lock',
    'consumers/python-consumer/consumer.py',
    'consumers/rust-consumer/Cargo.toml',
    'consumers/rust-consumer/Cargo.lock',
    'consumers/rust-consumer/src/main.rs',
  ];
  for (const relative of requiredSources) {
    assert.ok(existsSync(path.join(here, relative)), `missing parity source: ${relative}`);
  }

  const completed = spawnSync(process.execPath, [
    path.join(here, 'consumer-parity.mjs'),
    '--fixture', 'CF-PROTOCOL-002',
  ], { cwd: repo, encoding: 'utf8', timeout: 180_000 });
  assert.equal(completed.status, 0, completed.stderr || completed.stdout);
  const report = JSON.parse(completed.stdout);
  assert.equal(report.schema_id, 'superwagie.contract-consumer-parity.v1');
  assert.equal(report.fixture, 'CF-PROTOCOL-002');
  assert.equal(report.pass, true);
  assert.deepEqual(report.consumers.map(({ consumer }) => consumer), ['typescript', 'python', 'rust']);

  const expectedCases = readdirSync(path.join(repo, 'fixtures/contract-foundation/CF-PROTOCOL-002'))
    .filter((name) => name.endsWith('.json'))
    .length;
  assert.equal(report.summary.fixture_cases, expectedCases);
  assert.equal(report.summary.agreed_cases, expectedCases);
  assert.equal(report.summary.failed_cases, 0);
  assert.ok(report.consumers.every(({ pass, cases }) => pass && cases.length === expectedCases));
});

test('parity runner rejects a fixture whose declared expectation contradicts all three observations', () => {
  const temporaryRepo = mkdtempSync(path.join(tmpdir(), 'superwagie-contract-parity-'));
  cpSync(path.join(repo, 'docs/contracts/v1'), path.join(temporaryRepo, 'docs/contracts/v1'), { recursive: true });
  cpSync(
    path.join(repo, 'fixtures/contract-foundation/CF-PROTOCOL-002'),
    path.join(temporaryRepo, 'fixtures/contract-foundation/CF-PROTOCOL-002'),
    { recursive: true },
  );
  const fixturePath = path.join(
    temporaryRepo,
    'fixtures/contract-foundation/CF-PROTOCOL-002/intent-min-001.json',
  );
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  fixture.expect = 'invalid';
  writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  const completed = spawnSync(process.execPath, [
    path.join(here, 'consumer-parity.mjs'),
    '--repo-root', temporaryRepo,
    '--fixture', 'CF-PROTOCOL-002',
  ], { cwd: repo, encoding: 'utf8', timeout: 180_000 });
  assert.equal(completed.status, 1, completed.stderr || completed.stdout);
  const report = JSON.parse(completed.stdout);
  assert.equal(report.pass, false);
  assert.ok(report.failures.some(({ case_id: caseId }) => caseId === 'INTENT-MIN-001'));
});

test('resource policy is evaluated rather than trusted from the fixture expectation', () => {
  const temporaryRepo = mkdtempSync(path.join(tmpdir(), 'superwagie-contract-policy-'));
  cpSync(path.join(repo, 'docs/contracts/v1'), path.join(temporaryRepo, 'docs/contracts/v1'), { recursive: true });
  cpSync(
    path.join(repo, 'fixtures/contract-foundation/CF-PROTOCOL-002'),
    path.join(temporaryRepo, 'fixtures/contract-foundation/CF-PROTOCOL-002'),
    { recursive: true },
  );
  const fixturePath = path.join(
    temporaryRepo,
    'fixtures/contract-foundation/CF-PROTOCOL-002/resource-policy-allowed-021.json',
  );
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  fixture.request.audience.id = 'worker-other';
  writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

  const completed = spawnSync(process.execPath, [
    path.join(here, 'consumer-parity.mjs'),
    '--repo-root', temporaryRepo,
    '--fixture', 'CF-PROTOCOL-002',
  ], { cwd: repo, encoding: 'utf8', timeout: 180_000 });
  assert.equal(completed.status, 1, completed.stderr || completed.stdout);
  const report = JSON.parse(completed.stdout);
  assert.equal(report.pass, false);
  assert.ok(report.failures.some(({ case_id: caseId }) => caseId === 'RESOURCE-POLICY-ALLOWED-021'));
  for (const consumer of report.consumers) {
    const policyCase = consumer.cases.find(({ case_id: caseId }) => caseId === 'RESOURCE-POLICY-ALLOWED-021');
    assert.equal(policyCase.observed.outcome, 'audience-mismatch');
    assert.equal(policyCase.observed.schema_valid, true);
  }
});
