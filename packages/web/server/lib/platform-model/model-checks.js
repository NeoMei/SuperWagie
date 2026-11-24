import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isEnterpriseMode } from '../enterprise-mode.js';
import { ModelConfigurationError } from '../model-configuration/runtime.js';
import { managedCheckCallId, managedModelCheckPlan, probeManagedModel } from './model-check-probes.js';

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code, status) => { throw new ModelConfigurationError(code, status); };
const unfinished = (row) => ['queued', 'testing'].includes(row.status);
const stoppedTest = { status: 'skipped', errorCode: 'account_key_checks_stopped' };
const stopCodes = new Set([
  'platform_model_credits_required', 'platform_insufficient_funds', 'platform_billing_unavailable',
  'product_membership_expired', 'platform_session_expired', 'platform_session_changed', 'platform_model_access_unavailable',
]);
const knownFailure = z.string().regex(/^(?:platform_(?:model|billing|request|session|insufficient|gateway)|product_membership|model_configuration_test|native_media_invalid)[a-z0-9_]*$/);

export function createManagedModelChecks({ platformAccount, models, store, isAvailable, enterprise = isEnterpriseMode, probe = probeManagedModel, now = Date.now }) {
  const active = new Map();
  const timestamp = () => new Date(now()).toISOString();
  const context = ({ identity, owner, accountId, fundingMode }) => {
    if (fundingMode && fundingMode !== 'credits') fail('model_configuration_invalid_input', 400);
    if (!identity || !owner?.token) fail('platform_account_required', 401);
    const actor = platformAccount.actor(identity);
    const session = platformAccount.captureCommerceSession(identity);
    const { issuer, userId } = platformAccount.instancePrincipal(identity);
    if (!issuer || !actor.authSession || actor.billingAccountId !== accountId || session.billingAccountId !== accountId
      || actor.actingUserId !== session.actingUserId || userId !== session.actingUserId) fail('platform_account_forbidden', 403);
    const id = 'managed-model-check-' + digest([issuer, session.serviceId, actor.actingUserId, accountId]);
    const assertCurrent = () => {
      const current = platformAccount.actor(identity);
      if (current.authSession !== actor.authSession || current.actingUserId !== actor.actingUserId || current.billingAccountId !== accountId) fail('platform_session_changed', 409);
    };
    const assertAvailable = () => {
      assertCurrent();
      if (enterprise()) fail('enterprise_mode', 403);
      if (!isAvailable()) fail('model_configuration_account_runtime_unavailable', 503);
    };
    return { id, accountId, identity, authSession: actor.authSession, assertCurrent, assertAvailable };
  };
  const initialRows = (rows) => rows.map(({ id, modelId, purpose, operation }) => ({
    id, modelId, purpose, status: operation ? 'queued' : 'skipped', testedAt: null,
    errorCode: operation ? null : 'account_key_probe_unavailable',
  }));
  const view = (ctx, rows, saved) => {
    const running = saved?.status === 'testing' && active.get(ctx.id)?.authSession === ctx.authSession;
    const interrupted = saved?.status === 'testing' && !running;
    const tests = (saved?.tests ?? initialRows(rows)).map(({ callId: _callId, ...row }) =>
      interrupted && unfinished(row) ? { ...row, status: 'unknown', errorCode: 'account_key_test_unknown' } : row);
    return {
      accountId: ctx.accountId, enterpriseMode: enterprise(), fundingMode: 'credits', mode: 'managed',
      nativeCredits: { ready: isAvailable() }, activation: {
        operationId: saved?.runId ?? ctx.id, stage: 'test', status: interrupted ? 'unknown' : saved?.status ?? 'unknown',
        key: null, modelId: null, connectionId: null, providerId: null, test: saved?.test ?? null,
        testRunId: saved?.runId ?? null, tests, errorCode: interrupted ? 'account_key_test_unknown' : saved?.test?.errorCode ?? null,
        actions: active.has(ctx.id) || !rows.some(({ operation }) => operation) ? [] : ['retest'],
      },
    };
  };
  const read = async (input) => {
    const ctx = context(input);
    const rows = managedModelCheckPlan(await models());
    const saved = await store.read(ctx.id);
    ctx.assertCurrent();
    return view(ctx, rows, saved?.kind === 'managed-model-check' && saved.plan === digest(rows) ? saved : null);
  };
  const run = async (ctx, rows, saved, gateway) => {
    let cursor = 0;
    let stopped = false;
    let writes = Promise.resolve();
    const update = (index, change) => {
      Object.assign(saved.tests[index], change);
      const tests = structuredClone(saved.tests);
      writes = writes.then(async () => {
        if (!await store.update(ctx.id, { tests })) throw new Error('Missing model check receipt');
      });
      return writes;
    };
    const check = async () => {
      while (!stopped && cursor < rows.length) {
        const index = cursor++;
        const row = rows[index];
        if (!row.operation) continue;
        ctx.assertAvailable();
        const callId = managedCheckCallId(row.operation);
        // Persist the logical ID before issuing the only paid request for this row.
        await update(index, { status: 'testing', callId });
        if (stopped) {
          await update(index, stoppedTest);
          return;
        }
        const signal = AbortSignal.timeout(['video', 'ocr', 'image-edit'].includes(row.operation) ? 300_000 : 120_000);
        const send = (request) => {
          ctx.assertAvailable();
          return platformAccount.proxyProductModel(ctx.identity, {
            ...request, model: row.modelId, accountId: ctx.accountId, callId, taskId: saved.runId, signal,
          });
        };
        let result;
        try {
          await probe({ row, callId, taskId: saved.runId, send, signal, gateway });
          ctx.assertAvailable();
          result = { status: 'verified', errorCode: null };
        } catch (error) {
          const cause = error?.upstream ?? error;
          const code = [cause?.code, cause?.message].find((value) => knownFailure.safeParse(value).success) ?? 'account_key_test_unknown';
          stopped ||= stopCodes.has(code);
          result = { status: code === 'account_key_test_unknown' || signal.aborted ? 'unknown' : 'failed', errorCode: code };
        }
        await update(index, { ...result, testedAt: timestamp() });
      }
    };
    await Promise.allSettled(Array.from({ length: Math.min(3, rows.length) }, check));
    await writes;
    const tests = saved.tests.map((row) => {
      if (!unfinished(row)) return row;
      if (row.status === 'queued' && stopped) return { ...row, ...stoppedTest };
      return { ...row, status: 'unknown', errorCode: 'account_key_test_unknown' };
    });
    const verified = tests.length > 0 && tests.every((row) => row.status === 'verified');
    const hasUnknown = tests.some((row) => row.status === 'unknown');
    const status = verified ? 'ready' : hasUnknown ? 'unknown' : 'failed';
    await store.update(ctx.id, { tests, status, test: { status: verified ? 'verified' : status, testedAt: timestamp(), errorCode: verified ? null : hasUnknown ? 'account_key_test_unknown' : 'account_key_test_failed' } });
  };
  const activate = async (input) => {
    const ctx = context(input);
    if (input.action !== 'retest') fail('model_configuration_invalid_input', 400);
    ctx.assertAvailable();
    if (active.has(ctx.id) || active.size >= 4) fail('account_key_busy', 409);
    active.set(ctx.id, ctx);
    try {
      const config = await models();
      const rows = managedModelCheckPlan(config);
      ctx.assertAvailable();
      await platformAccount.usesProductCreditWallet(ctx.identity);
      ctx.assertAvailable();
      const saved = await store.create({ id: ctx.id, kind: 'managed-model-check', runId: randomUUID(), plan: digest(rows), status: 'testing', tests: initialRows(rows) });
      void run(ctx, rows, saved, config.gateway).catch(() => {}).finally(() => active.delete(ctx.id));
      return view(ctx, rows, saved);
    } catch (error) {
      active.delete(ctx.id);
      throw error;
    }
  };
  return { read, activate };
}
