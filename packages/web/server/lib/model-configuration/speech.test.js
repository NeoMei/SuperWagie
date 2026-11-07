import { afterEach, describe, expect, it } from 'vitest';
import { generateConfiguredSpeech } from './speech.js';

const binding = { protocol: 'minimax', baseUrl: 'https://api.minimax.cn/v1', apiKey: 'private-fixture-key', model: 'speech-2.8-hd', parameters: { voice: 'male-qn-qingse' } };
const audio = Buffer.concat([Buffer.from('ID3\u0004'), Buffer.alloc(64)]);
afterEach(() => { delete process.env.OPENCHAMBER_ENTERPRISE_MODE; });

describe('native configured speech', () => {
  it('uses the single Key native Bailian endpoint and validates binary WAV output', async () => {
    const native = { protocol: 'openai-compatible', baseUrl: 'https://llmrouter.quukk.com/v1', apiKey: 'private-fixture-key', model: 'qwen3-tts-flash', parameters: { speechOperation: 'bailian.audio.speech.create', voice: 'Cherry', language: 'Chinese' } };
    const wav = Buffer.alloc(48); wav.write('RIFF'); wav.write('WAVE', 8);
    const calls = [];
    const result = await generateConfiguredSpeech(native, { text: 'Hello', speed: 1 }, { idempotencyKey: 'speech-probe', fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(wav, { headers: { 'Content-Type': 'audio/wav' } });
    } });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://llmrouter.quukk.com/v1/native/bailian/audio/speech');
    expect(calls[0].init.headers).toMatchObject({ Authorization: 'Bearer private-fixture-key', 'Idempotency-Key': 'speech-probe' });
    expect(JSON.parse(calls[0].init.body)).toEqual({ model: 'qwen3-tts-flash', input: { text: 'Hello', voice: 'Cherry', language_type: 'Chinese' } });
    expect(result).toEqual({ buffer: wav, contentType: 'audio/wav' });
    await expect(generateConfiguredSpeech(native, { text: 'Hello' }, { fetchImpl: async () => Response.json({ output: { audio: { url: 'https://foreign.example/audio' } } }) })).rejects.toMatchObject({ code: 'model_configuration_invalid_provider_response' });
    process.env.OPENCHAMBER_ENTERPRISE_MODE = '1';
    await expect(generateConfiguredSpeech(native, { text: 'Hello' }, { fetchImpl: async () => { throw new Error('must not dispatch'); } })).rejects.toMatchObject({ code: 'enterprise_mode' });
  });
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

  it('rejects unsupported, oversize and malformed native speech without fallback or retries', async () => {
    const native = { protocol: 'openai-compatible', baseUrl: 'https://llmrouter.quukk.com/v1', apiKey: 'private-fixture-key', model: 'qwen3-tts-instruct-flash', parameters: { speechOperation: 'bailian.audio.speech.create' } };
    let calls = 0;
    const send = async () => { calls++; return new Response('private-fixture-key', { status: 401 }); };
    await expect(generateConfiguredSpeech({ ...native, parameters: {} }, { text: 'Hello' }, { fetchImpl: send })).rejects.toMatchObject({ code: 'model_configuration_unsupported_protocol' });
    await expect(generateConfiguredSpeech(native, { text: '字'.repeat(601) }, { fetchImpl: send })).rejects.toMatchObject({ code: 'model_configuration_invalid_input' });
    expect(calls).toBe(0);
    await expect(generateConfiguredSpeech(native, { text: '😀'.repeat(600) }, { fetchImpl: send })).rejects.toMatchObject({ message: 'model_configuration_provider_http_401' });
    expect(calls).toBe(1);
    await expect(generateConfiguredSpeech(native, { text: 'Hello' }, { fetchImpl: async () => new Response(Buffer.alloc(44), { headers: { 'Content-Type': 'audio/wav' } }) })).rejects.toMatchObject({ code: 'model_configuration_invalid_provider_response' });
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
