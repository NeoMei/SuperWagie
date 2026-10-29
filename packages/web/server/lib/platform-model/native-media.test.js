import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createNativeMediaTransport, NativeMediaError } from './native-media.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1', () => {
    cleanups.push(() => new Promise((done) => server.close(done)));
    resolve('http://127.0.0.1:' + server.address().port);
  });
});

const grant = { token: 'uh_model_media_grant' };
const allowlist = {
  speech: ['qwen3-tts-flash'],
  transcription: ['qwen3-asr-flash'],
  image_generation: ['qwen-image-2.0'],
  image_edit: ['wanx2.1-imageedit'],
  video: ['wan2.6-t2v'],
};
const transport = (gateway) => createNativeMediaTransport({
  gateway,
  fetchImpl: (url, init) => fetch(url, init),
  grantFor: async () => grant,
  operationAllowlist: allowlist,
});
const identity = { taskID: 'uh_task_fixture', idempotencyKey: 'call_fixture_1' };

const capture = (handler) => {
  const seen = { headers: null, body: null, path: '' };
  const server = http.createServer(async (req, res) => {
    seen.headers = req.headers;
    seen.path = req.url;
    let raw = '';
    for await (const chunk of req) raw += chunk;
    seen.body = req.headers['content-type']?.startsWith('multipart/form-data') ? raw : JSON.parse(raw);
    handler(res, seen);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      cleanups.push(() => new Promise((done) => server.close(done)));
      resolve({ url: 'http://127.0.0.1:' + server.address().port, seen });
    });
  });
};

describe('native media transport', () => {
  it('dispatches speech and returns audio bytes', async () => {
    const { url, seen } = await capture((res) => {
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      res.end(Buffer.from('fake-mp3-bytes'));
    });
    const result = await transport(url).dispatchSpeech({ model: 'qwen3-tts-flash', text: '你好', voice: 'Cherry', ...identity });
    expect(Buffer.isBuffer(result.buffer)).toBe(true);
    expect(result.contentType).toBe('audio/mpeg');
    expect(seen.path).toBe('/native/bailian/audio/speech');
    expect(seen.headers.authorization).toBe('Bearer uh_model_media_grant');
    expect(seen.headers['x-unihub-task-id']).toBe('uh_task_fixture');
    expect(seen.headers['idempotency-key']).toBe('call_fixture_1');
    expect(seen.body.model).toBe('qwen3-tts-flash');
    expect(seen.body.input).toEqual({ text: '你好', voice: 'Cherry' });
  });

  it('rejects a non-audio speech response without retry', async () => {
    const { url } = await capture((res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"unexpected":true}');
    });
    await expect(transport(url).dispatchSpeech({ model: 'qwen3-tts-flash', text: '你好', voice: 'Cherry', ...identity }))
      .rejects.toMatchObject({ code: 'native_media_invalid_response' });
  });

  it('surfaces gateway refusal status without retry', async () => {
    const { url } = await capture((res) => {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end('{"error":{"code":"gateway_media_refused"}}');
    });
    await expect(transport(url).dispatchSpeech({ model: 'qwen3-tts-flash', text: '你好', voice: 'Cherry', ...identity }))
      .rejects.toMatchObject({ status: 429, code: 'gateway_media_refused' });
  });

  it('dispatches transcription and returns transcript plus seconds', async () => {
    const { url, seen } = await capture((res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '你好' } }], usage: { seconds: 1 } }));
    });
    const result = await transport(url).dispatchTranscription({
      model: 'qwen3-asr-flash',
      audioDataUri: 'data:audio/wav;base64,aaaa',
      ...identity,
    });
    expect(result).toEqual({ transcript: '你好', seconds: 1 });
    expect(seen.path).toBe('/native/dashscope/audio/transcriptions');
    expect(seen.body.messages[0].content[0].input_audio.data).toBe('data:audio/wav;base64,aaaa');
  });

  it('rejects a transcription response missing usage seconds', async () => {
    const { url } = await capture((res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '你好' } }] }));
    });
    await expect(transport(url).dispatchTranscription({ model: 'qwen3-asr-flash', audioDataUri: 'data:audio/wav;base64,aaaa', ...identity }))
      .rejects.toBeInstanceOf(NativeMediaError);
  });

  it('dispatches image generation and returns https urls', async () => {
    const { url, seen } = await capture((res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ created: 1, data: [{ url: 'https://result.example/a.png' }] }));
    });
    const result = await transport(url).dispatchImageGeneration({ model: 'qwen-image-2.0', prompt: '苹果', n: 1, size: '1024*1024', ...identity });
    expect(result.urls).toEqual(['https://result.example/a.png']);
    expect(seen.path).toBe('/images/generations');
    expect(seen.body).toEqual({ model: 'qwen-image-2.0', prompt: '苹果', n: 1, size: '1024*1024', response_format: 'url' });
  });

  it('dispatches image generation and validates inline output', async () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const encoded = png.toString('base64');
    const { url } = await capture((res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ b64_json: encoded }] }));
    });
    await expect(transport(url).dispatchImageGeneration({ model: 'qwen-image-2.0', prompt: '苹果', ...identity }))
      .resolves.toMatchObject({ urls: [], images: [{ data: encoded, mimeType: 'image/png' }] });
  });

  it('dispatches video submit with the flat certified body', async () => {
    const { url, seen } = await capture((res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ task_id: 'vid_123', task_status: 'PENDING' }));
    });
    const result = await transport(url).dispatchVideoSubmit({ model: 'wan2.6-t2v', prompt: '橘猫', seconds: 5, size: '1280*720', ...identity });
    expect(result.taskId).toBe('vid_123');
    expect(seen.path).toBe('/videos');
    expect(seen.body).toEqual({ model: 'wan2.6-t2v', prompt: '橘猫', seconds: 5, size: '1280*720' });
  });

  it('dispatches the latest managed image edit with inline source and mask images', async () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
    const source = `data:image/png;base64,${png}`;
    const { url, seen } = await capture((res) => {
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'call_fixture_1', status: 'pending' }));
    });
    const result = await transport(url).dispatchImageEdit({ model: 'wanx2.1-imageedit', prompt: '替换背景', images: [source], mask: source, n: 1, ...identity });
    expect(result).toEqual({ callID: 'call_fixture_1', status: 'pending' });
    expect(seen.path).toBe('/images/edits');
    expect(seen.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(seen.body).toContain('name="model"');
    expect(seen.body).toContain('wanx2.1-imageedit');
    expect(seen.body).toContain('name="prompt"');
    expect(seen.body).toContain('替换背景');
    expect(seen.body).toContain('filename="source.png"');
    expect(seen.body).toContain('filename="mask.png"');
  });

  it('rejects missing masks and unsupported edit parameters before dispatch', async () => {
    const png = `data:image/png;base64,${Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')}`;
    const { url, seen } = await capture((res) => res.destroy()); const t = transport(url);
    const base = {model:'wanx2.1-imageedit', prompt:'replace', images:[png], ...identity};
    await expect(t.dispatchImageEdit(base)).rejects.toMatchObject({local:true, status:400});
    await expect(t.dispatchImageEdit({...base, mask:png, size:'1024*1024'})).rejects.toMatchObject({local:true, status:400});
    await expect(t.dispatchImageEdit({...base, mask:png, n:2})).rejects.toMatchObject({local:true, status:400});
    expect(seen.body).toBeNull();
  });

  it('rejects video outside certified resolution or bounds before sending', async () => {
    const { url, seen } = await capture((res) => res.destroy());
    const t = transport(url);
    await expect(t.dispatchVideoSubmit({ model: 'wan2.6-t2v', prompt: '橘猫', seconds: 30, size: '1280*720', ...identity }))
      .rejects.toMatchObject({ status: 400 });
    await expect(t.dispatchVideoSubmit({ model: 'wan2.6-t2v', prompt: '橘猫', seconds: 5, size: '640*480', ...identity }))
      .rejects.toMatchObject({ status: 400 });
    expect(seen.body).toBeNull();
  });

  it('refuses models outside the operation allowlist without a gateway call', async () => {
    const { url, seen } = await capture((res) => res.destroy());
    await expect(transport(url).dispatchSpeech({ model: 'qwen3-tts-instruct-flash', text: '你好', voice: 'Cherry', ...identity }))
      .rejects.toMatchObject({ code: 'native_media_model_not_admitted' });
    expect(seen.body).toBeNull();
  });

  it('rejects an insecure gateway at construction', () => {
    expect(() => createNativeMediaTransport({ gateway: 'http://example.com', fetchImpl: fetch, grantFor: async () => grant }))
      .toThrow(/https/);
  });
});
