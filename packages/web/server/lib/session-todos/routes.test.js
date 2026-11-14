import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, expect, it } from 'vitest';
import { createSessionTodosRuntime } from './runtime.js';
import { registerSessionTodosRoutes } from './routes.js';

const resources = [];
afterEach(async () => {
  for (const { runtime, directory } of resources.splice(0)) { await runtime.stop(); fs.rmSync(directory, { recursive: true, force: true }); }
});
const serve = (overrides, fetchImpl = async () => new Response(null, { status: 503 })) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-todos-route-'));
  const runtime = createSessionTodosRuntime({
    dataDir: directory, buildOpenCodeUrl: (route) => `http://upstream.test${route}`, getOpenCodeAuthHeaders: () => ({}),
    globalEventHub: { subscribeEvent: () => () => {}, subscribeStatus: () => () => {} }, getFlagOverrides: () => overrides,
    isSpaceDirectory: (value) => value.startsWith('/spaces/'), fetchImpl,
  });
  resources.push({ runtime, directory });
  const app = express();
  registerSessionTodosRoutes(app, { sessionTodosRuntime: runtime });
  return app;
};
it('returns off and unsupported separately and validates the scope', async () => {
  const app = serve('-todo');
  expect((await request(app).get('/api/session-todos/ses_123?directory=/repo')).body.state).toBe('off');
  expect((await request(app).get('/api/session-todos/ses_123?directory=/spaces/test')).body.state).toBe('unsupported');
  expect((await request(app).get('/api/session-todos/ses_123')).status).toBe(400);
});
it('an upstream failure is a failed response rather than a confirmed empty list', async () => {
  const app = serve('todo');
  const response = await request(app).get('/api/session-todos/ses_123?directory=/repo');
  expect(response.status).toBe(502);
  expect(response.body.todos).toBeUndefined();
});

it('an oversized newest completed list returns an explicit error without a completed prefix', async () => {
  const oversized = [...Array.from({ length: 200 }, (_, index) => ({ content: `Done ${index}`, status: 'completed' })), { content: 'Pending', status: 'pending' }];
  const app = serve('todo', async (url) => new URL(String(url)).pathname.endsWith('/message')
    ? Response.json({ data: [{ time: { created: 100, completed: 110 }, content: [{ type: 'tool', name: 'todowrite', state: { status: 'completed', input: { todos: oversized } } }] }], cursor: {} })
    : Response.json({ data: { id: 'ses_123' } }));
  const response = await request(app).get('/api/session-todos/ses_123?directory=/repo');
  expect(response.status).toBe(502);
  expect(response.body).toMatchObject({ code: 'todo-list-too-large' });
  expect(response.body.todos).toBeUndefined();
});
