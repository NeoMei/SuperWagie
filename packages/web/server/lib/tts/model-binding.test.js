import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import express from 'express';
import request from 'supertest';

import { registerTtsRoutes } from './routes.js';
import { createDictationService } from '../dictation/service.js';

const servers = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function fixture(handler) {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}/v1`;
}

function appWithBinding(resolveModelBinding, extra = {}) {
  const app = express();
  app.use(express.json());
  registerTtsRoutes(app, { resolveModelBinding, ...extra });
  return app;
}

describe('unified speech model bindings', () => {
  it('uses the selected speech endpoint, key, model and voice instead of request defaults', async () => {
    let received;
    const baseUrl = await fixture(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      received = { url: req.url, key: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) };
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      res.end('speech');
    });
    const app = appWithBinding(async (purpose, options) => {
      expect(purpose).toBe('tts');
      expect(options.supportedProtocols).toEqual(['openai-compatible', 'minimax', 'managed-media']);
      return { protocol: 'openai-compatible', baseUrl, apiKey: 'fixture-key', model: 'selected-speech', parameters: { voice: 'selected-voice' } };
    });
    const result = await request(app).post('/api/tts/speak').send({ text: 'Hello', model: 'stale-model', voice: 'stale-voice', apiKey: 'stale-key' });
    expect(result.status).toBe(200);
    expect(received).toMatchObject({ url: '/v1/audio/speech', key: 'Bearer fixture-key', body: { model: 'selected-speech', voice: 'selected-voice', input: 'Hello' } });
  });


  it('keeps configured playback unavailable when resolution fails and restores absence after clear', async () => {
    let configured = true;
    const app = appWithBinding(async () => {
      if (configured) throw Object.assign(new Error('private credential failure'), { code: 'model_configuration_credential_missing' });
      return null;
    });
    const failed = await request(app).get('/api/tts/status');
    expect(failed.status).toBe(200);
    expect(failed.body).toMatchObject({ available: false, configuredBinding: true });
    expect(JSON.stringify(failed.body)).not.toContain('private credential failure');
    configured = false;
    const cleared = await request(app).get('/api/tts/status');
    expect(cleared.status).toBe(200);
    expect(cleared.body.configuredBinding).toBe(false);
  });

  it('uses the selected short transcription binding without requiring legacy headers', async () => {
    let received;
    const baseUrl = await fixture(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = await new Response(Buffer.concat(chunks), { headers: { 'content-type': req.headers['content-type'] } }).formData();
      received = { url: req.url, key: req.headers.authorization, model: body.get('model') };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: 'selected transcription' }));
    });
    const app = appWithBinding(async (purpose) => {
      expect(purpose).toBe('stt-short');
      return { protocol: 'openai-compatible', baseUrl, apiKey: 'fixture-stt', model: 'selected-transcribe', parameters: {} };
    });
    const result = await request(app).post('/api/stt/transcribe').set('content-type', 'audio/webm').send(Buffer.from('audio'));
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ transcript: 'selected transcription' });
    expect(received).toEqual({ url: '/v1/audio/transcriptions', key: 'Bearer fixture-stt', model: 'selected-transcribe' });
  });

  it('journeys managed short transcription through the platform runtime without supplier keys', async () => {
    const admitted = [];
    const dispatched = [];
    const app = appWithBinding(async (purpose, options) => {
      expect(purpose).toBe('stt-short');
      expect(options.supportedProtocols).toEqual(['openai-compatible', 'managed-media']);
      return { protocol: 'managed-media', model: 'qwen3-asr-flash', parameters: {} };
    }, {
      getPlatformModelRuntime: () => ({
        isMediaOperationConfigured: () => true,
        admitMediaTask: async (identity, request) => {
          admitted.push({ identity, model: request.model.id });
          return { sessionID: 'media_stt_session' };
        },
        mediaDispatch: async (context) => {
          dispatched.push(context);
          return { transcript: 'managed transcription', seconds: 1 };
        },
      }),
      resolvePlatformIdentity: async () => ({ type: 'client', token: 'fixture-identity' }),
    });
    const audio = Buffer.from('audio');
    const result = await request(app).post('/api/stt/transcribe').set('content-type', 'audio/webm').send(audio);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ transcript: 'managed transcription' });
    expect(admitted).toEqual([{ identity: { type: 'client', token: 'fixture-identity' }, model: 'qwen3-asr-flash' }]);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ model: 'qwen3-asr-flash', operation: 'transcription', sessionID: 'media_stt_session' });
    expect(dispatched[0].inputs.audioDataUri).toBe('data:audio/webm;base64,' + audio.toString('base64'));
  });

  it('rejects unsupported saved protocols without using legacy credentials', async () => {
    const app = appWithBinding(async () => { throw Object.assign(new Error('Selected protocol is not supported by speech playback'), { code: 'model_configuration_unsupported_protocol', status: 409 }); });
    const result = await request(app).post('/api/tts/speak').send({ text: 'Hello' });
    expect(result.status).toBe(409);
    expect(result.body.code).toBe('model_configuration_unsupported_protocol');
  });


  it('journeys managed-media bindings through the platform runtime without supplier keys', async () => {
    const dispatched = [];
    const admitted = [];
    const app = appWithBinding(async () => ({ protocol: 'managed-media', model: 'qwen3-tts-flash', parameters: { voice: 'Cherry' } }), {
      getPlatformModelRuntime: () => ({
        isMediaOperationConfigured: () => true,
        admitMediaTask: async (identity, request) => {
          admitted.push({ identity, model: request.model.id });
          return { sessionID: 'media_fixture_session', taskID: 'uh_task_fixture', model: request.model.id };
        },
        mediaDispatch: async (ctx) => {
          dispatched.push(ctx);
          return { buffer: Buffer.from('managed-audio'), contentType: 'audio/mpeg' };
        },
      }),
      resolvePlatformIdentity: async () => ({ type: 'client', token: 'fixture-identity' }),
    });
    const result = await request(app).post('/api/tts/speak').send({ text: 'Hello' });
    expect(result.status).toBe(200);
    expect(Buffer.from(result.body).toString('utf8')).toBe('managed-audio');
    expect(result.headers['content-type']).toBe('audio/mpeg');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].model).toBe('qwen3-tts-flash');
    expect(dispatched[0].operation).toBe('speech');
    expect(dispatched[0].inputs).toEqual({ text: 'Hello', voice: 'Cherry' });
    expect(dispatched[0].identity).toEqual({ type: 'client', token: 'fixture-identity' });
    expect(dispatched[0].sessionID).toBe('media_fixture_session');
    expect(admitted).toEqual([{ identity: { type: 'client', token: 'fixture-identity' }, model: 'qwen3-tts-flash' }]);
  });

  it('surfaces a configured managed admission refusal without falling back', async () => {
    const app = appWithBinding(async () => ({ protocol: 'managed-media', model: 'qwen3-tts-flash', parameters: {} }), {
      getPlatformModelRuntime: () => ({
        isMediaOperationConfigured: () => true,
        admitMediaTask: async () => { const error = new Error('insufficient_funds'); error.status = 402; error.code = 'insufficient_funds'; throw error; },
        mediaDispatch: async () => { throw new Error('must not dispatch'); },
      }),
      resolvePlatformIdentity: async () => ({ type: 'client', token: 'session-identity' }),
    });
    const result = await request(app).post('/api/tts/speak').send({ text: 'Hello' });
    expect(result.status).toBe(402);
  });

  it('exposes only the actionable managed scope refusal for configured speech', async () => {
    const app=appWithBinding(async () => ({protocol:'managed-media',model:'qwen3-tts-flash',parameters:{}}), {
      getPlatformModelRuntime:()=>({isMediaOperationConfigured:()=>true,admitMediaTask:async()=>{throw Object.assign(new Error('private'),{code:'platform_model_scope_restart_required',status:403});}, mediaDispatch:async()=>{throw new Error('must not dispatch');}}),
      resolvePlatformIdentity:async()=>({type:'client',token:'fixture-owner'}),
    });
    const response=await request(app).post('/api/tts/speak').send({text:'Hello'});
    expect(response.status).toBe(403); expect(response.body).toEqual({error:'platform_model_scope_restart_required'});
  });
  it('returns 503 when the managed runtime is unavailable without touching credentials', async () => {
    const app = appWithBinding(async () => ({ protocol: 'managed-media', model: 'qwen3-tts-flash', parameters: {} }), {
      getPlatformModelRuntime: () => null,
    });
    const result = await request(app).post('/api/tts/speak').send({ text: 'Hello' });
    expect(result.status).toBe(503);
  });

  it('does not expose a provider-echoed server key through speech, short transcription, dictation or logs', async () => {
    const privateMarker = 'fixture-private-key-marker';
    const logs = [];
    vi.spyOn(console, 'error').mockImplementation((...args) => logs.push(args.map(String).join(' ')));
    vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.map(String).join(' ')));
    const baseUrl = await fixture(async (req, res) => {
      for await (const chunk of req) void chunk;
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Rejected credential ${privateMarker}`, type: 'authentication_error' } }));
    });
    const resolveModelBinding = async () => ({ protocol: 'openai-compatible', baseUrl, apiKey: privateMarker, model: 'selected-model', parameters: {} });
    const app = appWithBinding(resolveModelBinding);
    const speech = await request(app).post('/api/tts/speak').send({ text: 'Hello' });
    const short = await request(app).post('/api/stt/transcribe').set('content-type', 'audio/webm').send(Buffer.from('audio'));
    expect(speech.status).toBe(502);
    expect(short.status).toBe(502);
    expect(speech.body.code).toBe('model_configuration_provider_failed');
    expect(short.body.code).toBe('model_configuration_provider_failed');
    const service = createDictationService({ modelsDir: '/unused', resolveModelBinding });
    const { session } = await service.createSttSession({ provider: 'openai-compatible' });
    const failure = new Promise((resolve) => session.once('error', resolve));
    session.appendPcm16(Buffer.alloc(3200));
    session.commit();
    const error = await failure;
    expect(error.code).toBe('model_configuration_provider_failed');
    expect([JSON.stringify(speech.body), JSON.stringify(short.body), error.message, ...logs].join(' ')).not.toContain(privateMarker);
    session.close();
    service.shutdown();
  });

  it('uses the configured dictation model over legacy local preferences and restores local after clear', async () => {
    let resolutions = 0;
    let configured = true;
    const service = createDictationService({ modelsDir: '/unused', resolveModelBinding: async () => {
      resolutions += 1;
      return configured ? { baseUrl: 'http://127.0.0.1:1/v1', model: 'configured-stt', apiKey: 'fixture-key', parameters: {} } : null;
    } });
    expect(await service.getStatus()).toMatchObject({ provider: 'openai-compatible', available: true, activeModel: 'configured-stt' });
    expect(await service.getStatus({ provider: 'local' })).toMatchObject({ provider: 'openai-compatible', available: true, activeModel: 'configured-stt' });
    configured = false;
    expect(await service.getStatus({ provider: 'local' })).toMatchObject({ provider: 'local', available: false });
    expect(resolutions).toBe(3);
    service.shutdown();
  });

  it('applies the continuous dictation binding to a real transcription session', async () => {
    let received;
    const baseUrl = await fixture(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = await new Response(Buffer.concat(chunks), { headers: { 'content-type': req.headers['content-type'] } }).formData();
      received = { key: req.headers.authorization, model: body.get('model') };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: 'dictation result' }));
    });
    const service = createDictationService({ modelsDir: '/unused', resolveModelBinding: async (purpose) => {
      expect(purpose).toBe('stt-realtime');
      return { baseUrl, apiKey: 'dictation-key', model: 'dictation-model', parameters: {} };
    } });
    const result = await service.createSttSession({ provider: 'local', openaiCompatible: { baseUrl: 'http://127.0.0.1:1', model: 'stale' } });
    expect(result.error).toBeUndefined();
    const text = new Promise((resolve, reject) => {
      result.session.once('transcript', resolve);
      result.session.once('error', reject);
    });
    result.session.appendPcm16(Buffer.alloc(3200));
    result.session.commit();
    expect(await text).toMatchObject({ transcript: 'dictation result' });
    expect(received).toEqual({ key: 'Bearer dictation-key', model: 'dictation-model' });
    result.session.close();
    service.shutdown();
  });
});
