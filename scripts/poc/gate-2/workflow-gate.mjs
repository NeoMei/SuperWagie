import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Checker, argValue, writeResults, envFail, rmrf } from '../gate-1/lib.mjs';

const FIXTURE_ID = 'G2-WORKFLOW-001';
const EVIDENCE_REVISION = 'solution-b-v1';
const RISK_KINDS = ['scope_expansion', 'external_effect', 'destructive', 'high_cost_billing'];
const fixture = argValue(process.argv, '--fixture');
const resultsPath = argValue(process.argv, '--results-json');
const artifactsDir = argValue(process.argv, '--artifacts-dir');
if (fixture !== FIXTURE_ID || !resultsPath) {
  envFail('usage: workflow-gate.mjs --fixture ' + FIXTURE_ID + ' --results-json <path> [--artifacts-dir <dir>]');
}

const startedAt = new Date().toISOString();
const checker = new Checker();
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'superwagie-g2-workflow-'));
const hash = (value) => 'sha256:' + crypto.createHash('sha256').update(String(value)).digest('hex');
const now = Date.parse('2026-09-01T08:00:00Z');

function createState(content, tone) {
  return { run_id: 'run-001', revision: 1, content, tone, executions: {}, cache: {}, receipts: {}, log: [] };
}

function workflowReceipt(state) {
  return {
    receipt_type: 'workflow_gate', workflow_run_id: state.run_id,
    candidate_hash: hash(state.content + '|' + state.tone), accepted_revision: state.revision,
    status: 'valid', expires_at: '2026-09-01T08:10:00Z',
  };
}

function riskReceipt(kind, operation, scope) {
  return {
    receipt_type: 'risk_gate', risk_kind: kind, action_hash: hash(operation), scope_hash: hash(scope),
    authorized_operations: [operation], status: 'valid', expires_at: '2026-09-01T08:10:00Z',
  };
}

function installReceipt(extensionId, manifest, permissions) {
  return {
    receipt_type: 'install_gate', extension_id: extensionId,
    manifest_hash: hash(manifest), permissions_hash: hash([...permissions].sort().join('|')),
    status: 'valid', expires_at: '2026-09-01T08:10:00Z',
  };
}

function unexpired(receipt) {
  return receipt && receipt.status === 'valid' && Date.parse(receipt.expires_at) > now;
}

function acceptsWorkflow(state, receipt) {
  return unexpired(receipt) && receipt.receipt_type === 'workflow_gate' &&
    receipt.workflow_run_id === state.run_id && receipt.accepted_revision === state.revision &&
    receipt.candidate_hash === hash(state.content + '|' + state.tone);
}

function acceptsRisk(receipt, kind, operation, scope) {
  return unexpired(receipt) && receipt.receipt_type === 'risk_gate' && receipt.risk_kind === kind &&
    receipt.action_hash === hash(operation) && receipt.scope_hash === hash(scope) &&
    receipt.authorized_operations.includes(operation);
}

function acceptsInstall(receipt, extensionId, manifest, permissions) {
  return unexpired(receipt) && receipt.receipt_type === 'install_gate' && receipt.extension_id === extensionId &&
    receipt.manifest_hash === hash(manifest) && receipt.permissions_hash === hash([...permissions].sort().join('|'));
}

function stageKey(state, stage) {
  if (stage === 'draft') return 'draft:' + state.revision;
  if (stage === 'summary') return 'summary:' + state.revision + ':' + state.tone;
  if (stage === 'review') return 'review:' + state.revision;
  return 'export:' + state.revision + ':' + state.tone;
}

function runStage(state, stage, fail = false) {
  if (stage === 'export' && !acceptsWorkflow(state, state.receipts.workflow)) return { blocked: 'workflow_gate' };
  const key = stageKey(state, stage);
  if (state.cache[key]) return { reused: true, value: state.cache[key] };
  state.executions[stage] = (state.executions[stage] || 0) + 1;
  if (fail) throw new Error('injected stage failure');
  const value = { stage, key };
  state.cache[key] = value;
  state.log.push({ stage, key, executed: true });
  return { executed: true, value };
}

try {
  const gates = createState('正文内容', '正式');
  const wf = workflowReceipt(gates);
  const workflowValid = acceptsWorkflow(gates, wf);
  gates.revision += 1;
  const workflowInvalidated = !acceptsWorkflow(gates, wf);
  const expiredWorkflow = { ...workflowReceipt(gates), expires_at: '2026-09-01T07:59:59Z' };
  checker.check('wf:workflow-gate-binding', workflowValid && workflowInvalidated && !acceptsWorkflow(gates, expiredWorkflow),
    'valid=' + workflowValid + ' changed_candidate_rejected=' + workflowInvalidated);

  let allRisksValid = true;
  let allRiskForgeriesRejected = true;
  for (const kind of RISK_KINDS) {
    const receipt = riskReceipt(kind, 'operation.' + kind, 'project-001');
    const otherKind = RISK_KINDS.find((candidate) => candidate !== kind);
    allRisksValid = acceptsRisk(receipt, kind, 'operation.' + kind, 'project-001') && allRisksValid;
    allRiskForgeriesRejected = !acceptsRisk(receipt, kind, 'operation.' + kind, 'project-002') &&
      !acceptsRisk({ ...receipt, risk_kind: otherKind }, kind, 'operation.' + kind, 'project-001') && allRiskForgeriesRejected;
  }
  checker.check('wf:risk-gates', allRisksValid && allRiskForgeriesRejected,
    'kinds=' + RISK_KINDS.length + ' valid=' + allRisksValid + ' forgeries_rejected=' + allRiskForgeriesRejected);

  const install = installReceipt('skill-alpha', 'manifest-v1', ['workspace.read', 'ai.chat']);
  const installValid = acceptsInstall(install, 'skill-alpha', 'manifest-v1', ['ai.chat', 'workspace.read']);
  const installMutationRejected = !acceptsInstall(install, 'skill-alpha', 'manifest-v2', ['ai.chat', 'workspace.read']) &&
    !acceptsInstall(install, 'skill-alpha', 'manifest-v1', ['workspace.read', 'ai.chat', 'browser.fetch']);
  checker.check('wf:install-gate-binding', installValid && installMutationRejected,
    'valid=' + installValid + ' mutation_rejected=' + installMutationRejected);

  const local = createState('影响范围验证内容', '正式');
  runStage(local, 'draft');
  runStage(local, 'summary');
  runStage(local, 'review');
  local.receipts.workflow = workflowReceipt(local);
  runStage(local, 'export');
  local.tone = '口语化';
  local.receipts.workflow = workflowReceipt(local);
  runStage(local, 'summary');
  runStage(local, 'review');
  runStage(local, 'export');
  const localInvalidationVerified = local.executions.draft === 1 && local.executions.summary === 2 &&
    local.executions.review === 1 && local.executions.export === 2;
  checker.check('wf:local-invalidation', localInvalidationVerified, JSON.stringify(local.executions));

  const recovery = createState('恢复验证内容', '正式');
  runStage(recovery, 'draft');
  runStage(recovery, 'summary');
  recovery.receipts.workflow = workflowReceipt(recovery);
  const statePath = path.join(tmpBase, 'workflow.json');
  fs.writeFileSync(statePath, JSON.stringify(recovery, null, 2) + '\n');
  const restored = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  runStage(restored, 'draft');
  runStage(restored, 'summary');
  runStage(restored, 'review');
  runStage(restored, 'export');
  const recoveryOk = restored.executions.draft === 1 && restored.executions.summary === 1 &&
    restored.executions.review === 1 && restored.executions.export === 1;
  checker.check('wf:checkpoint-recovery', recoveryOk, JSON.stringify(restored.executions));

  const retry = createState('局部失败', '正式');
  runStage(retry, 'draft');
  runStage(retry, 'summary');
  runStage(retry, 'review');
  retry.receipts.workflow = workflowReceipt(retry);
  let failed = false;
  try { runStage(retry, 'export', true); } catch { failed = true; }
  runStage(retry, 'export');
  const retryOk = failed && retry.executions.export === 2 && retry.executions.draft === 1 && retry.executions.review === 1;
  checker.check('wf:leaf-retry', retryOk, JSON.stringify(retry.executions));

  if (artifactsDir) {
    fs.mkdirSync(artifactsDir, { recursive: true });
    fs.writeFileSync(path.join(artifactsDir, 'workflow-traces.json'), JSON.stringify({
      evidence_revision: EVIDENCE_REVISION, risk_kinds: RISK_KINDS,
      local_executions: local.executions, recovery_executions: restored.executions,
    }, null, 2) + '\n');
  }

  const pass = writeResults(resultsPath, {
    gate: 'gate-2', fixture: FIXTURE_ID, evidenceRevision: EVIDENCE_REVISION,
    startedAt, checker, decisionHint: 'GO', limitation: null,
    metrics: { gate_mechanisms: 3, risk_kinds: RISK_KINDS.length, local_invalidation_verified: localInvalidationVerified, checks: checker.summary },
  });
  console.log((pass ? 'PASS' : 'FAIL') + ' ' + FIXTURE_ID + ' checks=' + JSON.stringify(checker.summary));
  rmrf(tmpBase);
  process.exit(pass ? 0 : 1);
} catch (error) {
  console.error('ERROR executor: ' + (error && error.stack ? error.stack : String(error)));
  rmrf(tmpBase);
  process.exit(2);
}
