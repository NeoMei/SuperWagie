import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import { isEnterpriseMode } from '../enterprise-mode.js';
import { ModelConfigurationError } from './runtime.js';
import { llmRouterInferenceApiUrl } from './bootstrap-endpoints.js';
import { createAccountKeyStore } from './account-key-store.js';
import { parseAccountKeyCatalog, readAccountKeyCatalog } from './account-key-catalog.js';
import { selectAccountKeyModels, planAccountKeyTests } from './account-key-test-plan.js';
import { fundingModeSchema, nativePricingSourceSchema, nativeCreditDiscoverySchema, nativeCreditCapabilitiesSchema } from './native-credit-contract.js';
import { accountNativeSelectionsMatch } from './account-key-provider.js';

const id = z.string().min(1).max(200);
const instanceId = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const accountIdSchema = id.regex(/^[A-Za-z0-9_-]+$/);
const date = z.string().datetime({ offset: true });
const modelSchema = z.object({ id, name: id, operations: z.array(z.string()).max(30), dimensions: z.number().int().min(1).max(65536).nullable().optional(), input_modalities: z.array(z.string()).max(10).nullable().optional(), speechOperation: z.literal('bailian.audio.speech.create').optional() });
const discoverySchema = z.object({ account_id: id, origin_product_id: z.literal('superwagie'), instance_id: instanceId, models: z.array(modelSchema).max(1000) });
const keySchema = z.object({
  id, token: z.string().min(16).max(8192), credential_kind: z.literal('api_key'),
  actor_id: id, account_id: id, origin_product_id: z.literal('superwagie'), instance_id: instanceId,
  model_scope: z.literal('llmrouter_available'), pricing_source: nativePricingSourceSchema, credential_version: z.number().int().positive(),
  funding_mode: fundingModeSchema.optional(), asset: z.enum(['CNY/6', 'CREDIT/6']).optional(),
  models: z.array(id).max(1000), created_at: date, expires_at: date.nullable(), revoked_at: z.null(),
});
const scopedKeySchema = keySchema.omit({ token: true });
const matchesNativeFunding = (key, fundingMode) => fundingMode === 'credits'
  ? key.pricing_source === 'llmrouter_native_credit' && key.funding_mode === 'credits' && key.asset === 'CREDIT/6'
  : key.pricing_source === 'llmrouter_native' && (key.funding_mode === undefined || key.funding_mode === 'prepaid_cash') && (key.asset === undefined || key.asset === 'CNY/6');
const purposeSelection = (configuration, legacy, purpose) => {
  const binding = configuration.bindings.find((entry) => entry.purpose === purpose);
  if (binding) {
    const { connectionId, model, presetId, parameters } = binding;
    return structuredClone({ connectionId, model, presetId, parameters });
  }
  const previous = legacy.find((entry) => entry.purpose === purpose);
  return previous ? structuredClone({ modelId: previous.modelId, parameters: previous.parameters ?? {}, errorCode: previous.errorCode ?? null }) : null;
};
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
const runtimeErrorCodes = ['model_configuration_account_runtime_required', 'model_configuration_account_runtime_unavailable'];
const errorCode = (error, stage) => {
  if (runtimeErrorCodes.includes(error?.code)) return error.code;
  if (error?.code === 'model_configuration_account_probe_unknown') return 'account_key_test_unknown';
  if (error?.code === 'enterprise_mode') return 'enterprise_mode';
  if (['platform_session_changed', 'platform_account_changed', 'platform_account_required', 'platform_session_expired'].includes(error?.code)) return 'account_key_session_changed';
  if (error?.code === 'model_configuration_revision_conflict') return 'account_key_configuration_changed';
  if (['account_key_configuration_conflict', 'model_configuration_account_provider_conflict', 'model_configuration_account_key_conflict', 'model_configuration_credential_changed'].includes(error?.code)) return 'account_key_configuration_conflict';
  if (/^model_configuration_provider_http_(?:400|401|403|404|409|413|415|422|429)$/.test(error?.code ?? '') || ['model_configuration_embedding_dimensions_mismatch', 'model_configuration_embedding_rebuild_required', 'model_configuration_unsupported_protocol', 'model_configuration_knowledge_not_ready', 'model_configuration_ocr_unavailable', 'model_configuration_probe_unavailable', 'account_key_scope_unavailable', 'account_key_scope_limit', 'account_key_catalog_invalid'].includes(error?.code)) return error.code;
  return stage === 'test' ? 'account_key_test_failed' : 'account_key_configuration_failed';
};

/** One durable activation per verified actor/account/service on this runtime. */
export const createAccountKeyActivation = ({ dataDir, store, modelRuntime, platformAccount, provider, readLegacyModels = async () => [], readKeyCatalog = readAccountKeyCatalog, fetchImpl = fetch, receiptStore, env = process.env, enterpriseOptions, now = Date.now }) => {
  const journal = receiptStore ?? createAccountKeyStore({ dataDir });
  const consumerOwners = new Map();
  const credentialOwners = new Map();
  const rememberConsumerOwner = (ctx, record) => {
    if (!record?.key) return;
    consumerOwners.set(record.connectionId, ctx);
    credentialOwners.set(record.keyFingerprint, ctx);
  };
  const timestamp = () => new Date(now()).toISOString();
  const enterprise = () => isEnterpriseMode(enterpriseOptions);
  const requireEntry = () => { if (enterprise()) fail('enterprise_mode', 403); };
  const context = ({ accountId, identity, owner, fundingMode: requestedFundingMode }) => {
    const fundingMode = parse(fundingModeSchema, requestedFundingMode ?? 'prepaid_cash', 'model_configuration_invalid_input');
    parse(accountIdSchema, accountId, 'model_configuration_invalid_input');
    if (!owner?.token || !identity) fail('platform_account_required', 401);
    const session = platformAccount.captureCommerceSession(identity);
    const principal = platformAccount.instancePrincipal(identity);
    const actor = platformAccount.actor(identity);
    if (session.billingAccountId !== accountId || actor.billingAccountId !== accountId) fail('platform_account_forbidden', 403);
    if (!principal.issuer || principal.userId !== session.actingUserId || actor.actingUserId !== session.actingUserId || !actor.authSession) fail('platform_account_forbidden', 403);
    const ownership = { issuer: principal.issuer, serviceId: session.serviceId, actorId: session.actingUserId, accountId };
    const lockId = hash(ownership);
    const storageId = fundingMode === 'credits' ? hash({ ...ownership, fundingMode }) : lockId;
    const activeId = `${dataDir}:${lockId}`;
    const assertSession = () => {
      const current = platformAccount.actor(identity);
      const currentSession = platformAccount.captureCommerceSession(identity);
      if (current.authSession !== actor.authSession || current.actingUserId !== actor.actingUserId || current.billingAccountId !== accountId || currentSession.serviceId !== session.serviceId || platformAccount.instancePrincipal(identity).issuer !== ownership.issuer) fail('platform_session_changed');
    };
    const assertCurrent = () => { requireEntry(); assertSession(); };
    return { ownership, session, storageId, lockId, fundingMode, activeId, receiptId: `${dataDir}:${storageId}`, consumerId: hash([storageId, actor.authSession]), assertCurrent, assertSession };
  };
  const assertOwner = (ctx, record) => {
    if (record && (record.fundingMode ?? 'prepaid_cash') !== ctx.fundingMode) fail('account_key_configuration_conflict');
    if (record && Object.entries(ctx.ownership).some(([name, value]) => record[name] !== value)) fail('platform_account_forbidden', 403);
  };
  const project = (ctx, record) => {
    assertOwner(ctx, record);
    if (!record) return { accountId: ctx.ownership.accountId, enterpriseMode: enterprise(), fundingMode: ctx.fundingMode, nativeCredits: ctx.nativeCredits, activation: null };
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
    return { accountId: ctx.ownership.accountId, enterpriseMode: enterprise(), fundingMode: ctx.fundingMode, nativeCredits: ctx.nativeCredits, activation: {
      operationId: record.operationId, fundingMode: record.fundingMode ?? 'prepaid_cash', pricingSource: record.pricingSource, status, stage, key: record.key,
      modelId: record.modelId, connectionId: record.connectionId, providerId: record.providerId,
      test, testRunId: record.testRunId, tests, errorCode: code, actions,
    } };
  };
  const readNativeCredits = async (ctx) => {
    const capabilities = parse(nativeCreditCapabilitiesSchema, await ctx.session.request('/v1/capabilities'), 'account_key_catalog_invalid', 502);
    ctx.assertSession();
    ctx.fundingModeSupported = capabilities.native_credits !== undefined;
    if (ctx.fundingMode === 'credits') ctx.nativeCredits = capabilities.native_credits ?? { ready: false };
  };
  const requireCredits = async (ctx) => {
    if (ctx.fundingMode !== 'credits') return;
    await readNativeCredits(ctx);
    if (!ctx.nativeCredits.ready) fail('native_credits_unavailable');
  };
  const read = async (input) => {
    const ctx = context(input);
    if (ctx.fundingMode === 'credits') await readNativeCredits(ctx);
    // Restore both credential owners after restart without applying either Key.
    if (input.fundingMode === undefined) {
      const credits = context({ ...input, fundingMode: 'credits' });
      // A damaged separate receipt must not hide the readable cash receipt.
      const stored = await journal.read(credits.storageId).catch(() => null);
      assertOwner(credits, stored);
      rememberConsumerOwner(credits, stored);
    }
    const record = await observe(ctx, unsavedTests.get(ctx.receiptId) ?? await journal.read(ctx.storageId));
    ctx.assertSession();
    rememberConsumerOwner(ctx, record);
    return project(ctx, record);
  };
  const connectionFor = (record) => ({ id: record.connectionId, name: 'SuperWagie', providerId: 'llmrouter', protocol: 'openai-compatible', baseUrl: record.baseUrl, credentialSource: { type: 'model-bootstrap', providerId: 'llmrouter', ref: record.secretRef } });
  const providerRequest = (ctx, record, apiKey) => {
    const request = { providerId: record.providerId, modelId: record.modelId, apiKey, baseUrl: record.baseUrl, models: record.chatModels ?? record.models, assertCurrent: ctx.assertCurrent };
    if (record.previousChatModels) request.previousModels = record.previousChatModels;
    return request;
  };
  const observe = async (ctx, record) => {
    assertOwner(ctx, record);
    if (record?.status !== 'ready') return record;
    if (!record.tests.length || record.tests.some((row) => row.status !== 'verified' || !row.applied)) {
      return { ...record, status: 'unknown', stage: 'test', errorCode: 'account_key_apply_required', test: { ...record.test, status: 'unknown', errorCode: 'account_key_apply_required' } };
    }
    try {
      ctx.assertSession();
      if (record.baseUrl !== llmRouterInferenceApiUrl(env)) fail('account_key_configuration_conflict');
      const apiKey = await store.getSecret(record.secretRef);
      if (!apiKey || store.fingerprint(apiKey) !== record.keyFingerprint) fail('account_key_configuration_conflict');
      await modelRuntime.verifyAccountKeyConnection({ connection: connectionFor(record), apiKey, assertCurrent: ctx.assertSession });
      if (!provider?.verify) fail('account_key_configuration_failed');
      await provider.verify({ ...providerRequest(ctx, record, apiKey), assertCurrent: ctx.assertSession });
      for (const row of record.tests) {
        if (['agent', 'auxiliary'].includes(row.purpose)) {
          if (!provider.verifyConfiguredModel) fail('account_key_configuration_failed');
          await provider.verifyConfiguredModel({ ...providerRequest(ctx, record, apiKey), assertCurrent: ctx.assertSession }, { purpose: row.purpose, modelId: row.modelId });
        } else {
          const selected = record.purposeModels.find((candidate) => candidate.purpose === row.purpose);
          if (!selected) fail('account_key_configuration_conflict');
          await modelRuntime.verifyAccountKeyBindings({ connection: connectionFor(record), apiKey, bindings: [{ purpose: row.purpose, model: row.modelId, parameters: selected.parameters }], assertCurrent: ctx.assertSession });
        }
      }
      ctx.assertSession();
      return record;
    } catch (error) {
      ctx.assertSession();
      return { ...record, status: 'failed', stage: 'configure', errorCode: errorCode(error, 'configure') };
    }
  };
  const persist = async (ctx, record) => {
    const saved = await journal.write(ctx.storageId, { ...record, updatedAt: timestamp() });
    unsavedTests.delete(ctx.receiptId);
    return saved;
  };
  const selectionSnapshot = async (ctx) => {
    const configuration = await modelRuntime.getPublicConfiguration();
    const legacy = await readLegacyModels();
    ctx.assertCurrent();
    const native = provider.readConfiguredModels ? await provider.readConfiguredModels({ assertCurrent: ctx.assertCurrent }) : { models: [], settings: {} };
    ctx.assertCurrent();
    return { configuration, legacy, native };
  };
  const discover = async (ctx, record, snapshot) => {
    ctx.assertCurrent();
    const { configuration, legacy, native } = snapshot ?? await selectionSnapshot(ctx);
    ctx.selectionSnapshot = { configuration, legacy, native };
    let payload;
    if (record) {
      const apiKey = await store.getSecret(record.secretRef);
      if (!apiKey || store.fingerprint(apiKey) !== record.keyFingerprint) fail('account_key_configuration_conflict');
      const models = await readKeyCatalog({ apiKey, baseUrl: record.baseUrl, instanceId: record.instanceId, assertCurrent: ctx.assertCurrent, fetchImpl, env, enterpriseOptions });
      payload = { account_id: record.accountId, origin_product_id: 'superwagie', instance_id: record.instanceId, models };
    } else {
      if (ctx.fundingModeSupported === undefined) await readNativeCredits(ctx);
      const input = { model_scope: 'llmrouter_available' };
      if (ctx.fundingModeSupported) input.funding_mode = ctx.fundingMode;
      payload = await ctx.session.request(`/v1/accounts/${encodeURIComponent(ctx.ownership.accountId)}/model-discovery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    }
    if (!record && ctx.fundingMode === 'credits') parse(nativeCreditDiscoverySchema, payload, 'account_key_catalog_invalid', 502);
    const catalog = parse(discoverySchema, payload, 'account_key_catalog_invalid', 502);
    // The proxy carries the same technical metadata as the Key catalog.
    // Preserve native protocols before the public discovery schema strips it.
    if (!record) catalog.models = parseAccountKeyCatalog({ object: 'list', data: payload.models });
    ctx.assertCurrent();
    if (catalog.account_id !== ctx.ownership.accountId) fail('platform_account_forbidden', 403);
    if (new Set(catalog.models.map((model) => model.id)).size !== catalog.models.length) fail('account_key_catalog_invalid', 502);
    ctx.nativeSnapshot = native;
    ctx.assertCurrent();
    const selection = selectAccountKeyModels(catalog.models, configuration, legacy, native.models);
    if (!selection) fail('account_key_chat_model_unavailable', 409);
    ctx.purposeSnapshot = Object.fromEntries(selection.purposeModels.map(({ purpose }) => [purpose, purposeSelection(configuration, legacy, purpose)]));
    return { catalog, selection };
  };
  const issue = async (ctx) => {
    const { catalog, selection } = await discover(ctx);
    const operationId = randomUUID();
    let record = await persist(ctx, {
      version: 1, ...ctx.ownership, fundingMode: ctx.fundingMode, operationId, instanceId: catalog.instance_id,
      status: 'issuing', stage: 'issue', errorCode: null, key: null, secretRef: null, keyFingerprint: null,
      baseUrl: llmRouterInferenceApiUrl(env), providerId: `superwagie-account-${operationId}`, connectionId: `account-key-${operationId}`,
      ...selection, test: null, testRunId: null, tests: [], createdAt: timestamp(),
    });
    // No issuance idempotency exists upstream. Every post-dispatch failure is
    // unknown and retains this receipt; it must never issue another key.
    try {
      ctx.assertCurrent();
      const input = { name: 'SuperWagie', origin_product_id: 'superwagie', instance_id: record.instanceId, model_scope: 'llmrouter_available', funding_mode: ctx.fundingMode };
      const raw = await ctx.session.request(`/v1/accounts/${encodeURIComponent(ctx.ownership.accountId)}/api-keys`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const key = parse(keySchema, raw, 'account_key_issue_unknown', 502);
      if (!matchesNativeFunding(key, ctx.fundingMode)) fail('account_key_issue_unknown');
      if (key.actor_id !== record.actorId || key.account_id !== record.accountId || key.instance_id !== record.instanceId) fail('account_key_issue_unknown');
      const secret = await store.putSecret(key.token);
      record = await persist(ctx, { ...record, modelScope: key.model_scope, pricingSource: key.pricing_source, credentialVersion: key.credential_version, status: 'configuring', stage: 'configure', secretRef: secret.ref, keyFingerprint: secret.fingerprint, key: { id: key.id, last4: secret.last4, createdAt: key.created_at, expiresAt: key.expires_at } });
      return record;
    } catch {
      return persist(ctx, { ...record, status: 'unknown', errorCode: 'account_key_issue_unknown' });
    }
  };
  const upgradeScope = async (ctx, record) => {
    if (record.modelScope === 'llmrouter_available') return record;
    ctx.assertCurrent();
    let value;
    try {
      value = await ctx.session.request(`/v1/accounts/${encodeURIComponent(record.accountId)}/api-keys/${encodeURIComponent(record.key.id)}/scope`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model_scope: 'llmrouter_available', origin_product_id: 'superwagie', instance_id: record.instanceId }),
      });
    } catch { fail('account_key_scope_unavailable'); }
    ctx.assertCurrent();
    const key = parse(scopedKeySchema, value, 'account_key_scope_unavailable', 502);
    if (!matchesNativeFunding(key, record.fundingMode ?? 'prepaid_cash')) fail('account_key_scope_unavailable');
    if (key.id !== record.key.id || key.actor_id !== record.actorId || key.account_id !== record.accountId || key.instance_id !== record.instanceId
      || key.created_at !== record.key.createdAt || key.expires_at !== record.key.expiresAt || key.credential_version <= (record.credentialVersion ?? 0)) fail('account_key_scope_unavailable');
    return persist(ctx, { ...record, modelScope: key.model_scope, pricingSource: key.pricing_source, credentialVersion: key.credential_version });
  };
  const refreshSelection = async (ctx, record, initialSnapshot) => {
    // A crash can leave the provider already expanded while its receipt still
    // carries the previous catalog. Finish that exact transition before
    // starting another expansion, retaining both recovery states until saved.
    if (record.previousChatModels) {
      await configure(ctx, record);
      const { previousChatModels: _previous, ...configured } = record;
      record = await persist(ctx, configured);
    }
    const snapshot = initialSnapshot ?? await selectionSnapshot(ctx);
    record = await upgradeScope(ctx, record);
    const { catalog, selection } = await discover(ctx, record, snapshot);
    if (catalog.instance_id !== record.instanceId) fail('account_key_configuration_conflict');
    if (initialSnapshot) return persist(ctx, { ...record, ...selection });
    const previousChatModels = record.previousChatModels ?? record.chatModels ?? record.models;
    return persist(ctx, { ...record, ...selection, previousChatModels });
  };
  const configure = async (ctx, record) => {
    ctx.assertCurrent();
    if (record.baseUrl !== llmRouterInferenceApiUrl(env)) fail('account_key_configuration_conflict');
    const apiKey = await store.getSecret(record.secretRef);
    if (!apiKey || store.fingerprint(apiKey) !== record.keyFingerprint) fail('account_key_configuration_conflict');
    ctx.assertCurrent();
    const configuration = await modelRuntime.getPublicConfiguration();
    ctx.assertCurrent();
    await modelRuntime.saveAccountKeyConnection({
      revision: configuration.revision, connection: connectionFor(record),
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
    const nativeState = provider.readConfiguredModels ? await provider.readConfiguredModels({ assertCurrent: ctx.assertCurrent }) : null;
    const native = nativeState?.models ?? (provider.planTests ? await provider.planTests(request) : []);
    const keyCatalog = await readKeyCatalog({ apiKey, baseUrl: record.baseUrl, instanceId: record.instanceId, assertCurrent: ctx.assertCurrent, fetchImpl, env, enterpriseOptions });
    const nativeCandidate = (row) => {
      const unreadable = row?.errorCode && row.errorCode !== 'model_configuration_account_model_unconfigured';
      const modelId = unreadable ? row.modelId
        : record.chatModels.some((model) => model.id === row?.modelId) ? row.modelId : record.modelId;
      return { modelId, providerId: record.providerId, errorCode: unreadable ? row.errorCode : null };
    };
    const rows = [
      { id: 'account-chat', purpose: 'agent', account: true, ...nativeCandidate(native.find((row) => row.purpose === 'agent')) },
      ...native.filter((row) => row.purpose !== 'agent').map((row) => ({ id: row.id, purpose: row.purpose, ...nativeCandidate(row) })),
    ];
    if (ctx.nativeSnapshot && nativeState) {
      for (const row of rows) {
        const keys = row.purpose === 'agent' ? ['defaultModel', 'defaultVariant'] : ['smallModelUseDefault', 'smallModelOverride', 'smallModelVariant'];
        if (!accountNativeSelectionsMatch(ctx.nativeSnapshot.nativeSelections, nativeState.nativeSelections, ctx.nativeSnapshot.settings, row.purpose)
          || keys.some((key) => ctx.nativeSnapshot.settings[key] !== nativeState.settings[key])) {
          row.errorCode = 'account_key_configuration_conflict';
        }
      }
    }
    const plan = planAccountKeyTests(record, configuration, legacy, rows, keyCatalog);
    for (const row of plan) {
      if (!row.native && ctx.purposeSnapshot && !isDeepStrictEqual(ctx.purposeSnapshot[row.purpose], purposeSelection(configuration, legacy, row.purpose))) {
        row.status = 'skipped';
        row.errorCode = 'account_key_configuration_conflict';
      }
    }
    ctx.assertCurrent();
    let current = await persist(ctx, { ...record, status: 'testing', stage: 'test', test: null, testRunId: randomUUID(), errorCode: null,
      tests: plan.map((row) => ({ id: row.id, purpose: row.purpose, modelId: row.modelId, status: row.status ?? 'queued', errorCode: row.errorCode ?? null, testedAt: null, applied: false })) });
    let stopped = null;
    let writes = Promise.resolve();
    const checkpoint = () => {
      const snapshot = current;
      writes = writes.then(async () => {
        if (stopped === 'account_key_test_state_failed') return false;
        try { await persist(ctx, snapshot); return true; }
        catch { stopped = 'account_key_test_state_failed'; unsavedTests.set(ctx.receiptId, current); return false; }
      });
      return writes;
    };
    const update = (index, patch) => { current = { ...current, tests: current.tests.map((row, at) => at === index ? { ...row, ...patch } : row) }; };
    const outcome = (error) => {
      const code = error?.code;
      if (code === 'model_configuration_provider_unreachable' || /^model_configuration_provider_http_(?:408|5\d\d)$/.test(code ?? '') || !code) return { status: 'unknown', errorCode: 'account_key_test_unknown' };
      const safe = errorCode(error, 'test');
      const unknown = ['account_key_session_changed', 'enterprise_mode', 'account_key_test_unknown', 'account_key_configuration_changed', 'account_key_configuration_conflict', 'model_configuration_account_runtime_unavailable'].includes(safe);
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
          if (row.native) response = await provider.probe({ ...request, modelId: row.modelId });
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
          if (['account_key_session_changed', 'enterprise_mode', 'account_key_configuration_changed', 'account_key_configuration_conflict', ...runtimeErrorCodes].includes(result.errorCode)) stopped = result.errorCode;
        }
        update(index, result);
        await checkpoint();
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, plan.length) }, worker));
    current = { ...current, tests: current.tests.map((row) => ['queued', 'testing'].includes(row.status) ? { ...row, status: 'unknown', testedAt: null, errorCode: stopped ?? 'account_key_test_unknown' } : row) };
    // Probes share one revision. Apply confirmed choices serially afterwards,
    // so a successful save cannot invalidate a sibling's paid request.
    let applyRevision = configuration.revision;
    for (let index = 0; index < plan.length && !stopped; index++) {
      if (current.tests[index].status !== 'verified') continue;
      const row = plan[index];
      try {
        ctx.assertCurrent();
        const latestConfiguration = await modelRuntime.getPublicConfiguration();
        if (latestConfiguration.revision !== applyRevision) fail('model_configuration_revision_conflict');
        if (row.account || row.native) {
          if (!provider.selectConfiguredModel || !provider.verifyConfiguredModel) fail('account_key_configuration_failed');
          await provider.selectConfiguredModel(request, { purpose: row.purpose, modelId: row.modelId, expectedSettings: nativeState?.settings, expectedNativeSelections: nativeState?.nativeSelections });
          await provider.verifyConfiguredModel(request, { purpose: row.purpose, modelId: row.modelId });
        } else {
          const latestLegacy = latestConfiguration.bindings.some((binding) => binding.purpose === row.purpose) ? [] : await readLegacyModels();
          ctx.assertCurrent();
          if (ctx.purposeSnapshot && !isDeepStrictEqual(ctx.purposeSnapshot[row.purpose], purposeSelection(latestConfiguration, latestLegacy, row.purpose))) {
            update(index, { applicationError: { status: 'unknown', errorCode: 'account_key_configuration_conflict' } });
            await checkpoint();
            continue;
          }
          const binding = { purpose: row.purpose, model: row.modelId, parameters: row.binding.parameters };
          const saved = await modelRuntime.saveAccountKeyConnection({ revision: applyRevision, connection: connectionFor(record), apiKey, bindings: [binding], mode: 'replace-selected', assertCurrent: ctx.assertCurrent });
          applyRevision = saved.revision;
          await modelRuntime.verifyAccountKeyBindings({ connection: connectionFor(record), apiKey, bindings: [binding], assertCurrent: ctx.assertCurrent });
        }
        ctx.assertCurrent();
        update(index, { applied: true });
        await checkpoint();
      } catch (error) {
        const failed = outcome(error);
        update(index, { applicationError: failed });
        if (['account_key_session_changed', 'enterprise_mode', 'account_key_configuration_changed', 'account_key_configuration_conflict', ...runtimeErrorCodes].includes(failed.errorCode)) stopped = failed.errorCode;
        await checkpoint();
      }
    }
    const measured = current.tests;

    const status = !measured.length || measured.some((row) => row.status === 'unknown' || row.applicationError?.status === 'unknown') ? 'unknown' : measured.some((row) => row.status === 'failed' || row.status === 'skipped' || !row.applied) ? 'failed' : 'verified';
    const code = stopped ?? (status === 'verified' ? null : status === 'unknown' ? 'account_key_test_unknown' : 'account_key_test_failed');
    current = { ...current, status: status === 'verified' && !stopped ? 'ready' : status === 'failed' ? 'failed' : 'unknown', errorCode: code, test: { status: stopped ? 'unknown' : status, testedAt: timestamp(), errorCode: code } };
    try { current = await persist(ctx, current); unsavedTests.delete(ctx.receiptId); }
    catch {
      current = { ...current, status: 'unknown', errorCode: 'account_key_test_state_failed', test: { status: 'unknown', testedAt: null, errorCode: 'account_key_test_state_failed' } };
      unsavedTests.set(ctx.receiptId, current);
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
    await requireCredits(ctx);
    if (active.has(ctx.activeId)) fail('account_key_busy', 409);
    active.add(ctx.activeId);
    let result;
    try {
      result = await journal.withLock(ctx.lockId, async () => {
        let record = await observe(ctx, unsavedTests.get(ctx.receiptId) ?? await journal.read(ctx.storageId));
        assertOwner(ctx, record);
        ctx.assertCurrent();
        if (!record) {
          if (action !== 'activate') fail('account_key_activation_missing', 404);
          record = await issue(ctx);
          if (record.stage === 'issue') return record;
        } else {
          if (record.stage === 'issue') return { ...record, status: 'unknown', errorCode: 'account_key_issue_unknown' };
          if (record.stage === 'test' && action !== 'retest') return record;
          if (record.stage === 'configure' && !['resume', 'retest'].includes(action)) return record;
        }
        let apiKey;
        try {
          record = await refreshSelection(ctx, record, action === 'activate' ? ctx.selectionSnapshot : undefined);
          if (record.stage === 'configure') record = await persist(ctx, { ...record, status: 'configuring', errorCode: null });
          // Retest also validates both saved credentials before any paid call.
          apiKey = await configure(ctx, record);
          if (record.previousChatModels) {
            const { previousChatModels, ...configured } = record;
            record = await persist(ctx, configured);
          }
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
          catch { unsavedTests.set(ctx.receiptId, interrupted); return interrupted; }
        }
      });
    } finally { active.delete(ctx.activeId); }
    // Preserve the old owner's confirmed receipt even when the browser changed
    // identity while an operation was pending; never return it to that caller.
    ctx.assertCurrent();
    rememberConsumerOwner(ctx, result);
    return project(ctx, result);
  };
  // Server-only quick setup entry. Discovery stays read-only; an explicit
  // apply/issue action can prepare the same durable Key without paid probes.
  const prepareCredential = async (input) => {
    let ctx = context(input);
    ctx.assertCurrent();
    if (!provider) fail('model_configuration_bootstrap_unsupported', 501);
    await platformAccount.refreshSession(input.identity);
    ctx.assertCurrent();
    ctx = context(input);
    await requireCredits(ctx);
    if (active.has(ctx.activeId)) fail('account_key_busy', 409);
    active.add(ctx.activeId);
    try {
      return await journal.withLock(ctx.lockId, async () => {
        let record = await journal.read(ctx.storageId);
        assertOwner(ctx, record);
        ctx.assertCurrent();
        if (!record) record = await issue(ctx);
        if (!record.key || record.stage === 'issue') fail('account_key_issue_unknown');
        record = await upgradeScope(ctx, record);
        const { catalog } = await discover(ctx, record);
        const key = await store.getSecret(record.secretRef);
        if (!key || store.fingerprint(key) !== record.keyFingerprint) fail('account_key_configuration_conflict');
        ctx.assertCurrent();
        rememberConsumerOwner(ctx, record);
        return { key, funding_mode: record.fundingMode ?? 'prepaid_cash', pricing_source: record.pricingSource, origin_product_id: 'superwagie', account_id: record.accountId, instance_id: record.instanceId, expires_at: record.key.expiresAt, data: catalog.models };
      });
    } finally { active.delete(ctx.activeId); }
  };
  const captureConsumerOwner = async (binding) => {
    if (!binding?.apiKey || binding.providerId !== 'llmrouter' || binding.protocol !== 'openai-compatible') fail('account_key_consumer_owner_unavailable');
    const ctx = consumerOwners.get(binding.connectionId) ?? credentialOwners.get(store.fingerprint(binding.apiKey));
    if (!ctx) fail('account_key_consumer_owner_unavailable');
    ctx.assertCurrent();
    const original = await journal.read(ctx.storageId);
    assertOwner(ctx, original);
    if (!original?.key) fail('account_key_consumer_owner_unavailable');
    const assertCurrent = async () => {
      ctx.assertCurrent();
      const record = await journal.read(ctx.storageId);
      assertOwner(ctx, record);
      if (!record?.key || record.key.id !== original.key.id || record.connectionId !== original.connectionId
        || record.secretRef !== original.secretRef || record.keyFingerprint !== original.keyFingerprint || record.credentialVersion !== original.credentialVersion) fail('account_key_configuration_conflict');
      const apiKey = await store.getSecret(record.secretRef);
      if (!apiKey || store.fingerprint(apiKey) !== record.keyFingerprint || apiKey !== binding.apiKey || record.baseUrl !== binding.baseUrl) fail('account_key_configuration_conflict');
      if (binding.connectionId === record.connectionId) {
        await modelRuntime.verifyAccountKeyConnection({ connection: connectionFor(record), apiKey, assertCurrent: ctx.assertCurrent });
      } else {
        // Quick setup can retain a separate connection record for the same Key.
        // Its current binding must still resolve to this owned credential.
        const current = await modelRuntime.resolveBinding(binding.purpose, { supportedProtocols: ['openai-compatible'] });
        if (!current || current.connectionId !== binding.connectionId || current.model !== binding.model || current.providerId !== binding.providerId
          || current.protocol !== binding.protocol || current.baseUrl !== binding.baseUrl || current.apiKey !== apiKey) fail('account_key_configuration_conflict');
      }
      ctx.assertCurrent();
    };
    await assertCurrent();
    return { id: ctx.consumerId, assertCurrent };
  };
  return { read, activate, prepareCredential, captureConsumerOwner };
};
