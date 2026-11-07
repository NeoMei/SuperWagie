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
const supportedPurposes = ['ocr', 'vision', 'embedding', 'rerank', 'tts', 'image-generation'];
const purposeCatalog = [
  { id: 'ocr', name: 'OCR', operations: ['ocr'] },
  { id: 'vision', name: 'Vision', operations: ['vision'] },
  { id: 'embed', name: 'Embedding', operations: ['embedding'], dimensions: 2 },
  { id: 'rerank', name: 'Rerank', operations: ['rerank'] },
  { id: 'speech', name: 'Speech', operations: ['speech'] },
  { id: 'image', name: 'Image', operations: ['image_generation'] },
];
const completeCatalog = [{ id: 'chat-pro', name: 'Chat Pro', operations: ['chat'] }, ...purposeCatalog];
const verifiedPurposeRows = () => supportedPurposes.map((purpose, index) => expect.objectContaining({ purpose, modelId: purposeCatalog[index].id, status: 'verified', applied: true, errorCode: null }));
const unavailablePurposeRows = () => supportedPurposes.map((purpose) => ({ id: `purpose:${purpose}`, purpose, modelId: null, status: 'skipped', testedAt: null, applied: false, errorCode: 'account_key_model_unavailable' }));
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
      const body = init.body instanceof FormData ? { model: init.body.get('model') } : init.body ? JSON.parse(init.body) : null;
      probeCalls.push({ url, body });
      controls.modelProbeStarted?.resolve();
      if (controls.modelProbeWait) await controls.modelProbeWait.promise;
      if (controls.modelProbeError) throw controls.modelProbeError;
      if (controls.modelProbeStatus) return Response.json({}, { status: controls.modelProbeStatus });
      if (url.endsWith('/embeddings')) return Response.json({ data: [{ embedding: [1, 2] }] });
      if (url.endsWith('/rerank')) return Response.json({ results: [{ index: 0, relevance_score: 1 }] });
      if (url.endsWith('/images/generations')) return Response.json({ data: [{ url: 'https://image.example/fixture.png' }] });
      if (url.endsWith('/chat/completions')) return Response.json({ choices: [{ message: { content: 'A blue circle.' } }] });
      if (url.endsWith('/audio/speech')) return new Response(Buffer.from('UklGRiYAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQIAAAAAAA==', 'base64'), { headers: { 'Content-Type': 'audio/wav' } });
      if (url.endsWith('/ocr')) return Response.json({ id: 'uk_fixture-task', job_id: 'fixture-job', state: 'pending' }, { status: 202 });
      if (url.endsWith('/ocr/uk_fixture-task')) return Response.json({ id: 'uk_fixture-task', job_id: 'fixture-job', state: 'done', progress: { totalPages: 1, extractedPages: 1 } });
      if (url.endsWith('/ocr/uk_fixture-task/document')) return Response.json({ id: 'uk_fixture-task', pages: [{ text: 'TEST', layout: [] }] });
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
          controls.discoveryRequests = [...(controls.discoveryRequests ?? []), init.body ? JSON.parse(init.body) : null];
          if (controls.discoveryError) throw controls.discoveryError;
          return { account_id: 'account-1', origin_product_id: 'superwagie', instance_id: 'fixture-instance', models: controls.catalog ?? catalog ?? [{ id: 'chat-pro', name: 'Chat Pro', operations: ['chat'] }] };
        }
        if (route.endsWith('/api-keys/key-1/scope')) {
          controls.scopeRequests = [...(controls.scopeRequests ?? []), JSON.parse(init.body)];
          controls.scopeStarted?.resolve();
          if (controls.scopeWait) await controls.scopeWait.promise;
          return { id: 'key-1', credential_kind: 'api_key', actor_id: 'user-1', account_id: 'account-1', origin_product_id: 'superwagie', instance_id: 'fixture-instance', model_scope: 'llmrouter_available', pricing_source: 'llmrouter_native', credential_version: 2, models: [], created_at: '2026-11-06T00:00:00Z', expires_at: null, revoked_at: null, ...controls.scopeOverrides };
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
          controls.issuePayload = JSON.parse(init.body);
          const issuedModels = controls.issuePayload.models ?? [];
          controls.issuedModels = issuedModels;
          expect(JSON.parse(init.body)).toMatchObject({ instance_id: 'fixture-instance', origin_product_id: 'superwagie' });
          if (controls.issueWait) await controls.issueWait.promise;
          if (controls.issueError) throw controls.issueError;
          if (captured.authSession !== actor.authSession) throw Object.assign(new Error('changed after response'), { code: 'platform_session_changed', status: 409 });
          return { id: 'key-1', credential_kind: 'api_key', name: 'SuperWagie', actor_id: 'user-1', account_id: 'account-1', origin_product_id: 'superwagie', instance_id: 'fixture-instance', model_scope: controls.issuePayload.model_scope ?? 'selected', pricing_source: 'llmrouter_native', credential_version: 1, models: issuedModels, created_at: '2026-11-06T00:00:00Z', expires_at: null, revoked_at: null, token: issuedKey, ...controls.issueOverrides };
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
    configure: async ({ apiKey, assertCurrent, models, previousModels }) => {
      counts.configure++;
      controls.configuredModels = models;
      controls.previousModels = previousModels;
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
  const createRuntime = () => createModelBootstrapRuntime({ dataDir, store, modelRuntime, platformAccount, accountKeyProvider: provider, readKeyCatalog, readLegacyModels: async () => legacyModels, env, enterpriseOptions,
    uniHubClient: { discover: async () => ({ account_id: 'account-1', origin_product_id: 'superwagie', instance_id: 'fixture-instance', models: catalog ?? [{ id: 'chat-pro', name: 'Chat Pro', operations: ['chat'] }] }) },
  });
  return { dataDir, store, modelRuntime, counts, controls, env, create, createRuntime, provider, probeCalls, changeActor: (next) => { actor = { ...actor, ...next }; } };
};
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });

describe('persistent account key activation', () => {
  it('keeps native Bailian speech on the same account Key after receipt reload and retest', async () => {
    const speechOperation = { id: 'bailian.audio.speech.create', protocol: 'bailian', endpoint: '/v1/native/bailian/audio/speech', method: 'POST', transports: ['binary'], available: true, executable: true };
    const speech = { id: 'qwen3-tts-flash', name: 'Qwen speech', operations: ['speech'], capability_metadata: { id: 'qwen3-tts-flash', name: 'Qwen speech', capabilities: {}, operations: [speechOperation] } };
    const f = await fixture({ catalog: [{ id: 'chat-pro', name: 'Chat Pro', operations: ['chat'] }, speech] });
    f.controls.keyCatalog = [{ id: 'chat-pro', name: 'Chat Pro', operations: ['chat'] }, { id: speech.id, name: speech.name, operations: ['speech'], capabilitiesKnown: true, speechOperation: 'bailian.audio.speech.create' }];
    for (const action of ['activate', 'retest']) {
      const result = (await f.create().activate({ ...input, action })).activation;
      expect(result.tests.find((row) => row.purpose === 'tts')).toMatchObject({ status: 'verified', applied: true, modelId: 'qwen3-tts-flash' });
      const binding = await f.modelRuntime.resolveBinding('tts');
      expect(binding).toMatchObject({ protocol: 'openai-compatible', apiKey: issuedKey, parameters: { speechOperation: 'bailian.audio.speech.create' } });
    }
    expect(f.counts.issue).toBe(1);
    expect(f.probeCalls).toHaveLength(2);
    expect(f.probeCalls.every((call) => call.url === 'https://llmrouter.quukk.com/v1/native/bailian/audio/speech' && call.body.input.voice === 'Cherry')).toBe(true);
  });

  it('marks a complete Key catalog ready only after all supported purposes are verified and applied', async () => {
    const f = await fixture({ catalog: completeCatalog });
    const result = (await f.create().activate({ ...input, action: 'activate' })).activation;
    expect(result.tests).toEqual([
      expect.objectContaining({ purpose: 'agent', modelId: 'chat-pro', status: 'verified', applied: true, errorCode: null }),
      ...verifiedPurposeRows(),
    ]);
    expect(result).toMatchObject({ status: 'ready', test: { status: 'verified' } });
    expect((await f.modelRuntime.getPublicConfiguration()).bindings.map(({ purpose }) => purpose).sort()).toEqual([...supportedPurposes].sort());
  });

  it('keeps a fresh chat-only Key incomplete while retaining every unavailable feature result', async () => {
    const f = await fixture();
    const result = (await f.create().activate({ ...input, action: 'activate' })).activation;
    expect(result).toMatchObject({ status: 'failed', test: { status: 'failed' }, errorCode: 'account_key_test_failed' });
    expect(result.tests).toEqual([
      expect.objectContaining({ purpose: 'agent', modelId: 'chat-pro', status: 'verified', applied: true, errorCode: null }),
      ...unavailablePurposeRows(),
    ]);
    expect(f.probeCalls).toEqual([]);
    expect((await f.modelRuntime.getPublicConfiguration()).bindings).toEqual([]);
  });

  it.each([
    { id: 'replacement-key' }, { actor_id: 'another-actor' }, { account_id: 'another-account' },
    { origin_product_id: 'another-product' }, { instance_id: 'another-instance' },
    { model_scope: 'selected' }, { pricing_source: 'central' }, { credential_version: 1 },
    { expires_at: '2030-01-01T00:00:00Z' },
  ])('does not configure or probe after an invalid legacy scope upgrade %j', async (scopeOverrides) => {
    const f = await fixture();
    const first = (await f.create().activate({ ...input, action: 'activate' })).activation;
    const directory = path.join(f.dataDir, 'account-key-activation');
    const filename = path.join(directory, (await fs.readdir(directory)).find((name) => name.endsWith('.json')));
    const receipt = JSON.parse(await fs.readFile(filename, 'utf8'));
    receipt.modelScope = 'selected';
    await fs.writeFile(filename, JSON.stringify(receipt));
    f.controls.scopeOverrides = scopeOverrides;
    const result = (await f.create().activate({ ...input, action: 'retest' })).activation;
    expect(result).toMatchObject({ status: 'failed', errorCode: 'account_key_scope_unavailable', key: first.key });
    expect(f.counts).toEqual({ issue: 1, discover: 1, configure: 1, probe: 1 });
  });
  it('refuses a quick-setup commit when the account changes during consumer preparation', async () => {
    const f = await fixture({ catalog: [{ id: 'chat-pro', name: 'Chat Pro', operations: ['chat'] }, { id: 'embed', name: 'Embed', operations: ['embedding'], dimensions: 2 }], prepareBindingChange: async () => { f.changeActor({ billingAccountId: 'other-account', authSession: 'other-session' }); } });
    const runtime = f.createRuntime();
    const discovery = await runtime.discover({ source: 'session', identity: owner, owner });
    const preview = await runtime.preview({ discoveryId: discovery.discoveryId, revision: 0, purposes: ['embedding'], identity: owner, owner });
    const code = await runtime.apply({ discoveryId: discovery.discoveryId, operationId: preview.operationId, revision: 0, identity: owner, owner }).then(() => null, (error) => error.code);
    expect(code).toBe('platform_session_changed');
    expect((await f.modelRuntime.getPublicConfiguration()).connections).toEqual([]);
  });
  it('uses the issued key catalog for the initial provider registration', async () => {
    const f = await fixture();
    f.controls.keyCatalog = [{ id: 'chat-pro', name: 'Chat Pro', operations: ['chat'] }, { id: 'new-chat', name: 'New Chat', operations: ['chat'] }, ...purposeCatalog];
    const result = (await f.create().activate({ ...input, action: 'activate' })).activation;
    expect(result.status).toBe('ready');
    expect(f.controls.configuredModels).toEqual([{ id: 'chat-pro', name: 'Chat Pro' }, { id: 'new-chat', name: 'New Chat' }]);
    expect(f.counts.issue).toBe(1);
    expect(f.controls.scopeRequests).toBeUndefined();
  });

  it('keeps the reviewed quick-setup model unavailable across retries when the key catalog removes it', async () => {
    const f = await fixture({ catalog: [{ id: 'chat-pro', name: 'Chat Pro', operations: ['chat'] }, { id: 'embed', name: 'Embed', operations: ['embedding'], dimensions: 2 }] });
    const runtime = f.createRuntime();
    const discovery = await runtime.discover({ source: 'session', identity: owner, owner });
    const preview = await runtime.preview({ discoveryId: discovery.discoveryId, revision: 0, purposes: ['embedding'], identity: owner, owner });
    f.controls.keyCatalog = [{ id: 'chat-pro', name: 'Chat Pro', operations: ['chat'] }, { id: 'different-embed', name: 'Different', operations: ['embedding'], dimensions: 2 }];
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(runtime.apply({ discoveryId: discovery.discoveryId, operationId: preview.operationId, revision: 0, identity: owner, owner })).rejects.toMatchObject({ code: 'model_configuration_bootstrap_model_unavailable' });
    }
    expect((await f.modelRuntime.getPublicConfiguration()).connections).toEqual([]);
    expect(f.counts.issue).toBe(1);
  });
  it('reuses the durable account key for quick setup across reopen without probing or issuing another key', async () => {
    const f = await fixture();
    const original = (await f.create().activate({ ...input, action: 'activate' })).activation;
    for (let attempt = 0; attempt < 2; attempt++) {
      const discovery = await f.createRuntime().issueKey({ identity: owner, owner });
      expect(discovery.keyLast4).toBe(original.key.last4);
      expect(discovery.models.map((model) => model.id)).toEqual(['chat-pro']);
      expect(JSON.stringify(discovery)).not.toContain(issuedKey);
    }
    expect(f.counts.issue).toBe(1);
    expect(f.counts.configure).toBe(1);
    expect(f.counts.probe).toBe(1);
  });

  it('keeps session discovery read-only and applies the same account key instead of a managed session', async () => {
    const f = await fixture({ catalog: [{ id: 'chat-pro', name: 'Chat Pro', operations: ['chat'] }, { id: 'embed', name: 'Embed', operations: ['embedding'], dimensions: 2 }] });
    const runtime = f.createRuntime();
    const discovery = await runtime.discover({ source: 'session', identity: owner, owner });
    const preview = await runtime.preview({ discoveryId: discovery.discoveryId, revision: 0, purposes: ['embedding'], identity: owner, owner });
    expect(f.counts.issue).toBe(0);
    const applied = await runtime.apply({ discoveryId: discovery.discoveryId, operationId: preview.operationId, revision: 0, identity: owner, owner });
    expect(applied.configuration.connections[0]).toMatchObject({ providerId: 'llmrouter', protocol: 'openai-compatible', baseUrl: 'https://llmrouter.quukk.com/v1' });
    expect(await f.modelRuntime.resolveBinding('embedding')).toMatchObject({ apiKey: issuedKey });
    const captured = await runtime.accountKey.captureConsumerOwner(await f.modelRuntime.resolveBinding('embedding'));
    await expect(captured.assertCurrent()).resolves.toBeUndefined();
    expect(f.counts.issue).toBe(1);
    expect(f.counts.probe).toBe(0);
    await runtime.issueKey({ identity: owner, owner });
    expect(f.counts.issue).toBe(1);
    const current = await f.modelRuntime.getPublicConfiguration();
    const connection = current.connections[0];
    await f.modelRuntime.saveConnection({ revision: current.revision, connection: { id: connection.id, name: connection.name, providerId: connection.providerId, protocol: connection.protocol, baseUrl: connection.baseUrl, apiKey: 'fixture-foreign-connection-key' } });
    await expect(captured.assertCurrent()).rejects.toMatchObject({ code: 'account_key_configuration_conflict' });
    f.changeActor({ authSession: 'replacement-session' });
    await expect(captured.assertCurrent()).rejects.toMatchObject({ code: 'platform_session_changed' });
  });
  it('registers the full chat catalog above 32 models with one dynamically scoped key', async () => {
    const catalog = [...Array.from({ length: 105 }, (_, index) => ({ id: `chat-${index}`, name: `Chat ${index}`, operations: ['chat'] })), ...purposeCatalog];
    const f = await fixture({ catalog });
    const result = (await f.create().activate({ ...input, action: 'activate' })).activation;
    expect(result.status).toBe('ready');
    expect(f.controls.issuePayload).toEqual({ name: 'SuperWagie', origin_product_id: 'superwagie', instance_id: 'fixture-instance', model_scope: 'llmrouter_available' });
    expect(f.controls.discoveryRequests[0]).toEqual({ model_scope: 'llmrouter_available' });
    expect(f.controls.configuredModels).toHaveLength(105);
    expect(f.counts.issue).toBe(1);
    expect(f.counts.probe).toBe(1);
  });

  it('upgrades a legacy key in place and accepts future models without further scope mutations', async () => {
    const f = await fixture();
    const activation = f.create();
    const first = (await activation.activate({ ...input, action: 'activate' })).activation;
    const directory = path.join(f.dataDir, 'account-key-activation');
    const filename = path.join(directory, (await fs.readdir(directory)).find((name) => name.endsWith('.json')));
    const record = JSON.parse(await fs.readFile(filename, 'utf8'));
    delete record.modelScope; delete record.pricingSource; delete record.credentialVersion;
    await fs.writeFile(filename, JSON.stringify(record));
    f.controls.keyCatalog = [{ id: 'chat-pro', name: 'Chat Pro', operations: ['chat'] }, { id: 'embed', name: 'Embed', operations: ['embedding'], dimensions: 2 }];
    const upgraded = (await activation.activate({ ...input, action: 'retest' })).activation;
    expect(upgraded.key).toEqual(first.key);
    expect(upgraded.tests.find((row) => row.purpose === 'embedding')).toMatchObject({ status: 'verified', applied: true });
    f.controls.keyCatalog.push({ id: 'new-chat', name: 'New Chat', operations: ['chat'] });
    await activation.activate({ ...input, action: 'retest' });
    expect(f.controls.scopeRequests).toEqual([{ model_scope: 'llmrouter_available', origin_product_id: 'superwagie', instance_id: 'fixture-instance' }]);
    expect(f.controls.configuredModels).toEqual([{ id: 'chat-pro', name: 'Chat Pro' }, { id: 'new-chat', name: 'New Chat' }]);
    expect(f.counts.issue).toBe(1);
    expect(JSON.parse(await fs.readFile(filename, 'utf8'))).toMatchObject({ modelScope: 'llmrouter_available', pricingSource: 'llmrouter_native', credentialVersion: 2 });
  });

  it('does not label native models applied when the native selection adapter is missing', async () => {
    const f = await fixture();
    delete f.provider.selectConfiguredModel;
    const result = (await f.create().activate({ ...input, action: 'activate' })).activation;
    expect(result.status).not.toBe('ready');
    expect(result.tests[0]).toMatchObject({ status: 'verified', applied: false, errorCode: null, applicationError: { status: 'failed', errorCode: 'account_key_test_failed' } });
  });

  it('applies the current native default and auxiliary models only after their actual probes', async () => {
    const catalog = ['chat-pro', 'chosen', 'small'].map((id) => ({ id, name: id, operations: ['chat'] }));
    const f = await fixture({ catalog });
    f.provider.readConfiguredModels = async () => ({ models: [{ id: 'native-agent', purpose: 'agent', providerId: 'old', modelId: 'chosen' }, { id: 'native-auxiliary', purpose: 'auxiliary', providerId: 'old', modelId: 'small' }], settings: {}, nativeSelections: { agent: null, auxiliary: null } });
    const result = (await f.create().activate({ ...input, action: 'activate' })).activation;
    expect(f.controls.issuedModels).toEqual([]);
    expect(f.controls.selected).toEqual({ agent: 'chosen', auxiliary: 'small' });
    expect(result.tests).toEqual(expect.arrayContaining([expect.objectContaining({ purpose: 'agent', modelId: 'chosen', applied: true }), expect.objectContaining({ purpose: 'auxiliary', modelId: 'small', applied: true })]));
  });

  it('replaces unavailable native choices with tested key models without issuing another key', async () => {
    const f = await fixture({ catalog: completeCatalog });
    f.provider.readConfiguredModels = async () => ({ models: [
      { id: 'native-agent', purpose: 'agent', providerId: 'existing', modelId: 'existing-agent' },
      { id: 'native-auxiliary', purpose: 'auxiliary', providerId: 'existing', modelId: 'existing-small' },
    ], settings: { defaultModel: 'existing/existing-agent', smallModelUseDefault: false, smallModelOverride: 'existing/existing-small' }, nativeSelections: { agent: null, auxiliary: null } });
    const activation = f.create();
    for (const action of ['activate', 'retest']) {
      const result = (await activation.activate({ ...input, action })).activation;
      expect(result.status).toBe('ready');
      expect(result.tests).toEqual([
        expect.objectContaining({ purpose: 'agent', modelId: 'chat-pro', status: 'verified', applied: true, errorCode: null }),
        expect.objectContaining({ purpose: 'auxiliary', modelId: 'chat-pro', status: 'verified', applied: true, errorCode: null }),
        ...verifiedPurposeRows(),
      ]);
      expect(f.controls.selected).toEqual({ agent: 'chat-pro', auxiliary: 'chat-pro' });
    }
    expect(f.counts.probe).toBe(4);
    expect(f.counts.issue).toBe(1);
    expect(f.controls.issuedModels).toEqual([]);
    expect(f.controls.scopeRequests).toBeUndefined();
  });

  it('selects and tests key models for explicitly unconfigured native purposes', async () => {
    const f = await fixture();
    f.provider.readConfiguredModels = async () => ({ models: [
      { id: 'native-agent', purpose: 'agent', providerId: null, modelId: null, errorCode: 'model_configuration_account_model_unconfigured' },
      { id: 'native-auxiliary', purpose: 'auxiliary', providerId: null, modelId: null, errorCode: 'model_configuration_account_model_unconfigured' },
    ], settings: {}, nativeSelections: { agent: null, auxiliary: null } });
    const result = (await f.create().activate({ ...input, action: 'activate' })).activation;
    expect(result.tests).toEqual([
      expect.objectContaining({ purpose: 'agent', modelId: 'chat-pro', status: 'verified', applied: true }),
      expect.objectContaining({ purpose: 'auxiliary', modelId: 'chat-pro', status: 'verified', applied: true }),
      ...unavailablePurposeRows(),
    ]);
    expect(f.controls.selected).toEqual({ agent: 'chat-pro', auxiliary: 'chat-pro' });
    expect(f.counts.probe).toBe(2);
  });

  it('preserves a native selection changed after discovery and does not probe or apply that row', async () => {
    const f = await fixture();
    let modelId = 'old-native';
    f.provider.readConfiguredModels = async () => ({ models: [{ id: 'native-agent', purpose: 'agent', providerId: 'old', modelId }], settings: { defaultModel: `old/${modelId}` }, nativeSelections: { agent: null, auxiliary: null } });
    const originalConfigure = f.provider.configure;
    f.provider.configure = async (request) => { await originalConfigure(request); modelId = 'new-user-choice'; };
    const result = (await f.create().activate({ ...input, action: 'activate' })).activation;
    expect(result.tests[0]).toMatchObject({ status: 'skipped', errorCode: 'account_key_configuration_conflict', applied: false });
    expect(f.controls.selected).toBeUndefined();
    expect(f.counts.probe).toBe(0);
  });

  it('applies both native purposes when provider registration changes only the inferred free defaults', async () => {
    const f = await fixture({ catalog: completeCatalog });
    let inferredModel = 'big-pickle';
    f.provider.readConfiguredModels = async () => ({
      models: ['agent', 'auxiliary'].map((purpose) => ({ id: `native-${purpose}`, purpose, providerId: 'opencode', modelId: inferredModel })),
      settings: {}, nativeSelections: { agent: null, auxiliary: null },
    });
    const configure = f.provider.configure;
    f.provider.configure = async (request) => { await configure(request); inferredModel = 'flint-35-free'; };
    const select = f.provider.selectConfiguredModel;
    f.provider.selectConfiguredModel = async (request, target) => {
      expect(target.expectedNativeSelections).toEqual({ agent: null, auxiliary: null });
      await select(request, target);
    };
    const result = (await f.create().activate({ ...input, action: 'activate' })).activation;
    expect(result.status).toBe('ready');
    expect(result.tests).toEqual([
      expect.objectContaining({ purpose: 'agent', modelId: 'chat-pro', status: 'verified', applied: true }),
      expect.objectContaining({ purpose: 'auxiliary', modelId: 'chat-pro', status: 'verified', applied: true }),
      ...verifiedPurposeRows(),
    ]);
    expect(f.controls.selected).toEqual({ agent: 'chat-pro', auxiliary: 'chat-pro' });
    expect(f.counts.probe).toBe(2);
    expect(f.counts.issue).toBe(1);
  });

  it.each(['agent', 'title', 'inherited-agent', 'app-agent', 'app-auxiliary'])('preserves an explicit %s edit made after discovery without blocking unrelated purposes', async (change) => {
    const f = await fixture({ catalog: completeCatalog });
    const nativeSelections = { agent: { providerID: 'old', modelID: 'chat' }, auxiliary: change === 'inherited-agent' ? null : { providerID: 'old', modelID: 'small' } };
    const settings = {};
    f.provider.readConfiguredModels = async () => structuredClone({
      models: [{ id: 'native-agent', purpose: 'agent', providerId: 'old', modelId: 'chat' }, { id: 'native-auxiliary', purpose: 'auxiliary', providerId: 'old', modelId: 'small' }],
      settings, nativeSelections,
    });
    const configure = f.provider.configure;
    f.provider.configure = async (request) => {
      await configure(request);
      if (change === 'title') nativeSelections.auxiliary = { providerID: 'user', modelID: 'new-small' };
      else if (change === 'app-agent') settings.defaultModel = 'user/new-default';
      else if (change === 'app-auxiliary') Object.assign(settings, { smallModelUseDefault: false, smallModelOverride: 'user/new-small' });
      else nativeSelections.agent = { providerID: 'user', modelID: 'new-default' };
    };
    const result = (await f.create().activate({ ...input, action: 'activate' })).activation;
    const blocked = change === 'inherited-agent' ? ['agent', 'auxiliary'] : [change === 'title' || change === 'app-auxiliary' ? 'auxiliary' : 'agent'];
    for (const purpose of blocked) {
      expect(result.tests.find((row) => row.purpose === purpose)).toMatchObject({ status: 'skipped', applied: false, errorCode: 'account_key_configuration_conflict' });
      expect(f.controls.selected?.[purpose]).toBeUndefined();
    }
    expect(result.tests.filter((row) => supportedPurposes.includes(row.purpose))).toEqual(verifiedPurposeRows());
    expect(f.counts.probe).toBe(2 - blocked.length);
  });

  it('refuses an unreadable explicit native configuration before issuing or probing a Key', async () => {
    const f = await fixture();
    f.provider.readConfiguredModels = async () => { throw Object.assign(new Error('model_configuration_account_provider_unavailable'), { code: 'model_configuration_account_provider_unavailable' }); };
    await expect(f.create().activate({ ...input, action: 'activate' })).rejects.toMatchObject({ code: 'model_configuration_account_provider_unavailable' });
    expect(f.counts).toEqual({ issue: 0, configure: 0, probe: 0, discover: 0 });
    expect((await f.modelRuntime.getPublicConfiguration()).connections).toEqual([]);
  });

  it.each(['model_configuration_account_runtime_required', 'model_configuration_account_runtime_unavailable'])('refuses fresh setup with %s before issuance or inference', async (code) => {
    const f = await fixture();
    f.provider.readConfiguredModels = async () => { throw Object.assign(new Error(code), { code }); };
    await expect(f.create().activate({ ...input, action: 'activate' })).rejects.toMatchObject({ code });
    expect(f.counts).toEqual({ issue: 0, configure: 0, probe: 0, discover: 0 });
    expect(f.probeCalls).toEqual([]);
    expect((await f.modelRuntime.getPublicConfiguration()).connections).toEqual([]);
  });

  it.each(['model_configuration_account_runtime_required', 'model_configuration_account_runtime_unavailable'])('retains an existing Key and the safe %s reason across read, resume and retest refusals', async (code) => {
    const f = await fixture({ catalog: completeCatalog });
    const initial = (await f.create().activate({ ...input, action: 'activate' })).activation;
    const before = { counts: { ...f.counts }, probes: f.probeCalls.length };
    const refusal = Object.assign(new Error('fixture-private-runtime-detail'), { code });
    f.controls.verifyError = refusal;
    f.provider.readConfiguredModels = async () => { throw refusal; };
    const refused = (await f.create().read(input)).activation;
    expect(refused).toMatchObject({ status: 'failed', stage: 'configure', errorCode: code, key: initial.key });
    for (const action of ['activate', 'resume', 'retest']) {
      const result = (await f.create().activate({ ...input, action })).activation;
      expect(result).toMatchObject({ status: 'failed', stage: 'configure', errorCode: code, key: initial.key });
      expect(JSON.stringify(result)).not.toMatch(/fixture-private-runtime-detail|fixture-account-key/);
    }
    expect((await f.create().read(input)).activation).toMatchObject({ errorCode: code, key: initial.key });
    expect(f.counts).toEqual(before.counts);
    expect(f.probeCalls).toHaveLength(before.probes);
  });

  it.each(['model_configuration_account_runtime_required', 'model_configuration_account_runtime_unavailable'])('keeps %s visible when the runtime refuses after a Key was safely issued', async (code) => {
    const f = await fixture();
    f.controls.configureError = Object.assign(new Error('fixture-private-runtime-detail'), { code });
    const first = (await f.create().activate({ ...input, action: 'activate' })).activation;
    expect(first).toMatchObject({ status: 'failed', stage: 'configure', errorCode: code, key: { id: 'key-1', last4: '7890' } });
    for (const action of ['resume', 'retest']) {
      const result = (await f.create().activate({ ...input, action })).activation;
      expect(result).toMatchObject({ errorCode: code, key: first.key });
    }
    expect(f.counts.issue).toBe(1);
    expect(f.counts.probe).toBe(0);
    expect(f.probeCalls).toEqual([]);
  });

  it.each(['model_configuration_account_runtime_required', 'model_configuration_account_runtime_unavailable'])('preserves %s before probe planning without dispatching any inference', async (code) => {
    const f = await fixture({ catalog: completeCatalog });
    let configured = false;
    const configure = f.provider.configure;
    f.provider.configure = async (request) => { await configure(request); configured = true; };
    f.provider.readConfiguredModels = async () => {
      if (configured) throw Object.assign(new Error('fixture-private-runtime-detail'), { code });
      return { models: [], settings: {}, nativeSelections: { agent: null, auxiliary: null } };
    };
    const result = (await f.create().activate({ ...input, action: 'activate' })).activation;
    expect(result).toMatchObject({ status: 'unknown', stage: 'test', errorCode: code, key: { id: 'key-1' }, test: { status: 'unknown', errorCode: code } });
    expect(result.tests).toEqual([]);
    expect(f.counts.issue).toBe(1);
    expect(f.counts.probe).toBe(0);
    expect(f.probeCalls).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('fixture-private-runtime-detail');
  });

  it.each(['model_configuration_account_runtime_required', 'model_configuration_account_runtime_unavailable'])('preserves %s in the row and aggregate when the native probe refuses', async (code) => {
    const f = await fixture();
    f.controls.probeError = Object.assign(new Error('fixture-private-runtime-detail'), { code });
    const result = (await f.create().activate({ ...input, action: 'activate' })).activation;
    expect(result).toMatchObject({ errorCode: code, key: { id: 'key-1' }, test: { errorCode: code } });
    expect(result.tests[0]).toMatchObject({ errorCode: code, applied: false });
    expect(f.controls.selected).toBeUndefined();
    expect(f.probeCalls).toEqual([]);
    expect(f.counts.issue).toBe(1);
    expect((await f.create().read(input)).activation).toEqual(result);
    expect(JSON.stringify(result)).not.toContain('fixture-private-runtime-detail');
  });

  it('keeps a blocked embedding unapplied while applying an independent reranker after both probes pass', async () => {
    const legacyModels = [{ purpose: 'embedding', modelId: 'indexed-old-model', parameters: { dimensions: 4 } }];
    const f = await fixture({ catalog: [
      { id: 'chat-pro', name: 'Chat', operations: ['chat'] },
      { id: 'embed', name: 'Embed', operations: ['embedding'], dimensions: 2 },
      { id: 'rerank', name: 'Rerank', operations: ['rerank'] },
    ], legacyModels, prepareBindingChange: async (purpose, next) => {
      if (purpose === 'embedding') {
        expect(next).toMatchObject({ model: 'embed', parameters: { dimensions: 2 } });
        throw Object.assign(new Error('preserve index'), { code: 'model_configuration_embedding_rebuild_required' });
      }
    } });
    const result = (await f.create().activate({ ...input, action: 'activate' })).activation;
    expect(result).toMatchObject({ status: 'failed' });
    const embedding = result.tests.find((row) => row.purpose === 'embedding');
    expect(embedding).toMatchObject({ status: 'verified', errorCode: null, testedAt: expect.any(String), applied: false, applicationError: { status: 'failed', errorCode: 'model_configuration_embedding_rebuild_required' } });
    expect(result.tests.find((row) => row.purpose === 'rerank')).toMatchObject({ status: 'verified', applied: true });
    expect(await f.modelRuntime.resolveBinding('embedding')).toBeNull();
    expect(legacyModels).toEqual([{ purpose: 'embedding', modelId: 'indexed-old-model', parameters: { dimensions: 4 } }]);
    expect(await f.modelRuntime.resolveBinding('rerank')).toMatchObject({ apiKey: issuedKey, model: 'rerank' });
    expect(f.probeCalls).toHaveLength(2);
    expect((await f.create().read(input)).activation.tests.find((row) => row.purpose === 'embedding')).toEqual(embedding);
  });

  it('uses newly enabled models without another scope update or a replacement key', async () => {
    const f = await fixture();
    await f.create().activate({ ...input, action: 'activate' });
    f.controls.catalog = completeCatalog;
    f.controls.keyCatalog = f.controls.catalog;
    const result = (await f.create().activate({ ...input, action: 'retest' })).activation;
    expect(f.controls.scopeRequests).toBeUndefined();
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
    const directory = path.join(f.dataDir, 'account-key-activation');
    const filename = path.join(directory, (await fs.readdir(directory)).find((name) => name.endsWith('.json')));
    const receipt = JSON.parse(await fs.readFile(filename, 'utf8'));
    receipt.modelScope = 'selected';
    await fs.writeFile(filename, JSON.stringify(receipt));
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
    expect(result.tests.find((row) => row.purpose === 'embedding')).toMatchObject({ status: 'verified', errorCode: null, applied: false, applicationError: { status: 'unknown', errorCode: 'account_key_configuration_conflict' } });
    expect(result.status).toBe('unknown');
    expect(await f.modelRuntime.resolveBinding('embedding')).toBeNull();
    expect(f.probeCalls.filter((call) => call.url.endsWith('/embeddings'))).toHaveLength(1);
    expect(result.tests.find((row) => row.purpose === 'rerank')).toMatchObject({ status: 'verified', applied: true });
    expect(await f.modelRuntime.resolveBinding('rerank')).toMatchObject({ connectionId: result.connectionId, apiKey: issuedKey });
  });

  it('ignores a legacy catalog snapshot above 32 when refreshing a dynamic key', async () => {
    const f = await fixture();
    await f.create().activate({ ...input, action: 'activate' });
    const directory = path.join(f.dataDir, 'account-key-activation');
    const filename = path.join(directory, (await fs.readdir(directory)).find((name) => name.endsWith('.json')));
    const record = JSON.parse(await fs.readFile(filename, 'utf8'));
    record.models = [...record.models, ...Array.from({ length: 31 }, (_, index) => ({ id: `old-${index}`, name: `Old ${index}` }))];
    await fs.writeFile(filename, JSON.stringify(record));
    f.controls.catalog = completeCatalog;
    f.controls.keyCatalog = f.controls.catalog;
    const result = (await f.create().activate({ ...input, action: 'retest' })).activation;
    expect(result).toMatchObject({ status: 'ready', errorCode: null });
    expect(f.controls.scopeRequests).toBeUndefined();
    expect(f.counts.issue).toBe(1);
    expect(f.probeCalls.map(({ url }) => new URL(url).pathname).sort()).toEqual([
      '/v1/audio/speech', '/v1/chat/completions', '/v1/embeddings', '/v1/images/generations',
      '/v1/ocr', '/v1/ocr/uk_fixture-task', '/v1/ocr/uk_fixture-task/document', '/v1/rerank',
    ]);
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
    f.controls.catalog = [...['chat-pro', 'second', 'third'].map((id) => ({ id, name: id === 'chat-pro' ? 'Chat Pro' : id, operations: ['chat'] })), ...purposeCatalog];
    f.controls.keyCatalog = f.controls.catalog;
    f.provider.readConfiguredModels = async () => ({ models: [{ id: 'native-agent', purpose: 'agent', modelId: 'third', providerId: 'old' }], settings: {}, nativeSelections: { agent: null, auxiliary: null } });
    const result = (await f.create().activate({ ...input, action: 'resume' })).activation;
    expect(result.status).toBe('ready');
    expect(installed).toEqual(['chat-pro', 'second', 'third']);
    expect(f.controls.scopeRequests).toBeUndefined();
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
    const f = await fixture({ catalog: completeCatalog });
    const runtime = f.create();
    expect(runtime).toBeDefined();
    expect(await runtime.read(input)).toMatchObject({ accountId: 'account-1', enterpriseMode: false, activation: null });
    const result = await runtime.activate({ ...input, action: 'activate' });
    expect(result.activation).toMatchObject({ status: 'ready', stage: 'test', key: { id: 'key-1', last4: '7890' }, modelId: 'chat-pro', test: { status: 'verified' }, actions: ['retest'] });
    expect(JSON.stringify(result)).not.toMatch(/fixture-account-key|secretRef|actor_id|llmrouter|unihub/i);
    const configuration = await f.modelRuntime.getPublicConfiguration();
    expect(configuration.bindings.map(({ purpose }) => purpose).sort()).toEqual([...supportedPurposes].sort());
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
    { instance_id: 'other-instance' }, { id: undefined }, { token: undefined }, { token: 'abcd' }, { model_scope: 'selected' }, { pricing_source: 'central' }, { credential_version: 0 },
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

  it('resumes a committed connection after native setup failure and applies supported bindings', async () => {
    const f = await fixture({ catalog: completeCatalog });
    f.controls.configureError = new Error('setup unavailable');
    expect((await f.create().activate({ ...input, action: 'activate' })).activation).toMatchObject({ status: 'failed', stage: 'configure', actions: ['resume'] });
    const before = await f.modelRuntime.getPublicConfiguration();
    expect(before.connections).toHaveLength(1);
    f.controls.configureError = null;
    expect((await f.create().activate({ ...input, action: 'resume' })).activation.status).toBe('ready');
    const configured = await f.modelRuntime.getPublicConfiguration();
    expect(configured.connections).toEqual(before.connections);
    expect(configured.bindings.map(({ purpose }) => purpose).sort()).toEqual([...supportedPurposes].sort());
    expect(configured.bindings.every((binding) => binding.connectionId === before.connections[0].id)).toBe(true);
    expect(f.counts.issue).toBe(1);
  });

  it('requires explicit retest after a failed or uncertain paid request', async () => {
    const f = await fixture({ catalog: completeCatalog });
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
    const f = await fixture({ catalog: completeCatalog }); await f.create().activate({ ...input, action: 'activate' });
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
    const f = await fixture({ catalog: completeCatalog }); await f.create().activate({ ...input, action: 'activate' });
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
    const f = await fixture({ catalog: completeCatalog }); const app = express();
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
    const f = await fixture({ catalog: completeCatalog }); f.controls.accessExpired = true;
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
    const f = await fixture({ catalog: completeCatalog }); f.controls.configureWait = deferred(); f.controls.configureStarted = deferred();
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
    const f = await fixture({ catalog: completeCatalog }); await f.create().activate({ ...input, action: 'activate' });
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

  it('grants the catalog while probing only selected purposes and preserving binding verification', async () => {
    const f = await fixture({ catalog: multimodalCatalog });
    const result = (await f.create().activate({ ...input, action: 'activate' })).activation;
    expect(f.controls.issuedModels).toEqual([]);
    expect(result.testRunId).toEqual(expect.any(String));
    expect(result.tests.filter((row) => row.status === 'verified').map((row) => row.purpose).sort()).toEqual(['agent', 'embedding', 'image-generation', 'rerank', 'vision']);
    expect(result.tests.filter((row) => ['ocr', 'tts'].includes(row.purpose))).toEqual(unavailablePurposeRows().filter((row) => ['ocr', 'tts'].includes(row.purpose)));
    expect(result).toMatchObject({ status: 'failed', errorCode: 'account_key_test_failed' });
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

  it('selects and applies compatible image and vision replacements from the issued key catalog', async () => {
    const f = await fixture({ catalog: completeCatalog, legacyModels: [{ purpose: 'vision', modelId: 'chat-pro', parameters: {} }] });
    const connected = await f.modelRuntime.saveConnection({ revision: 0, connection: { name: 'Existing', providerId: 'existing', protocol: 'openai-compatible', baseUrl: 'https://existing.example/v1', apiKey: 'fixture-existing-key' } });
    await f.modelRuntime.saveBinding('image-generation', { revision: connected.revision, binding: { connectionId: connected.connections[0].id, model: 'retired-image', parameters: {} } });
    const result = (await f.create().activate({ ...input, action: 'activate' })).activation;
    expect(result.status).toBe('ready');
    for (const [purpose, modelId] of [['image-generation', 'image'], ['vision', 'vision']]) {
      expect(result.tests.find((row) => row.purpose === purpose)).toMatchObject({ modelId, status: 'verified', applied: true });
      expect(await f.modelRuntime.resolveBinding(purpose)).toMatchObject({ model: modelId, connectionId: result.connectionId, apiKey: issuedKey });
    }
    expect(f.probeCalls.filter((call) => call.url.endsWith('/images/generations')).map((call) => call.body.model)).toEqual(['image']);
    expect(f.probeCalls.filter((call) => call.url.endsWith('/chat/completions')).map((call) => call.body.model)).toEqual(['vision']);
  });

  it('replaces unavailable feature models while keeping unreadable selections incomplete', async () => {
    const f = await fixture({ catalog: multimodalCatalog, legacyModels: [{ purpose: 'embedding', modelId: 'legacy-index-model' }, { purpose: 'vision', modelId: null, errorCode: 'account_key_existing_configuration_unknown' }] });
    const connected = await f.modelRuntime.saveConnection({ revision: 0, connection: { name: 'Existing', providerId: 'existing', protocol: 'openai-compatible', baseUrl: 'https://existing.example/v1', apiKey: 'fixture-existing-key' } });
    await f.modelRuntime.saveBinding('rerank', { revision: connected.revision, binding: { connectionId: connected.connections[0].id, model: 'existing-reranker', parameters: {} } });
    const result = (await f.create().activate({ ...input, action: 'activate' })).activation;
    expect(f.controls.issuedModels).toEqual([]);
    expect(result.tests.find((row) => row.purpose === 'embedding')).toMatchObject({ status: 'verified', modelId: 'embed', applied: true, errorCode: null });
    expect(result.tests.find((row) => row.purpose === 'vision')).toMatchObject({ status: 'skipped', modelId: null, errorCode: 'account_key_existing_configuration_unknown' });
    expect(result.tests.find((row) => row.purpose === 'rerank')).toMatchObject({ status: 'verified', modelId: 'rerank', applied: true, errorCode: null });
    expect(await f.modelRuntime.resolveBinding('rerank')).toMatchObject({ connectionId: result.connectionId, model: 'rerank', apiKey: issuedKey });
    expect(f.probeCalls.some((call) => call.url === 'https://existing.example/v1/rerank')).toBe(false);
    expect(f.probeCalls.some((call) => call.url.endsWith('/rerank'))).toBe(true);
    expect(result.tests.filter((row) => row.status === 'verified').map((row) => row.purpose).sort()).toEqual(['agent', 'embedding', 'image-generation', 'rerank']);
  });

  it('limits actual dispatch to three and exposes durable queued, running, and terminal rows while a batch is pending', async () => {
    const f = await fixture({ catalog: completeCatalog });
    f.controls.probeWait = deferred(); f.controls.modelProbeWait = deferred(); f.controls.modelProbeStarted = deferred();
    const pending = f.create().activate({ ...input, action: 'activate' });
    await f.controls.modelProbeStarted.promise;
    for (let attempt = 0; attempt < 100 && f.probeCalls.length < 2; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
    const running = (await f.create().read(input)).activation;
    expect(f.counts.probe + f.probeCalls.length).toBe(3);
    expect(running.status).toBe('testing');
    expect(running.tests.filter((row) => row.status === 'testing')).toHaveLength(3);
    expect(running.tests.filter((row) => row.status === 'queued')).toHaveLength(4);
    f.controls.probeWait.resolve();
    for (let attempt = 0; attempt < 100 && f.probeCalls.length < 3; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
    const partial = (await f.create().read(input)).activation;
    expect(partial.tests.find((row) => row.id === 'account-chat').status).toBe('verified');
    expect(partial.testRunId).toBe(running.testRunId);
    f.controls.modelProbeWait.resolve();
    const complete = (await pending).activation;
    expect(complete.status).toBe('ready');
    expect(complete.tests.filter((row) => row.status === 'verified')).toHaveLength(7);
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
    record.status = 'ready'; record.errorCode = null;
    record.test = { status: 'verified', testedAt: '2026-11-06T00:01:00.000Z', errorCode: null };
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
    expect(result.tests.filter((row) => row.purpose !== 'agent')).toEqual(unavailablePurposeRows());
    expect(result).toMatchObject({ status: 'failed', errorCode: 'account_key_test_failed' });
    expect(f.counts).toEqual({ issue: 1, configure: 2, probe: 2, discover: 1 });
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
    expect(result.tests.find((row) => row.id === 'native-auxiliary')).toMatchObject({ modelId: 'chat-pro', status: 'verified', applied: true });
    expect(nativeCalls).toBe(0);
    expect(f.counts.probe).toBe(1);
    expect(f.controls.selected).toEqual({ auxiliary: 'chat-pro' });
  });

  it('replaces an unavailable auxiliary model through the same key without invoking the foreign provider', async () => {
    const f = await fixture();
    f.provider.planTests = async ({ providerId, modelId }) => [
      { id: 'native-agent', purpose: 'agent', providerId: 'foreign-provider', modelId },
      { id: 'native-auxiliary', purpose: 'auxiliary', providerId, modelId: 'unissued-model' },
    ];
    let nativeCalls = 0;
    f.provider.probeConfiguredModel = async () => { nativeCalls++; throw new Error('Foreign models cannot be probed'); };
    const result = (await f.create().activate({ ...input, action: 'activate' })).activation;
    expect(result.tests).toEqual([expect.objectContaining({ id: 'account-chat', modelId: 'chat-pro', status: 'verified' }), expect.objectContaining({ id: 'native-auxiliary', modelId: 'chat-pro', status: 'verified', applied: true, errorCode: null }), ...unavailablePurposeRows()]);
    expect(nativeCalls).toBe(0);
    expect(f.counts.probe).toBe(2);
    expect(f.controls.selected).toEqual({ agent: 'chat-pro', auxiliary: 'chat-pro' });
    expect(JSON.stringify(result)).not.toContain('foreign-provider');
  });

  it('replaces a saved binding whose model is absent with a tested compatible key model', async () => {
    const f = await fixture({ catalog: multimodalCatalog.slice(0, 3) });
    const initial = (await f.create().activate({ ...input, action: 'activate' })).activation;
    const configuration = await f.modelRuntime.getPublicConfiguration();
    await f.modelRuntime.saveBinding('embedding', { revision: configuration.revision, binding: { connectionId: initial.connectionId, model: 'unissued-model', parameters: {} } });
    const before = f.probeCalls.length;
    const result = (await f.create().activate({ ...input, action: 'retest' })).activation;
    expect(result.tests.find((row) => row.purpose === 'embedding')).toMatchObject({ status: 'verified', modelId: 'embed', applied: true, errorCode: null });
    expect(f.probeCalls).toHaveLength(before + 1);
    expect(await f.modelRuntime.resolveBinding('embedding')).toMatchObject({ model: 'embed', apiKey: issuedKey, parameters: { dimensions: 2 } });
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
