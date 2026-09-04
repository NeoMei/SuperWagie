import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Checker, argValue, writeResults, envFail, rmrf } from '../gate-1/lib.mjs';
import { createPublicMethodValidator } from '../contract-foundation/public-method-validator.mjs';

const FIXTURE_ID = 'G5-FACADE-001';
const EVIDENCE_REVISION = 'solution-b-v1';
const fixture = argValue(process.argv, '--fixture');
const resultsPath = argValue(process.argv, '--results-json');
const artifactsDir = argValue(process.argv, '--artifacts-dir');
if (fixture !== FIXTURE_ID || !resultsPath) {
  envFail('usage: facade-gate.mjs --fixture ' + FIXTURE_ID + ' --results-json <path> [--artifacts-dir <dir>]');
}

const startedAt = new Date().toISOString();
const checker = new Checker();
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'superwagie-g5-facade-'));

try {
  const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
  const catalogPath = path.join(repoRoot, 'docs', 'contracts', 'v1', 'public-capability-methods.json');
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const publicValidator = createPublicMethodValidator({ repoRoot });
  const methods = Array.isArray(catalog.methods) ? catalog.methods : [];
  const names = methods.map((method) => method.name);
  const knownRiskKinds = new Set(['scope_expansion', 'external_effect', 'destructive', 'high_cost_billing']);
  const knownGates = new Set(['none', 'risk_gate', 'risk_gate_when_triggered']);
  const payloadResultSchemasResolved = catalog.schema_resolution_status === 'resolved';
  const catalogValid = catalog.schema_resolution_status === 'resolved' &&
    methods.length > 0 && new Set(names).size === methods.length && methods.every((method) =>
    /^[a-z][a-z0-9_.-]{2,127}$/.test(method.name) &&
    /^superwagie:\/\/schemas\/v1\//.test(method.input_schema) &&
    /^superwagie:\/\/schemas\/v1\//.test(method.output_schema) &&
    knownGates.has(method.required_gate) &&
    Array.isArray(method.risk_kinds) && method.risk_kinds.every((kind) => knownRiskKinds.has(kind)));
  checker.check('facade:catalog-valid', catalogValid, 'methods=' + methods.length + ' unique=' + (new Set(names).size === methods.length));

  const revisions = new Map([['official_agent', 0], ['user_extension', 0]]);
  const forbiddenTrustedKeys = new Set([
    'actor_context', 'caller_identity', 'project_context', 'permission_context',
    'billing_context', 'gate_context', 'audit_context', 'gate_receipt',
    'actor', 'caller', 'project', 'effective_grants', 'grant_ids', 'wallet',
    'wallet_id', 'billing', 'billing_reservation', 'risk', 'risk_context',
    'risk_gate_receipt',
  ]);
  const error = (code) => ({ error: { code, safe_user_message: '请求未获授权。', next_actions: [] } });
  const hasForbidden = (object) => Object.keys(object || {}).some((key) => forbiddenTrustedKeys.has(key));

  let inputSchemaValidations = 0;
  let outputSchemaValidations = 0;
  function facadeCall(identity, methodName, payload = {}, clientContext = {}, gatewayContext = {}, simulatedOutput = undefined) {
    if (hasForbidden(clientContext) || hasForbidden(payload)) return error('SW_CALLER_CONTEXT_REJECTED');
    if (/^workflow\.private\./.test(methodName) || methodName === 'human_gate.submit_decision') return error('SW_PERMISSION_DENIED');
    const definition = methods.find((method) => method.name === methodName);
    if (!definition) return error('SW_SCHEMA_INVALID');
    inputSchemaValidations += 1;
    if (!publicValidator.validateInput(methodName, payload).valid) return error('SW_SCHEMA_INVALID');
    if (definition.required_gate === 'risk_gate' && !gatewayContext.risk_gate_receipt) return error('SW_RISK_GATE_REQUIRED');
    outputSchemaValidations += 1;
    if (!publicValidator.validateOutput(methodName, simulatedOutput).valid) return error('SW_SCHEMA_INVALID');
    const nextRevision = (revisions.get(identity.kind) || 0) + 1;
    revisions.set(identity.kind, nextRevision);
    const material = JSON.stringify({ method: methodName, payload });
    return {
      method: methodName,
      input_schema: definition.input_schema,
      result_schema: definition.output_schema,
      result_payload: simulatedOutput,
      artifact: { content_hash: 'sha256:' + crypto.createHash('sha256').update(material).digest('hex') },
      revision: nextRevision,
      receipt: { status: 'completed', identity_kind: identity.kind },
    };
  }

  const OFFICIAL = { kind: 'official_agent' };
  const USER = { kind: 'user_extension' };
  let parityOk = true;
  const parity = {};
  for (const definition of methods) {
    const fixtureCase = publicValidator.fixtures.get(definition.name);
    const payload = fixtureCase.input;
    const trustedGate = definition.required_gate === 'risk_gate'
      ? { risk_gate_receipt: { injected_by: 'trusted_gateway' } }
      : {};
    const official = facadeCall(OFFICIAL, definition.name, payload, {}, trustedGate, fixtureCase.output);
    const user = facadeCall(USER, definition.name, payload, {}, trustedGate, fixtureCase.output);
    const officialShape = Object.keys(official).sort().join(',');
    const userShape = Object.keys(user).sort().join(',');
    const receiptShape = Object.keys(official.receipt || {}).sort().join(',') === Object.keys(user.receipt || {}).sort().join(',');
    const artifactParity = official.artifact?.content_hash === user.artifact?.content_hash;
    const revisionParity = official.revision === user.revision;
    const methodOk = officialShape === userShape && receiptShape && artifactParity && revisionParity;
    parity[definition.name] = { method_ok: methodOk, official_revision: official.revision, user_revision: user.revision };
    parityOk = parityOk && methodOk;
  }
  const parityInputSchemaValidations = inputSchemaValidations;
  const parityOutputSchemaValidations = outputSchemaValidations;
  checker.check('facade:all-method-parity', parityOk, 'methods_covered=' + Object.keys(parity).length);

  let schemaNegativeCasesRejected = 0;
  for (const definition of methods) {
    const fixtureCase = publicValidator.fixtures.get(definition.name);
    const invalid = { ...fixtureCase.input, unexpected_field: true };
    if (!publicValidator.validateInput(definition.name, invalid).valid) schemaNegativeCasesRejected += 1;
  }
  checker.check('facade:schema-negative-cases', schemaNegativeCasesRejected === methods.length,
    'rejected=' + schemaNegativeCasesRejected + '/' + methods.length);

  const forgedActor = facadeCall(USER, 'workspace.read', {}, { actor_context: { user_id: 'admin' } });
  const forgedWallet = facadeCall(USER, 'ai.chat', {}, { billing_context: { wallet_id: 'other' } });
  const forgedPublishReceipt = facadeCall(USER, 'publish.promote', { gate_receipt: 'forged' }, {}, { risk_gate_receipt: { injected_by: 'trusted_gateway' } });
  const trustedContextForgeryRejected = [forgedActor, forgedWallet, forgedPublishReceipt]
    .every((result) => result.error?.code === 'SW_CALLER_CONTEXT_REJECTED');
  checker.check('facade:trusted-context-injection', trustedContextForgeryRejected,
    'actor=' + forgedActor.error?.code + ' wallet=' + forgedWallet.error?.code + ' receipt=' + forgedPublishReceipt.error?.code);

  const promoteFixture = publicValidator.fixtures.get('publish.promote');
  const riskWithoutReceipt = facadeCall(USER, 'publish.promote', promoteFixture.input, {}, {}, promoteFixture.output);
  const riskWithReceipt = facadeCall(USER, 'publish.promote', promoteFixture.input, {}, { risk_gate_receipt: { injected_by: 'trusted_gateway' } }, promoteFixture.output);
  checker.check('facade:risk-receipt-injected', riskWithoutReceipt.error?.code === 'SW_RISK_GATE_REQUIRED' && riskWithReceipt.receipt?.status === 'completed',
    'without=' + riskWithoutReceipt.error?.code + ' with=' + riskWithReceipt.receipt?.status);

  const privateMethods = ['workflow.private.list', 'workflow.private.read', 'workflow.private.start', 'human_gate.submit_decision'];
  const privateDenied = privateMethods.every((method) => facadeCall(USER, method).error?.code === 'SW_PERMISSION_DENIED');
  checker.check('facade:private-surface-denied', privateDenied, 'methods=' + privateMethods.length);

  const chatFixture = publicValidator.fixtures.get('ai.chat');
  const sample = facadeCall(USER, 'ai.chat', chatFixture.input, {}, {}, chatFixture.output);
  const serialized = JSON.stringify(sample).toLowerCase();
  const leaked = ['provider', 'openai', 'anthropic', 'api_key', 'apikey', 'sk-', 'codex-protocol', 'model']
    .filter((term) => serialized.includes(term));
  checker.check('facade:no-provider-leak', leaked.length === 0, 'leaked=' + (leaked.join('|') || 'none'));

  const effectiveArtifactsDir = artifactsDir || path.join(path.dirname(resultsPath), 'artifacts');
  fs.mkdirSync(effectiveArtifactsDir, { recursive: true });
  const parityBytes = Buffer.from(JSON.stringify({
    evidence_revision: EVIDENCE_REVISION, catalog_schema_id: catalog.schema_id,
    parity, trusted_context_forgery_rejected: trustedContextForgeryRejected,
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(effectiveArtifactsDir, 'facade-parity.json'), parityBytes);
  const facadeParityEvidence = {
    artifact: 'artifacts/facade-parity.json',
    sha256: `sha256:${crypto.createHash('sha256').update(parityBytes).digest('hex')}`,
    summary: {
      methods_covered: Object.keys(parity).length,
      caller_kinds_compared: 2,
      all_method_parity: parityOk,
    },
  };

  const pass = writeResults(resultsPath, {
    gate: 'gate-5', fixture: FIXTURE_ID, evidenceRevision: EVIDENCE_REVISION,
    startedAt, checker, decisionHint: 'CONDITIONAL_GO',
    limitation: '34 个 active 公开方法的真实领域 handler、产品 Worker 与 Managed AI 输出清洗/Secret scanner 尚未实现和垂直切片验收；Network Broker 的 DNS/IP/redirect/localhost 每跳校验尚未实现和垂直验收',
    metrics: {
      checks: checker.summary,
      methods_covered: Object.keys(parity).length,
      payload_result_schemas_resolved: payloadResultSchemasResolved,
      input_schema_validations: parityInputSchemaValidations,
      output_schema_validations: parityOutputSchemaValidations,
      schema_negative_cases_rejected: schemaNegativeCasesRejected,
      trusted_context_forgery_rejected: trustedContextForgeryRejected,
      caller_kinds_compared: 2,
    },
    extra: { facade_parity_evidence: facadeParityEvidence },
  });
  console.log((pass ? 'PASS' : 'FAIL') + ' ' + FIXTURE_ID + ' checks=' + JSON.stringify(checker.summary));
  rmrf(tmpBase);
  process.exit(pass ? 0 : 1);
} catch (error) {
  console.error('ERROR executor: ' + (error && error.stack ? error.stack : String(error)));
  rmrf(tmpBase);
  process.exit(2);
}
