import { afterEach, describe, expect, it } from 'vitest';
import { generateConfiguredSpeech } from './speech.js';

const binding = { protocol: 'minimax', baseUrl: 'https://api.minimax.cn/v1', apiKey: 'private-fixture-key', model: 'speech-2.8-hd', parameters: { voice: 'male-qn-qingse' } };
const audio = Buffer.concat([Buffer.from('ID3\u0004'), Buffer.alloc(64)]);
afterEach(() => { delete process.env.OPENCHAMBER_ENTERPRISE_MODE; });

describe('native configured speech', () => {
  it('uses MiniMax native payload and decodes hex audio without exposing credentials', async () => {
    let request;
    const result = await generateConfiguredSpeech(binding, { text: '  Hello  ', speed: 1.1 }, { fetchImpl: async (url, init) => {
      request = { url, init };
      return Response.json({ base_resp: { status_code: 0 }, data: { audio: audio.toString('hex') } });
    } });
    expect(request.url).toBe('https://api.minimax.cn/v1/t2a_v2');
    expect(request.init.headers.Authorization).toBe('Bearer private-fixture-key');
    expect(request.init.redirect).toBe('error');
    expect(JSON.parse(request.init.body)).toEqual({ model: 'speech-2.8-hd', text: 'Hello', stream: false, output_format: 'hex', voice_setting: { voice_id: 'male-qn-qingse', speed: 1.1 }, audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 } });
    expect(result.buffer).toEqual(audio);
    expect(result.contentType).toBe('audio/mpeg');
    expect(Object.keys(result)).toEqual(['buffer', 'contentType']);
  });

  it.each([
    { base_resp: { status_code: 1004, status_msg: 'private-fixture-key' } },
    { base_resp: { status_code: 0 }, data: { audio: 'abc' } },
    { base_resp: { status_code: 0 }, data: { audio: '00'.repeat(64) } },
  ])('rejects business errors and invalid hex/audio responses with a sanitized code', async (body) => {
    await expect(generateConfiguredSpeech(binding, { text: 'Hello' }, { fetchImpl: async () => Response.json(body) })).rejects.toMatchObject({ code: expect.stringMatching(/^model_configuration_/), message: expect.not.stringContaining('private-fixture-key') });
  });

  it('does not expose provider response bodies or thrown transport errors', async () => {
    for (const fetchImpl of [async () => new Response('private-fixture-key', { status: 401 }), async () => { throw new Error('private-fixture-key'); }]) {
      await expect(generateConfiguredSpeech(binding, { text: 'Hello' }, { fetchImpl })).rejects.toMatchObject({ message: expect.not.stringContaining('private-fixture-key') });
    }
  });

  it('rejects empty/oversize text and invalid speed before sending content', async () => {
    let requests = 0;
    const fetchImpl = async () => { requests++; return Response.json({}); };
    for (const input of [{ text: ' ' }, { text: 'x'.repeat(10000) }, { text: 'Hello', speed: 0 }, { text: 'Hello', speed: Infinity }]) {
      await expect(generateConfiguredSpeech(binding, input, { fetchImpl })).rejects.toMatchObject({ code: 'model_configuration_invalid_input', status: 400 });
    }
    expect(requests).toBe(0);
  });

  it('checks enterprise destination policy at the actual speech request boundary', async () => {
    process.env.OPENCHAMBER_ENTERPRISE_MODE = '1';
    let requests = 0;
    const fetchImpl = async () => { requests++; return Response.json({ base_resp: { status_code: 0 }, data: { audio: audio.toString('hex') } }); };
    await expect(generateConfiguredSpeech(binding, { text: 'Hello' }, { fetchImpl })).rejects.toMatchObject({ code: 'enterprise_mode', status: 403 });
    expect(requests).toBe(0);
    expect((await generateConfiguredSpeech({ ...binding, baseUrl: 'http://127.0.0.1:1234/v1' }, { text: 'Hello' }, { fetchImpl })).buffer).toEqual(audio);
    expect(requests).toBe(1);
  });
});
