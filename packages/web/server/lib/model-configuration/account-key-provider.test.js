import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { createAccountKeyProvider } from './account-key-provider.js';

const absentPolicy = () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); };
const providerId = 'superwagie-account-fixture-operation';
const key = 'fixture-private-key';
const baseUrl = 'https://inference.example.test/v1';
const modelId = 'fixture-chat';
const input = { providerId, name: 'SuperWagie', apiKey: key, baseUrl, models: [{ id: modelId, name: 'Fixture chat' }], modelId };
const emptyNativeSelections = () => ({ agent: null, auxiliary: null });

const fixture = (overrides = {}) => {
  const state = { runtime: {}, config: null, configEntries: [{ type: 'document', info: {} }], credentials: {}, calls: [], current: true, enabled: false, settings: {}, defaultModel: { providerID: 'existing', id: 'chat' }, titleModel: undefined, nativeModels: [{ providerID: 'existing', id: 'chat', enabled: true, variants: [] }], generate: async () => ({ text: 'OK' }) };
  const assertCurrent = async () => {
    if (!state.current) throw Object.assign(new Error('platform_account_selection_changed'), { code: 'platform_account_selection_changed', status: 409 });
  };
  const client = {
    config: { get: async () => structuredClone(state.configEntries) },
    model: {
      default: async () => ({ data: state.defaultModel }),
      list: async () => ({ data: state.nativeModels }),
    },
    agent: { get: async ({ agentID }) => { expect(agentID).toBe('title'); return { data: { id: 'title', model: state.titleModel } }; } },
    integration: {
      get: async () => ({ data: { methods: [{ type: 'key' }] } }),
      connect: { key: async (request) => {
        state.calls.push(['key', request]);
        state.credentials[request.integrationID] = { type: 'api', key: request.key };
      } },
    },
    experimental: { generate: { text: async (...args) => { state.calls.push(['generate', ...args]); return state.generate(...args); } } },
  };
  const helper = createAccountKeyProvider({
    env: { OPENCHAMBER_LLMROUTER_API_URL: baseUrl },
    enterpriseOptions: { env: {}, readFile: () => state.enabled ? '{"enterpriseMode":true}' : absentPolicy() },
    assertRuntime: () => state.runtime,
    getDefaultDirectory: () => '/fixture/current-project',
    getOpenCodeClient: (directory) => { state.calls.push(['client', directory]); return client; },
    readProviderConfig: async (id, directory) => { state.calls.push(['read-config', id, directory]); return { config: state.config, blocked: false }; },
    upsertProviderConfig: (id, config, directory, scope, options) => { state.calls.push(['config', id, config, directory, scope, options]); state.config = structuredClone(config); },
    readOpenCodeCredentials: async () => { state.calls.push(['read-key']); return state.credentials; },
    readSettings: async () => state.settings,
    writeSettings: async (changes, assertCurrent) => { await assertCurrent(); state.calls.push(['settings', changes]); state.settings = { ...state.settings, ...changes }; },
    wait: async () => {},
    now: () => '2026-11-06T08:00:00.000Z',
    ...overrides,
  });
  return { helper, state, client, configure: () => helper.configure({ ...input, assertCurrent }), probe: () => helper.probe({ ...input, assertCurrent }), assertCurrent };
};

const preparedFixture = async () => {
  const value = fixture();
  await value.configure();
  value.state.calls.length = 0;
  return value;
};

describe('account key native provider', () => {
  it.each(['readConfiguredModels', 'configure', 'verify', 'probe', 'planTests', 'selectConfiguredModel', 'verifyConfiguredModel', 'probeConfiguredModel'])('refuses %s without the current owned runtime before any native IO', async (action) => {
    const { helper, state, assertCurrent } = await preparedFixture();
    state.runtime = null;
    await expect(helper[action]({ ...input, assertCurrent }, {
      id: 'native-agent', purpose: 'agent', providerId, modelId,
      expectedSettings: {}, expectedNativeSelections: emptyNativeSelections(),
    })).rejects.toMatchObject({ code: 'model_configuration_account_runtime_unavailable' });
    expect(state.calls).toEqual([]);
  });

  it.each([undefined, () => { throw new Error('fixture-private-runtime-path'); }])('refuses a missing or failed runtime assertion without exposing its details', async (assertRuntime) => {
    const { helper, state, assertCurrent } = fixture({ assertRuntime });
    await expect(helper.readConfiguredModels({ assertCurrent })).rejects.toMatchObject({ code: 'model_configuration_account_runtime_unavailable', message: 'model_configuration_account_runtime_unavailable' });
    expect(state.calls).toEqual([]);
  });

  it.each(['model_configuration_account_runtime_required', 'model_configuration_account_runtime_unavailable'])('preserves the safe %s runtime refusal while discarding private details', async (code) => {
    const { helper, state, assertCurrent } = fixture({ assertRuntime: () => { throw Object.assign(new Error('fixture-private-runtime-path'), { code }); } });
    await expect(helper.readConfiguredModels({ assertCurrent })).rejects.toMatchObject({ code, message: code });
    await expect(helper.configure({ ...input, assertCurrent })).rejects.toMatchObject({ code, message: code });
    expect(state.calls).toEqual([]);
  });

  it.each(['unavailable', 'replacement'])('stops configuration when the runtime becomes %s during its provider read', async (change) => {
    let state;
    let reads = 0;
    const f = fixture({ readProviderConfig: async () => {
      reads++;
      state.runtime = change === 'replacement' ? {} : null;
      return { config: null, blocked: false };
    } });
    state = f.state;
    await expect(f.configure()).rejects.toMatchObject({ code: 'model_configuration_account_runtime_unavailable' });
    expect(reads).toBe(1);
    expect(state.calls).toEqual([]);
    expect(state.config).toBeNull();
    expect(state.credentials).toEqual({});
  });

  it('refuses a model snapshot if its settings read crosses a runtime replacement', async () => {
    let state;
    const f = fixture({ readSettings: async () => { state.runtime = {}; return {}; } });
    state = f.state;
    let configReads = 0;
    f.client.config.get = async () => { configReads++; return []; };
    await expect(f.helper.readConfiguredModels({ assertCurrent: f.assertCurrent })).rejects.toMatchObject({ code: 'model_configuration_account_runtime_unavailable' });
    expect(configReads).toBe(0);
    expect(state.calls.filter(([kind]) => ['config', 'key', 'settings', 'generate'].includes(kind))).toEqual([]);
  });

  it.each(['unavailable', 'replacement'])('checks a %s runtime again inside the settings writer before mutation', async (change) => {
    let state;
    let writes = 0;
    const f = fixture({ writeSettings: async (_changes, guard) => {
      state.runtime = change === 'replacement' ? {} : null;
      await guard();
      writes++;
    } });
    state = f.state;
    await f.configure();
    await expect(f.helper.selectConfiguredModel({ ...input, assertCurrent: f.assertCurrent }, {
      purpose: 'agent', modelId, expectedSettings: {}, expectedNativeSelections: emptyNativeSelections(),
    })).rejects.toMatchObject({ code: 'model_configuration_account_runtime_unavailable' });
    expect(writes).toBe(0);
    expect(state.settings).toEqual({});
  });

  it('rejects a late probe result after a runtime replacement without repeating generation', async () => {
    const { probe, state } = await preparedFixture();
    state.generate = async () => { state.runtime = {}; return { text: 'OK' }; };
    await expect(probe()).rejects.toMatchObject({ code: 'model_configuration_account_runtime_unavailable' });
    expect(state.calls.filter(([kind]) => kind === 'generate')).toHaveLength(1);
    expect(state.calls.some(([kind]) => ['settings', 'key'].includes(kind))).toBe(false);
  });

  it('captures only explicit native model selections while effective free defaults change', async () => {
    const { helper, state, assertCurrent } = fixture();
    const before = await helper.readConfiguredModels({ assertCurrent });
    state.defaultModel = { providerID: 'opencode', id: 'flint-35-free' };
    state.titleModel = { providerID: 'opencode', id: 'beam-free' };
    const after = await helper.readConfiguredModels({ assertCurrent });
    expect(after.models).not.toEqual(before.models);
    expect(before.nativeSelections).toEqual(emptyNativeSelections());
    expect(after.nativeSelections).toEqual(before.nativeSelections);
    expect(state.calls.some(([kind]) => ['config', 'key', 'settings', 'generate'].includes(kind))).toBe(false);
  });

  it('folds explicit native selections by document priority without retaining other configuration', async () => {
    const { helper, state, assertCurrent } = fixture();
    state.configEntries = [
      { type: 'document', info: { model: 'first/chat#high', agents: { title: { model: 'first/small' } }, providers: { private: { apiKey: key } } } },
      { type: 'directory', info: { model: 'ignored/chat', agents: { title: { model: 'ignored/small' } } } },
      { type: 'document', info: { model: { providerID: 'last', model: 'chat', variant: 'fast' } } },
    ];
    expect((await helper.readConfiguredModels({ assertCurrent })).nativeSelections).toEqual({
      agent: { providerID: 'last', modelID: 'chat', variant: 'fast' },
      auxiliary: { providerID: 'first', modelID: 'small' },
    });
    state.configEntries.push({ type: 'document', info: { agents: { title: { description: 'A higher-priority title definition' } } } });
    const snapshot = await helper.readConfiguredModels({ assertCurrent });
    expect(snapshot.nativeSelections).toEqual({ agent: { providerID: 'last', modelID: 'chat', variant: 'fast' }, auxiliary: null });
    expect(JSON.stringify(snapshot)).not.toContain(key);
  });

  it.each([
    undefined, { data: [] }, [{ type: 'document' }],
    [{ type: 'document', info: { model: 'invalid-reference' } }],
    [{ type: 'document', info: { model: null } }],
    [{ type: 'document', info: { agents: { title: { model: {} } } } }],
  ])('refuses a malformed explicit native configuration snapshot %j', async (configEntries) => {
    const { helper, state, assertCurrent } = fixture();
    state.configEntries = configEntries;
    await expect(helper.readConfiguredModels({ assertCurrent })).rejects.toMatchObject({ code: 'model_configuration_account_provider_unavailable' });
    expect(state.calls.some(([kind]) => ['config', 'key', 'settings', 'generate'].includes(kind))).toBe(false);
  });

  it('refuses failed native configuration reads before selection and during the final write guard', async () => {
    let beforeWrite = () => {};
    let writes = 0;
    const f = fixture({ writeSettings: async (_changes, guard) => { beforeWrite(); await guard(); writes++; } });
    await f.configure();
    const snapshot = await f.helper.readConfiguredModels({ assertCurrent: f.assertCurrent });
    beforeWrite = () => { f.client.config.get = async () => { throw new Error('private-native-config-detail'); }; };
    await expect(f.helper.selectConfiguredModel({ ...input, assertCurrent: f.assertCurrent }, { purpose: 'agent', modelId, expectedSettings: snapshot.settings, expectedNativeSelections: snapshot.nativeSelections })).rejects.toMatchObject({ code: 'model_configuration_account_provider_unavailable', message: 'model_configuration_account_provider_unavailable' });
    expect(writes).toBe(0);
    await expect(f.helper.readConfiguredModels({ assertCurrent: f.assertCurrent })).rejects.toMatchObject({ code: 'model_configuration_account_provider_unavailable' });
  });

  it.each(['agent', 'title', 'inherited-agent', 'title-variant'])('preserves an explicit native %s edit made while the settings write is queued', async (change) => {
    let beforeWrite = () => {};
    let writes = 0;
    const f = fixture({ writeSettings: async (_changes, guard) => { beforeWrite(); await guard(); writes++; } });
    const info = { model: 'native/original' };
    if (change.startsWith('title')) info.agents = { title: { model: 'native/small#fast' } };
    f.state.configEntries = [{ type: 'document', info }];
    await f.configure();
    const snapshot = await f.helper.readConfiguredModels({ assertCurrent: f.assertCurrent });
    beforeWrite = () => {
      if (change === 'title') info.agents.title.model = 'user/new-small';
      else if (change === 'title-variant') info.agents.title.model = 'native/small#careful';
      else info.model = 'user/new-default';
    };
    await expect(f.helper.selectConfiguredModel({ ...input, assertCurrent: f.assertCurrent }, {
      purpose: change === 'agent' ? 'agent' : 'auxiliary', modelId,
      expectedSettings: snapshot.settings, expectedNativeSelections: snapshot.nativeSelections,
    })).rejects.toMatchObject({ code: 'model_configuration_account_provider_conflict' });
    expect(writes).toBe(0);
  });

  it.each(['agent', 'auxiliary'])('preserves an explicit app %s edit made while the settings write is queued', async (purpose) => {
    let beforeWrite = () => {};
    let writes = 0;
    const f = fixture({ writeSettings: async (_changes, guard) => { beforeWrite(); await guard(); writes++; } });
    await f.configure();
    const snapshot = await f.helper.readConfiguredModels({ assertCurrent: f.assertCurrent });
    beforeWrite = () => {
      f.state.settings = purpose === 'agent' ? { defaultModel: 'user/new-default', defaultVariant: 'careful' }
        : { smallModelUseDefault: false, smallModelOverride: 'user/new-small', smallModelVariant: 'fast' };
    };
    await expect(f.helper.selectConfiguredModel({ ...input, assertCurrent: f.assertCurrent }, {
      purpose, modelId, expectedSettings: snapshot.settings, expectedNativeSelections: snapshot.nativeSelections,
    })).rejects.toMatchObject({ code: 'model_configuration_account_provider_conflict' });
    expect(writes).toBe(0);
  });

  it.each(['agent-app', 'auxiliary-app', 'auxiliary-title', 'auxiliary-app-default'])('ignores native selections outside the %s dependency when applying', async (mode) => {
    const { helper, state, assertCurrent } = await preparedFixture();
    state.configEntries = [{ type: 'document', info: { model: 'native/original' } }];
    if (mode === 'agent-app' || mode === 'auxiliary-app-default') state.settings.defaultModel = 'app/original';
    if (mode === 'auxiliary-app') state.settings = { smallModelUseDefault: false, smallModelOverride: 'app/small' };
    if (mode === 'auxiliary-title') state.configEntries[0].info.agents = { title: { model: 'native/small' } };
    const snapshot = await helper.readConfiguredModels({ assertCurrent });
    state.configEntries[0].info.model = 'native/changed';
    if (mode === 'auxiliary-app') state.configEntries[0].info.agents = { title: { model: 'native/changed-title' } };
    await helper.selectConfiguredModel({ ...input, assertCurrent }, {
      purpose: mode === 'agent-app' ? 'agent' : 'auxiliary', modelId,
      expectedSettings: snapshot.settings, expectedNativeSelections: snapshot.nativeSelections,
    });
    expect(state.calls.filter(([kind]) => kind === 'settings')).toHaveLength(1);
  });

  it('applies Agent and inherited auxiliary after a free default changes without mistaking its own Agent write for a conflict', async () => {
    const { helper, state, assertCurrent } = await preparedFixture();
    const snapshot = await helper.readConfiguredModels({ assertCurrent });
    state.defaultModel = { providerID: 'opencode', id: 'flint-35-free' };
    for (const purpose of ['agent', 'auxiliary']) {
      await helper.selectConfiguredModel({ ...input, assertCurrent }, { purpose, modelId, expectedSettings: snapshot.settings, expectedNativeSelections: snapshot.nativeSelections });
    }
    expect(state.settings).toEqual({ defaultModel: `${providerId}/${modelId}`, defaultVariant: '', smallModelUseDefault: false, smallModelOverride: `${providerId}/${modelId}`, smallModelVariant: '' });
    expect(state.calls.filter(([kind]) => kind === 'settings')).toHaveLength(2);
  });

  it('keeps a known-disabled auxiliary override readable and eligible for replacement', async () => {
    const { helper, state, assertCurrent } = fixture();
    state.settings = { smallModelUseDefault: false, smallModelOverride: 'existing/disabled' };
    state.nativeModels.push({ providerID: 'existing', id: 'disabled', enabled: false });
    const snapshot = await helper.readConfiguredModels({ assertCurrent });
    expect(snapshot.settings).toEqual(state.settings);
    expect(snapshot.models[1]).toEqual({ id: 'native-auxiliary', purpose: 'auxiliary', providerId: null, modelId: null, status: 'skipped', errorCode: 'model_configuration_account_model_unconfigured' });
    expect(snapshot.nativeSelections).toEqual(emptyNativeSelections());
  });

  it('registers native Responses, Claude and Gemini models under the same provider credential', async () => {
    const { helper, state, assertCurrent } = fixture();
    const models = [input.models[0],
      { id: 'responses', name: 'Responses', package: 'aisdk:@ai-sdk/openai' },
      { id: 'claude', name: 'Claude', package: 'aisdk:@ai-sdk/anthropic', inputModalities: ['text', 'image'] },
      { id: 'gemini', name: 'Gemini', package: 'aisdk:@ai-sdk/google' },
    ];
    await helper.configure({ ...input, models, assertCurrent });
    expect(state.calls.filter(([kind]) => kind === 'key')).toHaveLength(1);
    expect(state.config.models.responses).toMatchObject({ package: 'aisdk:@ai-sdk/openai' });
    expect(state.config.models.claude).toMatchObject({ package: 'aisdk:@ai-sdk/anthropic', capabilities: { input: ['text', 'image'] } });
    expect(state.config.models.gemini).toMatchObject({ package: 'aisdk:@ai-sdk/google', settings: { baseURL: 'https://inference.example.test/v1beta' } });
    await helper.verify({ ...input, models, assertCurrent });
  });
  it('refreshes renamed and removed catalog entries only from its exact previous snapshot', async () => {
    const { helper, state, assertCurrent } = await preparedFixture();
    const next = { ...input, modelId: 'replacement', models: [{ id: 'replacement', name: 'Replacement' }], previousModels: input.models, assertCurrent };
    await helper.configure(next);
    expect(state.config.models).toEqual({ replacement: { modelID: 'replacement', name: 'Replacement' } });
    expect(state.calls.some(([kind]) => ['key', 'settings', 'generate'].includes(kind))).toBe(false);
    state.config.models.replacement.name = 'My manual name';
    await expect(helper.configure({ ...next, models: [{ id: 'replacement', name: 'Renamed' }], previousModels: next.models })).rejects.toMatchObject({ code: 'model_configuration_account_provider_conflict' });
  });
  it('reads effective app defaults without requiring or creating an account key', async () => {
    const { helper, state, assertCurrent } = fixture();
    state.settings = { defaultModel: 'custom/chosen', defaultVariant: 'high', smallModelUseDefault: false, smallModelOverride: 'custom/small' };
    const result = await helper.readConfiguredModels({ assertCurrent });
    expect(result.models).toMatchObject([{ purpose: 'agent', providerId: 'custom', modelId: 'chosen', variant: 'high' }, { purpose: 'auxiliary', providerId: 'custom', modelId: 'small' }]);
    expect(state.calls.some(([kind]) => ['config', 'key', 'settings', 'generate'].includes(kind))).toBe(false);
  });

  it('sanitizes pre-issuance settings read failure without replacing it with an empty model plan', async () => {
    const { helper, state, assertCurrent } = fixture({ readSettings: async () => { throw new Error('fixture-private-setting-detail'); } });
    await expect(helper.readConfiguredModels({ assertCurrent })).rejects.toMatchObject({ code: 'model_configuration_account_provider_unavailable', message: 'model_configuration_account_provider_unavailable' });
    expect(state.calls.some(([kind]) => ['config', 'key', 'settings', 'generate'].includes(kind))).toBe(false);
  });

  it.each(['agent', 'auxiliary'])('switches the actual %s settings to the account key and verifies readback', async (purpose) => {
    const { helper, state, assertCurrent } = await preparedFixture();
    const selection = { purpose, modelId, expectedSettings: {}, expectedNativeSelections: emptyNativeSelections() };
    await helper.selectConfiguredModel({ ...input, assertCurrent }, selection);
    await helper.verifyConfiguredModel({ ...input, assertCurrent }, { purpose, modelId });
    expect(state.settings).toMatchObject(purpose === 'agent' ? { defaultModel: `${providerId}/${modelId}`, defaultVariant: '' } : { smallModelUseDefault: false, smallModelOverride: `${providerId}/${modelId}`, smallModelVariant: '' });
    expect(state.calls.some(([kind]) => ['key', 'generate'].includes(kind))).toBe(false);
  });

  it('refuses overwriting a changed user selection and a model outside the provider scope', async () => {
    const { helper, state, assertCurrent } = await preparedFixture();
    state.settings = { defaultModel: 'user/new-choice' };
    await expect(helper.selectConfiguredModel({ ...input, assertCurrent }, { purpose: 'agent', modelId, expectedSettings: {}, expectedNativeSelections: emptyNativeSelections() })).rejects.toMatchObject({ code: 'model_configuration_account_provider_conflict' });
    await expect(helper.selectConfiguredModel({ ...input, assertCurrent }, { purpose: 'agent', modelId: 'not-authorized', expectedSettings: state.settings, expectedNativeSelections: emptyNativeSelections() })).rejects.toMatchObject({ code: 'model_configuration_account_provider_invalid' });
    expect(state.calls.some(([kind]) => kind === 'settings')).toBe(false);
  });

  it('allows an exact previous provider model catalog to grow with the same credential', async () => {
    const { helper, state, assertCurrent } = await preparedFixture();
    const extended = { ...input, models: [...input.models, { id: 'second-chat', name: 'Second chat' }], previousModels: input.models, assertCurrent };
    await helper.configure(extended);
    expect(Object.keys(state.config.models)).toEqual([modelId, 'second-chat']);
    expect(state.calls.some(([kind]) => kind === 'key')).toBe(false);
    await helper.verify(extended);
  });

  it.each(['owner', 'settings', 'credential'])('checks %s again inside the native settings writer before mutation', async (change) => {
    let beforeWrite = () => {};
    let writes = 0;
    let state;
    const f = fixture({ writeSettings: async (changes, assertCurrent) => { beforeWrite(); await assertCurrent(); writes++; state.settings = { ...state.settings, ...changes }; } });
    state = f.state;
    await f.configure();
    beforeWrite = () => {
      if (change === 'owner') state.current = false;
      else if (change === 'settings') state.settings.defaultModel = 'user/changed-while-queued';
      else state.credentials[providerId] = { type: 'api', key: 'fixture-rotated' };
    };
    await expect(f.helper.selectConfiguredModel({ ...input, assertCurrent: f.assertCurrent }, { purpose: 'agent', modelId, expectedSettings: {}, expectedNativeSelections: emptyNativeSelections() })).rejects.toMatchObject({ code: change === 'owner' ? 'platform_account_selection_changed' : 'model_configuration_account_provider_conflict' });
    expect(writes).toBe(0);
  });

  it('does not refresh a provider with a different credential or an invented previous snapshot', async () => {
    const { helper, state, assertCurrent } = await preparedFixture();
    const more = { ...input, models: [...input.models, { id: 'second-chat', name: 'Second' }], previousModels: input.models, assertCurrent };
    state.credentials[providerId].key = 'fixture-different-key';
    await expect(helper.configure(more)).rejects.toMatchObject({ code: 'model_configuration_account_provider_conflict' });
    state.credentials[providerId].key = key;
    await expect(helper.configure({ ...more, previousModels: [...input.models, { id: 'removed', name: 'Removed' }] })).rejects.toMatchObject({ code: 'model_configuration_account_provider_conflict' });
    expect(state.calls.some(([kind]) => ['config', 'key'].includes(kind))).toBe(false);
  });

  it('uses the owning config writer while preserving defaults and refuses private inline edits on disk', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'account-key-provider-'));
    try {
      const script = `
        import fs from 'node:fs';
        import path from 'node:path';
        import assert from 'node:assert/strict';
        import { createAccountKeyProvider } from ${JSON.stringify(new URL('./account-key-provider.js', import.meta.url).href)};
        const directory = process.env.ACCOUNT_KEY_PROVIDER_TEST_DIR;
        const project = path.join(directory, 'current-project');
        fs.mkdirSync(project);
        const file = path.join(directory, 'opencode.json');
        const original = { model: 'existing/kept', small_model: 'existing/small', agents: { build: { model: { providerID: 'existing', id: 'kept' } } }, providers: { existing: { name: 'Existing', package: 'aisdk:@ai-sdk/openai', settings: { baseURL: 'https://existing.example.test/v1' } } } };
        fs.writeFileSync(file, JSON.stringify(original));
        const credentials = {};
        const runtime = {};
        let whileReadingCredential = () => {};
        const helper = createAccountKeyProvider({
          env: { OPENCHAMBER_LLMROUTER_API_URL: ${JSON.stringify(baseUrl)} },
          enterpriseOptions: { env: {}, readFile: () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); } },
          assertRuntime: () => runtime,
          getDefaultDirectory: () => project,
          readOpenCodeCredentials: async () => { whileReadingCredential(); return credentials; },
          getOpenCodeClient: () => ({ integration: { get: async () => ({ data: { methods: [{ type: 'key' }] } }), connect: { key: async ({ integrationID, key }) => { credentials[integrationID] = { type: 'api', key }; } } } }),
        });
        const input = { ...${JSON.stringify(input)}, assertCurrent: async () => {} };
        await helper.configure(input);
        const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.equal(stored.model, original.model);
        assert.equal(stored.small_model, original.small_model);
        assert.deepEqual(stored.agents, original.agents);
        assert.deepEqual(stored.providers.existing, original.providers.existing);
        assert.equal(stored.providers[input.providerId].name, 'SuperWagie');
        assert.equal(JSON.stringify(stored).includes(input.apiKey), false);
        await helper.configure(input);
        stored.providers[input.providerId].settings.apiKey = 'fixture-user-inline-key';
        fs.writeFileSync(file, JSON.stringify(stored));
        const before = fs.readFileSync(file, 'utf8');
        await assert.rejects(helper.configure(input), { code: 'model_configuration_account_provider_conflict' });
        assert.equal(fs.readFileSync(file, 'utf8'), before);
        fs.writeFileSync(file, '{invalid');
        await assert.rejects(helper.configure(input), { code: 'model_configuration_account_provider_unavailable' });
        assert.equal(fs.readFileSync(file, 'utf8'), '{invalid');
        fs.writeFileSync(file, JSON.stringify(original));
        whileReadingCredential = () => {
          const concurrent = structuredClone(original);
          concurrent.providers[input.providerId] = { name: 'User created', package: 'aisdk:@ai-sdk/openai', settings: { baseURL: 'https://user.example.test/v1' } };
          fs.writeFileSync(file, JSON.stringify(concurrent));
        };
        await assert.rejects(helper.configure(input), { code: 'model_configuration_account_provider_conflict' });
        assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).providers[input.providerId].name, 'User created');
        process.stdout.write('ok');
      `;
      const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
        encoding: 'utf8',
        stdio: 'pipe',
        env: { ...process.env, ACCOUNT_KEY_PROVIDER_TEST_DIR: directory, OPENCODE_CONFIG_DIR: directory, OPENCODE_CONFIG: '', OPENCODE_CONFIG_CONTENT: '' },
      });
      expect(output.endsWith('ok')).toBe(true);
      expect(output).not.toContain(key);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('writes a named provider before its private credential, reads back both, and preserves model choices', async () => {
    const { configure, state } = fixture();
    expect(await configure()).toEqual({ providerId, modelId });
    expect(state.calls.filter(([kind]) => ['config', 'key'].includes(kind)).map(([kind]) => kind)).toEqual(['config', 'key']);
    expect(state.config).toEqual({ name: 'SuperWagie', package: 'aisdk:@ai-sdk/openai-compatible', settings: { baseURL: baseUrl }, models: { [modelId]: { modelID: modelId, name: 'Fixture chat' } } });
    expect(JSON.stringify(state.config)).not.toContain(key);
    expect(state.calls.find(([kind]) => kind === 'config').slice(3)).toEqual(['/fixture/current-project', 'user', { hasStoredAuth: true }]);
    expect(state.calls.filter(([kind]) => kind === 'read-key').length).toBeGreaterThanOrEqual(2);
    expect(state.calls.some(([kind]) => /default|session|project-model/.test(kind))).toBe(false);
  });

  it('recovers matching writes without writing another credential or changing the provider', async () => {
    const { configure, state } = fixture();
    await configure();
    state.calls.length = 0;
    await configure();
    expect(state.calls.some(([kind]) => ['config', 'key'].includes(kind))).toBe(false);
  });

  it('verifies an existing provider in enterprise mode without changing config or running a probe', async () => {
    const { helper, state, assertCurrent } = await preparedFixture();
    state.enabled = true;
    await helper.verify({ ...input, assertCurrent });
    expect(state.calls.map(([kind]) => kind)).toEqual(['read-config', 'read-key']);
    state.credentials[providerId].key = 'fixture-rotated-key';
    await expect(helper.verify({ ...input, assertCurrent })).rejects.toMatchObject({ code: 'model_configuration_account_provider_conflict' });
    state.current = false;
    await expect(helper.verify({ ...input, assertCurrent })).rejects.toMatchObject({ code: 'platform_account_selection_changed' });
    expect(state.calls.some(([kind]) => ['config', 'key', 'generate'].includes(kind))).toBe(false);
  });

  it.each(['endpoint', 'inline-key', 'credential'])('preserves a conflicting %s on recovery', async (change) => {
    const { configure, state } = fixture();
    await configure();
    if (change === 'endpoint') state.config.settings.baseURL = 'https://changed.example.test/v1';
    if (change === 'inline-key') state.config.settings.apiKey = 'fixture-user-edited-key';
    if (change === 'credential') state.credentials[providerId].key = 'fixture-user-edited-key';
    const before = structuredClone({ config: state.config, credentials: state.credentials });
    state.calls.length = 0;
    await expect(configure()).rejects.toMatchObject({ code: 'model_configuration_account_provider_conflict', status: 409 });
    expect({ config: state.config, credentials: state.credentials }).toEqual(before);
    expect(state.calls.some(([kind]) => ['config', 'key'].includes(kind))).toBe(false);
  });

  it('fails closed on unreadable provider state and sanitized credential read errors', async () => {
    for (const overrides of [
      { readProviderConfig: async () => { throw new Error(key); } },
      { readOpenCodeCredentials: async () => { throw new Error(key); } },
    ]) {
      const { configure, state } = fixture(overrides);
      const error = await configure().catch((value) => value);
      expect(error.code).toBe('model_configuration_account_provider_unavailable');
      expect(error.message).not.toContain(key);
      expect(state.calls.some(([kind]) => ['config', 'key'].includes(kind))).toBe(false);
    }
  });

  it('does not overwrite shadowed or disabled providers', async () => {
    const { configure, state } = fixture({ readProviderConfig: async () => ({ config: null, blocked: true }) });
    await expect(configure()).rejects.toMatchObject({ code: 'model_configuration_account_provider_conflict' });
    expect(state.calls.some(([kind]) => ['config', 'key'].includes(kind))).toBe(false);
  });

  it('checks the selected owner after configuration and before writing the key', async () => {
    const f = fixture({ upsertProviderConfig: (_id, config) => { f.state.config = config; f.state.current = false; } });
    await expect(f.configure()).rejects.toMatchObject({ code: 'platform_account_selection_changed' });
    expect(f.state.calls.some(([kind]) => kind === 'key')).toBe(false);
  });

  it('checks dynamic enterprise policy before entry and after configuration', async () => {
    const initial = fixture();
    initial.state.enabled = true;
    await expect(initial.configure()).rejects.toMatchObject({ code: 'enterprise_mode', status: 403 });
    await expect(initial.probe()).rejects.toMatchObject({ code: 'enterprise_mode', status: 403 });
    expect(initial.state.calls).toHaveLength(0);
    const changed = fixture({ upsertProviderConfig: (_id, config) => { changed.state.config = config; changed.state.enabled = true; } });
    await expect(changed.configure()).rejects.toMatchObject({ code: 'enterprise_mode' });
    expect(changed.state.calls.some(([kind]) => kind === 'key')).toBe(false);
    const malformed = fixture({ enterpriseOptions: { env: {}, readFile: () => '{invalid' } });
    await expect(malformed.configure()).rejects.toMatchObject({ code: 'enterprise_mode' });
  });

  it('waits for config discovery before dispatching a single key write', async () => {
    const { configure, client, state } = fixture();
    let reads = 0;
    client.integration.get = async () => ({ data: { methods: ++reads < 3 ? [] : [{ type: 'key' }] } });
    await configure();
    expect(reads).toBe(3);
    expect(state.calls.filter(([kind]) => kind === 'key')).toHaveLength(1);
  });

  it('recovers an uncertain key write by readback without dispatching it again', async () => {
    const { configure, client, state } = fixture();
    client.integration.connect.key = async (request) => {
      state.calls.push(['key', request]);
      state.credentials[providerId] = { type: 'api', key };
      throw new Error(`response lost ${key}`);
    };
    await expect(configure()).rejects.toMatchObject({ code: 'model_configuration_account_provider_unavailable' });
    await configure();
    expect(state.calls.filter(([kind]) => kind === 'key')).toHaveLength(1);
  });

  it('sends one short text probe to the exact model with a deadline and publishes no response body', async () => {
    const { probe, state } = await preparedFixture();
    expect(await probe()).toEqual({ status: 'verified', testedAt: '2026-11-06T08:00:00.000Z' });
    const requests = state.calls.filter(([kind]) => kind === 'generate');
    expect(requests).toHaveLength(1);
    expect(requests[0][1]).toEqual({ prompt: 'Reply with OK.', model: { providerID: providerId, id: modelId } });
    expect(requests[0][2].signal).toBeInstanceOf(AbortSignal);
    expect(state.calls.find(([kind]) => kind === 'client')[1]).toBe('/fixture/current-project');
  });

  it.each(['empty', 'timeout', 'provider-error', 'authentication'])('does not verify or repeat a %s response', async (kind) => {
    const { probe, state } = await preparedFixture();
    state.generate = async () => {
      if (kind === 'empty') return { text: ' ' };
      if (kind === 'authentication') throw { _tag: 'ProviderRequestError', providerID: providerId, reason: 'authentication', status: 401, message: key };
      throw new Error(`${kind} ${key}`);
    };
    const error = await probe().catch((value) => value);
    expect(error.code).toBe(['empty', 'authentication'].includes(kind) ? 'model_configuration_account_probe_failed' : 'model_configuration_account_probe_unknown');
    expect(error.message).not.toContain(key);
    expect(state.calls.filter(([action]) => action === 'generate')).toHaveLength(1);
  });

  it.each(['owner', 'policy'])('rejects a late successful probe after the %s changes', async (kind) => {
    const { probe, state } = await preparedFixture();
    state.generate = async () => { if (kind === 'owner') state.current = false; else state.enabled = true; return { text: 'OK' }; };
    await expect(probe()).rejects.toMatchObject({ code: kind === 'owner' ? 'platform_account_selection_changed' : 'enterprise_mode' });
    expect(state.calls.filter(([action]) => action === 'generate')).toHaveLength(1);
  });

  it.each(['endpoint', 'credential'])('rejects a probe when its %s changed before dispatch or during the request', async (kind) => {
    const { probe, state } = await preparedFixture();
    const change = () => {
      if (kind === 'endpoint') state.config.settings.baseURL = 'https://changed.example.test/v1';
      else state.credentials[providerId].key = 'fixture-rotated-key';
    };
    state.generate = async () => { change(); return { text: 'OK' }; };
    await expect(probe()).rejects.toMatchObject({ code: 'model_configuration_account_provider_conflict' });
    expect(state.calls.filter(([action]) => action === 'generate')).toHaveLength(1);
    state.calls.length = 0;
    await expect(probe()).rejects.toMatchObject({ code: 'model_configuration_account_provider_conflict' });
    expect(state.calls.filter(([action]) => action === 'generate')).toHaveLength(0);
  });

  it('rejects an arbitrary credential destination or a model absent from its catalog before I/O', async () => {
    const { helper, assertCurrent, state } = fixture();
    for (const changes of [{ baseUrl: 'https://untrusted.example.test/v1' }, { modelId: 'absent' }, { providerId: 'openai' }]) {
      await expect(helper.configure({ ...input, ...changes, assertCurrent })).rejects.toMatchObject({ code: 'model_configuration_account_provider_invalid', status: 400 });
    }
    expect(state.calls).toHaveLength(0);
  });

  it('plans the actual default and the app auxiliary override with its supported variant without writes', async () => {
    const { helper, state, assertCurrent } = await preparedFixture();
    state.settings = { smallModelUseDefault: false, smallModelOverride: 'chosen/aux/model', smallModelVariant: 'fast' };
    state.titleModel = { providerID: 'ignored', id: 'title' };
    state.nativeModels.push({ providerID: 'chosen', id: 'aux/model', enabled: true, variants: [{ id: 'fast' }] });
    expect(await helper.planTests({ ...input, assertCurrent })).toEqual([
      { id: 'native-agent', purpose: 'agent', providerId: 'existing', modelId: 'chat' },
      { id: 'native-auxiliary', purpose: 'auxiliary', providerId: 'chosen', modelId: 'aux/model', variant: 'fast' },
    ]);
    expect(state.calls.some(([kind]) => ['generate', 'key', 'config'].includes(kind))).toBe(false);
  });

  it('uses the native title selection then the actual default when auxiliary has no explicit model', async () => {
    const { helper, state, assertCurrent } = await preparedFixture();
    state.titleModel = { providerID: 'configured', id: 'title', variant: 'unsupported' };
    state.nativeModels.push({ providerID: 'configured', id: 'title', enabled: true, variants: [] });
    const read = () => helper.planTests({ ...input, assertCurrent });
    expect((await read())[1]).toEqual({ id: 'native-auxiliary', purpose: 'auxiliary', providerId: 'configured', modelId: 'title' });
    state.nativeModels[1].enabled = false;
    expect((await read())[1]).toMatchObject({ providerId: 'existing', modelId: 'chat' });
    state.titleModel = undefined;
    state.defaultModel = null;
    expect((await read()).every((row) => row.status === 'skipped' && row.modelId === null)).toBe(true);
  });

  it('keeps unreadable effective settings unknown for both purposes instead of choosing a fallback provider', async () => {
    const f = fixture({ readSettings: async () => { throw new Error(key); } });
    await f.configure();
    const rows = await f.helper.planTests({ ...input, assertCurrent: f.assertCurrent });
    expect(rows[0]).toMatchObject({ status: 'skipped', errorCode: 'model_configuration_account_provider_unavailable' });
    expect(rows[1]).toMatchObject({ status: 'skipped', errorCode: 'model_configuration_account_provider_unavailable' });
    expect(JSON.stringify(rows)).not.toContain(key);
    expect(f.state.calls.filter(([kind]) => kind === 'generate')).toHaveLength(0);
  });

  it('reads authoritative preferences over the compatibility settings copy and refuses corrupt files', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'account-model-preferences-'));
    try {
      fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({ smallModelUseDefault: false, smallModelOverride: 'old/compatibility-copy' }));
      fs.writeFileSync(path.join(directory, 'preferences.json'), JSON.stringify({ version: 1, fields: {
        smallModelUseDefault: { value: false, updatedAt: 1 },
        smallModelOverride: { value: 'actual/preference', updatedAt: 1 },
      } }));
      const f = fixture({ env: { OPENCHAMBER_LLMROUTER_API_URL: baseUrl, OPENCHAMBER_DATA_DIR: directory }, readSettings: undefined });
      await f.configure();
      const read = () => f.helper.planTests({ ...input, assertCurrent: f.assertCurrent });
      expect((await read())[1]).toMatchObject({ providerId: 'actual', modelId: 'preference' });
      fs.writeFileSync(path.join(directory, 'preferences.json'), '{broken');
      expect((await read())[1]).toMatchObject({ status: 'skipped', errorCode: 'model_configuration_account_provider_unavailable' });
      expect(fs.readFileSync(path.join(directory, 'preferences.json'), 'utf8')).toBe('{broken');
      fs.rmSync(path.join(directory, 'preferences.json'));
      fs.writeFileSync(path.join(directory, 'settings.json'), '[]');
      expect((await read())[1]).toMatchObject({ status: 'skipped', errorCode: 'model_configuration_account_provider_unavailable' });
      fs.rmSync(path.join(directory, 'settings.json'));
      expect((await read())[1]).toMatchObject({ providerId: 'existing', modelId: 'chat' });
      expect(fs.readdirSync(directory)).toEqual([]);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it('probes only the persisted selected native model once and does not replace defaults or credentials', async () => {
    const { helper, state, assertCurrent } = await preparedFixture();
    state.titleModel = { providerID: 'configured', id: 'title', variant: 'fast' };
    state.nativeModels.push({ providerID: 'configured', id: 'title', enabled: true, variants: [{ id: 'fast' }] });
    const request = { ...input, assertCurrent };
    const row = (await helper.planTests(request))[1];
    expect(await helper.probeConfiguredModel(request, row)).toEqual({ status: 'verified', testedAt: '2026-11-06T08:00:00.000Z' });
    expect(state.calls.filter(([kind]) => kind === 'generate').map(([, request]) => request)).toEqual([
      { prompt: 'Reply with OK.', model: { providerID: 'configured', id: 'title', variant: 'fast' } },
    ]);
    expect(state.calls.some(([kind]) => ['key', 'config'].includes(kind))).toBe(false);
  });

  it.each(['before', 'during'])('rejects a selected native model change %s dispatch without replay', async (timing) => {
    const { helper, state, assertCurrent } = await preparedFixture();
    const request = { ...input, assertCurrent };
    const row = (await helper.planTests(request))[0];
    const change = () => { state.defaultModel = { providerID: 'changed', id: 'other' }; };
    if (timing === 'before') change();
    else state.generate = async () => { change(); return { text: 'OK' }; };
    await expect(helper.probeConfiguredModel(request, row)).rejects.toMatchObject({ code: 'model_configuration_account_provider_conflict' });
    expect(state.calls.filter(([kind]) => kind === 'generate')).toHaveLength(timing === 'before' ? 0 : 1);
  });

  it('rejects an auxiliary variant change after the request without marking the old variant verified', async () => {
    const { helper, state, assertCurrent } = await preparedFixture();
    state.settings = { smallModelUseDefault: false, smallModelOverride: 'existing/chat', smallModelVariant: 'fast' };
    state.nativeModels[0].variants = [{ id: 'fast' }, { id: 'thorough' }];
    const request = { ...input, assertCurrent };
    const row = (await helper.planTests(request))[1];
    state.generate = async () => { state.settings.smallModelVariant = 'thorough'; return { text: 'OK' }; };
    await expect(helper.probeConfiguredModel(request, row)).rejects.toMatchObject({ code: 'model_configuration_account_provider_conflict' });
    expect(state.calls.filter(([kind]) => kind === 'generate')).toHaveLength(1);
  });

  it('does not publish an old directory default as verified after the active directory changes', async () => {
    let directory = '/fixture/current-project';
    const f = fixture({ getDefaultDirectory: () => directory });
    await f.configure();
    const request = { ...input, assertCurrent: f.assertCurrent };
    const row = (await f.helper.planTests(request))[0];
    f.state.generate = async () => { directory = '/fixture/other-project'; return { text: 'OK' }; };
    await expect(f.helper.probeConfiguredModel(request, row)).rejects.toMatchObject({ code: 'model_configuration_account_provider_conflict' });
    expect(f.state.calls.filter(([kind]) => kind === 'generate')).toHaveLength(1);
  });

  it.each(['owner', 'policy'])('blocks native dispatch when %s changes during preflight reads', async (kind) => {
    const { helper, client, state, assertCurrent } = await preparedFixture();
    const request = { ...input, assertCurrent };
    const row = (await helper.planTests(request))[0];
    client.model.default = async () => {
      if (kind === 'owner') state.current = false;
      else state.enabled = true;
      return { data: state.defaultModel };
    };
    await expect(helper.probeConfiguredModel(request, row)).rejects.toMatchObject({ code: kind === 'owner' ? 'platform_account_selection_changed' : 'enterprise_mode' });
    expect(state.calls.filter(([action]) => action === 'generate')).toHaveLength(0);
  });

  it.each(['owner', 'policy', 'empty', 'unknown'])('does not publish native success after %s', async (kind) => {
    const { helper, state, assertCurrent } = await preparedFixture();
    const request = { ...input, assertCurrent };
    const row = (await helper.planTests(request))[0];
    state.generate = async () => {
      if (kind === 'owner') state.current = false;
      if (kind === 'policy') state.enabled = true;
      if (kind === 'unknown') throw new Error(key);
      return { text: kind === 'empty' ? '' : 'OK' };
    };
    const codes = { owner: 'platform_account_selection_changed', policy: 'enterprise_mode', empty: 'model_configuration_account_probe_failed', unknown: 'model_configuration_account_probe_unknown' };
    await expect(helper.probeConfiguredModel(request, row)).rejects.toMatchObject({ code: codes[kind] });
    expect(state.calls.filter(([action]) => action === 'generate')).toHaveLength(1);
  });

  it('refuses malformed native defaults and title responses without claiming an empty selection', async () => {
    const { helper, client, assertCurrent } = await preparedFixture();
    client.model.default = async () => ({ data: { providerID: 'existing', modelID: 'wire-api-name-only' } });
    client.agent.get = async () => ({ data: { id: 'title', model: { id: 1 } } });
    const rows = await helper.planTests({ ...input, assertCurrent });
    expect(rows.every((row) => row.status === 'skipped' && row.errorCode === 'model_configuration_account_provider_unavailable')).toBe(true);
  });
});
