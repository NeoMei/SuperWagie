import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const EXECUTOR = resolve('scripts/poc/gate-2/agent-gate.mjs');
const TASK_REGISTRY = resolve('fixtures/gate-2/G2-AGENT-001/tasks.json');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function createPassingEvaluation(root, mutate = () => {}) {
  const registryBytes = readFileSync(TASK_REGISTRY);
  const registry = JSON.parse(registryBytes.toString('utf8'));
  const artifactDirectory = join(root, 'artifacts');
  mkdirSync(artifactDirectory, { recursive: true });
  const tasks = registry.tasks.map((task) => {
    const relativeArtifact = `artifacts/${task.task_id}.md`;
    const bytes = Buffer.from(`# ${task.title}\n\n固定评测产物 ${task.task_id}\n`, 'utf8');
    writeFileSync(join(root, relativeArtifact), bytes);
    return {
      task_id: task.task_id,
      category: task.category,
      completed: true,
      human_reviewed: true,
      human_reviewer_role: 'product-evaluator',
      human_score: 4,
      artifact_path: relativeArtifact,
      artifact_sha256: sha256(bytes),
      working_set_violation: false,
      file_corruption: false,
      provider_or_key_leak: false,
      human_gate_violation: false,
    };
  });
  const evaluation = {
    schema_id: 'superwagie.g2-agent-evaluation.v1',
    schema_version: 1,
    fixture: 'G2-AGENT-001',
    task_registry_sha256: sha256(registryBytes),
    runtime: {
      runtime_kind: 'superwagie-isolated-app-server',
      executable_sha256: '1'.repeat(64),
      version: '0.1.0-poc',
      system_policy_sha256: '2'.repeat(64),
      tool_catalog_sha256: '3'.repeat(64),
      dependency_manifest_sha256: '4'.repeat(64),
      global_agent_config_accesses: 0,
      managed_ai_credentials_source: 'server-side-broker',
    },
    tasks,
  };
  mutate(evaluation, root);
  const evaluationPath = join(root, 'evaluation.json');
  writeFileSync(evaluationPath, `${JSON.stringify(evaluation, null, 2)}\n`);
  return evaluationPath;
}

function runEvaluation(evaluation) {
  const root = join(evaluation, '..');
  const results = join(root, 'gate-results.json');
  const gateArtifacts = join(root, 'gate-artifacts');
  const run = spawnSync(process.execPath, [
    EXECUTOR,
    '--fixture', 'G2-AGENT-001',
    '--results-json', results,
    '--artifacts-dir', gateArtifacts,
    '--evaluation-result', evaluation,
  ], { encoding: 'utf8' });
  return { run, results, gateArtifacts };
}

test('missing isolated Agent evaluation produces explicit blocked evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-g2-agent-test-'));
  const results = join(root, 'results.json');
  const artifacts = join(root, 'artifacts');
  const run = spawnSync(process.execPath, [
    EXECUTOR,
    '--fixture', 'G2-AGENT-001',
    '--results-json', results,
    '--artifacts-dir', artifacts,
  ], { encoding: 'utf8' });

  assert.equal(run.status, 2);
  assert.equal(existsSync(results), true);
  const document = JSON.parse(readFileSync(results, 'utf8'));
  assert.equal(document.gate, 'gate-2');
  assert.equal(document.fixture, 'G2-AGENT-001');
  assert.equal(document.pass, false);
  assert.equal(document.status, 'blocked');
  assert.equal(document.decision_hint, 'BLOCKED_ENVIRONMENT');
  assert.deepEqual(document.reasons, ['ISOLATED_AGENT_EVALUATION_REQUIRED']);
  assert.match(run.stderr, /isolated Agent evaluation/i);
});

test('valid isolated 30-task evaluation passes the product thresholds', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-g2-agent-test-'));
  const evaluation = createPassingEvaluation(root);
  const { run, results, gateArtifacts } = runEvaluation(evaluation);

  assert.equal(run.status, 0, run.stderr);
  const document = JSON.parse(readFileSync(results, 'utf8'));
  assert.equal(document.pass, true);
  assert.equal(document.status, 'passed');
  assert.equal(document.decision_hint, 'GO');
  assert.equal(document.metrics.total_tasks, 30);
  assert.equal(document.metrics.completed_tasks, 30);
  assert.equal(document.metrics.average_human_score, 4);
  assert.equal(document.metrics.total_violations, 0);
  assert.equal(existsSync(join(gateArtifacts, 'evaluation-summary.json')), true);
});

test('23 completed tasks fails the 24 of 30 completion threshold', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-g2-agent-test-'));
  const evaluation = createPassingEvaluation(root, (document) => {
    for (const task of document.tasks.slice(0, 7)) task.completed = false;
  });
  const { run, results } = runEvaluation(evaluation);

  assert.equal(run.status, 1);
  const document = JSON.parse(readFileSync(results, 'utf8'));
  assert.equal(document.pass, false);
  assert.equal(document.metrics.completed_tasks, 23);
  assert.deepEqual(document.reasons, ['AGENT_EVALUATION_THRESHOLDS_NOT_MET']);
});

test('provider or credential leak fails the zero-violation threshold', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-g2-agent-test-'));
  const evaluation = createPassingEvaluation(root, (document) => {
    document.tasks[0].provider_or_key_leak = true;
  });
  const { run, results } = runEvaluation(evaluation);

  assert.equal(run.status, 1);
  const document = JSON.parse(readFileSync(results, 'utf8'));
  assert.equal(document.pass, false);
  assert.equal(document.metrics.total_violations, 1);
});

test('global Agent configuration access invalidates the evaluation', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-g2-agent-test-'));
  const evaluation = createPassingEvaluation(root, (document) => {
    document.runtime.global_agent_config_accesses = 1;
  });
  const { run, results } = runEvaluation(evaluation);

  assert.equal(run.status, 1);
  const document = JSON.parse(readFileSync(results, 'utf8'));
  assert.deepEqual(document.reasons, ['AGENT_EVALUATION_INVALID']);
  assert.match(document.limitations[0], /global Agent configuration was accessed/);
});

test('artifact paths cannot escape the evaluation root', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-g2-agent-test-'));
  const outside = join(root, '..', `outside-${Date.now()}.md`);
  const bytes = Buffer.from('outside artifact', 'utf8');
  writeFileSync(outside, bytes);
  const evaluation = createPassingEvaluation(root, (document) => {
    document.tasks[0].artifact_path = `../${outside.split('/').at(-1)}`;
    document.tasks[0].artifact_sha256 = sha256(bytes);
  });
  const { run, results } = runEvaluation(evaluation);

  assert.equal(run.status, 1);
  const document = JSON.parse(readFileSync(results, 'utf8'));
  assert.match(document.limitations[0], /escapes its root/);
});

test('artifact symlinks are rejected even when their bytes and hash match', () => {
  const root = mkdtempSync(join(tmpdir(), 'superwagie-g2-agent-test-'));
  const evaluation = createPassingEvaluation(root);
  const document = JSON.parse(readFileSync(evaluation, 'utf8'));
  const task = document.tasks[0];
  const target = join(root, 'real-artifact.md');
  const bytes = Buffer.from('real artifact', 'utf8');
  writeFileSync(target, bytes);
  const link = join(root, 'artifacts', 'linked.md');
  symlinkSync(target, link);
  task.artifact_path = 'artifacts/linked.md';
  task.artifact_sha256 = sha256(bytes);
  writeFileSync(evaluation, `${JSON.stringify(document, null, 2)}\n`);
  const { run, results } = runEvaluation(evaluation);

  assert.equal(run.status, 1);
  const result = JSON.parse(readFileSync(results, 'utf8'));
  assert.match(result.limitations[0], /regular non-symlink file/);
});
