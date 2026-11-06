import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

import { isEnterpriseMode } from '../enterprise-mode.js';
import { ModelConfigurationError } from './runtime.js';
import { llmRouterInferenceApiUrl } from './bootstrap-endpoints.js';
import { createAccountKeyStore } from './account-key-store.js';
import { selectAccountKeyModels, planAccountKeyTests } from './account-key-test-plan.js';

const id = z.string().min(1).max(200);
const instanceId = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const accountIdSchema = id.regex(/^[A-Za-z0-9_-]+$/);
const date = z.string().datetime({ offset: true });
const modelSchema = z.object({ id, name: id, operations: z.array(z.string()).max(30), dimensions: z.number().int().min(1).max(65536).nullable().optional(), input_modalities: z.array(z.string()).max(10).nullable().optional() });
const discoverySchema = z.object({ account_id: id, origin_product_id: z.literal('superwagie'), instance_id: instanceId, models: z.array(modelSchema).max(1000) });
const keySchema = z.object({
  id, token: z.string().min(16).max(8192), credential_kind: z.literal('api_key'),
  actor_id: id, account_id: id, origin_product_id: z.literal('superwagie'), instance_id: instanceId,
  models: z.array(id).min(1).max(100), created_at: date, expires_at: date.nullable(), revoked_at: z.null(),
});
const active = new Set();
// A failed receipt write must not discard already observed provider results.
// This fallback is actor/account scoped and disappears after a successful write.
const unsavedTests = new Map();
const fail = (code, status = 409) => { throw new ModelConfigurationError(code, status); };
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parse = (schema, value, code, status = 400) => {
  const result = schema.safeParse(value);
  if (!result.success) fail(code, status);
  return result.data;
};
const errorCode = (error, stage) => {
  if (error?.code === 'model_configuration_account_probe_unknown') return 'account_key_test_unknown';
  if (error?.code === 'enterprise_mode') return 'enterprise_mode';
  if (['platform_session_changed', 'platform_account_changed', 'platform_account_required', 'platform_session_expired'].includes(error?.code)) return 'account_key_session_changed';
  if (error?.code === 'model_configuration_revision_conflict') return 'account_key_configuration_changed';
  if (['account_key_configuration_conflict', 'model_configuration_account_provider_conflict', 'model_configuration_account_key_conflict', 'model_configuration_credential_changed'].includes(error?.code)) return 'account_key_configuration_conflict';
  return stage === 'test' ? 'account_key_test_failed' : 'account_key_configuration_failed';
};

/** One durable activation per verified actor/account/service on this runtime. */
export const createAccountKeyActivation = ({ dataDir, store, modelRuntime, platformAccount, provider, readLegacyModels = async () => [], receiptStore, env = process.env, enterpriseOptions, now = Date.now }) => {
  const journal = receiptStore ?? createAccountKeyStore({ dataDir });
  const timestamp = () => new Date(now()).toISOString();
  const enterprise = () => isEnterpriseMode(enterpriseOptions);
  const requireEntry = () => { if (enterprise()) fail('enterprise_mode', 403); };
  const context = ({ accountId, identity, owner }) => {
    parse(accountIdSchema, accountId, 'model_configuration_invalid_input');
    if (!owner?.token || !identity) fail('platform_account_required', 401);
    const session = platformAccount.captureCommerceSession(identity);
    const principal = platformAccount.instancePrincipal(identity);
    const actor = platformAccount.actor(identity);
    if (session.billingAccountId !== accountId || actor.billingAccountId !== accountId) fail('platform_account_forbidden', 403);
    if (!principal.issuer || principal.userId !== session.actingUserId || actor.actingUserId !== session.actingUserId || !actor.authSession) fail('platform_account_forbidden', 403);
    const ownership = { issuer: principal.issuer, serviceId: session.serviceId, actorId: session.actingUserId, accountId };
    const storageId = hash(ownership);
    const activeId = `${dataDir}:${storageId}`;
    const assertSession = () => {
      const current = platformAccount.actor(identity);
      const currentSession = platformAccount.captureCommerceSession(identity);
      if (current.authSession !== actor.authSession || current.actingUserId !== actor.actingUserId || current.billingAccountId !== accountId || currentSession.serviceId !== session.serviceId || platformAccount.instancePrincipal(identity).issuer !== ownership.issuer) fail('platform_session_changed');
    };
    const assertCurrent = () => { requireEntry(); assertSession(); };
    return { ownership, session, storageId, activeId, assertCurrent, assertSession };
  };
  const assertOwner = (ctx, record) => {
    if (record && Object.entries(ctx.ownership).some(([name, value]) => record[name] !== value)) fail('platform_account_forbidden', 403);
  };
  const project = (ctx, record) => {
    assertOwner(ctx, record);
    if (!record) return { accountId: ctx.ownership.accountId, enterpriseMode: enterprise(), activation: null };
    let { status, stage, test, tests, errorCode: code } = record;
    if (!active.has(ctx.activeId)) {
      if (status === 'issuing') { status = 'unknown'; code = 'account_key_issue_unknown'; }
      if (status === 'testing') {
        status = 'unknown'; code = 'account_key_test_unknown'; test = { status: 'unknown', testedAt: null, errorCode: code };
        tests = tests.map((row) => ['queued', 'testing'].includes(row.status) ? { ...row, status: 'unknown', testedAt: null, errorCode: code } : row);
      }
      if (status === 'configuring') { status = 'interrupted'; code = 'account_key_configuration_interrupted'; }
    }
    const actions = active.has(ctx.activeId) || enterprise() || !record.key ? []
      : stage === 'configure' ? ['resume'] : stage === 'test' ? ['retest'] : [];
    return { accountId: ctx.ownership.accountId, enterpriseMode: enterprise(), activation: {
      operationId: record.operationId, status, stage, key: record.key,
      modelId: record.modelId, connectionId: record.connectionId, providerId: record.providerId,
      test, testRunId: record.testRunId, tests, errorCode: code, actions,
    } };
  };
  const read = async (input) => {
    const ctx = context(input);
    const record = await observe(ctx, unsavedTests.get(ctx.activeId) ?? await journal.read(ctx.storageId));
    ctx.assertSession();
    return project(ctx, record);
  };
  const connectionFor = (record) => ({ id: record.connectionId, name: 'SuperWagie', providerId: 'llmrouter', protocol: 'openai-compatible', baseUrl: record.baseUrl, credentialSource: { type: 'model-bootstrap', providerId: 'llmrouter', ref: record.secretRef } });
  const providerRequest = (ctx, record, apiKey) => ({ providerId: record.providerId, modelId: record.modelId, apiKey, baseUrl: record.baseUrl, models: record.chatModels ?? record.models, assertCurrent: ctx.assertCurrent });
  const observe = async (ctx, record) => {
    assertOwner(ctx, record);
    if (record?.status !== 'ready') return record;
    try {
      ctx.assertSession();
      if (record.baseUrl !== llmRouterInferenceApiUrl(env)) fail('account_key_configuration_conflict');
      const apiKey = await store.getSecret(record.secretRef);
      if (!apiKey || store.fingerprint(apiKey) !== record.keyFingerprint) fail('account_key_configuration_conflict');
      await modelRuntime.verifyAccountKeyConnection({ connection: connectionFor(record), apiKey, assertCurrent: ctx.assertSession });
      if (!provider?.verify) fail('account_key_configuration_failed');
      await provider.verify({ ...providerRequest(ctx, record, apiKey), assertCurrent: ctx.assertSession });
      ctx.assertSession();
      return record;
    } catch (error) {
      ctx.assertSession();
      return { ...record, status: 'failed', stage: 'configure', errorCode: errorCode(error, 'configure') };
    }
  };
  const persist = async (ctx, record) => {
    const saved = await journal.write(ctx.storageId, { ...record, updatedAt: timestamp() });
    unsavedTests.delete(ctx.activeId);
    return saved;
  };
  const issue = async (ctx) => {
    ctx.assertCurrent();
    const catalog = parse(discoverySchema, await ctx.session.request(`/v1/accounts/${encodeURIComponent(ctx.ownership.accountId)}/model-discovery`, { method: 'POST', headers: { 'Content-Type': 'application/json' } }), 'account_key_catalog_invalid', 502);
    ctx.assertCurrent();
    if (catalog.account_id !== ctx.ownership.accountId) fail('platform_account_forbidden', 403);
    if (new Set(catalog.models.map((model) => model.id)).size !== catalog.models.length) fail('account_key_catalog_invalid', 502);
    const configuration = await modelRuntime.getPublicConfiguration();
    const legacy = await readLegacyModels();
    ctx.assertCurrent();
    const selection = selectAccountKeyModels(catalog.models, configuration, legacy);
    if (!selection) fail('account_key_chat_model_unavailable', 409);
    const { models } = selection;
    const operationId = randomUUID();
    let record = await persist(ctx, {
      version: 1, ...ctx.ownership, operationId, instanceId: catalog.instance_id,
      status: 'issuing', stage: 'issue', errorCode: null, key: null, secretRef: null, keyFingerprint: null,
      baseUrl: llmRouterInferenceApiUrl(env), providerId: `superwagie-account-${operationId}`, connectionId: `account-key-${operationId}`,
      ...selection, test: null, testRunId: null, tests: [], createdAt: timestamp(),
    });
    // No issuance idempotency exists upstream. Every post-dispatch failure is
    // unknown and retains this receipt; it must never issue another key.
    try {
      ctx.assertCurrent();
      const raw = await ctx.session.request(`/v1/accounts/${encodeURIComponent(ctx.ownership.accountId)}/api-keys`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'SuperWagie', origin_product_id: 'superwagie', instance_id: record.instanceId, models: models.map((model) => model.id) }),
      });
      const key = parse(keySchema, raw, 'account_key_issue_unknown', 502);
      if (key.actor_id !== record.actorId || key.account_id !== record.accountId || key.instance_id !== record.instanceId || key.models.length !== models.length || models.some((model) => !key.models.includes(model.id))) fail('account_key_issue_unknown');
      const secret = await store.putSecret(key.token);
      record = await persist(ctx, { ...record, status: 'configuring', stage: 'configure', secretRef: secret.ref, keyFingerprint: secret.fingerprint, key: { id: key.id, last4: secret.last4, createdAt: key.created_at, expiresAt: key.expires_at } });
      return record;
    } catch {
      return persist(ctx, { ...record, status: 'unknown', errorCode: 'account_key_issue_unknown' });
    }
  };
  const configure = async (ctx, record) => {
    ctx.assertCurrent();
    if (record.baseUrl !== llmRouterInferenceApiUrl(env)) fail('account_key_configuration_conflict');
    const apiKey = await store.getSecret(record.secretRef);
    if (!apiKey || store.fingerprint(apiKey) !== record.keyFingerprint) fail('account_key_configuration_conflict');
    ctx.assertCurrent();
    const configuration = await modelRuntime.getPublicConfiguration();
    const legacy = await readLegacyModels();
    ctx.assertCurrent();
    await modelRuntime.saveAccountKeyConnection({
      revision: configuration.revision,
      connection: connectionFor(record),
      bindings: record.purposeModels.filter((row) => record.stage === 'configure' && !record.testRunId && row.modelId && !row.errorCode && !legacy.some((existing) => existing.purpose === row.purpose) && record.models.some((model) => model.id === row.modelId))
        .map((row) => ({ purpose: row.purpose, model: row.modelId, parameters: row.parameters })),
      apiKey, assertCurrent: ctx.assertCurrent,
    });
    ctx.assertCurrent();
    await provider.configure({ ...providerRequest(ctx, record, apiKey), name: 'SuperWagie' });
    ctx.assertCurrent();
    return apiKey;
  };
  const test = async (ctx, record, apiKey) => {
    ctx.assertCurrent();
    const configuration = await modelRuntime.getPublicConfiguration();
    const legacy = await readLegacyModels();
    const request = providerRequest(ctx, record, apiKey);
    const native = provider.planTests ? await provider.planTests(request) : [];
    const accountRow = { id: 'account-chat', purpose: 'agent', modelId: record.modelId, providerId: record.providerId, account: true };
    const rows = [accountRow, ...native.filter((row) => row.purpose !== 'agent' || row.providerId !== record.providerId || row.modelId !== record.modelId)];
    const plan = planAccountKeyTests(record, configuration, legacy, rows);
    ctx.assertCurrent();
    let current = await persist(ctx, { ...record, status: 'testing', stage: 'test', test: null, testRunId: randomUUID(), errorCode: null,
      tests: plan.map((row) => ({ id: row.id, purpose: row.purpose, modelId: row.modelId, status: row.status ?? 'queued', errorCode: row.errorCode ?? null, testedAt: null })) });
    let stopped = null;
    let writes = Promise.resolve();
    const checkpoint = () => {
      const snapshot = current;
      writes = writes.then(async () => {
        if (stopped === 'account_key_test_state_failed') return false;
        try { await persist(ctx, snapshot); return true; }
        catch { stopped = 'account_key_test_state_failed'; unsavedTests.set(ctx.activeId, current); return false; }
      });
      return writes;
    };
    const update = (index, patch) => { current = { ...current, tests: current.tests.map((row, at) => at === index ? { ...row, ...patch } : row) }; };
    const outcome = (error) => {
      const code = error?.code;
      if (code === 'model_configuration_provider_unreachable' || /^model_configuration_provider_http_(?:408|5\d\d)$/.test(code ?? '') || !code) return { status: 'unknown', errorCode: 'account_key_test_unknown' };
      const safe = errorCode(error, 'test');
      const unknown = ['account_key_session_changed', 'enterprise_mode', 'account_key_test_unknown', 'account_key_configuration_changed', 'account_key_configuration_conflict'].includes(safe);
      return { status: unknown ? 'unknown' : 'failed', errorCode: safe };
    };
    let cursor = 0;
    const worker = async () => {
      while (!stopped && cursor < plan.length) {
        const index = cursor++;
        const row = plan[index];
        if (row.status === 'skipped') continue;
        try { ctx.assertCurrent(); }
        catch (error) { stopped = outcome(error).errorCode; break; }
        update(index, { status: 'testing' });
        if (!await checkpoint()) break;
        if (stopped) break;
        let result;
        try {
          ctx.assertCurrent();
          let response;
          if (row.account) response = await provider.probe(request);
          else if (row.native) response = await provider.probeConfiguredModel(request, row);
          else {
            const input = { revision: row.revision, purpose: row.purpose, model: row.binding.model, parameters: row.binding.parameters };
            if (row.binding.presetId) input.presetId = row.binding.presetId;
            response = await modelRuntime.testConnection(row.binding.connectionId, input, { assertCurrent: ctx.assertCurrent, expectedBootstrapCredential: { connection: connectionFor(record), apiKey } });
          }
          ctx.assertCurrent();
          if (!date.safeParse(response?.testedAt).success || !['verified', 'failed'].includes(response?.status)) result = { status: 'unknown', errorCode: 'account_key_test_unknown', testedAt: null };
          else if (response.status === 'verified') result = { status: 'verified', errorCode: null, testedAt: response.testedAt };
          else result = { ...outcome({ code: response.errorCode ?? 'model_configuration_test_failed' }), testedAt: response.testedAt };
        } catch (error) {
          result = { ...outcome(error), testedAt: timestamp() };
          if (['account_key_session_changed', 'enterprise_mode', 'account_key_configuration_changed', 'account_key_configuration_conflict'].includes(result.errorCode)) stopped = result.errorCode;
        }
        update(index, result);
        await checkpoint();
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, plan.length) }, worker));
    current = { ...current, tests: current.tests.map((row) => ['queued', 'testing'].includes(row.status) ? { ...row, status: 'unknown', testedAt: null, errorCode: stopped ?? 'account_key_test_unknown' } : row) };
    const measured = current.tests.filter((row) => row.status !== 'skipped');
    const status = !measured.length || measured.some((row) => row.status === 'unknown') ? 'unknown' : measured.some((row) => row.status === 'failed') ? 'failed' : 'verified';
    const code = stopped ?? (status === 'verified' ? null : status === 'unknown' ? 'account_key_test_unknown' : 'account_key_test_failed');
    current = { ...current, status: status === 'verified' && !stopped ? 'ready' : status === 'failed' ? 'failed' : 'unknown', errorCode: code, test: { status: stopped ? 'unknown' : status, testedAt: timestamp(), errorCode: code } };
    try { current = await persist(ctx, current); unsavedTests.delete(ctx.activeId); }
    catch {
      current = { ...current, status: 'unknown', errorCode: 'account_key_test_state_failed', test: { status: 'unknown', testedAt: null, errorCode: 'account_key_test_state_failed' } };
      unsavedTests.set(ctx.activeId, current);
    }
    return current;
  };
  const activate = async (input) => {
    let ctx = context(input);
    const action = parse(z.enum(['activate', 'resume', 'retest']), input.action, 'model_configuration_invalid_input');
    ctx.assertCurrent();
    if (!provider) fail('model_configuration_bootstrap_unsupported', 501);
    await platformAccount.refreshSession(input.identity);
    ctx.assertCurrent();
    ctx = context(input);
    if (active.has(ctx.activeId)) fail('account_key_busy', 409);
    active.add(ctx.activeId);
    let result;
    try {
      result = await journal.withLock(ctx.storageId, async () => {
        let record = await observe(ctx, unsavedTests.get(ctx.activeId) ?? await journal.read(ctx.storageId));
        assertOwner(ctx, record);
        ctx.assertCurrent();
        if (!record) {
          if (action !== 'activate') fail('account_key_activation_missing', 404);
          record = await issue(ctx);
          if (record.stage === 'issue') return record;
        } else {
          if (record.stage === 'issue') return { ...record, status: 'unknown', errorCode: 'account_key_issue_unknown' };
          if (record.stage === 'test' && action !== 'retest') return record;
          if (record.stage === 'configure' && action !== 'resume') return record;
        }
        let apiKey;
        try {
          if (record.stage === 'configure') record = await persist(ctx, { ...record, status: 'configuring', errorCode: null });
          // Retest also validates both saved credentials before any paid call.
          apiKey = await configure(ctx, record);
          ctx.assertCurrent();
        } catch (error) {
          const code = errorCode(error, 'configure');
          return persist(ctx, { ...record, stage: 'configure', status: code === 'account_key_session_changed' ? 'interrupted' : 'failed', errorCode: code });
        }
        try { return await test(ctx, record, apiKey); }
        catch (error) {
          const code = errorCode(error, 'test');
          const interrupted = { ...record, stage: 'test', status: 'unknown', errorCode: code, testRunId: randomUUID(), tests: [], test: { status: 'unknown', testedAt: null, errorCode: code } };
          try { return await persist(ctx, interrupted); }
          catch { unsavedTests.set(ctx.activeId, interrupted); return interrupted; }
        }
      });
    } finally { active.delete(ctx.activeId); }
    // Preserve the old owner's confirmed receipt even when the browser changed
    // identity while an operation was pending; never return it to that caller.
    ctx.assertCurrent();
    return project(ctx, result);
  };
  return { read, activate };
};
