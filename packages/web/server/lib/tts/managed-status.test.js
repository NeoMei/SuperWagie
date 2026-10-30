import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createModelConfigurationRuntime } from '../model-configuration/runtime.js';
import { registerTtsRoutes } from './routes.js';
import { createPlatformModelRuntime } from '../platform-model/runtime.js';

const directories = [];
const absentPolicy = () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); };
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('managed speech readiness', () => {
  it('refuses managed speech before resolving identity or creating a task when the runtime disables it', async () => {
    let identityReads = 0;
    let admissions = 0;
    let dispatches = 0;
    const app = express(); app.use(express.json());
    registerTtsRoutes(app, {
      resolveModelBinding: async () => ({ protocol: 'managed-media', model: 'speech', parameters: {} }),
      getPlatformModelRuntime: () => ({ isMediaOperationConfigured: () => false, admitMediaTask: () => { admissions++; }, mediaDispatch: () => { dispatches++; } }),
      resolvePlatformIdentity: async () => { identityReads++; return {}; },
    });
    const result = await request(app).post('/api/tts/speak').send({ text: 'hello' });
    expect(result.status).toBe(503);
    expect(result.body.code).toBe('platform_media_recovery_unavailable');
    expect([identityReads, admissions, dispatches]).toEqual([0, 0, 0]);
  });
  it('refuses managed transcription before identity, task admission or dispatch', async () => {
    let identityReads = 0; let admissions = 0; let dispatches = 0;
    const app = express();
    registerTtsRoutes(app, {
      resolveModelBinding: async () => ({ protocol: 'managed-media', model: 'asr', parameters: {} }),
      getPlatformModelRuntime: () => ({ isMediaOperationConfigured: () => false, admitMediaTask: () => { admissions++; }, mediaDispatch: () => { dispatches++; } }),
      resolvePlatformIdentity: async () => { identityReads++; return {}; },
    });
    const result = await request(app).post('/api/stt/transcribe').set('content-type', 'audio/webm').send(Buffer.from('audio'));
    expect(result.status).toBe(503);
    expect(result.body.code).toBe('platform_media_recovery_unavailable');
    expect([identityReads, admissions, dispatches]).toEqual([0, 0, 0]);
  });
  it('reports the real managed binding as available without exposing credentials', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-tts-status-'));
    directories.push(dataDir);
    const configuration = createModelConfigurationRuntime({ dataDir, enterpriseOptions: { env: {}, readFile: absentPolicy } });
    let state = await configuration.saveConnection({ revision: 0, connection: { name: 'Managed', providerId: 'unihub', protocol: 'managed-media', baseUrl: 'https://llmrouter.example.test/platform/v1', apiKey: 'private-fixture' } });
    state = await configuration.saveBinding('tts', { revision: state.revision, binding: { connectionId: state.connections[0].id, model: 'speech-model', parameters: { voice: 'Cherry' } } });
    const app = express();
    let active = true;
    let enabled = true;
    registerTtsRoutes(app, { resolveModelBinding: configuration.resolveBinding, getPlatformModelRuntime: () => active ? ({ enabled: () => enabled, isMediaOperationConfigured: (model, operation) => model === 'speech-model' && operation === 'speech', admitMediaTask() {}, mediaDispatch() {} }) : null, resolvePlatformIdentity: async () => ({}) });
    const response = await request(app).get('/api/tts/status');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ available: true, configuredBinding: true, voices: ['Cherry'] });
    expect(JSON.stringify(response.body)).not.toContain('private-fixture');
    active = false;
    const unavailable = await request(app).get('/api/tts/status');
    expect(unavailable.body).toMatchObject({ available: false, configuredBinding: true });
    active = true;
    enabled = false;
    const disabled = await request(app).get('/api/tts/status');
    expect(disabled.body).toMatchObject({ available: false, configuredBinding: true });
    enabled = true;
    vi.stubEnv('OPENCHAMBER_ENTERPRISE_MODE', '1');
    const enterprise = await request(app).get('/api/tts/status');
    expect(enterprise.body).toMatchObject({ available: false, configuredBinding: true, enterpriseMode: true });
  });

  it('reports locally allowlisted models and operations without claiming account authorization', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-tts-runtime-'));
    directories.push(dataDir);
    const configuration = createModelConfigurationRuntime({ dataDir, enterpriseOptions: { env: {}, readFile: absentPolicy } });
    let state = await configuration.saveConnection({ revision: 0, connection: { name: 'Managed', providerId: 'unihub', protocol: 'managed-media', baseUrl: 'https://llmrouter.example.test/platform/v1', apiKey: 'private-fixture' } });
    state = await configuration.saveBinding('tts', { revision: state.revision, binding: { connectionId: state.connections[0].id, model: 'excluded', parameters: {} } });
    const runtime = await createPlatformModelRuntime({ dataDir, instanceDir: path.join(dataDir, 'instance'), env: { OPENCHAMBER_UNIHUB_GATEWAY_URL: 'http://127.0.0.1:54321/platform/v1', OPENCHAMBER_UNIHUB_MODELS: JSON.stringify([{ id: 'chat', name: 'chat', context: 1024, maxOutput: 100 }]), OPENCHAMBER_UNIHUB_MEDIA_MODELS: JSON.stringify(['allowed']) }, getAccountRuntime: () => { throw new Error('status must not read account'); }, readExecution: async () => null, enterprise: () => false });
    try {
      const app = express();
      registerTtsRoutes(app, { resolveModelBinding: configuration.resolveBinding, getPlatformModelRuntime: () => runtime, resolvePlatformIdentity: async () => { throw new Error('status must not read identity'); } });
      const excluded = await request(app).get('/api/tts/status');
      expect(excluded.body).toMatchObject({ available: false, configuredBinding: true, accountAuthorization: 'not_checked' });
      state = await configuration.saveBinding('tts', { revision: state.revision, binding: { connectionId: state.connections[0].id, model: 'allowed', parameters: {} } });
      const allowed = await request(app).get('/api/tts/status');
      expect(allowed.body).toMatchObject({ available: false, configuredBinding: true, accountAuthorization: 'not_checked' });
      expect(runtime.isMediaOperationConfigured('allowed', 'speech')).toBe(false);
      expect(runtime.isMediaOperationConfigured('allowed', 'video')).toBe(true);
      expect(runtime.isMediaOperationConfigured('allowed', 'not-an-operation')).toBe(false);
    } finally { await runtime.close(); }
  });

  it('preserves an unbound local speech selection even with an available managed default', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-tts-default-'));
    directories.push(dataDir);
    const runtime = await createPlatformModelRuntime({ dataDir, instanceDir: path.join(dataDir, 'instance'), env: { OPENCHAMBER_UNIHUB_GATEWAY_URL: 'http://127.0.0.1:54321/platform/v1', OPENCHAMBER_UNIHUB_MODELS: JSON.stringify([{ id: 'chat', name: 'chat', context: 1024, maxOutput: 100 }]), OPENCHAMBER_UNIHUB_MEDIA_MODELS: JSON.stringify(['speech-model']) }, getAccountRuntime: () => { throw new Error('must not access account'); }, readExecution: async () => null, enterprise: () => false });
    let requests = 0;
    const local = createServer((_req, res) => { requests += 1; res.writeHead(200, { 'content-type': 'audio/mpeg' }); res.end('local'); });
    await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve));
    const app = express(); app.use(express.json());
    registerTtsRoutes(app, { resolveModelBinding: async () => null, getPlatformModelRuntime: () => runtime, resolvePlatformIdentity: async () => { throw new Error('must not access managed identity'); } });
    try {
      const status = await request(app).get('/api/tts/status');
      expect(status.body.configuredBinding).toBe(false);
      const spoken = await request(app).post('/api/tts/speak').send({ text: 'hello', baseURL: `http://127.0.0.1:${local.address().port}/v1` });
      expect(spoken.status).toBe(200);
      expect(spoken.body.toString()).toBe('local');
      expect(requests).toBe(1);
    } finally { await runtime.close(); local.closeAllConnections(); await new Promise((resolve) => local.close(resolve)); }
  });

  it('uses a local speech endpoint when enterprise mode disables the unbound managed default', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'enterprise-local-speech-'));
    directories.push(dataDir);
    const runtime = await createPlatformModelRuntime({ dataDir, instanceDir: path.join(dataDir, 'instance'), env: { OPENCHAMBER_UNIHUB_GATEWAY_URL: 'http://127.0.0.1:54321/platform/v1', OPENCHAMBER_UNIHUB_MODELS: JSON.stringify([{ id: 'chat', name: 'chat', context: 1024, maxOutput: 100 }]), OPENCHAMBER_UNIHUB_MEDIA_MODELS: JSON.stringify(['speech-model']) }, getAccountRuntime: () => { throw new Error('must not access account'); }, readExecution: async () => null, enterprise: () => true });
    const requests = [];
    const local = createServer(async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      requests.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
      res.writeHead(200, { 'content-type': 'audio/mpeg' }); res.end('local-audio');
    });
    await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve));
    vi.stubEnv('OPENCHAMBER_ENTERPRISE_MODE', '1');
    const app = express(); app.use(express.json());
    registerTtsRoutes(app, { resolveModelBinding: async () => null, getPlatformModelRuntime: () => runtime, resolvePlatformIdentity: async () => { throw new Error('must not query managed identity'); } });
    try {
      const status = await request(app).get('/api/tts/status');
      expect(status.body).toMatchObject({ available: false, configuredBinding: false, enterpriseMode: true });
      const spoken = await request(app).post('/api/tts/speak').send({ text: 'hello', baseURL: `http://127.0.0.1:${local.address().port}/v1`, model: 'local-speech' });
      expect(spoken.status).toBe(200);
      expect(spoken.body.toString()).toBe('local-audio');
      expect(requests).toMatchObject([{ url: '/v1/audio/speech', body: { input: 'hello', model: 'local-speech' } }]);
      const cloud = await request(app).post('/api/tts/speak').send({ text: 'hello' });
      expect(cloud.status).toBe(403);
      expect(requests).toHaveLength(1);
    } finally { await runtime.close(); local.closeAllConnections(); await new Promise((resolve) => local.close(resolve)); }
  });

  it.each([null, 5, ''])('rejects invalid speech input before any model admission (%s)', async (text) => {
    let admissions = 0;
    const app = express(); app.use(express.json());
    registerTtsRoutes(app, { resolveModelBinding: async () => ({ protocol: 'managed-media', model: 'speech', parameters: {} }), getPlatformModelRuntime: () => ({ admitMediaTask() { admissions += 1; }, mediaDispatch() {} }), resolvePlatformIdentity: async () => ({}) });
    const response = await request(app).post('/api/tts/speak').send({ text });
    expect(response.status).toBe(400);
    expect(admissions).toBe(0);
  });
});
