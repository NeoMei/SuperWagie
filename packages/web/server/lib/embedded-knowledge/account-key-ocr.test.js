import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createAccountKeyOcrBroker } from './account-key-ocr.js';

const brokers = [];
const binding = { purpose: 'ocr', providerId: 'llmrouter', protocol: 'openai-compatible', connectionId: 'owned-connection', model: 'ocr-model', baseUrl: 'https://llmrouter.quukk.com/v1', apiKey: 'fixture-private-key', parameters: {}, revision: 1 };
const form = () => { const body = new FormData(); body.set('model', 'ocr-model'); body.set('optionalPayload', '{}'); body.set('file', new Blob(['fixture-document'], { type: 'image/png' }), 'sample.png'); return body; };
const fixture = async (changes = {}) => {
  const state = { current: true, binding: { ...binding }, calls: [], now: 1000 };
  const broker = createAccountKeyOcrBroker({
    resolveBinding: async () => state.binding,
    captureOwner: async () => ({ id: 'fixture-owner', assertCurrent: async () => { if (!state.current) throw new Error('changed'); } }),
    enterpriseOptions: { env: {}, policyFilePaths: [] }, now: () => state.now,
    fetchImpl: async (url, init) => {
      state.calls.push({ url, init });
      if (init.method === 'POST') return Response.json({ id: 'uk_fixture', job_id: 'job-fixture', state: 'pending' }, { status: 202 });
      if (url.endsWith('/document')) return Response.json({ id: 'uk_fixture', pages: [{ index: 0, width: 100, height: 100, text: 'Extracted test text', layout: [{ label: 'text', content: 'Extracted test text', bbox: [1, 2, 3, 4] }] }] });
      return Response.json({ id: 'uk_fixture', job_id: 'job-fixture', state: 'done', progress: { totalPages: 1, extractedPages: 1 } });
    }, ...changes,
  });
  brokers.push(broker);
  const scoped = await broker.materialize(state.binding);
  const submit = () => fetch(scoped.baseUrl, { method: 'POST', headers: { Authorization: `Bearer ${scoped.apiKey}` }, body: form() });
  return { state, broker, scoped, submit };
};
afterEach(async () => { await Promise.all(brokers.splice(0).map((broker) => broker.close())); });

describe('account key OCR knowledge bridge', () => {
  it('serves the actual Paddle jobs and JSONL consumer contract without sharing the account key', async () => {
    const { state, scoped, submit } = await fixture();
    expect(scoped.apiKey).not.toBe(binding.apiKey);
    expect(scoped.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/v2\/ocr\/jobs$/);
    const submitted = await (await submit()).json();
    expect(submitted.data.jobId).toBeTruthy();
    const polled = await (await fetch(`${scoped.baseUrl}/${submitted.data.jobId}`, { headers: { Authorization: `Bearer ${scoped.apiKey}` } })).json();
    expect(polled.data.state).toBe('done');
    const resultUrl = polled.data.resultUrl.jsonUrl;
    expect(new URL(resultUrl).origin).toBe(new URL(scoped.baseUrl).origin);
    expect(resultUrl).not.toContain(binding.apiKey);
    const result = await (await fetch(resultUrl)).json();
    expect(result).toEqual({ result: { layoutParsingResults: [{ markdown: { text: 'Extracted test text' }, prunedResult: { page_index: 0, width: 100, height: 100, parsing_res_list: [{ block_label: 'text', block_content: 'Extracted test text', block_bbox: [1, 2, 3, 4] }] } }] } });
    expect(state.calls.map(({ url, init }) => [url, init.method])).toEqual([
      ['https://llmrouter.quukk.com/v1/ocr', 'POST'], ['https://llmrouter.quukk.com/v1/ocr/uk_fixture', 'GET'], ['https://llmrouter.quukk.com/v1/ocr/uk_fixture/document', 'GET'],
    ]);
    expect(state.calls.every(({ init }) => init.redirect === 'error' && init.headers.Authorization === `Bearer ${binding.apiKey}`)).toBe(true);
    expect(state.calls[0].init.headers['X-Should-Retry']).toBe('false');
  });

  it('coalesces repeated submissions of identical content and never repeats an uncertain POST', async () => {
    let calls = 0;
    const { submit } = await fixture({ fetchImpl: async () => { calls += 1; throw new Error('private-provider-body'); } });
    const responses = await Promise.all([submit(), submit()]);
    expect(responses.map(({ status }) => status)).toEqual([503, 503]);
    expect(await (await submit()).text()).not.toContain('private-provider-body');
    expect(calls).toBe(1);
  });

  it.each(['owner', 'key', 'connection', 'parameters', 'revision', 'expired'])('invalidates scope after %s changes before any model dispatch', async (change) => {
    const { state, submit } = await fixture();
    if (change === 'owner') state.current = false;
    if (change === 'key') state.binding = { ...state.binding, apiKey: 'rotated' };
    if (change === 'connection') state.binding = { ...state.binding, connectionId: 'other' };
    if (change === 'parameters') state.binding = { ...state.binding, parameters: { language: 'changed' } };
    if (change === 'revision') state.binding = { ...state.binding, revision: 2 };
    if (change === 'expired') state.now += 600001;
    expect((await submit()).status).toBe(403);
    expect(state.calls).toHaveLength(0);
  });

  it('protects the result capability with current owner and a short expiry', async () => {
    const { state, scoped, submit } = await fixture();
    const submitted = await (await submit()).json();
    const response = await (await fetch(`${scoped.baseUrl}/${submitted.data.jobId}`, { headers: { Authorization: `Bearer ${scoped.apiKey}` } })).json();
    const resultUrl = response.data.resultUrl.jsonUrl;
    state.current = false;
    expect((await fetch(resultUrl)).status).toBe(403);
    expect(state.calls).toHaveLength(2);
    state.current = true; state.now += 60001;
    expect((await fetch(resultUrl)).status).toBe(403);
    expect(state.calls).toHaveLength(2);
  });

  it('renews an expired result capability while keeping the previous URL invalid', async () => {
    const { state, scoped, submit } = await fixture();
    const submitted = await (await submit()).json();
    const poll = async () => (await (await fetch(`${scoped.baseUrl}/${submitted.data.jobId}`, { headers: { Authorization: `Bearer ${scoped.apiKey}` } })).json()).data.resultUrl.jsonUrl;
    const original = await poll();
    state.now += 60001;
    const renewed = await poll();
    expect(renewed).not.toBe(original);
    expect((await fetch(original)).status).toBe(403);
    expect((await fetch(renewed)).status).toBe(200);
    expect(state.calls.filter(({ init }) => init.method === 'POST')).toHaveLength(1);
  });

  it('blocks a changed enterprise policy and discards a late upstream reply after owner changes', async () => {
    const enterpriseOptions = { env: {}, policyFilePaths: [] };
    const current = await fixture({ enterpriseOptions });
    enterpriseOptions.env.OPENCHAMBER_ENTERPRISE_MODE = '1';
    expect((await current.submit()).status).toBe(403);
    expect(current.state.calls).toHaveLength(0);
    enterpriseOptions.env.OPENCHAMBER_ENTERPRISE_MODE = '';
    let complete; let started;
    const dispatched = new Promise((resolve) => { started = resolve; });
    const late = await fixture({ fetchImpl: async () => { started(); return new Promise((resolve) => { complete = resolve; }); } });
    const response = late.submit();
    await dispatched;
    late.state.current = false;
    complete(Response.json({ id: 'uk_fixture', job_id: 'job-fixture', state: 'pending' }, { status: 202 }));
    expect((await response).status).toBe(403);
  });

  it('retains the upstream idempotency key across capability renewal', async () => {
    const { state, broker, submit } = await fixture();
    expect((await submit()).status).toBe(200);
    state.now += 600001;
    state.binding = { ...state.binding, revision: 2 };
    const renewed = await broker.materialize(state.binding);
    expect((await fetch(renewed.baseUrl, { method: 'POST', headers: { Authorization: `Bearer ${renewed.apiKey}` }, body: form() })).status).toBe(200);
    expect(state.calls[1].init.headers['Idempotency-Key']).toBe(state.calls[0].init.headers['Idempotency-Key']);
  });

  it('rejects browser-origin and foreign-host requests', async () => {
    const { state, scoped } = await fixture();
    expect((await fetch(scoped.baseUrl, { method: 'POST', headers: { Authorization: `Bearer ${scoped.apiKey}`, Origin: 'https://foreign.example' }, body: form() })).status).toBe(403);
    const status = await new Promise((resolve, reject) => {
      const request = http.request(scoped.baseUrl, { method: 'POST', headers: { Host: 'foreign.example' } }, (response) => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject); request.end();
    });
    expect(status).toBe(403);
    expect(state.calls).toHaveLength(0);
  });

  it('refuses credentials for an unapproved inference destination', async () => {
    const { state, broker } = await fixture();
    await expect(broker.materialize({ ...binding, baseUrl: 'https://foreign.example/v1' })).rejects.toMatchObject({ code: 'model_configuration_account_key_conflict' });
    expect(state.calls).toHaveLength(0);
  });
});
