import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createProductModelProxy } from './product-model-proxy.js';

const api = 'https://accounts.test';
const gateway = 'https://models.test/platform/v1';
const fixture = (expiredAt, allowedModels = ['fixture-chat']) => {
  const gatewayCalls = [];
  const saved = new Map();
  const app = createProductModelProxy({
    api, gateway, allowedModels, serviceCredential: 'operator-fixture',
    vault: { getSecret: async (ref) => saved.get(ref), putSecret: async (value, ref) => { saved.set(ref, value); } },
    fetchImpl: async (url, init) => {
      const target = new URL(url);
      switch (target.href) {
        case api + '/v1/me':
          return init.headers.Authorization === 'Bearer actor-fixture'
            ? Response.json({ id: 'actor-a' })
            : Response.json({ error: 'unauthenticated' }, { status: 401 });
        case api + '/v1/capabilities':
          if (expiredAt === 'catalog') return Response.json({ error: 'unavailable' }, { status: 503 });
          return Response.json({ client_id: 'superwagie-login', product_id: 'superwagie', product_credit_wallet: true });
        case api + '/v1/accounts/account-a/api-keys':
          expect(init.headers.Authorization).toBe('Bearer actor-fixture');
          expect(JSON.parse(init.body)).toMatchObject({ model_scope: 'llmrouter_available', credit_scope: 'product_v1' });
          if (expiredAt === 'issuance') return Response.json({ error: 'subscription_required' }, { status: 409 });
          return Response.json({
            token: 'uh_key_fixture', actor_id: 'actor-a', account_id: 'account-a', origin_product_id: 'superwagie',
            credit_scope: 'product_v1', model_scope: 'llmrouter_available', funding_mode: 'credits', asset: 'CREDIT/6',
          });
        case api + '/internal/v1/product-runtime/model-proofs':
          expect(init.headers.Authorization).toBe('Bearer operator-fixture');
          expect(init.headers['X-UniHub-Actor-Authorization']).toBe('Bearer actor-fixture');
          if (expiredAt === 'proof') return Response.json({ error: 'product_membership_expired' }, { status: 403 });
          return Response.json({ token: 'proof-fixture', expires_at: Math.floor(Date.now() / 1000) + 90 });
        case gateway + '/chat/completions':
          expect(init.headers).toMatchObject({ Authorization: 'Bearer uh_key_fixture', 'X-UniHub-Product-Authorization': 'proof-fixture', 'Idempotency-Key': 'call-fixture' });
          gatewayCalls.push({ method: init.method, body: JSON.parse(init.body) });
          return new Response('data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream', Authorization: 'Bearer upstream-private' } });
        case gateway + '/calls/call-fixture':
          expect(init.headers).toMatchObject({ Authorization: 'Bearer uh_key_fixture', 'X-UniHub-Product-Authorization': 'proof-fixture' });
          gatewayCalls.push({ method: init.method });
          return Response.json({ call_id: 'pc_fixture', idempotency_key: 'call-fixture', status: 'SETTLED', credit_scope: 'product_v1', asset: 'CREDIT/6', funding_product_id: 'superwagie' });
        case gateway + '/knowledge/route':
          expect(init.headers).toMatchObject({ 'X-UniHub-Task-ID': 'ktask_fixture', 'X-UniHub-Actor-Authorization': 'Bearer actor-fixture' });
          expect(init.headers['Idempotency-Key']).toBeUndefined();
          expect(JSON.parse(init.body)).toEqual({ model: 'text-embedding-v4', wire_operation: 'embeddings.create' });
          return Response.json({ policy_digest: 'a'.repeat(64), authorized_credential_id: 'product-key-id' }, { headers: { 'Cache-Control': 'no-store' } });
        case gateway + '/embeddings':
          expect(init.headers).toMatchObject({ 'X-UniHub-Task-ID': 'ktask_fixture', 'X-UniHub-Knowledge-Policy': 'a'.repeat(64), 'Idempotency-Key': 'wk_' + 'b'.repeat(60), 'X-UniHub-Actor-Authorization': 'Bearer actor-fixture' });
          return Response.json({ data: [] }, { headers: { 'Cache-Control': 'no-store' } });
        case gateway + '/knowledge/results/wk_' + 'b'.repeat(60):
          expect(init.headers['X-UniHub-Task-ID']).toBe('ktask_fixture');
          expect(init.headers['Idempotency-Key']).toBeUndefined();
          return Response.json({ data: [1] }, { headers: { 'X-UniHub-Knowledge-Receipt': 'signed-result', 'Cache-Control': 'no-store' } });
        case gateway + '/videos':
          expect(init.headers).toMatchObject({ Authorization: 'Bearer uh_key_fixture', 'X-UniHub-Product-Authorization': 'proof-fixture', 'Idempotency-Key': 'call-fixture' });
          gatewayCalls.push({ method: init.method, body: JSON.parse(init.body) });
          return Response.json({ task_id: 'verified-provider-task' });
        case gateway + '/videos/call-fixture':
          expect(init.headers['Idempotency-Key']).toBeUndefined();
          return Response.json({ id: 'pc_fixture', idempotency_key: 'call-fixture', task_id: 'verified-provider-task', status: 'SUCCESS' });
        case gateway + '/videos/call-fixture/result':
          return new Response(Buffer.from('local-fixture-media'), { headers: { 'Content-Type': 'video/mp4', 'X-Content-SHA256': 'e'.repeat(64), 'Set-Cookie': 'private-gateway-state' } });
        case gateway + '/images/edits': {
          const parsed = await new Response(init.body, { headers: { 'Content-Type': init.headers['Content-Type'] } }).formData();
          expect(parsed.get('model')).toBe('fixture-chat');
          expect(parsed.get('prompt')).toBe('fixture prompt');
          return Response.json({ id: 'pc_fixture', idempotency_key: 'call-fixture', status: 'pending' }, { status: 202 });
        }
        case gateway + '/images/edits/call-fixture':
          return Response.json({ id: 'pc_fixture', idempotency_key: 'call-fixture', status: 'pending' }, { status: 202 });
        default:
          throw new Error('Unexpected test destination');
      }
    },
  });
  const headers = { Authorization: 'Bearer actor-fixture', 'X-UniHub-Billing-Account': 'account-a', 'X-UniHub-Model': 'fixture-chat', 'Idempotency-Key': 'call-fixture' };
  const body = { model: 'fixture-chat', stream: true, messages: [{ role: 'user', content: 'fixture prompt' }] };
  return { app, headers, body, gatewayCalls, saved };
};

describe('isolated product model proxy', () => {
  it('forwards the admitted chat and reads its original receipt without returning either credential', async () => {
    const f = fixture();
    const chat = await request(f.app).post('/v1/product-model/chat').set(f.headers).send(f.body).expect(200);
    expect(chat.text).toBe('data: [DONE]\n\n');
    expect(chat.headers.authorization).toBeUndefined();
    const receipt = await request(f.app).get('/v1/product-model/calls/call-fixture').set(f.headers).expect(200);
    expect(receipt.body).toMatchObject({ idempotency_key: 'call-fixture', credit_scope: 'product_v1' });
    expect(JSON.stringify(receipt.body)).not.toMatch(/uh_key_|proof-fixture|operator-fixture/);
    expect(f.gatewayCalls).toEqual([{ method: 'POST', body: f.body }, { method: 'GET' }]);
  });

  it.each(['issuance', 'proof'])('reports inactive membership at %s before forwarding a paid model call', async (source) => {
    const f = fixture(source);
    await request(f.app).post('/v1/product-model/chat').set(f.headers).send(f.body)
      .expect(403, { error: { code: 'product_membership_expired', stage: 'pre_admission' } });
    expect(f.gatewayCalls).toHaveLength(0);
  });

  it('rejects a browser origin, another model, or an invalid actor before contacting the gateway', async () => {
    const f = fixture();
    await request(f.app).post('/v1/product-model/chat').set(f.headers).set('Origin', 'https://app.test').send(f.body).expect(400);
    await request(f.app).post('/v1/product-model/chat').set(f.headers).send({ ...f.body, model: 'other-model' }).expect(400);
    await request(f.app).post('/v1/product-model/chat').set(f.headers).set('Authorization', 'Bearer expired-actor').send(f.body).expect(401);
    await request(f.app).post('/v1/product-model/images').set(f.headers).send(f.body).expect(404);
    expect(f.gatewayCalls).toHaveLength(0);
  });

  it('forwards only the fixed knowledge model, immutable policy/task and canonical evidence', async () => {
    const f = fixture(undefined, ['text-embedding-v4']);
    const headers = { ...f.headers, 'X-UniHub-Model': 'text-embedding-v4', 'X-UniHub-Task-ID': 'ktask_fixture' };
    const key = 'wk_' + 'b'.repeat(60);
    const anchor = { model: 'text-embedding-v4', wire_operation: 'embeddings.create' };
    await request(f.app).post('/v1/product-model/knowledge-route').set(headers).send({ ...anchor, wire_operation: 'rerank.create' }).expect(400);
    await request(f.app).post('/v1/product-model/knowledge-route').set(headers).send(anchor).expect(200);
    await request(f.app).post('/v1/product-model/knowledge-embedding').set(headers).set('Idempotency-Key', key).set('X-UniHub-Knowledge-Policy', 'a'.repeat(64))
      .send({ model: 'text-embedding-v4', input: 'test', dimensions: 1024, encoding_format: 'float' }).expect(200);
    const got = await request(f.app).post('/v1/product-model/knowledge-results/' + key).set(headers).expect(200);
    expect(got.headers['x-unihub-knowledge-receipt']).toBe('signed-result');
  });

  it('submits certified video and preserves the original ID and safe download evidence', async () => {
    const f = fixture();
    const path = '/v1/product-model/videos';
    const input = { model: 'fixture-chat', prompt: 'fixture prompt', seconds: 5, size: '1280*720' };
    await request(f.app).post(path).set(f.headers).send(input).expect(200, { task_id: 'verified-provider-task' });
    await request(f.app).get(path + '/call-fixture').set(f.headers).expect(200);
    const output = await request(f.app).get(path + '/call-fixture/result').set(f.headers).expect(200);
    expect(output.headers['x-content-sha256']).toBe('e'.repeat(64));
    expect(output.headers['set-cookie']).toBeUndefined();
    expect(f.gatewayCalls).toEqual([{ method: 'POST', body: input }]);
  });

  it('admits the certified multipart image edit model and refuses a mismatched body', async () => {
    const f = fixture();
    const path = '/v1/product-model/image-edit';
    const upload = (model) => request(f.app).post(path).set(f.headers).field('model', model).field('prompt', 'fixture prompt').field('n', '1')
      .attach('image', Buffer.from('fixture-image'), { filename: 'source.png', contentType: 'image/png' })
      .attach('mask', Buffer.from('fixture-mask'), { filename: 'mask.png', contentType: 'image/png' });
    await upload('other-model').expect(400);
    await upload('fixture-chat').expect(202);
    await request(f.app).get(path + '/call-fixture').set(f.headers).expect(202);
  });

  it('recovers the original receipt after the admission catalog retires the model', async () => {
    const active = fixture();
    await request(active.app).post('/v1/product-model/chat').set(active.headers).send(active.body).expect(200);
    const retired = fixture('catalog', ['replacement-model']);
    for (const [ref, value] of active.saved) retired.saved.set(ref, value);
    await request(retired.app).post('/v1/product-model/chat').set(retired.headers).send(retired.body).expect(400);
    await request(retired.app).get('/v1/product-model/calls/call-fixture').set(retired.headers).expect(200);
    expect(retired.gatewayCalls).toEqual([{ method: 'GET' }]);
  });
});
