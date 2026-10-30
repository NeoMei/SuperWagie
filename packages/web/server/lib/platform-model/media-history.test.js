import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, expect, it } from 'vitest';
import { openModelStore } from './store.js';
import { createProductPlatformModelRuntime } from './runtime.js';
import { registerPlatformModelRoutes } from './routes.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const owner = (identity) => crypto.createHash('sha256').update(`${identity.type}:${identity.token}`).digest('hex');
const mediaSession = (identity, model) => 'media_' + crypto.createHash('sha256').update(`${owner(identity)}:${model}`).digest('hex').slice(0, 32);

it('lists only the current device, actor and payer media tasks without dispatch, across restart and pages', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'platform-media-history-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const alice = { type: 'client', token: 'alice-device' };
  const secondDevice = { type: 'client', token: 'other-device' };
  const store = await openModelStore(dir);
  const makeTask = (id, model, actor = 'alice', account = 'personal', sessionID = mediaSession(id, model)) => ({ id: `task-${model}`, sessionID, owner: owner(id), actorID: actor, accountID: account, model });
  const tasks = [makeTask(alice, 'model-a'), makeTask(alice, 'model-b'), makeTask(alice, 'other-payer', 'alice', 'team'), makeTask(secondDevice, 'other-device'), makeTask(alice, 'other-actor', 'mallory'), makeTask(alice, 'forged-id', 'alice', 'personal', 'media_forged'), makeTask(alice, 'agent', 'alice', 'personal', 'ses-agent')];
  await store.mutate((state) => {
    for (const task of tasks) {
      state.tasks[task.sessionID] = task;
      const id = `call-${task.model}`;
      state.calls[id] = { id, sessionID: task.sessionID, taskID: task.id, model: task.model, operation: 'video', digest: 'secret-digest', status: 'DISPATCHED', output: false };
    }
  });
  await store.close();
  let payer = 'personal'; let actor = 'alice'; const requests = [];
  const account = {
    actor: () => ({ actingUserId: actor, billingAccountId: payer, authSession: 'login' }),
    request: async (_identity, target, init) => {
      const body = JSON.parse(init.body);
      return { token: 'fixture-grant', actor_id: actor, account_id: payer, task_id: body.task_id, origin_product_id: 'superwagie', models: body.models, expires_at: new Date(Date.now() + 600000).toISOString() };
    },
  };
  const runtime = await createProductPlatformModelRuntime({
    dataDir: dir, instanceDir: path.join(dir, 'instance'),
    env: { OPENCHAMBER_UNIHUB_GATEWAY_URL: 'http://127.0.0.1:54321/platform/v1', OPENCHAMBER_UNIHUB_MODELS: JSON.stringify([{ id: 'chat', name: 'Chat', context: 8192, maxOutput: 100 }]) },
    getAccountRuntime: () => account,
    readExecution: async () => null, isManaged: () => true, enterprise: () => false,
    fetchImpl: async (url, init) => { requests.push({ url: String(url), method: init.method ?? 'GET' }); return Response.json({ call_id: String(url).split('/').pop(), status: 'SETTLED', charged: '123' }); },
  });
  cleanups.push(() => runtime.close());
  const app = express();
  registerPlatformModelRoutes(app, { runtime, resolveIdentity: (req) => req.headers['x-device'] === 'other' ? secondDevice : alice, readSession: async () => null, isRequestOriginAllowed: () => true });
  const first = await request(app).get('/api/platform-model/media-tasks?limit=1');
  expect(first.status).toBe(200);
  expect(first.body.tasks).toHaveLength(1);
  expect(first.body.nextCursor).toBe(first.body.tasks[0].sessionID);
  const second = await request(app).get('/api/platform-model/media-tasks').query({ limit: 1, after: first.body.nextCursor });
  expect(second.status).toBe(200); expect(second.body.tasks).toHaveLength(1); expect(second.body.nextCursor).toBeNull();
  expect([first.body.tasks[0].model, second.body.tasks[0].model].sort()).toEqual(['model-a', 'model-b']);
  expect(JSON.stringify([first.body, second.body])).not.toContain('secret-digest');
  expect(JSON.stringify([first.body, second.body])).not.toContain('mallory');
  expect((await request(app).get('/api/platform-model/media-tasks').set('x-device', 'other')).body.tasks.map((task) => task.model)).toEqual(['other-device']);
  payer = 'team';
  expect((await request(app).get('/api/platform-model/media-tasks')).body.tasks.map((task) => task.model)).toEqual(['other-payer']);
  payer = 'personal'; actor = 'mallory';
  expect((await request(app).get('/api/platform-model/media-tasks')).body.tasks.map((task) => task.model)).toEqual(['other-actor']);
  expect((await request(app).get('/api/platform-model/media-tasks?limit=51')).status).toBe(400);
  expect((await request(app).get('/api/platform-model/media-tasks?after=invalid')).status).toBe(400);
  expect(requests).toHaveLength(0);
  actor = 'alice';
  const selected = first.body.tasks[0];
  const settled = await request(app).post(`/api/platform-model/sessions/${selected.sessionID}/reconcile`);
  expect(settled.status).toBe(200);
  expect(settled.body.calls).toEqual([{ callID: `call-${selected.model}`, status: 'SETTLED', charged: '123' }]);
  expect(requests).toHaveLength(1);
  expect(requests[0].method).toBe('GET');
});
