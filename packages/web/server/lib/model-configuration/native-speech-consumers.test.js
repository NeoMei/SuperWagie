import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { createModelConfigurationRuntime } from './runtime.js';
import { createModelBootstrapStore } from './bootstrap-store.js';
import { synthesizeConfiguredSpeechFromDisk } from './resolve-cli.js';
import { registerTtsRoutes } from '../tts/routes.js';
import { configuredDefaultVoice, requestConfiguredSpeech } from '../../builtin-skills/supervideo-engine/src/providers/model-configuration.mjs';
import { validateVoice } from '../../builtin-skills/supervideo-engine/src/providers/tts.mjs';
import { runProcess } from '../../builtin-skills/supervideo-engine/src/providers/process.mjs';

const cleanups = [];
const audio = Buffer.concat([Buffer.from('ID3\u0004'), Buffer.alloc(64)]);
const nativeAudio = Buffer.alloc(48); nativeAudio.write('RIFF'); nativeAudio.write('WAVE', 8);
const resolver = fileURLToPath(new URL('./resolve-cli.js', import.meta.url));
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });
const fixture = async (bailian = false) => {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) });
    res.setHeader('Content-Type', bailian ? 'audio/wav' : 'application/json');
    res.end(bailian ? nativeAudio : JSON.stringify({ base_resp: { status_code: 0 }, data: { audio: audio.toString('hex') } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minimax-tts-consumer-'));
  cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const environment = { OPENCHAMBER_DATA_DIR: dataDir, OPENCHAMBER_LLMROUTER_API_URL: baseUrl };
  const secretStore = createModelBootstrapStore({ dataDir });
  const secret = bailian ? await secretStore.putSecret('private-native-speech-key') : null;
  const runtime = createModelConfigurationRuntime({ dataDir, env: environment, readModelBootstrapCredential: secretStore.getSecret });
  const connection = { name: 'Speech fixture', providerId: bailian ? 'llmrouter' : 'minimax', protocol: bailian ? 'openai-compatible' : 'minimax', baseUrl };
  let state = bailian
    ? await runtime.saveAccountKeyConnection({ revision: 0, connection: { ...connection, id: 'account-speech', credentialSource: { type: 'model-bootstrap', providerId: 'llmrouter', ref: secret.ref } }, apiKey: 'private-native-speech-key', assertCurrent: () => {} })
    : await runtime.saveConnection({ revision: 0, connection: { ...connection, apiKey: 'private-native-speech-key' } });
  state = await runtime.saveBinding('tts', { revision: state.revision, binding: { connectionId: state.connections[0].id, model: bailian ? 'qwen3-tts-flash' : 'speech-2.8-hd', parameters: bailian ? { speechOperation: 'bailian.audio.speech.create' } : { voice: 'male-qn-qingse' } } });
  return { dataDir, runtime, state, requests, environment, secretStore, secret };
};

describe('single Key Bailian speech consumers', () => {
  it('round trips the operation through storage, probes, playback and the private narration CLI', async () => {
    const { dataDir, runtime, state, requests, environment } = await fixture(true);
    expect(await fs.readFile(path.join(dataDir, 'model-bootstrap', 'secrets.json'), 'utf8')).not.toContain('private-native-speech-key');
    expect(await fs.readFile(path.join(dataDir, 'model-configuration.json'), 'utf8')).not.toContain('private-native-speech-key');
    expect((await runtime.testBinding('tts', { revision: state.revision })).bindings[0].verification.status).toBe('verified');
    const app = express(); app.use(express.json());
    registerTtsRoutes(app, { resolveModelBinding: runtime.resolveBinding });
    const spoken = await request(app).post('/api/tts/speak').send({ text: '朗读测试', model: 'ignored', apiKey: 'ignored' });
    expect(spoken.status).toBe(200);
    expect(spoken.body).toEqual(nativeAudio);
    expect((await request(app).get('/api/tts/status')).body).toMatchObject({ available: true, voices: ['Cherry'] });
    const binding = await runtime.resolveBinding('tts');
    const voice = await configuredDefaultVoice({ resolveBinding: async () => binding });
    expect(voice).toEqual({ provider: 'openai-compatible', model: 'qwen3-tts-flash', voice: 'Cherry' });
    expect(validateVoice(voice)).toBe(voice);
    const previousResolver = process.env.SUPERWAGIE_MODEL_RESOLVER;
    process.env.SUPERWAGIE_MODEL_RESOLVER = resolver;
    try {
      const result = await requestConfiguredSpeech('视频旁白测试', voice, { resolveBinding: async () => binding, runResolver: (file, args, options) => runProcess(file, args, { ...options, env: { ...options.env, ...environment } }) });
      expect(result.bytes).toEqual(nativeAudio);
      expect(result.contentType).toBe('audio/wav');
      expect(result.evidence).toMatchObject({ provider: 'bailian', model: 'qwen3-tts-flash', voice: 'Cherry' });
      expect(JSON.stringify(result)).not.toContain('private-native-speech-key');
    } finally {
      if (previousResolver === undefined) delete process.env.SUPERWAGIE_MODEL_RESOLVER;
      else process.env.SUPERWAGIE_MODEL_RESOLVER = previousResolver;
    }
    expect(requests).toHaveLength(3);
    expect(requests.every((entry) => entry.url === '/v1/native/bailian/audio/speech' && entry.authorization === 'Bearer private-native-speech-key' && entry.body.model === 'qwen3-tts-flash' && entry.body.input.voice === 'Cherry')).toBe(true);
  });

  it('refuses a changed destination, stale model or deleted encrypted Key before dispatch', async () => {
    const { dataDir, environment, secretStore, secret, requests } = await fixture(true);
    const input = JSON.stringify({ text: 'Hello', expectedModel: 'qwen3-tts-flash', expectedVoice: 'Cherry' });
    const invoke = (extraEnv = {}, body = input) => runProcess(process.execPath, [resolver, '--synthesize-tts'], { input: body, env: { ...process.env, ...environment, ...extraEnv } });
    const drifted = await invoke({ OPENCHAMBER_LLMROUTER_API_URL: 'https://different.example/v1' });
    expect(drifted).toMatchObject({ code: 1, stdout: '', stderr: 'model_configuration_credential_destination_denied' });
    const stale = await invoke({}, JSON.stringify({ text: 'Hello', expectedModel: 'old-model' }));
    expect(stale).toMatchObject({ code: 1, stdout: '', stderr: 'model_configuration_voice_mismatch' });
    await secretStore.deleteSecret(secret.ref);
    const missing = await invoke();
    expect(missing).toMatchObject({ code: 1, stdout: '', stderr: 'model_configuration_credential_missing' });
    expect(requests).toHaveLength(0);
    expect(JSON.stringify([drifted, stale, missing])).not.toContain('private-native-speech-key');
    expect((await fs.stat(path.join(dataDir, 'model-bootstrap', 'master.key'))).size).toBe(32);
  });
});

describe('managed-media unified speech consumers', () => {
  it('saves a unihub managed-media binding and journeys speech through the platform runtime', async () => {
    const dispatched = [];
    const admitted = [];
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-tts-consumer-'));
    cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
    const runtime = createModelConfigurationRuntime({ dataDir });
    let state = await runtime.saveConnection({ revision: 0, connection: { name: 'LLMRouter managed', providerId: 'unihub', protocol: 'managed-media', baseUrl: 'https://llmrouter.quukk.com/platform/v1', apiKey: 'requires-managed-session' } });
    state = await runtime.saveBinding('tts', { revision: state.revision, binding: { connectionId: state.connections[0].id, model: 'qwen3-tts-flash', parameters: { voice: 'Cherry' } } });
    const binding = await runtime.resolveBinding('tts');
    expect(binding.protocol).toBe('managed-media');
    expect(binding.model).toBe('qwen3-tts-flash');
    const app = express();
    app.use(express.json());
    registerTtsRoutes(app, {
      resolveModelBinding: runtime.resolveBinding,
      getPlatformModelRuntime: () => ({
        isMediaOperationConfigured: () => true,
        admitMediaTask: async (identity, request) => {
          admitted.push({ identity, model: request.model.id });
          return { sessionID: 'media_session', taskID: 'uh_task_managed', model: request.model.id };
        },
        mediaDispatch: async (ctx) => {
          dispatched.push(ctx);
          return { buffer: Buffer.from('managed-audio'), contentType: 'audio/mpeg' };
        },
      }),
      resolvePlatformIdentity: async () => ({ type: 'client', token: 'session-identity' }),
    });
    const spoken = await request(app).post('/api/tts/speak').send({ text: '朗读测试', model: 'ignored', apiKey: 'ignored' });
    expect(spoken.status).toBe(200);
    expect(spoken.body.toString()).toBe('managed-audio');
    expect(admitted[0].model).toBe('qwen3-tts-flash');
    expect(dispatched[0].sessionID).toBe('media_session');
    expect(dispatched[0].inputs).toEqual({ text: '朗读测试', voice: 'Cherry' });
  });
});

describe('MiniMax unified speech consumers', () => {
  it('preserves native input and enterprise refusals as sanitized 400/403 responses', async () => {
    const binding = { protocol: 'minimax', baseUrl: 'https://api.minimax.cn/v1', apiKey: 'private-native-speech-key', model: 'speech-2.8-hd', parameters: {} };
    const app = express();
    app.use(express.json());
    registerTtsRoutes(app, { resolveModelBinding: async () => binding });
    expect((await request(app).post('/api/tts/speak').send({ text: ' ' })).status).toBe(400);
    process.env.OPENCHAMBER_ENTERPRISE_MODE = '1';
    try {
      const denied = await request(app).post('/api/tts/speak').send({ text: 'Hello' });
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe('enterprise_mode');
      expect(JSON.stringify(denied.body)).not.toContain('private-native-speech-key');
    } finally { delete process.env.OPENCHAMBER_ENTERPRISE_MODE; }
  });

  it('probes and reads aloud through the same native speech contract with no legacy fields', async () => {
    const { runtime, state, requests } = await fixture();
    expect((await runtime.testBinding('tts', { revision: state.revision })).bindings[0].verification.status).toBe('verified');
    const app = express();
    app.use(express.json());
    registerTtsRoutes(app, { resolveModelBinding: runtime.resolveBinding });
    const spoken = await request(app).post('/api/tts/speak').send({ text: '朗读测试', model: 'ignored', apiKey: 'ignored' });
    expect(spoken.status).toBe(200);
    expect(spoken.body).toEqual(audio);
    expect(requests.map((entry) => entry.url)).toEqual(['/v1/t2a_v2', '/v1/t2a_v2']);
    expect(requests.every((entry) => entry.authorization === 'Bearer private-native-speech-key' && entry.body.model === 'speech-2.8-hd')).toBe(true);
    expect((await request(app).get('/api/tts/status')).body).toMatchObject({ available: true, voices: ['male-qn-qingse'] });
  });

  it('privately synthesizes via a real child CLI and selects a usable SuperVideo default voice', async () => {
    const { dataDir, runtime, requests } = await fixture();
    const binding = await runtime.resolveBinding('tts');
    const voice = await configuredDefaultVoice({ resolveBinding: async () => binding });
    expect(voice).toEqual({ provider: 'minimax', model: 'speech-2.8-hd', voice: 'male-qn-qingse' });
    expect(validateVoice(voice)).toBe(voice);
    const previousResolver = process.env.SUPERWAGIE_MODEL_RESOLVER;
    process.env.SUPERWAGIE_MODEL_RESOLVER = resolver;
    try {
      const result = await requestConfiguredSpeech('视频旁白测试', voice, { resolveBinding: async () => binding, runResolver: (file, args, options) => runProcess(file, args, { ...options, env: { ...options.env, OPENCHAMBER_DATA_DIR: dataDir } }) });
      expect(result.bytes).toEqual(audio);
      expect(result.evidence).toEqual({ provider: 'minimax', model: 'speech-2.8-hd', voice: 'male-qn-qingse', status: 'succeeded' });
      expect(JSON.stringify(result)).not.toContain('private-native-speech-key');
    } finally {
      if (previousResolver === undefined) delete process.env.SUPERWAGIE_MODEL_RESOLVER;
      else process.env.SUPERWAGIE_MODEL_RESOLVER = previousResolver;
    }
    expect(requests).toHaveLength(1);
    expect(requests[0].body.text).toBe('视频旁白测试');
  });

  it('rejects stale explicit project voices, unknown secret input fields and oversized stdin before generation', async () => {
    const { dataDir, requests } = await fixture();
    await expect(synthesizeConfiguredSpeechFromDisk({ text: 'Hello', expectedModel: 'old-model' }, { dataDir })).rejects.toMatchObject({ code: 'model_configuration_voice_mismatch' });
    await expect(synthesizeConfiguredSpeechFromDisk({ text: 'Hello', expectedVoice: 'old-voice' }, { dataDir })).rejects.toMatchObject({ code: 'model_configuration_voice_mismatch' });
    await expect(synthesizeConfiguredSpeechFromDisk({ text: 'Hello', apiKey: 'input-secret' }, { dataDir })).rejects.toMatchObject({ code: 'model_configuration_invalid_input' });
    const oversized = await runProcess(process.execPath, [resolver, '--synthesize-tts'], { input: JSON.stringify({ text: 'x'.repeat(70000) }), env: { ...process.env, OPENCHAMBER_DATA_DIR: dataDir } });
    expect(oversized.code).toBe(1);
    expect(oversized.stdout).toBe('');
    expect(oversized.stderr).toBe('model_configuration_invalid_input');
    expect(requests).toHaveLength(0);
  });
});
