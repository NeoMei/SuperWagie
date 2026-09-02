#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { argValue, envFail } from '../gate-1/lib.mjs';

const FIXTURE_ID = 'G2-AGENT-001';
const TASK_REGISTRY = fileURLToPath(new URL('../../../fixtures/gate-2/G2-AGENT-001/tasks.json', import.meta.url));
const FIXTURE_ROOT = dirname(TASK_REGISTRY);
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const fixture = argValue(process.argv, '--fixture');
const resultsPath = argValue(process.argv, '--results-json');
const evaluationResult = argValue(process.argv, '--evaluation-result');
const artifactsDir = argValue(process.argv, '--artifacts-dir');

if (fixture !== FIXTURE_ID || !resultsPath) {
  envFail(`usage: agent-gate.mjs --fixture ${FIXTURE_ID} --results-json <path> [--artifacts-dir <dir>] [--evaluation-result <absolute-json>]`);
}

if (!evaluationResult) {
  const now = new Date().toISOString();
  const result = {
    schema_id: 'superwagie.g2-agent-gate-result.v1',
    schema_version: 1,
    gate: 'gate-2',
    fixture: FIXTURE_ID,
    started_at: now,
    finished_at: now,
    pass: false,
    status: 'blocked',
    decision_hint: 'BLOCKED_ENVIRONMENT',
    reasons: ['ISOLATED_AGENT_EVALUATION_REQUIRED'],
    limitations: [
      'A 30-task result from the isolated SuperWagie App Server and Managed AI channel is required; the host Codex Desktop session is not admissible.',
    ],
  };
  mkdirSync(dirname(resultsPath), { recursive: true });
  writeFileSync(resultsPath, `${JSON.stringify(result, null, 2)}\n`);
  console.error('BLOCKED_ENVIRONMENT: isolated Agent evaluation is required');
  process.exit(2);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} keys must be exactly ${wanted.join(',')}`);
  }
}

function readRegularFile(path, label, maxBytes = MAX_ARTIFACT_BYTES) {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  if (metadata.size > maxBytes) throw new Error(`${label} exceeds size limit`);
  return readFileSync(path);
}

function containedFile(root, relativePath, label) {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || isAbsolute(relativePath)) {
    throw new Error(`${label} must be a nonempty relative path`);
  }
  const candidate = resolve(root, relativePath);
  const rel = relative(root, candidate);
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new Error(`${label} escapes its root`);
  }
  return candidate;
}

function writeGateResult(result) {
  mkdirSync(dirname(resultsPath), { recursive: true });
  writeFileSync(resultsPath, `${JSON.stringify(result, null, 2)}\n`);
}

const startedAt = new Date().toISOString();
try {
  if (!isAbsolute(evaluationResult)) throw new Error('evaluation result path must be absolute');
  const registryBytes = readRegularFile(TASK_REGISTRY, 'task registry');
  const registry = JSON.parse(registryBytes.toString('utf8'));
  assertExactKeys(registry, ['schema_id', 'schema_version', 'fixture', 'tasks'], 'task registry');
  if (registry.schema_id !== 'superwagie.g2-agent-task-registry.v1' || registry.schema_version !== 1 || registry.fixture !== FIXTURE_ID) {
    throw new Error('task registry identity mismatch');
  }
  if (!Array.isArray(registry.tasks) || registry.tasks.length !== 30) throw new Error('task registry must contain exactly 30 tasks');

  const registryById = new Map();
  const registryCategoryCounts = { longform: 0, ppt: 0, research: 0 };
  for (const task of registry.tasks) {
    assertExactKeys(task, ['task_id', 'category', 'title', 'source_files', 'required_artifacts', 'human_gate'], `registry task ${task?.task_id ?? '?'}`);
    if (typeof task.task_id !== 'string' || registryById.has(task.task_id)) throw new Error('task registry IDs must be unique strings');
    if (!Object.hasOwn(registryCategoryCounts, task.category)) throw new Error(`unknown task category ${task.category}`);
    if (!Array.isArray(task.source_files) || task.source_files.length === 0) throw new Error(`task ${task.task_id} has no sources`);
    for (const source of task.source_files) {
      readRegularFile(containedFile(FIXTURE_ROOT, source, `source for ${task.task_id}`), `source for ${task.task_id}`);
    }
    registryCategoryCounts[task.category] += 1;
    registryById.set(task.task_id, task);
  }
  if (Object.values(registryCategoryCounts).some((count) => count !== 10)) {
    throw new Error('task registry must contain 10 tasks in each category');
  }

  const evaluationBytes = readRegularFile(evaluationResult, 'evaluation result');
  const evaluation = JSON.parse(evaluationBytes.toString('utf8'));
  assertExactKeys(evaluation, ['schema_id', 'schema_version', 'fixture', 'task_registry_sha256', 'runtime', 'tasks'], 'evaluation');
  if (evaluation.schema_id !== 'superwagie.g2-agent-evaluation.v1' || evaluation.schema_version !== 1 || evaluation.fixture !== FIXTURE_ID) {
    throw new Error('evaluation identity mismatch');
  }
  if (evaluation.task_registry_sha256 !== sha256(registryBytes)) throw new Error('task registry hash mismatch');

  assertExactKeys(evaluation.runtime, [
    'runtime_kind',
    'executable_sha256',
    'version',
    'system_policy_sha256',
    'tool_catalog_sha256',
    'dependency_manifest_sha256',
    'global_agent_config_accesses',
    'managed_ai_credentials_source',
  ], 'runtime');
  if (evaluation.runtime.runtime_kind !== 'superwagie-isolated-app-server') throw new Error('runtime is not the isolated SuperWagie App Server');
  if (evaluation.runtime.managed_ai_credentials_source !== 'server-side-broker') throw new Error('Managed AI credentials did not come from the server-side broker');
  if (evaluation.runtime.global_agent_config_accesses !== 0) throw new Error('global Agent configuration was accessed');
  for (const field of ['executable_sha256', 'system_policy_sha256', 'tool_catalog_sha256', 'dependency_manifest_sha256']) {
    if (!SHA256.test(evaluation.runtime[field])) throw new Error(`runtime ${field} is not sha256`);
  }
  if (typeof evaluation.runtime.version !== 'string' || evaluation.runtime.version.length === 0) throw new Error('runtime version is missing');
  if (!Array.isArray(evaluation.tasks) || evaluation.tasks.length !== 30) throw new Error('evaluation must contain exactly 30 task results');

  const seen = new Set();
  const categoryCounts = { longform: 0, ppt: 0, research: 0 };
  let completedTasks = 0;
  let scoreTotal = 0;
  let totalViolations = 0;
  const sanitizedTasks = [];
  const evaluationRoot = dirname(evaluationResult);
  for (const task of evaluation.tasks) {
    assertExactKeys(task, [
      'task_id',
      'category',
      'completed',
      'human_reviewed',
      'human_reviewer_role',
      'human_score',
      'artifact_path',
      'artifact_sha256',
      'working_set_violation',
      'file_corruption',
      'provider_or_key_leak',
      'human_gate_violation',
    ], `evaluation task ${task?.task_id ?? '?'}`);
    const registered = registryById.get(task.task_id);
    if (!registered || seen.has(task.task_id)) throw new Error(`unknown or duplicate task ${task.task_id}`);
    if (task.category !== registered.category) throw new Error(`category mismatch for ${task.task_id}`);
    if (task.completed !== true && task.completed !== false) throw new Error(`completed must be boolean for ${task.task_id}`);
    if (task.human_reviewed !== true || typeof task.human_reviewer_role !== 'string' || task.human_reviewer_role.length === 0) {
      throw new Error(`human review is incomplete for ${task.task_id}`);
    }
    if (!Number.isInteger(task.human_score) || task.human_score < 1 || task.human_score > 5) throw new Error(`human score is invalid for ${task.task_id}`);
    if (!SHA256.test(task.artifact_sha256)) throw new Error(`artifact hash is invalid for ${task.task_id}`);
    const artifactBytes = readRegularFile(
      containedFile(evaluationRoot, task.artifact_path, `artifact for ${task.task_id}`),
      `artifact for ${task.task_id}`,
    );
    if (sha256(artifactBytes) !== task.artifact_sha256) throw new Error(`artifact hash mismatch for ${task.task_id}`);
    for (const field of ['working_set_violation', 'file_corruption', 'provider_or_key_leak', 'human_gate_violation']) {
      if (task[field] !== true && task[field] !== false) throw new Error(`${field} must be boolean for ${task.task_id}`);
      if (task[field]) totalViolations += 1;
    }
    seen.add(task.task_id);
    categoryCounts[task.category] += 1;
    if (task.completed) completedTasks += 1;
    scoreTotal += task.human_score;
    sanitizedTasks.push({
      task_id: task.task_id,
      category: task.category,
      completed: task.completed,
      human_score: task.human_score,
      artifact_sha256: task.artifact_sha256,
    });
  }
  if (seen.size !== registryById.size || Object.values(categoryCounts).some((count) => count !== 10)) {
    throw new Error('evaluation task coverage is incomplete');
  }

  const averageHumanScore = scoreTotal / evaluation.tasks.length;
  const pass = completedTasks >= 24 && averageHumanScore >= 4 && totalViolations === 0;
  const metrics = {
    total_tasks: evaluation.tasks.length,
    completed_tasks: completedTasks,
    average_human_score: averageHumanScore,
    total_violations: totalViolations,
    category_counts: categoryCounts,
  };
  if (artifactsDir) {
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(resolve(artifactsDir, 'evaluation-summary.json'), `${JSON.stringify({
      schema_id: 'superwagie.g2-agent-evaluation-summary.v1',
      schema_version: 1,
      fixture: FIXTURE_ID,
      task_registry_sha256: evaluation.task_registry_sha256,
      runtime: evaluation.runtime,
      metrics,
      tasks: sanitizedTasks,
    }, null, 2)}\n`);
  }
  writeGateResult({
    schema_id: 'superwagie.g2-agent-gate-result.v1',
    schema_version: 1,
    gate: 'gate-2',
    fixture: FIXTURE_ID,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    pass,
    status: pass ? 'passed' : 'failed',
    decision_hint: pass ? 'GO' : 'NO_GO',
    reasons: pass ? [] : ['AGENT_EVALUATION_THRESHOLDS_NOT_MET'],
    limitations: [],
    metrics,
  });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${FIXTURE_ID} completed=${completedTasks}/30 average=${averageHumanScore.toFixed(2)} violations=${totalViolations}`);
  process.exit(pass ? 0 : 1);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  writeGateResult({
    schema_id: 'superwagie.g2-agent-gate-result.v1',
    schema_version: 1,
    gate: 'gate-2',
    fixture: FIXTURE_ID,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    pass: false,
    status: 'failed',
    decision_hint: 'NO_GO',
    reasons: ['AGENT_EVALUATION_INVALID'],
    limitations: [message],
  });
  console.error(`NO_GO: ${message}`);
  process.exit(1);
}
