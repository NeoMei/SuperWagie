import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { createModelConfigurationRuntime } from './runtime.js';
import { registerModelConfigurationRoutes } from './routes.js';
import { registerCommonRequestMiddleware } from '../opencode/core-routes.js';

const directories = [];
const noPolicyFile = () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); };
const fixture = async (options = {}) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'model-connection-probe-'));
  directories.push(dataDir);
  const runtime = createModelConfigurationRuntime({ dataDir, enterpriseOptions: { env: {}, readFile: noPolicyFile }, ...options });
  return { dataDir, runtime };
};
const connection = (changes = {}) => ({ name: 'Probe fixture', providerId: 'openai', protocol: 'openai-compatible', baseUrl: 'https://api.example.test/v1', apiKey: 'fixture-private-key', ...changes });
const connect = (runtime, changes = {}) => runtime.saveConnection({ revision: 0, connection: connection(changes) });
const input = (revision = 1, changes = {}) => ({ revision, purpose: 'embedding', model: 'fixture-embedding', parameters: { dimensions: 2 }, ...changes });
const embeddingResponse = () => Response.json({ data: [{ embedding: [0.1, 0.2] }] });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });

describe('read-only saved connection probes', () => {
  it('uses the saved endpoint and key with the chosen model without creating a binding or writing configuration', async () => {
    const requests = [];
    let preparations = 0;
    const { dataDir, runtime } = await fixture({
      prepareBindingChange: async () => { preparations += 1; },
      fetchImpl: async (url, init) => { requests.push({ url, init }); return embeddingResponse(); },
    });
    const state = await connect(runtime);
    const filePath = path.join(dataDir, 'model-configuration.json');
    const before = await fs.readFile(filePath, 'utf8');
    const result = await runtime.testConnection(state.connections[0].id, input());
    expect(result).toEqual({ status: 'verified', testedAt: expect.any(String) });
    expect(Number.isFinite(Date.parse(result.testedAt))).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://api.example.test/v1/embeddings');
    expect(requests[0].init.headers.Authorization).toBe('Bearer fixture-private-key');
    expect(requests[0].init.redirect).toBe('error');
    expect(JSON.parse(requests[0].init.body)).toEqual({ model: 'fixture-embedding', input: ['SuperWagie model configuration test'], dimensions: 2 });
    expect(await fs.readFile(filePath, 'utf8')).toBe(before);
    expect((await runtime.getPublicConfiguration()).bindings).toEqual([]);
    expect(preparations).toBe(0);
    expect(JSON.stringify(result)).not.toContain('fixture-private-key');
  });

  it('keeps an existing binding and its verification when testing another model', async () => {
    const { dataDir, runtime } = await fixture({ fetchImpl: async () => embeddingResponse() });
    let state = await connect(runtime);
    state = await runtime.saveBinding('embedding', { revision: state.revision, binding: { connectionId: state.connections[0].id, model: 'already-bound', parameters: { dimensions: 2 } } });
    state = await runtime.testBinding('embedding', { revision: state.revision });
    const before = await fs.readFile(path.join(dataDir, 'model-configuration.json'), 'utf8');
    await runtime.testConnection(state.connections[0].id, input(state.revision));
    expect(await fs.readFile(path.join(dataDir, 'model-configuration.json'), 'utf8')).toBe(before);
    expect((await runtime.getPublicConfiguration()).bindings[0]).toMatchObject({ model: 'already-bound', verification: { status: 'verified' } });
  });

  it('returns a purpose failure without leaking upstream bodies or errors and leaves the store untouched', async () => {
    const { runtime, dataDir } = await fixture({ fetchImpl: async () => Response.json({ error: 'fixture-private-key' }, { status: 401 }) });
    const state = await connect(runtime);
    const before = await fs.readFile(path.join(dataDir, 'model-configuration.json'), 'utf8');
    const result = await runtime.testConnection(state.connections[0].id, input());
    expect(result).toMatchObject({ status: 'failed', errorCode: 'model_configuration_provider_http_401' });
    expect(JSON.stringify(result)).not.toContain('fixture-private-key');
    expect(await fs.readFile(path.join(dataDir, 'model-configuration.json'), 'utf8')).toBe(before);
  });

  it('rejects malformed input, stale revisions and missing connections before making requests', async () => {
    let calls = 0;
    const { runtime } = await fixture({ fetchImpl: async () => { calls += 1; return embeddingResponse(); } });
    const state = await connect(runtime);
    const id = state.connections[0].id;
    for (const candidate of [input(1, { apiKey: 'override' }), input(1, { model: '' }), input(1, { purpose: 'unknown' }), input(1, { parameters: { dimensions: 0 } })]) {
      await expect(runtime.testConnection(id, candidate)).rejects.toMatchObject({ code: 'model_configuration_invalid_input', status: 400 });
    }
    await expect(runtime.testConnection('../invalid', input())).rejects.toMatchObject({ code: 'model_configuration_invalid_input' });
    await expect(runtime.testConnection(id, input(0))).rejects.toMatchObject({ code: 'model_configuration_revision_conflict', status: 409 });
    await expect(runtime.testConnection('missing', input())).rejects.toMatchObject({ code: 'model_configuration_connection_missing', status: 404 });
    expect(calls).toBe(0);
  });

  it('rejects native, planned, unavailable-probe and incompatible preset choices without a request', async () => {
    let calls = 0;
    const { runtime } = await fixture({ fetchImpl: async () => { calls += 1; return embeddingResponse(); } });
    const state = await connect(runtime);
    const id = state.connections[0].id;
    await expect(runtime.testConnection(id, input(1, { purpose: 'agent' }))).rejects.toMatchObject({ code: 'model_configuration_not_connected', status: 501 });
    await expect(runtime.testConnection(id, input(1, { purpose: 'video-generation' }))).rejects.toMatchObject({ code: 'model_configuration_probe_unavailable', status: 501 });
    await expect(runtime.testConnection(id, input(1, { purpose: 'stt-realtime' }))).rejects.toMatchObject({ code: 'model_configuration_probe_unavailable', status: 501 });
    await expect(runtime.testConnection(id, input(1, { presetId: 'qwen-embedding' }))).rejects.toMatchObject({ code: 'model_configuration_incompatible_preset', status: 400 });
    await expect(runtime.testConnection(id, input(1, { presetId: 'openai-embedding', model: 'other-model' }))).rejects.toMatchObject({ code: 'model_configuration_incompatible_preset', status: 400 });
    expect(calls).toBe(0);
  });

  it('rejects recommendations requiring adapters even when their protocol has a generic probe', async () => {
    let calls = 0;
    const { runtime } = await fixture({ fetchImpl: async () => { calls += 1; return embeddingResponse(); } });
    const state = await connect(runtime, { providerId: 'voyage', protocol: 'voyage' });
    await expect(runtime.testConnection(state.connections[0].id, input(1, { purpose: 'rerank', presetId: 'voyage-rerank', model: 'rerank-3', parameters: {} }))).rejects.toMatchObject({ code: 'model_configuration_unsupported_protocol', status: 501 });
    expect(calls).toBe(0);
  });

  it('enforces enterprise policy at invocation while permitting a saved local connection', async () => {
    const env = {};
    let calls = 0;
    const { runtime } = await fixture({ enterpriseOptions: { env, readFile: noPolicyFile }, fetchImpl: async () => { calls += 1; return embeddingResponse(); } });
    let state = await connect(runtime);
    state = await runtime.saveConnection({ revision: state.revision, connection: connection({ name: 'Local', baseUrl: 'http://127.0.0.1:9999/v1', apiKey: undefined }) });
    env.OPENCHAMBER_ENTERPRISE_MODE = '1';
    await expect(runtime.testConnection(state.connections[0].id, input(2))).rejects.toMatchObject({ code: 'enterprise_mode', status: 403 });
    expect(calls).toBe(0);
    expect(await runtime.testConnection(state.connections[1].id, input(2))).toMatchObject({ status: 'verified' });
    expect(calls).toBe(1);
  });

  it('refuses an obsolete result after another configuration write completes during the provider request', async () => {
    const started = deferred();
    const finish = deferred();
    const { runtime } = await fixture({ fetchImpl: async () => { started.resolve(); await finish.promise; return embeddingResponse(); } });
    const state = await connect(runtime);
    const id = state.connections[0].id;
    const pending = runtime.testConnection(id, input());
    await started.promise;
    await runtime.saveConnection({ revision: 1, connection: connection({ id, name: 'Renamed' }) });
    finish.resolve();
    await expect(pending).rejects.toMatchObject({ code: 'model_configuration_revision_conflict', status: 409 });
    expect((await runtime.getPublicConfiguration()).revision).toBe(2);
  });

  it('resolves a native API key at probe time without copying it into the store', async () => {
    let key = 'native-key-before';
    const authorizations = [];
    const { runtime, dataDir } = await fixture({
      readOpenCodeCredentials: async () => ({ openai: { type: 'api', key } }),
      fetchImpl: async (_url, init) => { authorizations.push(init.headers.Authorization); return embeddingResponse(); },
    });
    const state = await connect(runtime, { baseUrl: 'https://api.openai.com/v1', apiKey: undefined, credentialSource: { type: 'opencode', providerId: 'openai' } });
    key = 'native-key-after';
    const result = await runtime.testConnection(state.connections[0].id, input());
    expect(result.status).toBe('verified');
    expect(authorizations).toEqual(['Bearer native-key-after']);
    expect(await fs.readFile(path.join(dataDir, 'model-configuration.json'), 'utf8')).not.toContain('native-key-');
    expect(JSON.stringify(result)).not.toContain('native-key-');
  });

  it('refuses a native key rotation or disappearance during a probe', async () => {
    for (const after of ['rotated-key', null]) {
      let key = 'native-starting-key';
      const { runtime } = await fixture({
        readOpenCodeCredentials: async () => key ? { openai: { type: 'api', key } } : {},
        fetchImpl: async () => { key = after; return embeddingResponse(); },
      });
      const state = await connect(runtime, { baseUrl: 'https://api.openai.com/v1', apiKey: undefined, credentialSource: { type: 'opencode', providerId: 'openai' } });
      await expect(runtime.testConnection(state.connections[0].id, input())).rejects.toMatchObject({ code: after ? 'model_configuration_credential_changed' : 'model_configuration_credential_missing', status: 409 });
      expect((await runtime.getPublicConfiguration()).revision).toBe(1);
    }
  });

  it('does not send a provider request when native credentials cannot be read', async () => {
    let available = true;
    let calls = 0;
    const { runtime } = await fixture({
      readOpenCodeCredentials: async () => { if (!available) throw new Error('native-private-key'); return { openai: { type: 'api', key: 'native-private-key' } }; },
      fetchImpl: async () => { calls += 1; return embeddingResponse(); },
    });
    const state = await connect(runtime, { baseUrl: 'https://api.openai.com/v1', apiKey: undefined, credentialSource: { type: 'opencode', providerId: 'openai' } });
    available = false;
    await expect(runtime.testConnection(state.connections[0].id, input())).rejects.toMatchObject({ code: 'model_configuration_credential_unavailable', status: 503 });
    expect(calls).toBe(0);
  });

  it('parses the new route behind production middleware and returns only the test result', async () => {
    const { runtime } = await fixture({ fetchImpl: async () => embeddingResponse() });
    const state = await connect(runtime);
    const app = express();
    registerCommonRequestMiddleware(app, { express });
    registerModelConfigurationRoutes(app, { runtime });
    const route = `/api/model-configuration/connections/${state.connections[0].id}/test`;
    const tested = await request(app).post(route).send(input());
    expect(tested.status).toBe(200);
    expect(tested.body).toEqual({ status: 'verified', testedAt: expect.any(String) });
    expect(JSON.stringify(tested.body)).not.toContain('fixture-private-key');
    const stale = await request(app).post(route).send(input(0));
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({ error: 'model_configuration_revision_conflict', code: 'model_configuration_revision_conflict' });
    const malformed = await request(app).post(route).set('Content-Type', 'application/json').send('{ fixture-private-key');
    expect(malformed.status).toBe(400);
    expect(JSON.stringify(malformed.body)).not.toContain('fixture-private-key');
  });
});
