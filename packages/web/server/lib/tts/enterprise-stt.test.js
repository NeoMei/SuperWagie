import { createServer } from 'node:http';
import { once } from 'node:events';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerTtsRoutes } from './routes.js';
import { createDictationService } from '../dictation/service.js';

const servers = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

const appWith = (resolveModelBinding) => {
  const app = express();
  registerTtsRoutes(app, { resolveModelBinding });
  return app;
};

async function asrFixture() {
  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ url: req.url, key: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ text: 'heard' }));
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { seen, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

describe('speech-to-text enterprise boundary', () => {
  it('returns a visible unbound failure outside enterprise mode', async () => {
    const app = appWith(async () => null);
    const result = await request(app).post('/api/stt/transcribe').set('content-type', 'audio/webm').send(Buffer.from('audio'));
    expect(result.status).toBe(503);
    expect(result.body.code).toBe('stt_not_configured');
  });

  it('fails closed in enterprise mode when no ASR binding is configured', async () => {
    vi.stubEnv('OPENCHAMBER_ENTERPRISE_MODE', '1');
    const app = appWith(async () => null);
    const result = await request(app).post('/api/stt/transcribe').set('content-type', 'audio/webm').send(Buffer.from('audio'));
    expect(result.status).toBe(403);
    expect(result.body.code).toBe('enterprise_mode');
  });

  it('sends configured audio only to the resolved ASR binding', async () => {
    const { seen, baseUrl } = await asrFixture();
    const app = appWith(async (purpose, options) => {
      expect(purpose).toBe('stt-short');
      expect(options.supportedProtocols).toEqual(['openai-compatible']);
      return { protocol: 'openai-compatible', baseUrl, apiKey: 'fixture-key', model: 'qwen3-asr-flash', parameters: {} };
    });
    const result = await request(app).post('/api/stt/transcribe').set('content-type', 'audio/wav').send(Buffer.from('audio'));
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ transcript: 'heard' });
    expect(seen).toEqual([{ url: '/v1/audio/transcriptions', key: 'Bearer fixture-key' }]);
  });

  it('keeps dictation unbound as a visible failure outside enterprise mode', async () => {
    const service = createDictationService({ modelsDir: '/unused', resolveModelBinding: async () => null });
    expect(await service.createSttSession()).toMatchObject({ reasonCode: 'stt_not_configured', retryable: false });
    expect(await service.getStatus()).toMatchObject({ provider: 'openai-compatible', available: false, reasonCode: 'stt_not_configured' });
    service.shutdown();
  });

  it('fails closed for dictation in enterprise mode when no ASR binding is configured', async () => {
    vi.stubEnv('OPENCHAMBER_ENTERPRISE_MODE', '1');
    const service = createDictationService({ modelsDir: '/unused', resolveModelBinding: async () => null });
    expect(await service.createSttSession()).toMatchObject({ reasonCode: 'enterprise_mode', retryable: false });
    expect(await service.getStatus()).toMatchObject({ provider: 'openai-compatible', available: false, reasonCode: 'enterprise_mode' });
    service.shutdown();
  });

  it('surfaces binding resolution failures from dictation status and session creation', async () => {
    const failure = Object.assign(new Error('enterprise_mode'), { code: 'enterprise_mode', status: 403 });
    const service = createDictationService({ modelsDir: '/unused', resolveModelBinding: async () => { throw failure; } });
    expect(await service.createSttSession()).toMatchObject({ reasonCode: 'enterprise_mode', retryable: false });
    expect(await service.getStatus()).toMatchObject({ provider: 'openai-compatible', available: false, reasonCode: 'enterprise_mode' });
    service.shutdown();
  });
});
