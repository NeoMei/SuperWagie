import { afterEach, describe, expect, it } from 'vitest';
import { createManagedKnowledgeBroker } from './managed-broker.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture() {
  let valid = true; let clock = 1000; let failDispatch = false;
  const dispatched = []; const reads = [];
  const broker = await createManagedKnowledgeBroker({
    resourceOrigin: 'https://llmrouter.example', now: () => clock, lifetimeMs: 5000,
    admit: async ({ purpose, model }) => ({ sessionID: 'session-' + purpose, taskID: 'task-' + purpose, actorID: 'actor-a', accountID: 'payer-a', model }),
    validate: async ({ identity, actorID, accountID }) => valid && identity === 'owner-private' && actorID === 'actor-a' && accountID === 'payer-a',
    dispatch: async (request) => {
      dispatched.push(request);
      if (failDispatch) throw new Error('unknown upstream result');
      const body = request.operation === 'ocr' ? { data: { jobId: request.callID, state: 'pending' } } : { data: [{ index: 0, embedding: [0.5, 0.25] }] };
      return { status: 200, contentType: 'application/json', body: Buffer.from(JSON.stringify(body)) };
    },
    read: async (request) => {
      reads.push(request);
      return { status: 200, contentType: 'application/json', body: Buffer.from(JSON.stringify({ data: { jobId: request.callID, state: 'done', resultUrl: { jsonUrl: 'https://llmrouter.example/api/ocr/jobs/j1/resources/r1?grant=opaque' } } })) };
    },
  });
  cleanups.push(() => broker.close());
  const activate = () => broker.activate('owner-private', { embedding: 'text-embedding-v4', rerank: 'qwen3-rerank', vision: 'qwen-vl', ocr: 'PaddleOCR-VL-1.6' });
  return { broker, activate, dispatched, reads, expire: () => { clock += 5001; }, revoke: () => { valid = false; }, failDispatch: () => { failDispatch = true; } };
}
const jsonCall = (binding, path, input, options = {}) => fetch(binding.baseUrl + path, {
  method: 'POST', headers: { authorization: 'Bearer ' + binding.apiKey, 'content-type': 'application/json', ...(options.key ? { 'idempotency-key': options.key } : {}) }, body: JSON.stringify(input),
});

describe('managed knowledge capability broker', () => {
  it('rejects unsupported scope keys and non-object request bodies before dispatch', async () => {
    const f = await fixture();
    for (const selected of [null, [], {}, { toString: 'model' }, { embedding: 3 }, { vision: '' }]) {
      await expect(f.broker.activate('owner-private', selected)).rejects.toMatchObject({ code: 'knowledge_scope_invalid' });
    }
    const { bindings } = await f.activate();
    for (const body of [null, [], 'model', 42]) {
      expect((await jsonCall(bindings.embedding, '/embeddings', body, { key: 'invalid' })).status).toBe(400);
    }
    expect(f.dispatched).toHaveLength(0);
  });

  it('requires stable call identity, restricts model and endpoint, and safely replays the same result', async () => {
    const f = await fixture(); const scope = await f.activate(); const b = scope.bindings.embedding;
    const input = { model: b.model, input: ['hello'] };
    expect((await jsonCall(b, '/embeddings', input)).status).toBe(400);
    expect((await jsonCall(b, '/embeddings', { ...input, model: 'other' }, { key: 'call-1' })).status).toBe(400);
    expect((await jsonCall(b, '/chat/completions', input, { key: 'call-1' })).status).toBe(404);
    expect(f.dispatched).toHaveLength(0);
    const first = await jsonCall(b, '/embeddings', input, { key: 'call-1' });
    const second = await jsonCall(b, '/embeddings', input, { key: 'call-1' });
    expect(first.status).toBe(200); expect(await first.json()).toEqual(await second.json());
    expect(f.dispatched).toHaveLength(1);
    expect(f.dispatched[0]).toMatchObject({ actorID: 'actor-a', accountID: 'payer-a', sessionID: 'session-embedding', model: b.model, operation: 'embedding', path: '/v1/embeddings' });
    expect(f.dispatched[0].callID).toMatch(/^kb_[a-f0-9]{64}$/);
    expect((await jsonCall(b, '/embeddings', { ...input, input: ['changed'] }, { key: 'call-1' })).status).toBe(409);
    expect(JSON.stringify(scope)).not.toContain('owner-private');
  });

  it('never lets another activation replace a fixed payer and expires revoked identity', async () => {
    const f = await fixture(); const scope = await f.activate();
    await expect(f.broker.activate('other-owner', { embedding: 'text-embedding-v4' })).rejects.toMatchObject({ code: 'knowledge_scope_busy' });
    const b = scope.bindings.embedding;
    f.revoke();
    const response = await jsonCall(b, '/embeddings', { model: b.model, input: ['hello'] }, { key: 'call-2' });
    expect(response.status).toBe(401); expect(f.dispatched).toHaveLength(0);
    f.broker.release();
  });

  it('blocks uncertain dispatch and never resends it on an automatic retry', async () => {
    const f = await fixture(); const { bindings } = await f.activate(); const b = bindings.embedding;
    f.failDispatch();
    const input = { model: b.model, input: ['hello'] };
    expect((await jsonCall(b, '/embeddings', input, { key: 'call-3' })).status).toBe(502);
    expect((await jsonCall(b, '/embeddings', input, { key: 'call-3' })).status).toBe(409);
    expect(f.dispatched).toHaveLength(1);
    expect(() => f.broker.release()).toThrow('knowledge_reconciliation_required');
  });

  it('passes the durable worker call ID through without reassigning it', async () => {
    const f = await fixture(); const { bindings } = await f.activate(); const b = bindings.embedding;
    const callId = 'wk_' + 'a'.repeat(60);
    const response = await jsonCall(b, '/embeddings', { model: b.model, input: ['hello'] }, { key: callId });
    expect(response.status).toBe(200);
    expect(f.dispatched[0].callID).toBe(callId);
  });

  it('binds OCR poll to its submitted call and permits only gateway-owned result URLs', async () => {
    const f = await fixture(); const { bindings } = await f.activate(); const b = bindings.ocr;
    const form = new FormData(); form.set('model', b.model); form.set('optionalPayload', '{}'); form.set('file', new Blob(['test'], { type: 'application/pdf' }), 'test.pdf');
    const submit = await fetch(b.baseUrl, { method: 'POST', headers: { authorization: 'Bearer ' + b.apiKey, 'idempotency-key': 'ocr-1' }, body: form });
    expect(submit.status).toBe(200);
    const id = (await submit.json()).data.jobId;
    expect(() => f.broker.release()).toThrow('knowledge_reconciliation_required');
    const denied = await fetch(b.baseUrl + '/different-call', { headers: { authorization: 'Bearer ' + b.apiKey } });
    expect(denied.status).toBe(404);
    const status = await fetch(b.baseUrl + '/' + id, { headers: { authorization: 'Bearer ' + b.apiKey } });
    expect(status.status).toBe(200); expect((await status.json()).data.state).toBe('done');
    expect(f.reads[0]).toMatchObject({ callID: id, sessionID: 'session-ocr', path: '/platform/api/v2/ocr/jobs/' + id });
    f.broker.release();
  });

  it('denies expired capability before upstream IO', async () => {
    const f = await fixture(); const { bindings } = await f.activate(); const b = bindings.embedding;
    f.expire();
    expect((await jsonCall(b, '/embeddings', { model: b.model, input: ['hello'] }, { key: 'call-4' })).status).toBe(401);
    expect(f.dispatched).toHaveLength(0);
  });

  it('deduplicates equivalent OCR multipart bodies with different boundaries', async () => {
    const f = await fixture(); const { bindings } = await f.activate(); const b = bindings.ocr;
    const makeForm = () => { const form = new FormData(); form.set('model', b.model); form.set('optionalPayload', '{}'); form.set('file', new Blob(['same'], { type: 'application/pdf' }), 'same.pdf'); return form; };
    const submit = () => fetch(b.baseUrl, { method: 'POST', headers: { authorization: 'Bearer ' + b.apiKey, 'idempotency-key': 'same-ocr' }, body: makeForm() });
    const first = await submit(); const second = await submit();
    expect(first.status).toBe(200); expect(await first.json()).toEqual(await second.json());
    expect(f.dispatched).toHaveLength(1);
  });

  it('cannot activate a scope after the broker closes during admission', async () => {
    let unblock;
    const admitted = new Promise((resolve) => { unblock = resolve; });
    const broker = await createManagedKnowledgeBroker({ resourceOrigin: 'https://llmrouter.example', admit: () => admitted, validate: async () => true, dispatch: async () => {}, read: async () => {} });
    const opening = broker.activate('owner', { embedding: 'model' });
    await broker.close();
    unblock({ sessionID: 'session', taskID: 'task', actorID: 'actor', accountID: 'payer', model: 'model' });
    await expect(opening).rejects.toMatchObject({ code: 'knowledge_scope_unavailable' });
  });
});
