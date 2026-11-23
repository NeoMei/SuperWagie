import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { expect, it, vi } from 'vitest';
import { createModelBootstrapStore } from '../model-configuration/bootstrap-store.js';
import { registerModelBootstrapRoutes } from '../model-configuration/bootstrap-routes.js';
import { sampleImage, sttProbeWav } from '../model-configuration/adapters.js';
import { createManagedModelChecks } from './model-checks.js';
import { managedCheckCallId, managedModelCheckPlan, probeManagedModel } from './model-check-probes.js';

const config = {
  gateway: 'https://gateway.test/platform/v1',
  models: [{ id: 'fixture-text' }, { id: 'deepseek-v4-flash-vision-exp' }],
  mediaModels: ['qwen3-tts-flash', 'qwen3-tts-instruct-flash', 'qwen3-asr-flash', 'qwen-image-2.0', 'qwen-image-2.0-pro', 'wanx2.1-imageedit', 'wan2.6-t2v'],
};
const identity = { type: 'session', token: 'fixture-owner' };
const settled = (callId, canonicalId = 'gateway-fixture') => Response.json({ call_id: canonicalId, idempotency_key: callId, credit_scope: 'product_v1', funding_product_id: 'superwagie', asset: 'CREDIT/6', status: 'SETTLED' });
const events = (value) => new Response(value, { headers: { 'Content-Type': 'text/event-stream' } });
const answer = 'data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const scope = () => ({ actingUserId: 'actor-a', billingAccountId: 'account-a' });

it('keeps reads free and checks models only after a same-origin action from the selected payer', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'managed-model-check-'));
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const calls = new Map();
  const platformAccount = {
    actor: (auth) => ({ ...scope(), actingUserId: auth === identity ? 'actor-a' : 'actor-b', authSession: 'fixture-login' }),
    captureCommerceSession: (auth) => ({ ...scope(), actingUserId: auth === identity ? 'actor-a' : 'actor-b', serviceId: 'fixture-service' }),
    instancePrincipal: (auth) => ({ issuer: 'https://account.test', userId: auth === identity ? 'actor-a' : 'actor-b' }),
    usesProductCreditWallet: vi.fn(async () => true),
    proxyProductModel: vi.fn(async (_actor, { operation, callId, model, body }) => {
      if (operation === 'receipt') return settled(callId);
      calls.set(operation + '/' + model, JSON.parse(body));
      await blocked;
      if (model === 'fixture-text') return events('data: [DONE]\n\n');
      return events(answer);
    }),
  };
  const managedAccountKey = createManagedModelChecks({
    platformAccount, store: createModelBootstrapStore({ dataDir }), isAvailable: () => true,
    models: () => ({ gateway: config.gateway, models: config.models }), enterprise: () => false,
    probe: (input) => input.row.operation.startsWith('knowledge-') || input.row.operation === 'ocr' ? Promise.resolve() : probeManagedModel(input),
  });
  const app = express();
  registerModelBootstrapRoutes(app, {
    managedAccountKey, resolveIdentity: (req) => req.get('X-Test-Actor') === 'other' ? { type: 'session', token: 'other-owner' } : identity,
    resolveOwner: () => identity,
    isRequestOriginAllowed: async (req) => req.get('Origin') === 'https://fixture.test',
  });
  const route = '/api/model-configuration/bootstrap/account-key';
  const input = { action: 'retest', accountId: 'account-a', fundingMode: 'credits' };
  try {
    const initial = await request(app).get(route).query({ accountId: 'account-a' }).expect(200);
    expect(initial.headers['cache-control']).toBe('no-store');
    expect(initial.body).toMatchObject({ mode: 'managed', activation: { actions: ['retest'], testRunId: null } });
    expect(initial.body.activation.tests).toHaveLength(6);
    expect(platformAccount.proxyProductModel).not.toHaveBeenCalled();
    expect(platformAccount.usesProductCreditWallet).not.toHaveBeenCalled();
    await request(app).post(route).send(input).expect(403);
    await request(app).post(route).set('Origin', 'https://fixture.test').send({ ...input, accountId: 'other-account' }).expect(403);
    await request(app).post(route).set('Origin', 'https://fixture.test').send({ ...input, action: 'activate' }).expect(400);
    await request(app).post(route).set('Origin', 'https://fixture.test').send({ ...input, model: 'arbitrary' }).expect(400);
    await request(app).post('/api/model-configuration/bootstrap/issue-key').send({}).expect(501);
    const started = await request(app).post(route).set('Origin', 'https://fixture.test').send(input).expect(200);
    expect(started.body.activation.status).toBe('testing');
    await request(app).post(route).set('Origin', 'https://fixture.test').send(input).expect(409);
    const other = await request(app).get(route).set('X-Test-Actor', 'other').query({ accountId: 'account-a' }).expect(200);
    expect(other.body.activation.testRunId).toBeNull();
    release();
    await vi.waitFor(async () => {
      const result = await request(app).get(route).query({ accountId: 'account-a' }).expect(200);
      expect(result.body.activation).toMatchObject({ status: 'failed', testRunId: started.body.activation.testRunId });
      const rows = result.body.activation.tests;
      expect(rows.map(({ status }) => status)).toEqual(['failed', 'verified', 'verified', 'verified', 'verified', 'verified']);
      expect(rows[0].errorCode).toBe('model_configuration_test_invalid_response');
      expect(rows.every((row) => !('callId' in row))).toBe(true);
    });
    expect(platformAccount.proxyProductModel.mock.calls.filter(([, call]) => call.operation === 'chat')).toHaveLength(3);
    expect(calls.get('chat/deepseek-v4-flash-vision-exp').messages[0].content[1].type).toBe('image_url');
  } finally {
    release();
    await rm(dataDir, { recursive: true, force: true });
  }
});

const taskId = 'test-run-fixture';
const wire = (row) => row.operation === 'knowledge-embedding' ? 'embeddings.create' : 'rerank.create';
const knowledgeResult = (row, callId) => {
  const data = row.operation === 'knowledge-embedding' ? { data: [{ embedding: Array(1024).fill(0.25) }] } : { output: { results: [{ index: 0, relevance_score: 0.95 }] } };
  const bytes = Buffer.from(JSON.stringify(data));
  const receipt = { call_id: callId, task_id: taskId, model: row.modelId, wire_operation: wire(row), policy_digest: 'a'.repeat(64), status: 'SETTLED', content_sha256: digest(bytes) };
  return new Response(bytes, { headers: { 'X-UniHub-Knowledge-Receipt': Buffer.from(JSON.stringify(receipt)).toString('base64url') } });
};
const fixtureResponses = (row, callId) => {
  const png = sampleImage.split(',')[1];
  const mp4 = Buffer.from('0000ftypmp42');
  const ocr = Buffer.from(JSON.stringify({ id: 'ocr-fixture', pages: [{ text: 'SuperWagie connection test', layout: [] }] }));
  return {
    chat: () => events(answer),
    speech: () => new Response(sttProbeWav(), { headers: { 'Content-Type': 'audio/wav' } }),
    transcription: () => Response.json({ choices: [{ message: { content: '' } }], usage: { seconds: 1 } }),
    'image-generation': () => Response.json({ data: [{ b64_json: png }] }),
    'image-edit': () => Response.json({ idempotency_key: callId, status: 'pending' }, { status: 202 }),
    'image-edit-status': () => Response.json({ data: [{ b64_json: png }] }),
    video: () => Response.json({ task_id: 'video-fixture' }),
    'video-status': () => Response.json({ id: 'gateway-fixture', idempotency_key: callId, status: 'SUCCESS' }),
    'video-result': () => new Response(mp4, { headers: { 'X-Content-SHA256': digest(mp4) } }),
    'knowledge-route': () => Response.json({ policy_digest: 'a'.repeat(64) }),
    'knowledge-embedding': () => Response.json({}),
    'knowledge-rerank': () => Response.json({}),
    'knowledge-result': () => knowledgeResult(row, callId),
    'ocr-submit': () => Response.json({ code: 0 }),
    'ocr-status': () => Response.json({ code: 0, data: { jobId: 'ocr-fixture', state: 'done', extractProgress: { totalPages: 1, extractedPages: 1 } } }),
    'ocr-document': () => new Response(ocr, { headers: { 'X-Content-SHA256': digest(ocr), 'X-UniHub-Call-ID': 'ocr-fixture', 'X-UniHub-Idempotency-Key': callId } }),
    receipt: () => settled(callId, row.operation === 'ocr' ? 'ocr-fixture' : undefined),
  };
};

it.each(managedModelCheckPlan(config))('validates the model output and settled receipt for $id', async (row) => {
  const callId = managedCheckCallId(row.operation);
  const responses = fixtureResponses(row, callId);
  const send = vi.fn(async ({ operation }) => responses[operation]());
  await probeManagedModel({ row, callId, taskId, send, signal: AbortSignal.timeout(1000), gateway: config.gateway });
  expect(send.mock.calls.filter(([call]) => call.body !== undefined && call.operation !== 'knowledge-route')).toHaveLength(1);
  expect(send.mock.calls.filter(([call]) => call.operation === 'receipt')).toHaveLength(1);
});

it('does not pass a healthy SSE stream with a receipt belonging to another call', async () => {
  const row = managedModelCheckPlan(config)[0];
  const send = async ({ operation }) => operation === 'chat' ? events(answer) : settled('wrong-call');
  await expect(probeManagedModel({ row, callId: managedCheckCallId(row.operation), send, signal: AbortSignal.timeout(1000), gateway: config.gateway }))
    .rejects.toThrow('model_configuration_test_invalid_response');
});

it('stops after an authoritative funding refusal and never replays a persisted interrupted batch', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'managed-model-check-'));
  const store = createModelBootstrapStore({ dataDir });
  const platformAccount = {
    actor: () => ({ ...scope(), authSession: 'fixture-login' }),
    captureCommerceSession: () => ({ ...scope(), serviceId: 'fixture-service' }),
    instancePrincipal: () => ({ issuer: 'https://account.test', userId: 'actor-a' }),
    usesProductCreditWallet: async () => true,
    proxyProductModel: vi.fn(async () => Response.json({ error: { code: 'platform_model_credits_required', stage: 'pre_admission' } }, { status: 402 })),
  };
  const options = { platformAccount, store, models: () => config, isAvailable: () => true, enterprise: () => false };
  const check = createManagedModelChecks(options);
  const input = { identity, owner: identity, accountId: 'account-a', action: 'retest' };
  try {
    const initial = await check.read(input);
    const started = await check.activate(input);
    await vi.waitFor(async () => expect((await check.read(input)).activation.status).toBe('failed'));
    const final = await check.read(input);
    expect(final.activation.tests[0]).toMatchObject({ status: 'failed', errorCode: 'platform_model_credits_required' });
    expect(final.activation.tests.at(-1)).toMatchObject({ status: 'skipped', errorCode: 'account_key_checks_stopped' });
    expect(platformAccount.proxyProductModel.mock.calls.length).toBeLessThanOrEqual(3);

    // Emulate a restart after persisting intent but before a terminal result.
    const key = initial.activation.operationId;
    const saved = await store.read(key);
    await store.update(key, {
      status: 'testing', test: null,
      tests: saved.tests.map((row, index) => index === 1 ? { ...row, status: 'testing' } : row),
    });
    const requestCount = platformAccount.proxyProductModel.mock.calls.length;
    const restarted = await createManagedModelChecks(options).read(input);
    expect(restarted.activation).toMatchObject({ status: 'unknown', testRunId: started.activation.testRunId });
    expect(restarted.activation.tests[0].status).toBe('failed');
    expect(restarted.activation.tests[1].status).toBe('unknown');
    expect(platformAccount.proxyProductModel.mock.calls).toHaveLength(requestCount);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
