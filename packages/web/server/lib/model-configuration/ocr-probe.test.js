import { inflateSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testModelBinding } from './adapters.js';
import { MODEL_PURPOSES } from './catalog.js';

const binding = { purpose: 'ocr', protocol: 'openai-compatible', providerId: 'llmrouter', model: 'fixture-ocr', baseUrl: 'https://llmrouter.quukk.com/v1', apiKey: 'fixture-key', parameters: {} };
const submitted = { id: 'uk_fixture-task', job_id: 'private-job', state: 'pending', status_url: 'https://foreign.example/private' };
const document = { id: 'uk_fixture-task', pages: [{ text: 'TEST', layout: [] }] };
const status = (state, progress = { totalPages: 1, extractedPages: 1 }) => ({ id: 'uk_fixture-task', job_id: 'private-job', state, progress, result_url: 'https://foreign.example/private-result' });
afterEach(() => vi.useRealTimers());

describe('managed OCR protocol probe', () => {
  it('submits one synthetic text page and verifies its consumable document on the owning paths', async () => {
    expect(MODEL_PURPOSES.find((purpose) => purpose.id === 'ocr').probeProtocols).toContain('openai-compatible');
    vi.useFakeTimers();
    const requests = [];
    const probe = testModelBinding(binding, { idempotencyKey: 'probe-ocr-1', fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return Response.json(url.endsWith('/document') ? document : requests.length === 1 ? submitted : status(requests.length === 2 ? 'running' : 'done'), { status: requests.length === 1 ? 202 : 200 });
    } });
    await vi.runAllTimersAsync();
    await probe;
    expect(requests.map(({ url, init }) => [url, init.method])).toEqual([
      ['https://llmrouter.quukk.com/v1/ocr', 'POST'],
      ['https://llmrouter.quukk.com/v1/ocr/uk_fixture-task', 'GET'],
      ['https://llmrouter.quukk.com/v1/ocr/uk_fixture-task', 'GET'],
      ['https://llmrouter.quukk.com/v1/ocr/uk_fixture-task/document', 'GET'],
    ]);
    const { init } = requests[0];
    expect(init.headers).toMatchObject({ Authorization: 'Bearer fixture-key', 'Idempotency-Key': 'probe-ocr-1', 'X-Should-Retry': 'false' });
    expect(init.headers['Content-Type']).toBeUndefined();
    expect(init.body).toBeInstanceOf(FormData);
    expect([...init.body.keys()]).toEqual(['model', 'file']);
    expect(init.body.get('model')).toBe('fixture-ocr');
    const file = init.body.get('file');
    expect(file.type).toBe('image/png');
    const png = Buffer.from(await file.arrayBuffer());
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([200, 80]);
    const idatLength = png.readUInt32BE(33);
    const pixels = inflateSync(png.subarray(41, 41 + idatLength));
    expect(pixels.includes(0)).toBe(true);
    expect(pixels.includes(255)).toBe(true);
    expect(requests.every(({ init: request }) => request.redirect === 'error')).toBe(true);
    expect(requests.every(({ init: request }) => request.signal === init.signal)).toBe(true);
  });

  it.each([
    status('done', { totalPages: 0, extractedPages: 0 }),
    status('done', { totalPages: 1, extractedPages: 0 }),
    status('done', { totalPages: 1, extractedPages: 2 }),
    { ...status('done'), id: 'another-task' },
    { ...status('done'), job_id: 'another-job' },
    { code: 0, data: { state: 'done' } },
  ])('rejects a terminal response without matching extraction proof', async (payload) => {
    let calls = 0;
    await expect(testModelBinding(binding, { fetchImpl: async () => Response.json(++calls === 1 ? submitted : payload) })).rejects.toMatchObject({ code: 'model_configuration_invalid_provider_response' });
    expect(calls).toBe(2);
  });

  it('refuses an older gateway without the document consumer endpoint after a completed job', async () => {
    const methods = [];
    await expect(testModelBinding(binding, { fetchImpl: async (url, init) => {
      methods.push(init.method);
      if (url.endsWith('/document')) return new Response('private provider response', { status: 404 });
      return Response.json(init.method === 'POST' ? submitted : status('done'));
    } })).rejects.toMatchObject({ code: 'model_configuration_provider_http_404' });
    expect(methods).toEqual(['POST', 'GET', 'GET']);
  });

  it.each([
    { ...document, id: 'other-task' },
    { ...document, pages: [] },
    { ...document, pages: [{ text: '' }] },
    { ...document, pages: [{ text: '   ' }] },
    { ...document, pages: [{ text: 'TEST' }, { text: 'another' }] },
  ])('rejects a completed task without its single readable synthetic page', async (payload) => {
    const methods = [];
    await expect(testModelBinding(binding, { fetchImpl: async (url, init) => {
      methods.push(init.method);
      return Response.json(url.endsWith('/document') ? payload : init.method === 'POST' ? submitted : status('done'));
    } })).rejects.toMatchObject({ code: 'model_configuration_invalid_provider_response' });
    expect(methods).toEqual(['POST', 'GET', 'GET']);
  });

  it('reports a failed OCR job without repeating submission or exposing provider text', async () => {
    let calls = 0;
    await expect(testModelBinding(binding, { fetchImpl: async () => Response.json(++calls === 1 ? submitted : { ...status('failed'), error: 'private-fixture' }) })).rejects.toMatchObject({ message: 'model_configuration_provider_rejected' });
    expect(calls).toBe(2);
  });

  it('does not repeat a submission after an uncertain network response', async () => {
    let calls = 0;
    await expect(testModelBinding(binding, { fetchImpl: async () => { calls += 1; throw new Error('private-fixture'); } })).rejects.toMatchObject({ code: 'model_configuration_provider_unreachable' });
    expect(calls).toBe(1);
  });

  it.each([403, 404, 429, 500])('preserves HTTP %s failures without resubmission or raw messages', async (code) => {
    let calls = 0;
    await expect(testModelBinding(binding, { fetchImpl: async () => ++calls === 1 ? Response.json(submitted) : new Response('private-fixture', { status: code }) })).rejects.toMatchObject({ message: `model_configuration_provider_http_${code}` });
    expect(calls).toBe(2);
  });

  it('checks changed policy after waiting before the next status request', async () => {
    vi.useFakeTimers();
    let calls = 0;
    let allowed = true;
    const probe = testModelBinding(binding, {
      assertCurrent: () => { if (!allowed) throw Object.assign(new Error('enterprise_mode'), { code: 'enterprise_mode' }); },
      fetchImpl: async () => {
        calls += 1;
        if (calls === 2) setTimeout(() => { allowed = false; }, 1000);
        return Response.json(calls === 1 ? submitted : status('running'));
      },
    });
    const result = probe.then(() => null, (error) => error);
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ code: 'enterprise_mode' });
    expect(calls).toBe(2);
  });

  it('bounds pending status polling and never reads result URLs', async () => {
    vi.useFakeTimers();
    let posts = 0;
    let gets = 0;
    const probe = testModelBinding(binding, { fetchImpl: async (_url, init) => {
      if (init.method === 'POST') { posts += 1; return Response.json(submitted); }
      gets += 1; return Response.json(status('running', { totalPages: 1, extractedPages: 0 }));
    } });
    const assertion = expect(probe).rejects.toMatchObject({ code: 'model_configuration_provider_unreachable' });
    await vi.runAllTimersAsync();
    await assertion;
    expect(posts).toBe(1);
    expect(gets).toBeGreaterThan(1);
    expect(gets).toBeLessThanOrEqual(60);
  });

  it.each(['before', 'after-submit', 'after-status', 'after-document'])('checks owner and policy %s and preserves its refusal', async (change) => {
    let calls = 0;
    const error = Object.assign(new Error('owner changed'), { code: 'platform_account_session_changed' });
    await expect(testModelBinding(binding, {
      assertCurrent: () => { if (change === 'before' || change === 'after-submit' && calls >= 1 || change === 'after-status' && calls >= 2 || change === 'after-document' && calls >= 3) throw error; },
      fetchImpl: async () => Response.json(++calls === 1 ? submitted : calls === 3 ? document : status('done')),
    })).rejects.toBe(error);
    expect(calls).toBe(change === 'before' ? 0 : change === 'after-submit' ? 1 : change === 'after-status' ? 2 : 3);
  });

  it('refuses malformed task identifiers before any status request', async () => {
    let calls = 0;
    await expect(testModelBinding(binding, { fetchImpl: async () => { calls += 1; return Response.json({ ...submitted, id: '../another-origin' }); } })).rejects.toMatchObject({ code: 'model_configuration_invalid_provider_response' });
    expect(calls).toBe(1);
  });
});
