import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { createModelBootstrapRuntime } from './bootstrap.js';
import { createModelBootstrapStore } from './bootstrap-store.js';
import { createModelConfigurationRuntime, ModelConfigurationError } from './runtime.js';
import { registerModelBootstrapRoutes } from './bootstrap-routes.js';
import { createAccountKeyStore } from './account-key-store.js';
import { createAccountKeyActivation } from './account-key-activation.js';

const directories = [];
const issuedKey = 'fixture-account-key-7890';
const owner = { type: 'ui-session', token: 'fixture-runtime-owner' };
const input = { accountId: 'account-1', identity: owner, owner };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const fixture = async ({ secretStore, catalog, legacyModels = [], prepareBindingChange } = {}) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'account-key-activation-'));
  directories.push(dataDir);
  const env = {};
  const enterpriseOptions = { env, policyFilePaths: [] };
  const store = createModelBootstrapStore({ dataDir, secretStore });
  const probeCalls = [];
  const modelRuntime = createModelConfigurationRuntime({ dataDir, env, enterpriseOptions, readModelBootstrapCredential: store.getSecret, prepareBindingChange,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body); probeCalls.push({ url, body });
      controls.modelProbeStarted?.resolve();
      if (controls.modelProbeWait) await controls.modelProbeWait.promise;
      if (controls.modelProbeError) throw controls.modelProbeError;
      if (controls.modelProbeStatus) return Response.json({}, { status: controls.modelProbeStatus });
      if (url.endsWith('/embeddings')) return Response.json({ data: [{ embedding: [1, 2] }] });
      if (url.endsWith('/rerank')) return Response.json({ results: [{ index: 0, relevance_score: 1 }] });
      if (url.endsWith('/images/generations')) return Response.json({ data: [{ url: 'https://image.example/fixture.png' }] });
      if (url.endsWith('/chat/completions')) return Response.json({ choices: [{ message: { content: 'A blue circle.' } }] });
      throw new Error('Unexpected model probe');
    },
  });
  let actor = { actingUserId: 'user-1', billingAccountId: 'account-1', authSession: 'session-1' };
  const counts = { issue: 0, configure: 0, probe: 0, discover: 0 };
  const readKeyCatalog = async ({ apiKey }) => {
    expect(apiKey).toBe(issuedKey);
    return controls.keyCatalog ?? (catalog ?? [{ id: 'chat-pro', name: 'Chat Pro', operations: ['chat'] }]);
  };
  const controls = {};
  const platformAccount = {
    actor: () => ({ ...actor }),
    refreshSession: async () => {
      controls.refreshStarted?.resolve();
      if (controls.refreshWait) await controls.refreshWait.promise;
      if (controls.refreshError) throw controls.refreshError;
      controls.refreshed = true;
      return { ...actor };
    },
    instancePrincipal: () => ({ issuer: 'https://identity.example.test', userId: actor.actingUserId }),
    captureCommerceSession: () => {
      const captured = { ...actor };
      const expired = controls.accessExpired && !controls.refreshed;
      return { ...captured, serviceId: 'fixture-service', request: async (route, init) => {
        if (captured.authSession !== actor.authSession) throw Object.assign(new Error('changed'), { code: 'platform_session_changed', status: 409 });
        if (expired) throw Object.assign(new Error('expired'), { code: 'platform_session_expired', status: 401 });
        if (route.endsWith('/model-discovery')) {
          counts.discover++;
          if (controls.discoveryError) throw controls.discoveryError;
          return { account_id: 'account-1', origin_product_id: 'superwagie', instance_id: 'fixture-instance', models: controls.catalog ?? catalog ?? [{ id: 'chat-pro', name: 'Chat Pro', operations: ['chat'] }] };
        }
        if (route.endsWith('/api-keys/key-1/models')) {
          controls.scopeRequests = [...(controls.scopeRequests ?? []), JSON.parse(init.body).models];
          controls.issuedModels = [...new Set([...controls.issuedModels, ...JSON.parse(init.body).models])];
          controls.scopeStarted?.resolve();
          if (controls.scopeWait) await controls.scopeWait.promise;
          return { id: 'key-1', credential_kind: 'api_key', actor_id: 'user-1', account_id: 'account-1', origin_product_id: 'superwagie', instance_id: 'fixture-instance', models: controls.issuedModels, created_at: '2026-11-06T00:00:00Z', expires_at: null, revoked_at: null };
        }
        if (route.endsWith('/api-keys')) {
          counts.issue++;
          controls.issueStarted?.resolve();
          const issuedModels = JSON.parse(init.body).models;
          controls.issuedModels = issuedModels;
          expect(JSON.parse(init.body)).toMatchObject({ instance_id: 'fixture-instance', origin_product_id: 'superwagie' });
          if (controls.issueWait) await controls.issueWait.promise;
          if (controls.issueError) throw controls.issueError;
          if (captured.authSession !== actor.authSession) throw Object.assign(new Error('changed after response'), { code: 'platform_session_changed', status: 409 });
          return { id: 'key-1', credential_kind: 'api_key', name: 'SuperWagie', actor_id: 'user-1', account_id: 'account-1', origin_product_id: 'superwagie', instance_id: 'fixture-instance', models: issuedModels, created_at: '2026-11-06T00:00:00Z', expires_at: null, revoked_at: null, token: issuedKey, ...controls.issueOverrides };
        }
        throw new Error('Unexpected upstream route');
      } };
    },
  };
  const provider = {
    selectConfiguredModel: async ({ assertCurrent }, { purpose, modelId }) => {
      assertCurrent();
      if (controls.selectError) throw controls.selectError;
      controls.selected = { ...controls.selected, [purpose]: modelId };
    },
    verifyConfiguredModel: async ({ assertCurrent }, { purpose, modelId }) => {
      assertCurrent();
      if (controls.selected?.[purpose] !== modelId) throw Object.assign(new Error('changed selection'), { code: 'model_configuration_account_provider_conflict' });
    },
    verify: async ({ apiKey, assertCurrent }) => {
      assertCurrent();
      expect(apiKey).toBe(issuedKey);
      if (controls.verifyError) throw controls.verifyError;
    },
    configure: async ({ apiKey, assertCurrent }) => {
      counts.configure++;
      controls.configureStarted?.resolve();
      expect(apiKey).toBe(issuedKey);
      assertCurrent();
      if (controls.configureWait) await controls.configureWait.promise;
      if (controls.configureError) throw controls.configureError;
      assertCurrent();
    },
    probe: async ({ assertCurrent }) => {
      counts.probe++;
      controls.probeStarted?.resolve();
      assertCurrent();
      if (controls.probeWait) await controls.probeWait.promise;
      if (controls.probeError) throw controls.probeError;
      assertCurrent();
      return { status: 'verified', testedAt: '2026-11-06T00:01:00.000Z' };
    },
  };
  const create = ({ available = true, receiptStore } = {}) => receiptStore
    ? createAccountKeyActivation({ dataDir, store, modelRuntime, platformAccount, provider: available ? provider : undefined, readKeyCatalog, readLegacyModels: async () => legacyModels, receiptStore, env, enterpriseOptions })
    : createModelBootstrapRuntime({ dataDir, store, modelRuntime, platformAccount, accountKeyProvider: available ? provider : undefined, readKeyCatalog, readLegacyModels: async () => legacyModels, env, enterpriseOptions }).accountKey;
  return { dataDir, store, modelRuntime, counts, controls, env, create, provider, probeCalls, changeActor: (next) => { actor = { ...actor, ...next }; } };
};
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });

describe('persistent account key activation', () => {
  it('does not label native models applied when the native selection adapter is missing', async () => {
    const f = await fixture();
    delete f.provider.selectConfiguredModel;
    const result = (await f.create().activate({ ...input, action: 'activate' })).activation;
    expect(result.status).not.toBe('ready');
    expect(result.tests[0]).toMatchObject({ status: 'failed', applied: false });
  });

  it('applies the current native default and auxiliary models only after their actual probes', async () => {
    const catalog = ['chat-pro', 'chosen', 'small'].map((id) => ({ id, name: id, operations: ['chat'] }));
    const f = await fixture({ catalog });
    f.provider.readConfiguredModels = async () => ({ models: [{ id: 'native-agent', purpose: 'agent', providerId: 'old', modelId: 'chosen' }, { id: 'native-auxiliary', purpose: 'auxiliary', providerId: 'old', modelId: 'small' }], settings: {} });
    const result = (await f.create().activate({ ...input, action: 'activate' })).activation;
    expect(f.controls.issuedModels).toEqual(['chosen', 'small']);
    expect(f.controls.selected).toEqual({ agent: 'chosen', auxiliary: 'small' });
    expect(result.tests).toEqual(expect.arrayContaining([expect.objectContaining({ purpose: 'agent', modelId: 'chosen', applied: true }), expect.objectContaining({ purpose: 'auxiliary', modelId: 'small', applied: true })]));
  });

  it('preserves unavailable native choices instead of testing or applying the provider registration model', async () => {
    const f = await fixture();
    f.provider.readConfiguredModels = async () => ({ models: [
      { id: 'native-agent', purpose: 'agent', providerId: 'existing', modelId: 'existing-agent' },
      { id: 'native-auxiliary', purpose: 'auxiliary', providerId: 'existing', modelId: 'existing-small' },
    ], settings: { defaultModel: 'existing/existing-agent', smallModelUseDefault: false, smallModelOverride: 'existing/existing-small' } });
    const activation = f.create();
    for (const action of ['activate', 'retest']) {
      const result = (await activation.activate({ ...input, action })).activation;
      expect(result.status).toBe('failed');
      expect(result.tests).toEqual([
        expect.objectContaining({ purpose: 'agent', modelId: 'existing-agent', status: 'skipped', applied: false, errorCode: 'account_key_model_not_authorized' }),
        expect.objectContaining({ purpose: 'auxiliary', modelId: 'existing-small', status: 'skipped', applied: false, errorCode: 'account_key_model_not_authorized' }),
      ]);
      expect(f.controls.selected).toBeUndefined();
      expect(f.counts.probe).toBe(0);
    }
    expect(f.counts.issue).toBe(1);
    expect(f.controls.issuedModels).toEqual(['chat-pro']);
    expect(f.controls.scopeRequests).toBeUndefined();
  });

  it('selects a catalog chat default only when the native default is explicitly unconfigured', async () => {
    const f = await fixture();
    f.provider.readConfiguredModels = async () => ({ models: [
      { id: 'native-agent', purpose: 'agent', providerId: null, modelId: null, errorCode: 'model_configuration_account_model_unconfigured' },
    ], settings: {} });
    const result = (await f.create().activate({ ...input, action: 'activate' })).activation;
    expect(result.tests).toEqual([expect.objectContaining({ purpose: 'agent', modelId: 'chat-pro', status: 'verified', applied: true })]);
    expect(f.controls.selected).toEqual({ agent: 'chat-pro' });
    expect(f.counts.probe).toBe(1);
  });

  it('preserves a native selection changed after discovery and does not probe or apply that row', async () => {
    const f = await fixture();
    let modelId = 'old-native';
    f.provider.readConfiguredModels = async () => ({ models: [{ id: 'native-agent', purpose: 'agent', providerId: 'old', modelId }], settings: { defaultModel: `old/${modelId}` } });
    const originalConfigure = f.provider.configure;
    f.provider.configure = async (request) => { await originalConfigure(request); modelId = 'new-user-choice'; };
    const result = (await f.create().activate({ ...input, action: 'activate' })).activation;
    expect(result.tests[0]).toMatchObject({ status: 'skipped', errorCode: 'account_key_configuration_conflict', applied: false });
    expect(f.controls.selected).toBeUndefined();
    expect(f.counts.probe).toBe(0);
  });

  it('keeps a blocked embedding unapplied while applying an independent reranker after both probes pass', async () => {
    const f = await fixture({ catalog: [
      { id: 'chat-pro', name: 'Chat', operations: ['chat'] },
      { id: 'embed', name: 'Embed', operations: ['embedding'], dimensions: 2 },
      { id: 'rerank', name: 'Rerank', operations: ['rerank'] },
    ], prepareBindingChange: async (purpose) => {
      if (purpose === 'embedding') throw Object.assign(new Error('preserve index'), { code: 'model_configuration_embedding_rebuild_required' });
    } });
    const result = (await f.create().activate({ ...input, action: 'activate' })).activation;
    expect(result).toMatchObject({ status: 'failed' });
    expect(result.tests.find((row) => row.purpose === 'embedding')).toMatchObject({ status: 'failed', errorCode: 'model_configuration_embedding_rebuild_required', applied: false });
    expect(result.tests.find((row) => row.purpose === 'rerank')).toMatchObject({ status: 'verified', applied: true });
    expect(await f.modelRuntime.resolveBinding('embedding')).toBeNull();
    expect(await f.modelRuntime.resolveBinding('rerank')).toMatchObject({ apiKey: issuedKey, model: 'rerank' });
    expect(f.probeCalls).toHaveLength(2);
  });

  it('expands the same key before testing newly selected models and never issues a replacement key', async () => {
    const f = await fixture();
    await f.create().activate({ ...input, action: 'activate' });
    f.controls.catalog = [{ id: 'chat-pro', name: 'Chat Pro', operations: ['chat'] }, { id: 'embed', name: 'Embed', operations: ['embedding'], dimensions: 2 }];
    f.controls.keyCatalog = f.controls.catalog;
    const result = (await f.create().activate({ ...input, action: 'retest' })).activation;
    expect(f.controls.scopeRequests).toEqual([['embed']]);
    expect(f.counts.issue).toBe(1);
    expect(result.tests.find((row) => row.purpose === 'embedding')).toMatchObject({ status: 'verified', applied: true });
  });

  it.each(['model', 'connection', 'parameters', 'removed', 'added', 'verification'])('preserves a %s change during scope expansion without blocking an independent purpose', async (change) => {
    const f = await fixture();
    const activation = f.create();
    await activation.activate({ ...input, action: 'activate' });
    let configuration = await f.modelRuntime.getPublicConfiguration();
    configuration = await f.modelRuntime.saveConnection({ revision: configuration.revision, connection: { name: 'Existing', providerId: 'existing', protocol: 'openai-compatible', baseUrl: 'https://existing.example/v1', apiKey: 'fixture-existing-key' } });
    const existing = configuration.connections.find((connection) => connection.providerId === 'existing');
    const original = { connectionId: existing.id, model: 'rerank', parameters: {} };
    if (change !== 'added') await f.modelRuntime.saveBinding('rerank', { revision: configuration.revision, binding: original });
    f.controls.catalog = [
      { id: 'chat-pro', name: 'Chat Pro', operations: ['chat'] },
      { id: 'rerank', name: 'Rerank', operations: ['rerank'] },
      { id: 'embed', name: 'Embed', operations: ['embedding'], dimensions: 2 },
    ];
    f.controls.keyCatalog = f.controls.catalog;
    f.controls.scopeStarted = deferred(); f.controls.scopeWait = deferred();
    const pending = activation.activate({ ...input, action: 'retest' });
    await f.controls.scopeStarted.promise;
    configuration = await f.modelRuntime.getPublicConfiguration();
    let replacement = { ...original };
    if (change === 'model' || change === 'added') replacement.model = 'new-user-choice';
    if (change === 'parameters') replacement.parameters = { language: 'fr' };
    if (change === 'connection') {
      configuration = await f.modelRuntime.saveConnection({ revision: configuration.revision, connection: { name: 'Replacement', providerId: 'replacement', protocol: 'openai-compatible', baseUrl: 'https://replacement.example/v1', apiKey: 'fixture-replacement-key' } });
      replacement.connectionId = configuration.connections.find((connection) => connection.providerId === 'replacement').id;
    }
    if (change === 'removed') replacement = null;
    if (change === 'verification') {
      await f.modelRuntime.testBinding('rerank', { revision: configuration.revision });
      f.probeCalls.length = 0;
    } else {
      await f.modelRuntime.saveBinding('rerank', { revision: configuration.revision, binding: replacement });
    }
    f.controls.scopeWait.resolve();
    const result = (await pending).activation;
    const rerank = result.tests.find((row) => row.purpose === 'rerank');
    if (change === 'verification') {
      expect(rerank).toMatchObject({ status: 'verified', applied: true });
      expect(await f.modelRuntime.resolveBinding('rerank')).toMatchObject({ connectionId: result.connectionId, apiKey: issuedKey });
    } else {
      expect(rerank).toMatchObject({ status: 'skipped', errorCode: 'account_key_configuration_conflict', applied: false });
      expect(f.probeCalls.some((call) => call.url.endsWith('/rerank'))).toBe(false);
      const current = (await f.modelRuntime.getPublicConfiguration()).bindings.find((binding) => binding.purpose === 'rerank');
      if (replacement) expect(current).toMatchObject(replacement);
      else expect(current).toBeUndefined();
    }
    expect(result.tests.find((row) => row.purpose === 'embedding')).toMatchObject({ status: 'verified', applied: true });
    expect(await f.modelRuntime.resolveBinding('embedding')).toMatchObject({ connectionId: result.connectionId, apiKey: issuedKey });
    expect(f.counts.issue).toBe(1);
  });

  it('preserves legacy model edits during configuration while applying unrelated purposes', async () => {
    const legacyModels = [{ purpose: 'embedding', modelId: 'embed', parameters: { dimensions: 2 } }];
    const f = await fixture({ legacyModels, catalog: [
      { id: 'chat-pro', name: 'Chat', operations: ['chat'] },
      { id: 'embed', name: 'Embed', operations: ['embedding'], dimensions: 2 },
      { id: 'rerank', name: 'Rerank', operations: ['rerank'] },
    ] });
    f.controls.configureStarted = deferred(); f.controls.configureWait = deferred();
    const pending = f.create().activate({ ...input, action: 'activate' });
    await f.controls.configureStarted.promise;
    legacyModels[0].modelId = 'new-legacy-choice';
    f.controls.configureWait.resolve();
    const result = (await pending).activation;
    expect(result.tests.find((row) => row.purpose === 'embedding')).toMatchObject({ status: 'skipped', errorCode: 'account_key_configuration_conflict', applied: false });
    expect(await f.modelRuntime.resolveBinding('embedding')).toBeNull();
    expect(f.probeCalls.some((call) => call.url.endsWith('/embeddings'))).toBe(false);
    expect(result.tests.find((row) => row.purpose === 'rerank')).toMatchObject({ status: 'verified', applied: true });
  });

  it.each(['model', 'parameters'])('preserves legacy %s edits made during a paid probe and continues applying unrelated purposes', async (change) => {
    const legacyModels = [{ purpose: 'embedding', modelId: 'embed', parameters: { dimensions: 2 } }];
    const f = await fixture({ legacyModels, catalog: [
      { id: 'chat-pro', name: 'Chat', operations: ['chat'] },
      { id: 'embed', name: 'Embed', operations: ['embedding'], dimensions: 2 },
      { id: 'rerank', name: 'Rerank', operations: ['rerank'] },
    ] });
    f.controls.modelProbeStarted = deferred(); f.controls.modelProbeWait = deferred();
    const pending = f.create().activate({ ...input, action: 'activate' });
    await f.controls.modelProbeStarted.promise;
    if (change === 'model') legacyModels[0].modelId = 'new-legacy-choice';
    else legacyModels[0].parameters.dimensions = 4;
    f.controls.modelProbeWait.resolve();
    const result = (await pending).activation;
    expect(result.tests.find((row) => row.purpose === 'embedding')).toMatchObject({ status: 'unknown', errorCode: 'account_key_configuration_conflict', applied: false });
    expect(await f.modelRuntime.resolveBinding('embedding')).toBeNull();
    expect(f.probeCalls.filter((call) => call.url.endsWith('/embeddings'))).toHaveLength(1);
    expect(result.tests.find((row) => row.purpose === 'rerank')).toMatchObject({ status: 'verified', applied: true });
    expect(await f.modelRuntime.resolveBinding('rerank')).toMatchObject({ connectionId: result.connectionId, apiKey: issuedKey });
  });

  it('refuses a scope union above 32 before sending an expansion request', async () => {
    const f = await fixture();
    await f.create().activate({ ...input, action: 'activate' });
    const directory = path.join(f.dataDir, 'account-key-activation');
    const filename = path.join(directory, (await fs.readdir(directory)).find((name) => name.endsWith('.json')));
    const record = JSON.parse(await fs.readFile(filename, 'utf8'));
    record.models = [...record.models, ...Array.from({ length: 31 }, (_, index) => ({ id: `old-${index}`, name: `Old ${index}` }))];
    await fs.writeFile(filename, JSON.stringify(record));
    f.controls.catalog = [{ id: 'chat-pro', name: 'Chat Pro', operations: ['chat'] }, { id: 'embed', name: 'Embed', operations: ['embedding'], dimensions: 2 }];
    f.controls.keyCatalog = f.controls.catalog;
    const result = (await f.create().activate({ ...input, action: 'retest' })).activation;
    expect(result).toMatchObject({ status: 'failed', errorCode: 'account_key_scope_limit' });
    expect(f.controls.scopeRequests).toBeUndefined();
    expect(f.counts.issue).toBe(1);
    expect(f.probeCalls).toEqual([]);
  });

  it('recovers a pending native catalog expansion before adding another model on resume', async () => {
    const f = await fixture();
    let installed = ['chat-pro'];
    const originalConfigure = f.provider.configure;
    f.provider.configure = async (request) => {
      await originalConfigure(request);
      const desired = request.models.map((model) => model.id);
      if (JSON.stringify(installed) !== JSON.stringify(desired) && JSON.stringify(installed) !== JSON.stringify(request.previousModels?.map((model) => model.id))) throw Object.assign(new Error('catalog conflict'), { code: 'model_configuration_account_provider_conflict' });
      installed = desired;
    };
    await f.create().activate({ ...input, action: 'activate' });
    const directory = path.join(f.dataDir, 'account-key-activation');
    const filename = path.join(directory, (await fs.readdir(directory)).find((name) => name.endsWith('.json')));
    const record = JSON.parse(await fs.readFile(filename, 'utf8'));
    record.status = 'failed'; record.stage = 'configure';
    record.previousChatModels = record.chatModels;
    record.chatModels = [...record.chatModels, { id: 'second', name: 'second' }];
    record.models = [...record.models, { id: 'second', name: 'second' }];
    f.controls.issuedModels = record.models.map((model) => model.id);
    installed = ['chat-pro', 'second'];
    await fs.writeFile(filename, JSON.stringify(record));
    f.controls.catalog = ['chat-pro', 'second', 'third'].map((id) => ({ id, name: id === 'chat-pro' ? 'Chat Pro' : id, operations: ['chat'] }));
    f.controls.keyCatalog = f.controls.catalog;
    f.provider.readConfiguredModels = async () => ({ models: [{ id: 'native-agent', purpose: 'agent', modelId: 'third', providerId: 'old' }], settings: {} });
    const result = (await f.create().activate({ ...input, action: 'resume' })).activation;
    expect(result.status).toBe('ready');
    expect(installed).toEqual(['chat-pro', 'second', 'third']);
    expect(f.controls.scopeRequests).toEqual([['third']]);
    expect(f.counts.issue).toBe(1);
    expect(JSON.parse(await fs.readFile(filename, 'utf8')).previousChatModels).toBeUndefined();
  });

  it('captures a live consumer owner without new paid requests and rejects session changes or key rotation', async () => {
    const f = await fixture({ catalog: [{ id: 'chat-pro', name: 'Chat', operations: ['chat'] }, { id: 'embed', name: 'Embed', operations: ['embedding'], dimensions: 2 }] });
    const runtime = f.create();
    const activation = (await runtime.activate({ ...input, action: 'activate' })).activation;
    const binding = await f.modelRuntime.resolveBinding('embedding');
    const captured = await runtime.captureConsumerOwner(binding);
    expect(captured.id).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(captured)).not.toMatch(/session-1|user-1|fixture-account-key/);
    await captured.assertCurrent();
    f.changeActor({ authSession: 'new-session' });
    await expect(captured.assertCurrent()).rejects.toMatchObject({ code: 'platform_session_changed' });
    await runtime.read(input);
    const current = await runtime.captureConsumerOwner(binding);
    expect(current.id).not.toBe(captured.id);
    const configuration = await f.modelRuntime.getPublicConfiguration();
    const connection = configuration.connections.find((entry) => entry.id === activation.connectionId);
    const { hasApiKey: _hasApiKey, credentialSource: _credentialSource, ...editable } = connection;
    await f.modelRuntime.saveConnection({ revision: configuration.revision, connection: { ...editable, apiKey: 'fixture-new-private-key' } });
    await expect(current.assertCurrent()).rejects.toMatchObject({ code: 'model_configuration_account_key_conflict' });
    expect(f.counts.issue).toBe(1);
    expect(f.probeCalls).toHaveLength(1);
  });
  it('issues once, stores real last4, configures a separate connection, and recovers without replaying a test', async () => {
    const f = await fixture();
    const runtime = f.create();
    expect(runtime).toBeDefined();
    expect(await runtime.read(input)).toMatchObject({ accountId: 'account-1', enterpriseMode: false, activation: null });
    const result = await runtime.activate({ ...input, action: 'activate' });
    expect(result.activation).toMatchObject({ status: 'ready', stage: 'test', key: { id: 'key-1', last4: '7890' }, modelId: 'chat-pro', test: { status: 'verified' }, actions: ['retest'] });
    expect(JSON.stringify(result)).not.toMatch(/fixture-account-key|secretRef|actor_id|llmrouter|unihub/i);
    const configuration = await f.modelRuntime.getPublicConfiguration();
    expect(configuration.bindings).toEqual([]);
    expect(configuration.connections).toHaveLength(1);
    expect(configuration.connections[0].id).toBe(result.activation.connectionId);
    f.changeActor({ authSession: 'relogin' });
    expect(await f.create().read(input)).toEqual(result);
    expect(await f.create().activate({ ...input, action: 'activate' })).toEqual(result);
    expect(f.counts).toEqual({ issue: 1, configure: 1, probe: 1, discover: 1 });
  });

  it('keeps ambiguous issuance unknown across reopen and refuses another issuance', async () => {
    const f = await fixture();
    f.controls.issueError = new Error('upstream connection lost with private response');
    const first = await f.create().activate({ ...input, action: 'activate' });
    expect(first.activation).toMatchObject({ status: 'unknown', stage: 'issue', key: null, actions: [], errorCode: 'account_key_issue_unknown' });
    for (const action of ['activate', 'resume', 'retest']) expect((await f.create().activate({ ...input, action })).activation.status).toBe('unknown');
    expect((await f.create().read(input)).activation).toEqual(first.activation);
    expect(f.counts).toEqual({ issue: 1, discover: 1, configure: 0, probe: 0 });
  });

  it.each([
    { actor_id: 'other-user' }, { account_id: 'other-account' }, { origin_product_id: 'other-product' },
    { instance_id: 'other-instance' }, { id: undefined }, { token: undefined }, { token: 'abcd' }, { models: ['embed'] },
  ])('does not install a key with an invalid authoritative scope %j', async (issueOverrides) => {
    const f = await fixture(); f.controls.issueOverrides = issueOverrides;
    expect((await f.create().activate({ ...input, action: 'activate' })).activation).toMatchObject({ status: 'unknown', key: null });
    expect((await f.modelRuntime.getPublicConfiguration()).connections).toEqual([]);
    expect(f.counts.configure).toBe(0); expect(f.counts.probe).toBe(0);
  });

  it('rejects an account mismatch before any upstream request and separates owners', async () => {
    const f = await fixture();
    await expect(f.create().read({ ...input, accountId: 'other-account' })).rejects.toMatchObject({ code: 'platform_account_forbidden' });
    await expect(f.create().activate({ ...input, accountId: 'other-account', action: 'activate' })).rejects.toMatchObject({ code: 'platform_account_forbidden' });
    expect(f.counts.issue).toBe(0); expect(f.counts.discover).toBe(0);
    await f.create().activate({ ...input, action: 'activate' });
    f.changeActor({ actingUserId: 'user-2', authSession: 'another-session' });
    expect((await f.create().read(input)).activation).toBeNull();
  });

  it('rejects overlapping activation while GET observes its durable issuing stage', async () => {
    const f = await fixture();
    f.controls.issueWait = deferred(); f.controls.issueStarted = deferred();
    const pending = f.create().activate({ ...input, action: 'activate' });
    await f.controls.issueStarted.promise;
    expect((await f.create().read(input)).activation).toMatchObject({ status: 'issuing', actions: [] });
    await expect(f.create().activate({ ...input, action: 'activate' })).rejects.toMatchObject({ code: 'account_key_busy' });
    f.controls.issueWait.resolve(); await pending;
    expect(f.counts.issue).toBe(1); expect(f.counts.probe).toBe(1);
  });

  it('keeps issuance unknown when the captured session refuses a late response after a new login', async () => {
    const f = await fixture();
    f.controls.issueWait = deferred(); f.controls.issueStarted = deferred();
    const pending = f.create().activate({ ...input, action: 'activate' });
    await f.controls.issueStarted.promise;
    f.changeActor({ actingUserId: 'user-2', authSession: 'second-session' });
    f.controls.issueWait.resolve();
    await expect(pending).rejects.toMatchObject({ code: 'platform_session_changed' });
    expect((await f.create().read(input)).activation).toBeNull();
    expect((await f.modelRuntime.getPublicConfiguration()).connections).toEqual([]);
    expect(f.counts.configure).toBe(0); expect(f.counts.probe).toBe(0);
    f.changeActor({ actingUserId: 'user-1', authSession: 'third-session' });
    expect((await f.create().read(input)).activation).toMatchObject({ status: 'unknown', key: null, actions: [] });
    expect((await f.create().activate({ ...input, action: 'resume' })).activation.status).toBe('unknown');
    expect(f.counts.issue).toBe(1);
  });

  it('resumes a committed connection after native setup failure without replacing a binding', async () => {
    const f = await fixture();
    f.controls.configureError = new Error('setup unavailable');
    expect((await f.create().activate({ ...input, action: 'activate' })).activation).toMatchObject({ status: 'failed', stage: 'configure', actions: ['resume'] });
    const before = await f.modelRuntime.getPublicConfiguration();
    expect(before.connections).toHaveLength(1);
    f.controls.configureError = null;
    expect((await f.create().activate({ ...input, action: 'resume' })).activation.status).toBe('ready');
    expect(await f.modelRuntime.getPublicConfiguration()).toEqual(before);
    expect(f.counts.issue).toBe(1);
  });

  it('requires explicit retest after a failed or uncertain paid request', async () => {
    const f = await fixture();
    f.controls.probeError = Object.assign(new Error('provider timeout'), { code: 'model_configuration_account_probe_unknown' });
    const failed = await f.create().activate({ ...input, action: 'activate' });
    expect(failed.activation).toMatchObject({ status: 'unknown', stage: 'test', actions: ['retest'], test: { status: 'unknown' } });
    await f.create().read(input);
    await f.create().activate({ ...input, action: 'activate' });
    await f.create().activate({ ...input, action: 'resume' });
    expect(f.counts.probe).toBe(1);
    f.controls.probeError = null;
    expect((await f.create().activate({ ...input, action: 'retest' })).activation.status).toBe('ready');
    expect(f.counts.probe).toBe(2); expect(f.counts.issue).toBe(1);
  });

  it.each(['issuing', 'testing', 'configuring'])('restores persisted %s as uncertainty or interruption without automatic dispatch', async (status) => {
    const f = await fixture(); await f.create().activate({ ...input, action: 'activate' });
    const directory = path.join(f.dataDir, 'account-key-activation');
    const filename = path.join(directory, (await fs.readdir(directory)).find((name) => name.endsWith('.json')));
    const record = JSON.parse(await fs.readFile(filename, 'utf8'));
    Object.assign(record, { status, stage: status === 'issuing' ? 'issue' : status === 'testing' ? 'test' : 'configure' });
    await fs.writeFile(filename, JSON.stringify(record));
    expect((await f.create().read(input)).activation.status).toBe(status === 'configuring' ? 'interrupted' : 'unknown');
    expect(f.counts).toEqual({ issue: 1, configure: 1, probe: 1, discover: 1 });
  });

  it('refuses enterprise provider entry before issuance and after asynchronous setup', async () => {
    const f = await fixture(); f.env.OPENCHAMBER_ENTERPRISE_MODE = '1';
    await expect(f.create().activate({ ...input, action: 'activate' })).rejects.toMatchObject({ code: 'enterprise_mode' });
    expect(await f.create().read(input)).toMatchObject({ enterpriseMode: true, activation: null });
    expect(f.counts.issue).toBe(0);
    f.env.OPENCHAMBER_ENTERPRISE_MODE = '0';
    f.controls.configureWait = deferred(); f.controls.configureStarted = deferred();
    const pending = f.create().activate({ ...input, action: 'activate' });
    await f.controls.configureStarted.promise;
    f.env.OPENCHAMBER_ENTERPRISE_MODE = '1'; f.controls.configureWait.resolve();
    await expect(pending).rejects.toMatchObject({ code: 'enterprise_mode' });
    expect((await f.create().read(input)).activation).toMatchObject({ status: 'failed', stage: 'configure', actions: [] });
    expect(f.counts.probe).toBe(0);
  });

  it('reports edited configuration on GET without repairing it or repeating the test', async () => {
    const f = await fixture(); await f.create().activate({ ...input, action: 'activate' });
    const configuration = await f.modelRuntime.getPublicConfiguration();
    const connection = configuration.connections[0];
    await f.modelRuntime.saveConnection({ revision: configuration.revision, connection: { id: connection.id, name: 'User edited', providerId: 'openai', protocol: 'openai-compatible', baseUrl: 'https://other.example.test/v1', apiKey: 'fixture-other-user-key' } });
    const edited = await f.modelRuntime.getPublicConfiguration();
    expect((await f.create().read(input)).activation).toMatchObject({ status: 'failed', stage: 'configure', actions: ['resume'], test: { status: 'verified' } });
    expect((await f.create().activate({ ...input, action: 'resume' })).activation.status).toBe('failed');
    expect(await f.modelRuntime.getPublicConfiguration()).toEqual(edited);
    expect(f.counts.probe).toBe(1);
  });

  it('reports a native credential conflict on GET without losing the key receipt', async () => {
    const f = await fixture(); await f.create().activate({ ...input, action: 'activate' });
    f.controls.verifyError = Object.assign(new Error('changed'), { code: 'model_configuration_account_provider_conflict' });
    expect((await f.create().read(input)).activation).toMatchObject({ status: 'failed', stage: 'configure', key: { id: 'key-1', last4: '7890' }, errorCode: 'account_key_configuration_conflict' });
    expect(f.counts.probe).toBe(1); expect(f.counts.configure).toBe(1);
  });

  it.each(['session', 'enterprise', 'credential'])('refuses a %s change during staged connection persistence before rename', async (change) => {
    const f = await fixture();
    let current = true; let reads = 0;
    const runtime = createModelConfigurationRuntime({ dataDir: f.dataDir, env: f.env, enterpriseOptions: { env: f.env, policyFilePaths: [] }, readModelBootstrapCredential: async () => {
      reads++;
      if (reads === 2) {
        if (change === 'session') current = false;
        if (change === 'enterprise') f.env.OPENCHAMBER_ENTERPRISE_MODE = '1';
        if (change === 'credential') return 'fixture-replaced-key';
      }
      return issuedKey;
    } });
    const connection = { id: 'activation-connection', name: 'SuperWagie', providerId: 'llmrouter', protocol: 'openai-compatible', baseUrl: 'https://llmrouter.quukk.com/v1', credentialSource: { type: 'model-bootstrap', providerId: 'llmrouter', ref: 'fixture-private-ref' } };
    await expect(runtime.saveAccountKeyConnection({ revision: 0, connection, apiKey: issuedKey, assertCurrent: () => { if (!current) throw new ModelConfigurationError('platform_session_changed', 409); } })).rejects.toMatchObject({ code: change === 'session' ? 'platform_session_changed' : change === 'enterprise' ? 'enterprise_mode' : 'model_configuration_credential_changed' });
    expect((await runtime.getPublicConfiguration()).connections).toEqual([]);
    expect((await runtime.getPublicConfiguration()).revision).toBe(0);
  });

  it('serves authenticated no-store account-key state and rejects extra mutation input', async () => {
    const f = await fixture(); const app = express();
    registerModelBootstrapRoutes(app, { bootstrapRuntime: { accountKey: f.create() }, resolveIdentity: () => owner, resolveOwner: (_req, _res, options) => {
      expect(options).toEqual({ allowClientAuth: true, allowUrlToken: false });
      return owner;
    } });
    const initial = await request(app).get('/api/model-configuration/bootstrap/account-key?accountId=account-1').expect(200);
    expect(initial.headers['cache-control']).toBe('no-store');
    expect(initial.body.activation).toBeNull();
    await request(app).post('/api/model-configuration/bootstrap/account-key').send({ accountId: 'account-1', action: 'activate', secret: 'not-accepted' }).expect(400);
    await request(app).get('/api/model-configuration/bootstrap/account-key?accountId=account-1&accountId=other').expect(400);
    await request(app).post('/api/model-configuration/bootstrap/account-key').send({ accountId: 'other-account', action: 'activate' }).expect(403);
    expect(f.counts.issue).toBe(0);
    const result = await request(app).post('/api/model-configuration/bootstrap/account-key').send({ accountId: 'account-1', action: 'activate' }).expect(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.body.activation.status).toBe('ready');
    expect(JSON.stringify(result.body)).not.toContain(issuedKey);
  });

  it('refuses missing identities and unsupported activation before dispatch', async () => {
    const f = await fixture(); const app = express();
    registerModelBootstrapRoutes(app, { bootstrapRuntime: { accountKey: f.create() }, resolveIdentity: () => null, resolveOwner: () => owner });
    await request(app).get('/api/model-configuration/bootstrap/account-key?accountId=account-1').expect(409);
    await request(app).post('/api/model-configuration/bootstrap/account-key').send({ accountId: 'account-1', action: 'activate' }).expect(409);
    const unsupported = express(); registerModelBootstrapRoutes(unsupported);
    await request(unsupported).get('/api/model-configuration/bootstrap/account-key?accountId=account-1').expect(501);
    await expect(f.create({ available: false }).activate({ ...input, action: 'activate' })).rejects.toMatchObject({ code: 'model_configuration_bootstrap_unsupported' });
    expect(f.counts.issue).toBe(0);
  });

  it('captures a refreshed access token before dispatching while retaining the original identity guard', async () => {
    const f = await fixture(); f.controls.accessExpired = true;
    expect((await f.create().activate({ ...input, action: 'activate' })).activation.status).toBe('ready');
    expect(f.counts.issue).toBe(1);
  });

  it('does not issue for a replacement login while refreshing the original access token', async () => {
    const f = await fixture(); f.controls.refreshWait = deferred(); f.controls.refreshStarted = deferred();
    const pending = f.create().activate({ ...input, action: 'activate' });
    await f.controls.refreshStarted.promise;
    f.changeActor({ actingUserId: 'user-2', authSession: 'new-login' }); f.controls.refreshWait.resolve();
    await expect(pending).rejects.toMatchObject({ code: 'platform_session_changed' });
    expect(f.counts.issue).toBe(0); expect(f.counts.discover).toBe(0);
  });

  it('keeps a safely saved key recoverable when the account changes during configuration', async () => {
    const f = await fixture(); f.controls.configureWait = deferred(); f.controls.configureStarted = deferred();
    const pending = f.create().activate({ ...input, action: 'activate' });
    await f.controls.configureStarted.promise;
    f.changeActor({ billingAccountId: 'other-account', authSession: 'account-switch' }); f.controls.configureWait.resolve();
    await expect(pending).rejects.toMatchObject({ code: 'platform_session_changed' });
    expect(f.counts.probe).toBe(0);
    f.changeActor({ billingAccountId: 'account-1', authSession: 'back-to-account' });
    expect((await f.create().read(input)).activation).toMatchObject({ status: 'interrupted', key: { last4: '7890' }, actions: ['resume'] });
    expect((await f.create().activate({ ...input, action: 'resume' })).activation.status).toBe('ready');
    expect(f.counts.issue).toBe(1);
  });

  it('never creates a new encryption master key when reading an existing key with its master missing', async () => {
    const f = await fixture(); await f.create().activate({ ...input, action: 'activate' });
    const master = path.join(f.dataDir, 'model-bootstrap', 'master.key');
    await fs.unlink(master);
    const reloadedStore = createModelBootstrapStore({ dataDir: f.dataDir });
    const directory = path.join(f.dataDir, 'account-key-activation');
    const record = JSON.parse(await fs.readFile(path.join(directory, (await fs.readdir(directory)).find((name) => name.endsWith('.json'))), 'utf8'));
    expect(await reloadedStore.getSecret(record.secretRef)).toBeNull();
    await expect(fs.stat(master)).rejects.toMatchObject({ code: 'ENOENT' });
    const newSecret = await reloadedStore.putSecret('fixture-new-key');
    expect(await reloadedStore.getSecret(newSecret.ref)).toBe('fixture-new-key');
  });

  it('retains long-lived key receipts and fails closed on a damaged receipt without issuing', async () => {
    const f = await fixture(); await f.create().activate({ ...input, action: 'activate' });
    const directory = path.join(f.dataDir, 'account-key-activation');
    const filename = path.join(directory, (await fs.readdir(directory)).find((name) => name.endsWith('.json')));
    const record = JSON.parse(await fs.readFile(filename, 'utf8'));
    record.createdAt = '2024-01-01T00:00:00.000Z';
    await fs.writeFile(filename, JSON.stringify(record));
    expect((await f.create().read(input)).activation).toMatchObject({ status: 'ready', key: { last4: '7890' } });
    await fs.writeFile(filename, '{broken');
    await expect(f.create().read(input)).rejects.toMatchObject({ code: 'account_key_store_invalid' });
    await expect(f.create().activate({ ...input, action: 'activate' })).rejects.toMatchObject({ code: 'account_key_store_invalid' });
    expect(f.counts.issue).toBe(1);
  });

  it('serializes dead-writer recovery so a second writer cannot unlink a fresh lease', async () => {
    const f = await fixture(); const storageId = 'a'.repeat(64);
    const directory = path.join(f.dataDir, 'account-key-activation'); await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, `${storageId}.json.lock`), '99999999:dead-writer');
    const entered = deferred(); const release = deferred(); let writes = 0;
    const first = createAccountKeyStore({ dataDir: f.dataDir }).withLock(storageId, async () => { writes++; entered.resolve(); await release.promise; });
    await entered.promise;
    await expect(createAccountKeyStore({ dataDir: f.dataDir }).withLock(storageId, () => { writes++; })).rejects.toMatchObject({ code: 'account_key_busy' });
    release.resolve(); await first;
    expect(writes).toBe(1);
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it('rejects a replaced secret with matching last4 before passing it to native configuration', async () => {
    const secrets = new Map();
    const f = await fixture({ secretStore: { put: (ref, key) => secrets.set(ref, key), get: (ref) => secrets.get(ref) } });
    f.controls.configureError = new Error('interrupted native setup');
    await f.create().activate({ ...input, action: 'activate' });
    for (const ref of secrets.keys()) secrets.set(ref, 'fixture-replaced-key-7890');
    f.controls.configureError = null;
    expect((await f.create().activate({ ...input, action: 'resume' })).activation).toMatchObject({ status: 'failed', errorCode: 'account_key_configuration_conflict' });
    expect(f.counts.configure).toBe(1); expect(f.counts.probe).toBe(0);
  });

  const multimodalCatalog = [
    { id: 'chat-pro', name: 'Chat Pro', operations: ['chat'] },
    { id: 'chat-unused', name: 'Unused chat', operations: ['chat'] },
    { id: 'embed', name: 'Embedding', operations: ['embedding'], dimensions: 2 },
    { id: 'rerank', name: 'Ranking', operations: ['rerank'] },
    { id: 'image', name: 'Image', operations: ['image_generation'] },
        { id: 'vision', name: 'Vision', operations: ['vision'] },
    { id: 'video-unused', name: 'Video', operations: ['video'] },
  ];

  it.each(['replacement-key', 'replacement-endpoint', 'rotated-reference'])('refuses a purpose probe after %s changes during native configuration', async (change) => {
    const secrets = new Map();
    const f = await fixture({ catalog: multimodalCatalog.slice(0, 3), secretStore: { put: (ref, key) => secrets.set(ref, key), get: (ref) => secrets.get(ref) } });
    f.controls.configureStarted = deferred();
    f.controls.configureWait = deferred();
    const pending = f.create().activate({ ...input, action: 'activate' });
    await f.controls.configureStarted.promise;
    const configuration = await f.modelRuntime.getPublicConfiguration();
    const connection = configuration.connections[0];
    if (change === 'rotated-reference') {
      for (const ref of secrets.keys()) secrets.set(ref, 'fixture-foreign-key');
    } else {
      await f.modelRuntime.saveConnection({ revision: configuration.revision, connection: {
        id: connection.id, name: connection.name, providerId: connection.providerId, protocol: connection.protocol,
        baseUrl: change === 'replacement-endpoint' ? 'https://other.example.test/v1' : connection.baseUrl,
        apiKey: change === 'replacement-key' ? 'fixture-foreign-key' : issuedKey,
      } });
    }
    f.controls.configureWait.resolve();
    const result = (await pending).activation;
    expect(f.probeCalls).toEqual([]);
    expect(result).toMatchObject({ status: 'unknown', errorCode: 'account_key_configuration_conflict' });
    expect(result.tests.find((row) => row.purpose === 'embedding')).toMatchObject({ status: 'unknown', errorCode: 'account_key_configuration_conflict' });
    expect(f.counts.issue).toBe(1);
  });

  it('signs only the selected capability models, fills missing bindings, and tests each real operation without mutating verification', async () => {
    const f = await fixture({ catalog: multimodalCatalog });
    const result = (await f.create().activate({ ...input, action: 'activate' })).activation;
    expect(f.controls.issuedModels.sort()).toEqual(['chat-pro', 'embed', 'image', 'rerank', 'vision']);
    expect(result.testRunId).toEqual(expect.any(String));
    expect(result.tests.filter((row) => row.status === 'verified').map((row) => row.purpose).sort()).toEqual(['agent', 'embedding', 'image-generation', 'rerank', 'vision']);
    expect(result.tests.some((row) => row.purpose === 'ocr' || row.modelId === 'ocr-only')).toBe(false);
    expect(result.tests.some((row) => row.modelId === 'chat-unused' || row.modelId === 'video-unused')).toBe(false);
    expect(f.probeCalls.map((call) => new URL(call.url).pathname).sort()).toEqual(['/v1/chat/completions', '/v1/embeddings', '/v1/images/generations', '/v1/rerank']);
    const configuration = await f.modelRuntime.getPublicConfiguration();
    expect(configuration.bindings).toHaveLength(4);
    expect(configuration.bindings.every((binding) => binding.verification.status === 'untested')).toBe(true);
    const reopened = await f.create().read(input);
    expect(reopened.activation).toEqual(result);
    expect((await f.modelRuntime.getPublicConfiguration()).revision).toBe(configuration.revision);
    expect(f.counts.issue).toBe(1);
  });

  it('tests and switches existing functions to the same account key without reading their foreign keys', async () => {
    const f = await fixture({ catalog: multimodalCatalog.filter((model) => model.id !== 'ocr-only'), legacyModels: [{ purpose: 'embedding', modelId: 'embed', parameters: { dimensions: 2 } }] });
    const connected = await f.modelRuntime.saveConnection({ revision: 0, connection: { name: 'Existing', providerId: 'existing', protocol: 'openai-compatible', baseUrl: 'https://existing.example/v1', apiKey: 'fixture-existing-key' } });
    await f.modelRuntime.saveBinding('image-generation', { revision: connected.revision, binding: { connectionId: connected.connections[0].id, model: 'image', parameters: {} } });
    const result = (await f.create().activate({ ...input, action: 'activate' })).activation;
    expect(result.tests.filter((row) => row.status === 'verified')).toHaveLength(5);
    for (const purpose of ['embedding', 'rerank', 'image-generation', 'vision']) {
      const resolved = await f.modelRuntime.resolveBinding(purpose);
      expect(resolved).toMatchObject({ connectionId: result.connectionId, apiKey: issuedKey });
    }
    expect(f.probeCalls.every((call) => call.url.startsWith('https://llmrouter.quukk.com/v1/'))).toBe(true);
  });

  it('does not claim all models passed when an existing model cannot be tested', async () => {
    const f = await fixture({ legacyModels: [{ purpose: 'embedding', modelId: 'missing-model' }] });
    const result = (await f.create().activate({ ...input, action: 'activate' })).activation;
    expect(result.test.status).not.toBe('verified');
    expect(result.status).not.toBe('ready');
    expect(result.tests.find((row) => row.purpose === 'embedding')).toMatchObject({ status: 'skipped', errorCode: 'account_key_model_unavailable' });
  });

  it('preserves unavailable current models with explicit incomplete results and excludes unused catalog models', async () => {
    const f = await fixture({ catalog: multimodalCatalog, legacyModels: [{ purpose: 'embedding', modelId: 'legacy-index-model' }, { purpose: 'vision', modelId: null, errorCode: 'account_key_existing_configuration_unknown' }] });
    const connected = await f.modelRuntime.saveConnection({ revision: 0, connection: { name: 'Existing', providerId: 'existing', protocol: 'openai-compatible', baseUrl: 'https://existing.example/v1', apiKey: 'fixture-existing-key' } });
    await f.modelRuntime.saveBinding('rerank', { revision: connected.revision, binding: { connectionId: connected.connections[0].id, model: 'existing-reranker', parameters: {} } });
    const result = (await f.create().activate({ ...input, action: 'activate' })).activation;
    expect(f.controls.issuedModels).toEqual(['chat-pro', 'image']);
    expect(result.tests.find((row) => row.purpose === 'embedding')).toMatchObject({ status: 'skipped', modelId: 'legacy-index-model', errorCode: 'account_key_model_unavailable' });
    expect(result.tests.find((row) => row.purpose === 'vision')).toMatchObject({ status: 'skipped', modelId: null, errorCode: 'account_key_existing_configuration_unknown' });
    expect(result.tests.find((row) => row.purpose === 'rerank')).toMatchObject({ status: 'skipped', modelId: 'existing-reranker', applied: false, errorCode: 'account_key_model_unavailable' });
    expect((await f.modelRuntime.getPublicConfiguration()).bindings.find((binding) => binding.purpose === 'rerank')).toMatchObject({ connectionId: connected.connections[0].id, model: 'existing-reranker' });
    expect(f.probeCalls.some((call) => call.url === 'https://existing.example/v1/rerank')).toBe(false);
    expect(f.probeCalls.some((call) => call.url.endsWith('/rerank'))).toBe(false);
    expect(result.tests.filter((row) => row.status === 'verified').map((row) => row.purpose).sort()).toEqual(['agent', 'image-generation']);
  });

  it('limits actual dispatch to three and exposes durable queued, running, and terminal rows while a batch is pending', async () => {
    const f = await fixture({ catalog: multimodalCatalog });
    f.controls.probeWait = deferred(); f.controls.modelProbeWait = deferred(); f.controls.modelProbeStarted = deferred();
    const pending = f.create().activate({ ...input, action: 'activate' });
    await f.controls.modelProbeStarted.promise;
    for (let attempt = 0; attempt < 100 && f.probeCalls.length < 2; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
    const running = (await f.create().read(input)).activation;
    expect(f.counts.probe + f.probeCalls.length).toBe(3);
    expect(running.status).toBe('testing');
    expect(running.tests.filter((row) => row.status === 'testing')).toHaveLength(3);
    expect(running.tests.filter((row) => row.status === 'queued')).toHaveLength(2);
    f.controls.probeWait.resolve();
    for (let attempt = 0; attempt < 100 && f.probeCalls.length < 3; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
    const partial = (await f.create().read(input)).activation;
    expect(partial.tests.find((row) => row.id === 'account-chat').status).toBe('verified');
    expect(partial.testRunId).toBe(running.testRunId);
    f.controls.modelProbeWait.resolve();
    const complete = (await pending).activation;
    expect(complete.status).toBe('ready');
    expect(complete.tests.filter((row) => row.status === 'verified')).toHaveLength(5);
  });

  it('keeps confirmed provider failure separate from lost-response uncertainty and changes run IDs only on explicit retest', async () => {
    const f = await fixture({ catalog: multimodalCatalog.slice(0, 3) });
    f.controls.modelProbeStatus = 401;
    const failed = (await f.create().activate({ ...input, action: 'activate' })).activation;
    expect(failed.tests.find((row) => row.purpose === 'embedding').status).toBe('failed');
    expect(failed.tests.find((row) => row.id === 'account-chat').status).toBe('verified');
    expect((await f.create().read(input)).activation.testRunId).toBe(failed.testRunId);
    expect(f.probeCalls).toHaveLength(1);
    f.controls.modelProbeStatus = null;
    f.controls.modelProbeError = new Error('transport interrupted');
    const unknown = (await f.create().activate({ ...input, action: 'retest' })).activation;
    expect(unknown.testRunId).not.toBe(failed.testRunId);
    expect(unknown.tests.find((row) => row.purpose === 'embedding')).toMatchObject({ status: 'unknown', errorCode: 'account_key_test_unknown' });
    expect(unknown.status).toBe('unknown');
    expect(f.counts.issue).toBe(1); expect(f.probeCalls).toHaveLength(2);
  });

  it('reads legacy single-chat receipts and refreshes catalog only on explicit retest', async () => {
    const f = await fixture();
    await f.create().activate({ ...input, action: 'activate' });
    const directory = path.join(f.dataDir, 'account-key-activation');
    const filename = path.join(directory, (await fs.readdir(directory)).find((name) => name.endsWith('.json')));
    const record = JSON.parse(await fs.readFile(filename, 'utf8'));
    delete record.purposeModels; delete record.chatModels; delete record.testRunId; delete record.tests;
    await fs.writeFile(filename, JSON.stringify(record));
    const originalConfigure = f.provider.configure;
    f.provider.configure = async (request) => {
      expect(request.previousModels).toEqual([{ id: 'chat-pro', name: 'Chat Pro' }]);
      await originalConfigure(request);
    };
    const old = (await f.create().read(input)).activation;
    expect(old.testRunId).toBeNull(); expect(old.tests).toEqual([]);
    expect(old).toMatchObject({ status: 'unknown', errorCode: 'account_key_apply_required' });
    const result = (await f.create().activate({ ...input, action: 'retest' })).activation;
    expect(result.tests.some((row) => row.purpose === 'embedding')).toBe(false);
    expect(f.counts).toEqual({ issue: 1, configure: 2, probe: 2, discover: 2 });
    expect((await f.modelRuntime.getPublicConfiguration()).bindings).toEqual([]);
  });

  it('projects only unfinished rows as unknown after restart while retaining confirmed results', async () => {
    const f = await fixture({ catalog: multimodalCatalog });
    await f.create().activate({ ...input, action: 'activate' });
    const directory = path.join(f.dataDir, 'account-key-activation');
    const filename = path.join(directory, (await fs.readdir(directory)).find((name) => name.endsWith('.json')));
    const record = JSON.parse(await fs.readFile(filename, 'utf8'));
    record.status = 'testing'; record.test = null;
    record.tests = record.tests.map((row) => row.purpose === 'embedding' ? { ...row, status: 'testing', testedAt: null } : row.purpose === 'image-generation' ? { ...row, status: 'queued', testedAt: null } : row);
    await fs.writeFile(filename, JSON.stringify(record));
    const recovered = (await f.create().read(input)).activation;
    expect(recovered.tests.find((row) => row.id === 'account-chat').status).toBe('verified');
    expect(recovered.tests.filter((row) => row.status === 'unknown').map((row) => row.purpose).sort()).toEqual(['embedding', 'image-generation']);
    expect(f.counts.probe).toBe(1); expect(f.probeCalls).toHaveLength(4);
  });

  it('reapplies missing purpose bindings when the user explicitly tests and applies all functions', async () => {
    const f = await fixture({ catalog: multimodalCatalog.slice(0, 3) });
    await f.create().activate({ ...input, action: 'activate' });
    const configuration = await f.modelRuntime.getPublicConfiguration();
    const cleared = await f.modelRuntime.saveBinding('embedding', { revision: configuration.revision, binding: null });
    const retried = (await f.create().activate({ ...input, action: 'retest' })).activation;
    expect(retried.tests.find((row) => row.purpose === 'embedding')).toMatchObject({ status: 'verified', applied: true });
    expect((await f.modelRuntime.getPublicConfiguration()).revision).toBeGreaterThan(cleared.revision);
    expect(f.probeCalls).toHaveLength(2);
  });

  it('tests the auxiliary candidate through the account key without borrowing the previous variant or credential', async () => {
    const f = await fixture();
    f.provider.planTests = async ({ providerId, modelId }) => [
      { id: 'native-agent', purpose: 'agent', providerId, modelId },
      { id: 'native-auxiliary', purpose: 'auxiliary', providerId, modelId, variant: 'reasoning' },
    ];
    const nativeCalls = [];
    const originalProbe = f.provider.probe;
    f.provider.probe = async (req) => {
      nativeCalls.push({ modelId: req.modelId, providerId: req.providerId });
      await originalProbe(req);
      return { status: 'verified', testedAt: '2026-11-06T00:01:00.000Z' };
    };
    const result = (await f.create().activate({ ...input, action: 'activate' })).activation;
    expect(nativeCalls).toHaveLength(2);
    expect(nativeCalls[0]).toMatchObject({ providerId: result.providerId, modelId: 'chat-pro' });
    expect(result.tests.find((row) => row.id === 'native-auxiliary')).toMatchObject({ modelId: 'chat-pro', status: 'verified' });
    expect(result.tests.some((row) => row.id === 'native-agent')).toBe(false);
    expect(JSON.stringify(result.tests)).not.toContain(result.providerId);
    expect(f.counts.probe).toBe(2);
  });

  it('keeps unreadable native selections incomplete without substituting the registration model', async () => {
    const f = await fixture();
    f.provider.planTests = async () => [
      { id: 'native-agent', purpose: 'agent', providerId: null, modelId: null, status: 'skipped', errorCode: 'model_configuration_account_provider_unavailable' },
      { id: 'native-auxiliary', purpose: 'auxiliary', providerId: null, modelId: null, status: 'skipped', errorCode: 'model_configuration_account_model_unconfigured' },
    ];
    let nativeCalls = 0;
    f.provider.probeConfiguredModel = async () => { nativeCalls++; throw new Error('Unavailable selections cannot be probed'); };
    const result = (await f.create().activate({ ...input, action: 'activate' })).activation;
    expect(result.tests.some((row) => row.id === 'native-agent')).toBe(false);
    expect(result.tests.find((row) => row.id === 'account-chat')).toMatchObject({ modelId: null, status: 'skipped', applied: false, errorCode: 'model_configuration_account_provider_unavailable' });
    expect(result.tests.find((row) => row.id === 'native-auxiliary')).toMatchObject({ status: 'skipped' });
    expect(nativeCalls).toBe(0);
    expect(f.counts.probe).toBe(0);
    expect(f.controls.selected).toBeUndefined();
  });

  it('preserves an unavailable auxiliary model without invoking the foreign provider', async () => {
    const f = await fixture();
    f.provider.planTests = async ({ providerId, modelId }) => [
      { id: 'native-agent', purpose: 'agent', providerId: 'foreign-provider', modelId },
      { id: 'native-auxiliary', purpose: 'auxiliary', providerId, modelId: 'unissued-model' },
    ];
    let nativeCalls = 0;
    f.provider.probeConfiguredModel = async () => { nativeCalls++; throw new Error('Foreign models cannot be probed'); };
    const result = (await f.create().activate({ ...input, action: 'activate' })).activation;
    expect(result.tests).toEqual([expect.objectContaining({ id: 'account-chat', modelId: 'chat-pro', status: 'verified' }), expect.objectContaining({ id: 'native-auxiliary', modelId: 'unissued-model', status: 'skipped', applied: false, errorCode: 'account_key_model_not_authorized' })]);
    expect(nativeCalls).toBe(0);
    expect(f.counts.probe).toBe(1);
    expect(f.controls.selected).toEqual({ agent: 'chat-pro' });
    expect(JSON.stringify(result)).not.toContain('foreign-provider');
  });

  it('skips a saved binding on the account connection when its model is outside the issued scope', async () => {
    const f = await fixture({ catalog: multimodalCatalog.slice(0, 3) });
    const initial = (await f.create().activate({ ...input, action: 'activate' })).activation;
    const configuration = await f.modelRuntime.getPublicConfiguration();
    await f.modelRuntime.saveBinding('embedding', { revision: configuration.revision, binding: { connectionId: initial.connectionId, model: 'unissued-model', parameters: {} } });
    const before = f.probeCalls.length;
    const result = (await f.create().activate({ ...input, action: 'retest' })).activation;
    expect(result.tests.find((row) => row.purpose === 'embedding')).toMatchObject({ status: 'skipped', errorCode: 'account_key_model_unavailable' });
    expect(f.probeCalls).toHaveLength(before);
    expect(f.counts.issue).toBe(1);
  });

  it('stops queued probes when the captured account changes and keeps the old owner receipt separate', async () => {
    const f = await fixture({ catalog: multimodalCatalog });
    f.controls.probeWait = deferred(); f.controls.modelProbeWait = deferred(); f.controls.modelProbeStarted = deferred();
    const pending = f.create().activate({ ...input, action: 'activate' });
    await f.controls.modelProbeStarted.promise;
    for (let attempt = 0; attempt < 100 && f.probeCalls.length < 2; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
    f.changeActor({ actingUserId: 'user-2', authSession: 'replacement-session' });
    f.controls.probeWait.resolve(); f.controls.modelProbeWait.resolve();
    await expect(pending).rejects.toMatchObject({ code: 'platform_session_changed' });
    expect(f.probeCalls).toHaveLength(2);
    expect((await f.create().read(input)).activation).toBeNull();
    f.changeActor({ actingUserId: 'user-1', authSession: 'new-login' });
    const receipt = (await f.create().read(input)).activation;
    expect(receipt.status).toBe('unknown');
    expect(receipt.tests.filter((row) => row.status === 'unknown')).toHaveLength(5);
    expect(f.counts.issue).toBe(1);
  });

  it('stops new probes after a receipt write failure and retains every obtained result without unhandled rejections', async () => {
    const f = await fixture({ catalog: multimodalCatalog });
    const underlying = createAccountKeyStore({ dataDir: f.dataDir });
    let broken = false;
    const receiptStore = { ...underlying, write: async (id, record) => {
      if (broken || record.tests.some((row) => row.status === 'verified')) { broken = true; throw new Error('disk unavailable'); }
      return underlying.write(id, record);
    } };
    f.controls.modelProbeWait = deferred(); f.controls.modelProbeStarted = deferred();
    f.controls.probeWait = deferred();
    const pending = f.create({ receiptStore }).activate({ ...input, action: 'activate' });
    await f.controls.modelProbeStarted.promise;
    for (let attempt = 0; attempt < 100 && f.probeCalls.length < 2; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
    f.controls.probeWait.resolve();
    for (let attempt = 0; attempt < 100 && !broken; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(broken).toBe(true);
    expect(f.counts.probe + f.probeCalls.length).toBe(3);
    f.controls.modelProbeWait.resolve();
    const result = (await pending).activation;
    expect(result.status).toBe('unknown');
    expect(result.tests.filter((row) => row.status === 'verified')).toHaveLength(3);
    expect(result.tests.filter((row) => row.status === 'unknown')).toHaveLength(2);
    expect(result.errorCode).toBe('account_key_test_state_failed');
    expect((await f.create().read(input)).activation).toEqual(result);
    expect(f.counts.issue).toBe(1);
  });
});
