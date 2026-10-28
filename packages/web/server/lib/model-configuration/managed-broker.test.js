import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { synthesizeConfiguredSpeechFromDisk } from './resolve-cli.js';

const cleanups = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

describe('managed-media synthesis broker', () => {
  it('synthesizes through the private media broker for managed bindings', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-cli-'));
    cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
    const state = {
      version: 1, revision: 3,
      connections: [{ id: 'unihub-managed', name: 'LLMRouter managed', providerId: 'unihub', protocol: 'managed-media', baseUrl: 'https://llmrouter.quukk.com/platform/v1' }],
      bindings: [{ purpose: 'tts', connectionId: 'unihub-managed', model: 'qwen3-tts-flash', parameters: { voice: 'Cherry' }, verification: { status: 'untested' } }],
    };
    await fs.writeFile(path.join(dataDir, 'model-configuration.json'), JSON.stringify(state));
    const brokerRequests = [];
    const broker = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      brokerRequests.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) });
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      res.end(Buffer.from('managed-broker-audio'));
    });
    await new Promise((resolve) => broker.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise((resolve) => broker.close(resolve)));
    const environment = {
      OPENCHAMBER_DATA_DIR: dataDir,
      OPENCHAMBER_UNIHUB_PROXY_URL: `http://127.0.0.1:${broker.address().port}`,
      OPENCHAMBER_UNIHUB_PROXY_TOKEN: 'broker-capability-token',
    };
    const result = await synthesizeConfiguredSpeechFromDisk(
      { text: '朗读测试', sessionID: 'media_test_session', expectedModel: 'qwen3-tts-flash', expectedVoice: 'Cherry' },
      { environment },
    );
    expect(Buffer.from(result.audio, 'base64').toString('utf8')).toBe('managed-broker-audio');
    expect(result.contentType).toBe('audio/mpeg');
    expect(brokerRequests).toHaveLength(1);
    expect(brokerRequests[0]).toMatchObject({ url: '/media/speech', authorization: 'Bearer broker-capability-token' });
    expect(brokerRequests[0].body).toEqual({ sessionID: 'media_test_session', model: 'qwen3-tts-flash', text: '朗读测试', voice: 'Cherry' });
  });

  it('fails closed when the broker capability env is missing', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-cli-nobroker-'));
    cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
    const state = {
      version: 1, revision: 3,
      connections: [{ id: 'unihub-managed', name: 'LLMRouter managed', providerId: 'unihub', protocol: 'managed-media', baseUrl: 'https://llmrouter.quukk.com/platform/v1' }],
      bindings: [{ purpose: 'tts', connectionId: 'unihub-managed', model: 'qwen3-tts-flash', parameters: {}, verification: { status: 'untested' } }],
    };
    await fs.writeFile(path.join(dataDir, 'model-configuration.json'), JSON.stringify(state));
    await expect(synthesizeConfiguredSpeechFromDisk(
      { text: '朗读测试', sessionID: 'media_test_session' },
      { environment: { OPENCHAMBER_DATA_DIR: dataDir } },
    )).rejects.toMatchObject({ code: 'model_configuration_unavailable' });
  });
});
