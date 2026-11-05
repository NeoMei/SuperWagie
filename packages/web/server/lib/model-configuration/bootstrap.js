import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

import { MODEL_PRESETS, MODEL_PURPOSES, PURPOSE_IDS } from './catalog.js';
import { ModelConfigurationError } from './runtime.js';
import { createModelBootstrapStore } from './bootstrap-store.js';
import { llmRouterInferenceApiUrl } from './bootstrap-endpoints.js';

const fail = (code, status = 400) => { throw new ModelConfigurationError(code, status); };
const parse = (schema, value) => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) return fail('model_configuration_invalid_input', 400);
  return parsed.data;
};
const sourceSchema = z.enum(['session', 'imported-key']);
const modeSchema = z.enum(['fill-missing', 'replace-managed']);
const purposesSchema = z.array(z.enum(PURPOSE_IDS)).max(PURPOSE_IDS.length).default(PURPOSE_IDS);
const purposeOperation = (operation) => {
  const value = String(operation ?? '').toLowerCase();
  if (['chat', 'completion', 'text', 'generate', 'tool'].includes(value)) return 'chat';
  if (value.includes('embed')) return 'embedding';
  if (value.includes('rerank')) return 'rerank';
  if (value.includes('vision') || value.includes('image-input')) return 'vision';
  if (value.includes('ocr')) return 'ocr';
  if (value.includes('speech-to-text') || value.includes('stt') || value.includes('transcri')) return 'stt';
  if (value.includes('text-to-speech') || value.includes('tts') || value.includes('speech')) return 'tts';
  if (value.includes('video')) return 'video';
  if (value.includes('image')) return 'image';
  return value;
};
const supports = (model, purpose) => {
  const operations = Array.isArray(model.operations) ? model.operations.map(purposeOperation) : [];
  if (purpose === 'agent' || purpose === 'auxiliary') return operations.includes('chat') || operations.length === 0 && model.input_modalities?.includes?.('text');
  if (purpose === 'vision') return operations.includes('vision') || model.input_modalities?.some?.((item) => ['image', 'vision'].includes(String(item).toLowerCase()));
  if (purpose === 'embedding' || purpose === 'multimodal-embedding') return operations.includes('embedding');
  if (purpose === 'rerank') return operations.includes('rerank');
  if (purpose.startsWith('stt')) return operations.includes('stt');
  if (purpose === 'tts') return operations.includes('tts');
  if (purpose === 'ocr') return operations.includes('ocr');
  if (purpose === 'image-generation' || purpose === 'image-editing') return operations.includes('image');
  if (purpose === 'video-generation') return operations.includes('video');
  return false;
};
const normalizeModel = (value) => ({
  id: String(value.id ?? value.model ?? '').trim(),
  name: String(value.name ?? value.display_name ?? value.id ?? value.model ?? '').trim(),
  operations: Array.isArray(value.operations) ? value.operations.map(String) : [],
  inputModalities: value.input_modalities ?? value.inputModalities ?? [],
  outputModalities: value.output_modalities ?? value.outputModalities ?? [],
  context: value.context ?? value.context_window ?? null,
  maxOutput: value.max_output ?? value.maxOutput ?? null,
  dimensions: value.dimensions ?? value.parameters?.dimensions ?? null,
  probe: Boolean(value.probe),
  rateId: value.rate_id ?? value.rateId ?? null,
  recommendation: Number.isFinite(value.recommendation) ? value.recommendation : 0,
  cost: value.cost ?? value.price ?? null,
});
const normalizedCatalog = (payload) => {
  const models = payload?.data ?? payload?.models ?? payload?.catalog ?? [];
  return Array.isArray(models) ? models.map(normalizeModel).filter((model) => model.id) : [];
};
const ownerFingerprint = (owner) => owner?.token ? createHash('sha256').update(JSON.stringify([owner.type ?? '', owner.token])).digest('hex') : null;
const publicDiscovery = (record) => ({
  discoveryId: record.id,
  source: record.source,
  accountId: record.accountId ?? null,
  instanceId: record.instanceId ?? null,
  originProductId: record.originProductId,
  expiresAt: record.expiresAt ?? null,
  keyFingerprint: record.keyFingerprint ?? null,
  keyLast4: record.keyLast4 ?? null,
  catalog: record.catalog,
  models: record.catalog,
});
const isManagedConnection = (connection) => connection?.providerId === 'unihub' || connection?.protocol === 'managed-media';

const callClient = async (client, methodNames, input) => {
  for (const name of methodNames) if (client?.[name] instanceof Function) return client[name](input);
  return null;
};
const withDeadline = async (promise, timeoutMs) => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('deadline'), { code: 'model_configuration_test_timeout' })), timeoutMs); })]);
  } finally { clearTimeout(timer); }
};

export const createModelBootstrapRuntime = (dependencies = {}) => {
  const { dataDir, modelRuntime, platformAccount, uniHubClient, fetchImpl = fetch, secretStore, env = process.env } = dependencies;
  if (!dataDir || !modelRuntime) throw new Error('Model bootstrap needs dataDir and modelRuntime');
  const store = dependencies.store ?? createModelBootstrapStore({ dataDir, secretStore });
  const accountValue = (name, identity) => {
    if (identity && platformAccount?.actor instanceof Function) {
      const actor = platformAccount.actor(identity);
      if (name === 'accountId') return actor.billingAccountId;
      if (name === 'userId') return actor.actingUserId;
    }
    return platformAccount?.[name] instanceof Function ? platformAccount[name]() : platformAccount?.[name];
  };
  const assertScope = (payload, identity) => {
    const originProductId = payload?.origin_product_id ?? payload?.originProductId ?? payload?.metadata?.origin_product_id;
    const instanceId = payload?.instance_id ?? payload?.instanceId ?? payload?.metadata?.instance_id;
    const accountId = payload?.account_id ?? payload?.accountId ?? payload?.metadata?.account_id;
    if (originProductId !== 'superwagie') return fail('model_configuration_bootstrap_product_mismatch', 403);
    if (!instanceId || !accountId) return fail('model_configuration_bootstrap_scope_missing', 502);
    const expectedInstance = accountValue('instanceId', identity);
    if (expectedInstance && instanceId && expectedInstance !== instanceId) return fail('model_configuration_bootstrap_instance_mismatch', 403);
    const expectedAccount = accountValue('accountId', identity);
    if (expectedAccount && accountId && expectedAccount !== accountId) return fail('model_configuration_bootstrap_account_mismatch', 403);
    if (!normalizedCatalog(payload).length) return fail('model_configuration_bootstrap_empty_catalog', 404);
    return { originProductId, instanceId: instanceId ?? expectedInstance ?? null, accountId: accountId ?? expectedAccount ?? null };
  };
  const discover = async ({ source, key, identity, owner } = {}) => {
    parse(sourceSchema, source);
    if (source === 'imported-key' && (!key || key.length > 8192)) return fail('model_configuration_invalid_input');
    const baseUrl = source === 'imported-key' ? llmRouterInferenceApiUrl(env) : null;
    const payload = await callClient(uniHubClient, ['discover', 'discoverModels', 'modelDiscovery'], { source, key, identity, accountId: accountValue('accountId', identity), instanceId: accountValue('instanceId', identity), originProductId: 'superwagie', fetchImpl });
    if (!payload) return fail('model_configuration_bootstrap_unavailable', 501);
    const scope = assertScope(payload, identity);
    const secret = source === 'imported-key' ? await store.putSecret(key) : payload.secret ? await store.putSecret(payload.secret) : null;
    const actor = identity && platformAccount?.actor instanceof Function ? platformAccount.actor(identity) : null;
    const record = await store.create({ source, ...scope, baseUrl, ownerUserId: actor?.actingUserId ?? null, ownerAuthSession: actor?.authSession ?? null, ownerRuntimeFingerprint: ownerFingerprint(owner), expiresAt: payload.expires_at ?? payload.expiresAt ?? null, catalog: normalizedCatalog(payload), keyFingerprint: secret?.fingerprint ?? payload.key_fingerprint ?? payload.keyFingerprint ?? null, keyLast4: secret?.last4 ?? null, secretRef: secret?.ref ?? null, status: 'discovered' });
    return publicDiscovery(record);
  };
  const issueKey = async (input = {}) => {
    const baseUrl = llmRouterInferenceApiUrl(env);
    const payload = await callClient(uniHubClient, ['issueKey', 'createKey', 'generateKey'], { ...input, identity: input.identity, originProductId: 'superwagie', accountId: accountValue('accountId', input.identity), instanceId: accountValue('instanceId', input.identity) });
    if (!payload?.key) return fail('model_configuration_bootstrap_key_unavailable', 502);
    let discovery;
    if (normalizedCatalog(payload).length) {
      const scope = assertScope(payload, input.identity);
      const secret = await store.putSecret(payload.key);
      const actor = input.identity && platformAccount?.actor instanceof Function ? platformAccount.actor(input.identity) : null;
      const record = await store.create({ source: 'imported-key', ...scope, baseUrl, ownerUserId: actor?.actingUserId ?? null, ownerAuthSession: actor?.authSession ?? null, ownerRuntimeFingerprint: ownerFingerprint(input.owner), expiresAt: payload.expires_at ?? payload.expiresAt ?? null, catalog: normalizedCatalog(payload), keyFingerprint: secret.fingerprint, keyLast4: secret.last4, secretRef: secret.ref, status: 'discovered' });
      discovery = publicDiscovery(record);
    } else {
      discovery = await discover({ source: 'imported-key', key: payload.key, identity: input.identity, owner: input.owner });
    }
    return { ...discovery, keyFingerprint: discovery.keyFingerprint, keyLast4: discovery.keyLast4 };
  };
  const readDiscovery = async (id, identity, owner) => {
    const record = await store.read(id);
    if (!record || record.status === 'revoked') return fail('model_configuration_bootstrap_discovery_missing', 404);
    if (record.ownerRuntimeFingerprint && ownerFingerprint(owner) !== record.ownerRuntimeFingerprint) return fail('model_configuration_bootstrap_owner_changed', 409);
    if (record.ownerAuthSession) {
      if (!identity || !(platformAccount?.actor instanceof Function)) return fail('platform_account_required', 409);
      const actor = platformAccount.actor(identity);
      if (actor.actingUserId !== record.ownerUserId || actor.authSession !== record.ownerAuthSession || actor.billingAccountId !== record.accountId) return fail('platform_session_changed', 409);
    }
    return record;
  };
  const mappingPlan = async (record, revision, mode, purposes, selections = {}) => {
    const configuration = await modelRuntime.getPublicConfiguration();
    if (configuration.revision !== revision) return fail('model_configuration_revision_conflict', 409);
    const wanted = purposes.filter((purpose) => MODEL_PURPOSES.find((entry) => entry.id === purpose)?.status === 'available');
    const add = [], replace = [], preserve = [], unavailable = [];
    for (const purpose of wanted) {
      const current = configuration.bindings.find((binding) => binding.purpose === purpose);
      // Bootstrap creates OpenAI-compatible or managed-media connections; routing requires Jev.
      if (purpose === 'routing') {
        if (current) preserve.push({ purpose, currentModel: current.model, connectionId: current.connectionId });
        else unavailable.push({ purpose, reason: 'no_supported_model' });
        continue;
      }
      const selected = selections[purpose];
      const candidates = record.catalog.filter((model) => supports(model, purpose));
      if (selected && !candidates.some((entry) => entry.id === selected)) return fail('model_configuration_bootstrap_model_unavailable', 409);
      const model = candidates.find((entry) => entry.id === selected) ?? [...candidates].sort((a, b) => b.recommendation - a.recommendation || a.id.localeCompare(b.id))[0];
      if (!model) { unavailable.push({ purpose, reason: 'no_supported_model' }); continue; }
      const preset = MODEL_PRESETS.find((entry) => entry.model === model.id && entry.purposes.includes(purpose));
      const parameters = { ...(preset?.parameters ?? {}) };
      if (model.dimensions && parameters.dimensions === undefined) parameters.dimensions = model.dimensions;
      const plan = { purpose, model: model.id, modelName: model.name, capabilities: model.operations, candidates: candidates.map((entry) => ({ id: entry.id, name: entry.name })), parameters, cost: model.cost ?? null };
      if (!current) add.push(plan);
      else if (mode === 'replace-managed' && isManagedConnection(configuration.connections.find((entry) => entry.id === current.connectionId))) replace.push({ ...plan, currentModel: current.model, connectionId: current.connectionId });
      else preserve.push({ ...plan, currentModel: current.model, connectionId: current.connectionId });
    }
    return { revision, mode, add, replace, preserve, unavailable, costs: { estimated: [...add, ...replace].reduce((sum, item) => sum + (Number(item.cost) || 0), 0), expensivePurposes: [...add, ...replace].filter((item) => ['image-generation', 'image-editing', 'video-generation'].includes(item.purpose)).map((item) => item.purpose) } };
  };
  const preview = async ({ discoveryId, revision, mode = 'fill-missing', purposes = PURPOSE_IDS, selections = {}, identity, owner } = {}) => {
    parse(modeSchema, mode); parse(purposesSchema, purposes);
    const record = await readDiscovery(discoveryId, identity, owner);
    const plan = await mappingPlan(record, revision, mode, purposes, selections);
    const operation = await store.create({ kind: 'apply', discoveryId, revision, mode, purposes, selections, plan, status: 'previewed' });
    const items = [
      ...plan.add.map((item) => ({ purpose: item.purpose, action: 'add', modelId: item.model, recommendedModel: item.model, candidates: item.candidates, estimatedCost: Number(item.cost) || 0 })),
      ...plan.replace.map((item) => ({ purpose: item.purpose, action: 'replace', modelId: item.model, recommendedModel: item.model, currentModel: item.currentModel, candidates: item.candidates, estimatedCost: Number(item.cost) || 0, requiresConfirmation: true })),
      ...plan.preserve.map((item) => ({ purpose: item.purpose, action: 'preserve', modelId: item.currentModel, currentModel: item.currentModel, candidates: item.candidates })),
      ...plan.unavailable.map((item) => ({ purpose: item.purpose, action: 'unavailable', modelId: null, reason: item.reason })),
    ];
    return { operationId: operation.id, discoveryId, items, ...plan };
  };
  const currentSecret = async (record, identity) => {
    let key = await store.getSecret(record.secretRef);
    if (!key && record.source === 'session') {
      const session = await callClient(uniHubClient, ['getSessionKey', 'sessionKey', 'resolveSessionCredential'], { identity, accountId: record.accountId, instanceId: record.instanceId });
      if (session?.key) key = session.key;
    }
    if (!key && record.source === 'imported-key') return fail('model_configuration_bootstrap_secret_missing', 409);
    return key;
  };
  const applyOperation = async ({ operationId, discoveryId, revision, mode = 'fill-missing', selections = {}, identity, owner } = {}) => {
    const operation = await store.read(operationId);
    if (!operation || operation.discoveryId !== discoveryId) return fail('model_configuration_bootstrap_operation_missing', 404);
    if (operation.status === 'applied') return operation.result;
    if (operation.revision !== revision || operation.mode !== mode) return fail('model_configuration_revision_conflict', 409);
    const discovery = await readDiscovery(discoveryId, identity, owner);
    const plan = await mappingPlan(discovery, revision, mode, operation.purposes, operation.selections ?? selections);
    const before = await modelRuntime.getPublicConfiguration();
    if (before.revision !== revision) return fail('model_configuration_revision_conflict', 409);
    const result = { operationId, discoveryId, applied: [], revision, rollbackAvailable: true };
    if (!plan.add.length && !plan.replace.length) {
      result.configuration = before;
      const updated = await store.update(operationId, { status: 'applied', result, before, plan, addedConnectionId: null, originalBindings: {} });
      return updated.result;
    }
    const key = await currentSecret(discovery, identity);
    const imported = discovery.source === 'imported-key';
    if (imported && discovery.baseUrl !== llmRouterInferenceApiUrl(env)) return fail('model_configuration_credential_destination_denied', 403);
    const connection = imported
      ? before.connections.find((entry) => entry.providerId === 'llmrouter' && entry.protocol === 'openai-compatible' && entry.baseUrl === discovery.baseUrl)
      : before.connections.find((entry) => entry.providerId === 'unihub' && entry.protocol === 'managed-media');
    const durableSecret = imported && !connection ? await store.putSecret(key) : null;
    const originalBindings = Object.fromEntries(before.bindings.filter((binding) => plan.replace.some((entry) => entry.purpose === binding.purpose)).map((binding) => [binding.purpose, binding]));
    let state = before;
    try {
      if (modelRuntime.applyBootstrap) {
        const connectionInput = connection ? null : imported
          ? { name: 'LLMRouter API Key', providerId: 'llmrouter', protocol: 'openai-compatible', baseUrl: discovery.baseUrl, credentialSource: { type: 'model-bootstrap', providerId: 'llmrouter', ref: durableSecret?.ref ?? discovery.secretRef } }
          : { name: 'UniHub managed session', providerId: 'unihub', protocol: 'managed-media', baseUrl: 'https://llmrouter.quukk.com/platform/v1' };
        state = await modelRuntime.applyBootstrap({ revision, mode, connection, connectionInput, bindings: [...plan.add, ...plan.replace].map((item) => ({ purpose: item.purpose, model: item.model, parameters: item.parameters })) });
        result.applied.push(...[...plan.add, ...plan.replace].map((item) => item.purpose));
      } else {
        let connectionId = connection?.id;
        if (!connectionId) {
          const input = imported
            ? { name: 'LLMRouter API Key', providerId: 'llmrouter', protocol: 'openai-compatible', baseUrl: discovery.baseUrl, credentialSource: { type: 'model-bootstrap', providerId: 'llmrouter', ref: durableSecret?.ref ?? discovery.secretRef } }
            : { name: 'UniHub managed session', providerId: 'unihub', protocol: 'managed-media', baseUrl: 'https://llmrouter.quukk.com/platform/v1' };
          state = await modelRuntime.saveConnection({ revision: state.revision, connection: input });
          connectionId = state.connections.find((entry) => entry.id === state.connections.at(-1)?.id)?.id;
        }
        for (const item of [...plan.add, ...plan.replace]) {
          state = await modelRuntime.saveBinding(item.purpose, { revision: state.revision, binding: { connectionId, model: item.model, parameters: item.parameters ?? {} } });
          result.applied.push(item.purpose);
        }
      }
    } catch (error) {
      try { await rollbackInternal({ before, state, plan, addedConnectionId: connection ? null : state.connections.at(-1)?.id }); } catch { /* Preserve original failure. */ }
      if (durableSecret && modelRuntime.applyBootstrap) await store.deleteSecret(durableSecret.ref);
      throw error;
    }
    result.revision = state.revision;
    result.configuration = await modelRuntime.getPublicConfiguration();
    const addedConnection = connection ? null : state.connections.at(-1);
    const updated = await store.update(operationId, { status: 'applied', result, before, plan, addedConnectionId: addedConnection?.id ?? null, durableSecretRef: durableSecret?.ref ?? null, originalBindings });
    return updated.result;
  };
  const applying = new Map();
  const apply = (input = {}) => {
    const existing = applying.get(input.operationId);
    if (existing) return existing;
    const pending = applyOperation(input).finally(() => {
      if (applying.get(input.operationId) === pending) applying.delete(input.operationId);
    });
    applying.set(input.operationId, pending);
    return pending;
  };
  const rollbackInternal = async ({ before, state, plan, addedConnectionId }) => {
    let current = await modelRuntime.getPublicConfiguration();
    for (const item of [...plan.add, ...plan.replace]) {
      const old = before.bindings.find((binding) => binding.purpose === item.purpose);
      const binding = old ? { connectionId: old.connectionId, presetId: old.presetId, model: old.model, parameters: old.parameters } : null;
      current = await modelRuntime.saveBinding(item.purpose, { revision: current.revision, binding });
    }
    const added = addedConnectionId ? state.connections.find((entry) => entry.id === addedConnectionId) : null;
    if (added) current = await modelRuntime.removeConnection(added.id, { revision: current.revision });
    return current;
  };
  const startTests = async ({ revision, purposes = PURPOSE_IDS, expensive = false } = {}) => {
    parse(purposesSchema, purposes);
    const current = await modelRuntime.getPublicConfiguration();
    if (current.revision !== revision) return fail('model_configuration_revision_conflict', 409);
    const run = await store.create({ kind: 'test', revision, purposes, statuses: Object.fromEntries(purposes.map((purpose) => [purpose, { status: !expensive && ['image-generation', 'image-editing', 'video-generation', 'ocr'].includes(purpose) ? 'skipped' : 'pending' }])), status: 'running' });
    const bindings = Object.fromEntries(current.bindings.map((binding) => [binding.purpose, binding]));
    const connections = Object.fromEntries(current.connections.map((connection) => [connection.id, connection]));
    for (const purpose of purposes) {
      const binding = bindings[purpose];
      if (binding && connections[binding.connectionId]?.protocol === 'managed-media') run.statuses[purpose] = { status: 'unavailable', errorCode: 'model_configuration_managed_probe_unavailable' };
    }
    await store.update(run.id, { statuses: run.statuses });
    const queue = purposes.filter((purpose) => run.statuses[purpose].status === 'pending');
    const worker = async () => {
      while (queue.length) {
        const purpose = queue.shift();
        if (!purpose) return;
        const key = `${run.id}:${purpose}:${randomUUID()}`;
        try {
          if (!(modelRuntime.testBinding instanceof Function)) throw Object.assign(new Error('probe unavailable'), { code: 'model_configuration_probe_unavailable' });
          await withDeadline(modelRuntime.testBinding(purpose, { revision, idempotencyKey: key }), 30_000);
          await store.update(run.id, (state) => ({ ...state, statuses: { ...state.statuses, [purpose]: { status: 'verified' } } }));
        } catch (error) {
          await store.update(run.id, (state) => ({ ...state, statuses: { ...state.statuses, [purpose]: { status: 'failed', errorCode: error.code?.startsWith('model_configuration_') ? error.code : 'model_configuration_test_failed' } } }));
        }
      }
    };
    void Promise.all([worker(), worker()]).then(() => store.update(run.id, { status: 'complete' })).catch(() => {});
    return { testRunId: run.id, status: run.status, results: Object.entries(run.statuses).map(([purpose, value]) => ({ purpose, ...value })) };
  };
  const readTestRun = async (testRunId) => {
    const run = await store.read(testRunId);
    if (!run || run.kind !== 'test') return fail('model_configuration_bootstrap_test_missing', 404);
    return {
      testRunId: run.id,
      revision: run.revision,
      status: run.status,
      purposes: run.statuses,
      results: Object.entries(run.statuses).map(([purpose, value]) => ({ purpose, ...value })),
    };
  };
  const rollback = async ({ operationId, revision, identity, owner } = {}) => {
    const operation = await store.read(operationId);
    if (!operation?.before) return fail('model_configuration_bootstrap_rollback_missing', 404);
    await readDiscovery(operation.discoveryId, identity, owner);
    const current = await modelRuntime.getPublicConfiguration();
    if (current.revision !== revision) return fail('model_configuration_revision_conflict', 409);
    const restored = await rollbackInternal({ before: operation.before, state: current, plan: operation.plan, addedConnectionId: operation.addedConnectionId });
    if (operation.durableSecretRef) await store.deleteSecret(operation.durableSecretRef);
    const result = { operationId, rolledBack: true, revision: restored.revision, configuration: await modelRuntime.getPublicConfiguration() };
    await store.update(operationId, { status: 'rolled-back', result });
    return result;
  };
  return { discover, issueKey, preview, apply, startTests, readTestRun, rollback, store };
};
