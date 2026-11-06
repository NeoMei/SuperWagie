import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createModelConfigurationRuntime } from './runtime.js';
import { createKnowledgeModelBindings } from '../embedded-knowledge/model-bindings.js';

const directories = [];
const apiKey = 'fixture-account-key';
const connection = { id: 'account-key-fixture', name: 'SuperWagie', providerId: 'llmrouter', protocol: 'openai-compatible', baseUrl: 'https://inference.example.test/v1', credentialSource: { type: 'model-bootstrap', providerId: 'llmrouter', ref: 'fixture-reference' } };
const target = { purpose: 'embedding', model: 'account-embedding', parameters: { dimensions: 2 } };
const fixture = async (options = {}) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'account-key-bindings-'));
  directories.push(dataDir);
  const env = {};
  const runtime = createModelConfigurationRuntime({ dataDir, env: { OPENCHAMBER_LLMROUTER_API_URL: connection.baseUrl }, enterpriseOptions: { env, readFile: () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); } }, readModelBootstrapCredential: async () => apiKey, ...options });
  const state = await runtime.saveConnection({ revision: 0, connection: { name: 'Existing', providerId: 'other', protocol: 'openai-compatible', baseUrl: 'https://previous.example.test/v1', apiKey: 'fixture-old-key' } });
  await runtime.saveBinding('embedding', { revision: state.revision, binding: { connectionId: state.connections[0].id, model: 'previous-model', parameters: { dimensions: 2 } } });
  return { runtime, dataDir, env, apply: async (bindings = [target], extra = {}) => runtime.saveAccountKeyConnection({ revision: (await runtime.getPublicConfiguration()).revision, connection, apiKey, bindings, assertCurrent: () => {}, mode: 'replace-selected', ...extra }) };
};
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });

describe('account key consumer switching', () => {
  it('replaces only selected bindings and resolves their actual consumer credential', async () => {
    const { runtime, apply } = await fixture();
    const before = await runtime.getPublicConfiguration();
    await runtime.saveBinding('rerank', { revision: before.revision, binding: { connectionId: before.connections[0].id, model: 'kept-rerank', parameters: {} } });
    const result = await apply();
    expect(result.bindings.find((binding) => binding.purpose === 'embedding')).toMatchObject({ connectionId: connection.id, model: target.model, verification: { status: 'untested' } });
    expect(result.bindings.find((binding) => binding.purpose === 'rerank').model).toBe('kept-rerank');
    expect(await runtime.resolveBinding('embedding')).toMatchObject({ apiKey, baseUrl: connection.baseUrl, model: target.model, parameters: { dimensions: 2 } });
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });

  it('retains fill-missing compatibility for callers that did not request replacement', async () => {
    const { runtime, apply } = await fixture();
    await apply([target], { mode: 'fill-missing' });
    expect((await runtime.resolveBinding('embedding')).model).toBe('previous-model');
  });

  it('keeps the existing file intact when the consumer refuses an indexed embedding change', async () => {
    let blocked = false;
    const { runtime, dataDir, apply } = await fixture({ prepareBindingChange: async (purpose) => {
      if (blocked && purpose === 'embedding') throw Object.assign(new Error('index protected'), { code: 'model_configuration_embedding_rebuild_required' });
    } });
    const before = await fs.readFile(path.join(dataDir, 'model-configuration.json'), 'utf8');
    blocked = true;
    await expect(apply()).rejects.toMatchObject({ code: 'model_configuration_embedding_rebuild_required', status: 409 });
    expect(await fs.readFile(path.join(dataDir, 'model-configuration.json'), 'utf8')).toBe(before);
    await apply([{ purpose: 'rerank', model: 'account-rerank', parameters: {} }]);
    expect((await runtime.resolveBinding('embedding')).model).toBe('previous-model');
    expect((await runtime.resolveBinding('rerank')).apiKey).toBe(apiKey);
  });

  it('verifies saved model inputs and the resolved key, refusing changed credentials or consumer choices', async () => {
    let currentKey = apiKey;
    const { runtime, apply } = await fixture({ readModelBootstrapCredential: async () => currentKey });
    await apply();
    const verify = () => runtime.verifyAccountKeyBindings({ connection, apiKey, bindings: [target], assertCurrent: () => {} });
    expect((await verify()).bindings.find((binding) => binding.purpose === 'embedding').model).toBe(target.model);
    currentKey = 'fixture-rotated-key';
    await expect(verify()).rejects.toMatchObject({ code: 'model_configuration_credential_changed' });
    currentKey = apiKey;
    const current = await runtime.getPublicConfiguration();
    await runtime.saveBinding('embedding', { revision: current.revision, binding: { connectionId: connection.id, model: 'edited-model', parameters: target.parameters } });
    await expect(verify()).rejects.toMatchObject({ code: 'model_configuration_account_key_conflict' });
  });

  it.each(['owner', 'policy', 'credential'])('preserves prior bindings when %s changes during preparation', async (change) => {
    let active = true;
    let currentKey = apiKey;
    let beforePrepare = () => {};
    const { runtime, dataDir, env, apply } = await fixture({ readModelBootstrapCredential: async () => currentKey, prepareBindingChange: async () => beforePrepare() });
    const before = await fs.readFile(path.join(dataDir, 'model-configuration.json'), 'utf8');
    beforePrepare = () => { if (change === 'owner') active = false; else if (change === 'policy') env.OPENCHAMBER_ENTERPRISE_MODE = '1'; else currentKey = 'fixture-rotated'; };
    const result = await apply([target], { assertCurrent: () => { if (!active) throw Object.assign(new Error('changed'), { code: 'platform_session_changed' }); } }).then(() => 'written', (error) => error.code);
    expect(result).toBe(change === 'owner' ? 'platform_session_changed' : change === 'policy' ? 'enterprise_mode' : 'model_configuration_credential_changed');
    expect(await fs.readFile(path.join(dataDir, 'model-configuration.json'), 'utf8')).toBe(before);
    expect((await runtime.getPublicConfiguration()).revision).toBe(2);
  });

  it.each([false, true])('applies the saved account key through the real knowledge consumer with indexed=%s', async (indexed) => {
    let consumer;
    const { runtime, apply } = await fixture({ prepareBindingChange: (...args) => consumer?.prepareModelBindingChange(...args) });
    const models = [
      { id: 'existing-embedding-row', name: 'previous-model', type: 'Embedding', parameters: { base_url: 'https://previous.example.test/v1', api_key: 'fixture-old-key', embedding_parameters: { dimension: 2 } } },
      { id: 'existing-rerank-row', name: 'previous-rerank', type: 'Rerank', parameters: { base_url: 'https://previous.example.test/v1', api_key: 'fixture-old-key' } },
    ];
    const updates = [];
    consumer = createKnowledgeModelBindings({
      getState: () => ({ email: 'fixture@example.invalid', password: 'fixture-local', knowledgeBaseId: 'kb-fixture' }),
      readDocuments: async () => indexed ? { document: { knowledgeId: 'retained-document', state: 'ready' } } : {},
      resolveModelBinding: runtime.resolveBinding,
      createClient: () => ({ login: async () => ({ token: 'fixture-session' }), listModels: async () => models, getKnowledgeBase: async () => ({ id: 'kb-fixture', name: 'Retained library', embedding_model_id: 'existing-embedding-row' }), listKnowledge: async () => ({ total: indexed ? 1 : 0 }), updateModel: async (id, value) => { updates.push({ id, value }); Object.assign(models.find((entry) => entry.id === id), value); } }),
    });
    if (indexed) await expect(apply()).rejects.toMatchObject({ code: 'model_configuration_embedding_rebuild_required' });
    else await apply();
    await apply([{ purpose: 'rerank', model: 'account-rerank', parameters: {} }]);
    await consumer.syncModelBindings();
    expect(models.find((entry) => entry.type === 'Rerank')).toMatchObject({ id: 'existing-rerank-row', name: 'account-rerank', parameters: { api_key: apiKey, base_url: connection.baseUrl, provider: 'generic' } });
    expect(models.find((entry) => entry.type === 'Embedding')).toMatchObject(indexed
      ? { id: 'existing-embedding-row', name: 'previous-model', parameters: { api_key: 'fixture-old-key', base_url: 'https://previous.example.test/v1' } }
      : { id: 'existing-embedding-row', name: target.model, parameters: { api_key: apiKey, base_url: connection.baseUrl, embedding_parameters: { dimension: 2 } } });
    expect(updates.some((entry) => entry.id !== 'existing-embedding-row' && entry.id !== 'existing-rerank-row')).toBe(false);
  });
});
