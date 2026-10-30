import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openModelStore } from './store.js';
import { createPlatformModelRuntime, createProductPlatformModelRuntime } from './runtime.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it.each([200, 500])('cancels oversized receipt streams (HTTP %i) and preserves the original pending call', async (httpStatus) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'receipt-response-bound-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const identity = { type: 'client', token: 'fixture-client' };
  const owner = crypto.createHash('sha256').update(`${identity.type}:${identity.token}`).digest('hex');
  const store = await openModelStore(dir);
  await store.mutate((state) => {
    state.tasks.session = { id: 'task-a', sessionID: 'session', owner, actorID: 'alice', accountID: 'personal', model: 'chat' };
    state.calls.call = { id: 'call', sessionID: 'session', taskID: 'task-a', model: 'chat', operation: 'video', digest: 'fixture', status: 'ASYNC_PENDING', output: false };
  });
  await store.close();
  let cancelled = false; let chunks = 0;
  const body = new ReadableStream({
    pull(controller) { if (chunks++ < 16) controller.enqueue(new Uint8Array(128 * 1024).fill(65)); else controller.close(); },
    cancel() { cancelled = true; },
  });
  const account = {
    actor: () => ({ actingUserId: 'alice', billingAccountId: 'personal', authSession: 'fixture' }),
    request: async (_identity, _target, init) => {
      const body = JSON.parse(init.body);
      return { token: 'fixture', actor_id: 'alice', account_id: 'personal', task_id: body.task_id, origin_product_id: 'superwagie', models: body.models, expires_at: new Date(Date.now() + 600000).toISOString() };
    },
  };
  const runtime = await createProductPlatformModelRuntime({
    dataDir: dir, instanceDir: path.join(dir, 'instance'),
    env: { OPENCHAMBER_UNIHUB_GATEWAY_URL: 'http://127.0.0.1:54321/platform/v1', OPENCHAMBER_UNIHUB_MODELS: JSON.stringify([{ id: 'chat', name: 'Chat', context: 8192, maxOutput: 100 }]) },
    getAccountRuntime: () => account, readExecution: async () => null, isManaged: () => true, enterprise: () => false,
    fetchImpl: async () => new Response(body, { status: httpStatus, headers: { 'content-type': 'application/json' } }),
  });
  cleanups.push(() => runtime.close());
  await expect(runtime.reconcile(identity, 'session')).rejects.toMatchObject({ code: 'platform_reconciliation_required' });
  expect(cancelled).toBe(true);
  expect(runtime.status(identity, 'session').calls).toEqual([{ callID: 'call', status: 'DELIVERED' }]);
});

it.each([200, 500])('cancels oversized video status (HTTP %i) without changing the original pending call', async (httpStatus) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'video-status-bound-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const identity = { type: 'client', token: 'fixture-client' };
  const owner = crypto.createHash('sha256').update(`${identity.type}:${identity.token}`).digest('hex');
  const store = await openModelStore(dir);
  await store.mutate((state) => {
    state.tasks.session = { id: 'task-a', sessionID: 'session', owner, actorID: 'alice', accountID: 'personal', model: 'chat' };
    state.calls.call = { id: 'call', sessionID: 'session', taskID: 'task-a', model: 'chat', operation: 'video', digest: 'fixture', status: 'ASYNC_PENDING', output: false };
  });
  await store.close();
  let cancelled = false; let chunks = 0;
  const body = new ReadableStream({
    pull(controller) { if (chunks++ < 16) controller.enqueue(new Uint8Array(128 * 1024).fill(65)); else controller.close(); },
    cancel() { cancelled = true; },
  });
  const account = {
    actor: () => ({ actingUserId: 'alice', billingAccountId: 'personal', authSession: 'fixture' }),
    request: async (_identity, _target, init) => {
      const body = JSON.parse(init.body);
      return { token: 'fixture', actor_id: 'alice', account_id: 'personal', task_id: body.task_id, origin_product_id: 'superwagie', models: body.models, expires_at: new Date(Date.now() + 600000).toISOString() };
    },
  };
  const runtime = await createPlatformModelRuntime({
    dataDir: dir, instanceDir: path.join(dir, 'instance'),
    env: { OPENCHAMBER_UNIHUB_GATEWAY_URL: 'http://127.0.0.1:54321/platform/v1', OPENCHAMBER_UNIHUB_MODELS: JSON.stringify([{ id: 'chat', name: 'Chat', context: 8192, maxOutput: 100 }]) },
    getAccountRuntime: () => account, readExecution: async () => ({ promptID: 'msg_test', idle: null, model: { providerID: 'unihub', id: 'chat' } }), isManaged: () => true, enterprise: () => false,
    fetchImpl: async () => new Response(body, { status: httpStatus, headers: { 'content-type': 'application/json' } }),
  });
  cleanups.push(() => runtime.close());
  await runtime.materializePlugin();
  await runtime.admit(identity, { id: 'session', model: { providerID: 'unihub', id: 'chat' } }, 'msg_test');
  const env = runtime.createChildEnv();
  const response = await fetch(env.OPENCHAMBER_UNIHUB_PROXY_URL + '/media/video/status', {
    method: 'POST', headers: { authorization: `Bearer ${env.OPENCHAMBER_UNIHUB_PROXY_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ sessionID: 'session', callID: 'call' }),
  });
  expect(response.status).toBe(502);
  expect((await response.json()).error.code).toBe(httpStatus === 200 ? 'platform_video_status_invalid' : 'platform_video_status_unavailable');
  expect(cancelled).toBe(true);
  expect(runtime.status(identity, 'session').calls).toEqual([{ callID: 'call', status: 'DELIVERED' }]);
});
