import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { MODEL_PRESETS, MODEL_PURPOSES } from './catalog.js';
import { createModelConfigurationRuntime } from './runtime.js';
import { registerModelConfigurationRoutes } from './routes.js';
import { registerCommonRequestMiddleware } from '../opencode/core-routes.js';

const directories = [];
const noPolicyFile = () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); };
const fixture = async (options = {}) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'model-configuration-'));
  directories.push(dataDir);
  return { dataDir, runtime: createModelConfigurationRuntime({ dataDir, enterpriseOptions: { env: {}, readFile: noPolicyFile }, ...options }) };
};
const connectionInput = (changes = {}) => ({ name: 'Fixture', providerId: 'openai', protocol: 'openai-compatible', baseUrl: 'https://api.example.test/v1', apiKey: 'fixture-private-key', ...changes });
const connect = async (runtime, changes = {}) => runtime.saveConnection({ revision: 0, connection: connectionInput(changes) });
const bind = async (runtime, state, changes = {}, purpose = 'embedding') => runtime.saveBinding(purpose, { revision: state.revision, binding: { connectionId: state.connections[0].id, model: 'fixture-model', parameters: { dimensions: 2 }, ...changes } });
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });

describe('model configuration persistence and boundaries', () => {
  it('publishes every purpose with recommendations and every bundled skill', async () => {
    for (const purpose of MODEL_PURPOSES) {
      const presets = MODEL_PRESETS.filter((entry) => entry.purposes.includes(purpose.id));
      expect(presets.some((entry) => entry.origin === 'china')).toBe(true);
      expect(presets.some((entry) => entry.origin === 'international')).toBe(true);
    }
    expect(MODEL_PURPOSES[0].consumerIds).toEqual(expect.arrayContaining(['superppt', 'ai-image-to-ppt', 'image-to-editable-pptx', 'supervideo', 'superwriter', 'WPSComposer', 'superweb', 'obsidian-excalidraw', 'grilling', 'grill-me', 'grill-with-docs', 'to-spec', 'domain-modeling']));
    const skills = await fs.readdir(new URL('../../builtin-skills/skills/', import.meta.url), { withFileTypes: true });
    expect(MODEL_PURPOSES[0].consumerIds).toEqual(expect.arrayContaining([...skills.filter((entry) => entry.isDirectory()).map((entry) => entry.name), 'superppt']));
    expect(MODEL_PURPOSES.find((entry) => entry.id === 'image-editing')).toMatchObject({ status: 'planned', consumerIds: expect.arrayContaining(['managed-image-edit']) });
    expect(MODEL_PURPOSES.find((entry) => entry.id === 'vision').consumerIds).toContain('ai-image-to-ppt');
    for (const purpose of ['image-generation', 'video-generation']) {
      expect(MODEL_PRESETS.filter((entry) => entry.purposes.includes(purpose)).map((entry) => entry.providerId)).toEqual(expect.arrayContaining(['aliyun', 'volcengine']));
    }
  });
  it('starts empty without creating a file and never publishes a key', async () => {
    const { runtime, dataDir } = await fixture();
    expect(await runtime.getPublicConfiguration()).toMatchObject({ version: 1, revision: 0, connections: [], bindings: [] });
    await expect(fs.stat(path.join(dataDir, 'model-configuration.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const saved = await connect(runtime);
    expect(saved.connections[0].hasApiKey).toBe(true);
    expect(JSON.stringify(saved)).not.toContain('fixture-private-key');
    const mode = (await fs.stat(path.join(dataDir, 'model-configuration.json'))).mode & 0o777;
    expect(mode).toBe(0o600);
    const reloaded = createModelConfigurationRuntime({ dataDir, enterpriseOptions: { env: {}, readFile: noPolicyFile } });
    await bind(reloaded, saved);
    expect(await reloaded.resolveBinding('embedding', { supportedProtocols: ['openai-compatible'] })).toMatchObject({ apiKey: 'fixture-private-key', model: 'fixture-model' });
  });
  it('keeps a key on metadata edits and requires replacement when its destination changes', async () => {
    const { runtime } = await fixture();
    const state = await connect(runtime);
    const connection = state.connections[0];
    const { hasApiKey, ...editable } = connection;
    expect(hasApiKey).toBe(true);
    const renamed = await runtime.saveConnection({ revision: 1, connection: { ...editable, name: 'Renamed' } });
    expect(renamed.connections[0]).toMatchObject({ name: 'Renamed', hasApiKey: true });
    await expect(runtime.saveConnection({ revision: 2, connection: { ...editable, baseUrl: 'https://another.example.test/v1' } })).rejects.toMatchObject({ code: 'model_configuration_replacement_key_required' });
    expect((await runtime.getPublicConfiguration()).revision).toBe(2);
  });
  it('refuses malformed stored data without replacing it with empty state', async () => {
    const { runtime, dataDir } = await fixture();
    const filePath = path.join(dataDir, 'model-configuration.json');
    await fs.writeFile(filePath, '{broken configuration');
    await expect(runtime.getPublicConfiguration()).rejects.toMatchObject({ code: 'model_configuration_malformed' });
    await expect(connect(runtime)).rejects.toMatchObject({ code: 'model_configuration_malformed' });
    expect(await fs.readFile(filePath, 'utf8')).toBe('{broken configuration');
  });

  it('refuses an extra connection before it can make the persisted configuration unreadable', async () => {
    const { runtime, dataDir } = await fixture();
    const filePath = path.join(dataDir, 'model-configuration.json');
    const state = { version: 1, revision: 100, bindings: [], connections: Array.from({ length: 100 }, (_, index) => ({ ...connectionInput(), id: `connection-${index}` })) };
    await fs.writeFile(filePath, JSON.stringify(state));
    const before = await fs.readFile(filePath, 'utf8');
    await expect(runtime.saveConnection({ revision: 100, connection: connectionInput() })).rejects.toMatchObject({ code: 'model_configuration_invalid_input', status: 400 });
    expect(await fs.readFile(filePath, 'utf8')).toBe(before);
    expect((await runtime.getPublicConfiguration()).connections).toHaveLength(100);
    expect((await runtime.getPublicConfiguration()).revision).toBe(100);
  });
  it('rejects unrecognized fields, URL credentials and duplicate persisted IDs', async () => {
    const { runtime, dataDir } = await fixture();
    await expect(connect(runtime, { oauth: 'not-a-key' })).rejects.toMatchObject({ code: 'model_configuration_invalid_input' });
    await expect(connect(runtime, { baseUrl: 'https://user:password@example.test/v1' })).rejects.toMatchObject({ code: 'model_configuration_invalid_input' });
    const state = await connect(runtime);
    const filePath = path.join(dataDir, 'model-configuration.json');
    const stored = JSON.parse(await fs.readFile(filePath, 'utf8'));
    stored.connections.push(stored.connections[0]);
    await fs.writeFile(filePath, JSON.stringify(stored));
    await expect(runtime.getPublicConfiguration()).rejects.toMatchObject({ code: 'model_configuration_malformed' });
    expect(state.revision).toBe(1);
  });
  it('serializes writes and rejects an older revision', async () => {
    const { runtime } = await fixture();
    const results = await Promise.allSettled([connect(runtime), connect(runtime, { name: 'Concurrent' })]);
    expect(results.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((entry) => entry.status === 'rejected').reason.code).toBe('model_configuration_revision_conflict');
    expect((await runtime.getPublicConfiguration()).connections).toHaveLength(1);
  });
  it('rejects another process lock without touching persisted data', async () => {
    const { runtime, dataDir } = await fixture();
    await fs.writeFile(path.join(dataDir, 'model-configuration.json.lock'), 'another writer');
    await expect(connect(runtime)).rejects.toMatchObject({ code: 'model_configuration_busy' });
    expect((await runtime.getPublicConfiguration()).revision).toBe(0);
  });
  it('prevents deleting a referenced connection and preserves native OpenCode ownership', async () => {
    const { runtime } = await fixture();
    let state = await connect(runtime);
    state = await bind(runtime, state);
    await expect(runtime.removeConnection(state.connections[0].id, { revision: state.revision })).rejects.toMatchObject({ code: 'model_configuration_connection_in_use' });
    await expect(bind(runtime, state, {}, 'agent')).rejects.toMatchObject({ code: 'model_configuration_native_purpose' });
    state = await runtime.saveBinding('embedding', { revision: state.revision, binding: null });
    expect((await runtime.removeConnection(state.connections[0].id, { revision: state.revision })).connections).toHaveLength(0);
  });
  it('does not apply a preset to another provider/model or unsupported consumer protocol', async () => {
    const { runtime } = await fixture();
    const state = await connect(runtime);
    await expect(bind(runtime, state, { presetId: 'qwen-embedding' })).rejects.toMatchObject({ code: 'model_configuration_incompatible_preset' });
    await bind(runtime, state);
    await expect(runtime.resolveBinding('embedding', { supportedProtocols: ['aliyun'] })).rejects.toMatchObject({ code: 'model_configuration_unsupported_protocol' });
  });
  it('saves recommendations needing adapters without pretending they are executable', async () => {
    const { runtime } = await fixture();
    const state = await connect(runtime, { providerId: 'aliyun', protocol: 'aliyun' });
    await bind(runtime, state, { presetId: 'qwen-tts', model: 'qwen-audio-3.1-tts-plus', parameters: {} }, 'tts');
    await expect(runtime.resolveBinding('tts', { supportedProtocols: ['aliyun'] })).rejects.toMatchObject({ code: 'model_configuration_unsupported_protocol' });
  });
  it('keeps planned video unavailable even when configured', async () => {
    const { runtime } = await fixture();
    const state = await connect(runtime);
    await bind(runtime, state, {}, 'video-generation');
    await expect(runtime.resolveBinding('video-generation')).rejects.toMatchObject({ code: 'model_configuration_not_connected' });
  });
  it('validates knowledge changes before saving and checks linked connection rotation', async () => {
    let rejectChanges = false;
    const changes = [];
    const { runtime } = await fixture({ prepareBindingChange: async (purpose, next, previous) => {
      changes.push({ purpose, next, previous });
      if (rejectChanges) throw Object.assign(new Error('Indexed model must stay'), { code: 'embedding_rebuild_required' });
    } });
    let state = await connect(runtime);
    state = await bind(runtime, state);
    expect(changes[0].next.parameters.dimensions).toBe(2);
    rejectChanges = true;
    await expect(bind(runtime, state, { model: 'different-space' })).rejects.toMatchObject({ code: 'embedding_rebuild_required' });
    const { hasApiKey, ...editable } = state.connections[0];
    expect(hasApiKey).toBe(true);
    await expect(runtime.saveConnection({ revision: state.revision, connection: { ...editable, apiKey: 'rotated' } })).rejects.toMatchObject({ code: 'embedding_rebuild_required' });
    expect((await runtime.getPublicConfiguration()).revision).toBe(state.revision);
    expect((await runtime.resolveBinding('embedding')).apiKey).toBe('fixture-private-key');
  });
  it('enforces provider entry and invocation guards at use time', async () => {
    const env = {};
    const { runtime } = await fixture({ enterpriseOptions: { env, readFile: noPolicyFile } });
    let state = await connect(runtime);
    state = await bind(runtime, state);
    env.OPENCHAMBER_ENTERPRISE_MODE = '1';
    await expect(runtime.saveConnection({ revision: state.revision, connection: connectionInput() })).rejects.toMatchObject({ code: 'enterprise_mode' });
    await expect(runtime.resolveBinding('embedding')).rejects.toMatchObject({ code: 'enterprise_mode' });
    await runtime.saveBinding('embedding', { revision: state.revision, binding: null });
    expect((await runtime.getPublicConfiguration()).enterpriseMode).toBe(true);
  });
});

describe('purpose-specific server probes', () => {
  it('verifies dimensions and consumes the actual saved key/endpoint at invocation', async () => {
    const requests = [];
    const { runtime } = await fixture({ fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return Response.json({ data: [{ embedding: [0.1, 0.2] }] });
    } });
    let state = await connect(runtime);
    state = await bind(runtime, state);
    const verified = await runtime.testBinding('embedding', { revision: state.revision });
    expect(verified.bindings[0].verification.status).toBe('verified');
    expect(requests[0].url).toBe('https://api.example.test/v1/embeddings');
    expect(requests[0].init.headers.Authorization).toBe('Bearer fixture-private-key');
    expect(JSON.parse(requests[0].init.body)).toMatchObject({ model: 'fixture-model', dimensions: 2 });
    const { hasApiKey, ...editable } = verified.connections[0];
    expect(hasApiKey).toBe(true);
    const rotated = await runtime.saveConnection({ revision: verified.revision, connection: { ...editable, apiKey: 'rotated-private-key' } });
    expect(rotated.bindings[0].verification.status).toBe('untested');
    expect((await runtime.resolveBinding('embedding')).apiKey).toBe('rotated-private-key');
  });
  it('records invalid provider payloads as failed, never verified', async () => {
    const { runtime } = await fixture({ fetchImpl: async () => Response.json({ data: [{ embedding: [0.1] }] }) });
    let state = await connect(runtime);
    state = await bind(runtime, state);
    state = await runtime.testBinding('embedding', { revision: state.revision });
    expect(state.bindings[0].verification).toMatchObject({ status: 'failed', errorCode: 'model_configuration_dimension_mismatch' });
  });

  it('leaves a valid binding untested when its probe belongs to the consuming component', async () => {
    let providerCalls = 0;
    const { runtime } = await fixture({ fetchImpl: async () => { providerCalls += 1; return Response.json({ text: 'test' }); } });
    let state = await connect(runtime);
    state = await bind(runtime, state, { parameters: {} }, 'stt-realtime');
    await expect(runtime.testBinding('stt-realtime', { revision: state.revision })).rejects.toMatchObject({ code: 'model_configuration_probe_unavailable', status: 501 });
    expect(providerCalls).toBe(0);
    expect((await runtime.getPublicConfiguration()).bindings[0].verification.status).toBe('untested');
  });

  it('parses mutations behind the production request middleware and never echoes malformed JSON', async () => {
    const { runtime } = await fixture();
    const app = express();
    registerCommonRequestMiddleware(app, { express });
    registerModelConfigurationRoutes(app, { runtime });
    const created = await request(app).post('/api/model-configuration/connections').send({ revision: 0, connection: connectionInput() });
    expect(created.status).toBe(200);
    expect(created.body.connections).toHaveLength(1);
    expect(JSON.stringify(created.body)).not.toContain('fixture-private-key');
    const id = created.body.connections[0].id;
    const binding = await request(app).put('/api/model-configuration/bindings/embedding').send({ revision: 1, binding: { connectionId: id, model: 'test-embedding', parameters: { dimensions: 2 } } });
    expect(binding.status).toBe(200);
    const cleared = await request(app).put('/api/model-configuration/bindings/embedding').send({ revision: 2, binding: null });
    expect(cleared.status).toBe(200);
    const removed = await request(app).delete(`/api/model-configuration/connections/${id}`).send({ revision: 3 });
    expect(removed.status).toBe(200);
    expect(removed.body.connections).toEqual([]);
    const malformed = await request(app).post('/api/model-configuration/connections').set('Content-Type', 'application/json').send('{ fixture-private-marker');
    expect(malformed.status).toBe(400);
    expect(JSON.stringify(malformed.body)).not.toContain('fixture-private-marker');
  });
  it('does not allow a late probe to overwrite a newer model choice', async () => {
    let resolveResponse;
    const response = new Promise((resolve) => { resolveResponse = resolve; });
    let requestStarted;
    const started = new Promise((resolve) => { requestStarted = resolve; });
    const { runtime } = await fixture({ fetchImpl: async () => { requestStarted(); return response; } });
    let state = await connect(runtime);
    state = await bind(runtime, state);
    const probing = runtime.testBinding('embedding', { revision: state.revision });
    await started;
    state = await bind(runtime, state, { model: 'newer-model' });
    resolveResponse(Response.json({ data: [{ embedding: [1, 2] }] }));
    await expect(probing).rejects.toMatchObject({ code: 'model_configuration_revision_conflict' });
    expect((await runtime.getPublicConfiguration()).bindings[0]).toMatchObject({ model: 'newer-model', verification: { status: 'untested' } });
  });
  it('uses provider-family paths without copying keys into responses', async () => {
    const calls = [];
    const { runtime } = await fixture({ fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return Response.json({ output: { results: [{ index: 0, relevance_score: 0.9 }] } });
    } });
    let state = await connect(runtime, { providerId: 'aliyun', protocol: 'aliyun', baseUrl: 'https://workspace.cn-beijing.maas.aliyuncs.com' });
    state = await bind(runtime, state, { parameters: {} }, 'rerank');
    const tested = await runtime.testBinding('rerank', { revision: state.revision });
    expect(calls[0].url).toBe('https://workspace.cn-beijing.maas.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank');
    expect(calls[0].body.input.documents).toHaveLength(2);
    expect(tested.bindings[0].verification.status).toBe('verified');
    expect(JSON.stringify(tested)).not.toContain('fixture-private-key');
  });
  it('routes return stable errors without echoing malformed bodies or secrets', async () => {
    const { runtime } = await fixture();
    const app = express();
    app.use(express.json());
    registerModelConfigurationRoutes(app, { runtime });
    const result = await request(app).post('/api/model-configuration/connections').send({ revision: 0, connection: connectionInput({ unexpectedSecret: 'never-echo-this' }) });
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: 'model_configuration_invalid_input', code: 'model_configuration_invalid_input' });
    expect(JSON.stringify(result.body)).not.toContain('never-echo-this');
  });
  it('probes Jev through its native request and validates the classification answer', async () => {
    const calls = [];
    let valid = true;
    const { runtime } = await fixture({ fetchImpl: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return Response.json({ answers: { probe: valid ? { choice: 'blue', confidence: 1 } : { message: 'not a classification answer' } } });
    } });
    let state = await connect(runtime, { providerId: 'jev', protocol: 'jev', baseUrl: 'https://api.typesafe.ai/v1/systemone' });
    state = await bind(runtime, state, { presetId: 'jev-routing', model: 'jev-latest', parameters: {} }, 'routing');
    state = await runtime.testBinding('routing', { revision: state.revision });
    expect(state.bindings[0].verification.status).toBe('verified');
    expect(calls[0]).toMatchObject({ url: 'https://api.typesafe.ai/v1/systemone', body: { model: 'jev-latest', questions: { probe: { type: 'choice' } } }, init: { redirect: 'error', headers: { Authorization: 'Bearer fixture-private-key' } } });
    valid = false;
    state = await runtime.testBinding('routing', { revision: state.revision });
    expect(state.bindings[0].verification).toMatchObject({ status: 'failed', errorCode: 'model_configuration_invalid_provider_response' });
  });
});
