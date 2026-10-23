import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { createModelConfigurationRuntime } from './runtime.js';
import { synthesizeConfiguredSpeechFromDisk } from './resolve-cli.js';
import { registerTtsRoutes } from '../tts/routes.js';
import { configuredDefaultVoice, requestConfiguredSpeech } from '../../builtin-skills/supervideo-engine/src/providers/model-configuration.mjs';
import { validateVoice } from '../../builtin-skills/supervideo-engine/src/providers/tts.mjs';
import { runProcess } from '../../builtin-skills/supervideo-engine/src/providers/process.mjs';

const cleanups = [];
const audio = Buffer.concat([Buffer.from('ID3\u0004'), Buffer.alloc(64)]);
const resolver = fileURLToPath(new URL('./resolve-cli.js', import.meta.url));
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });
const fixture = async () => {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ base_resp: { status_code: 0 }, data: { audio: audio.toString('hex') } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minimax-tts-consumer-'));
  cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
  const runtime = createModelConfigurationRuntime({ dataDir });
  let state = await runtime.saveConnection({ revision: 0, connection: { name: 'MiniMax fixture', providerId: 'minimax', protocol: 'minimax', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'private-native-speech-key' } });
  state = await runtime.saveBinding('tts', { revision: state.revision, binding: { connectionId: state.connections[0].id, model: 'speech-2.8-hd', parameters: { voice: 'male-qn-qingse' } } });
  return { dataDir, runtime, state, requests };
};

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
