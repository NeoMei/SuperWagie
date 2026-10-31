import { afterEach, expect, test } from 'bun:test';
import express from 'express';
import { registerConversationMemoryRoutes } from './routes.js';

const servers = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }))); });
const serve = async (runtime) => {
  const app = express();
  registerConversationMemoryRoutes(app, { runtime });
  const server = app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${server.address().port}`;
};

test('parses explicit enablement and rejects client supplied project identities', async () => {
  let enabled = false;
  const url = await serve({ setEnabled: async (next) => { enabled = next; return { enabled }; } });
  expect((await fetch(`${url}/api/conversation-memory/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: 'true' }) })).status).toBe(400);
  expect(enabled).toBe(false);
  const response = await fetch(`${url}/api/conversation-memory/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
  expect(await response.json()).toEqual({ enabled: true });
  expect((await fetch(`${url}/api/conversation-memory/entries?directory=/work/a&projectId=other`)).status).toBe(400);
});

test('forwards the current source scope and exposes stable failures without internal messages', async () => {
  const seen = [];
  const url = await serve({
    capture: async (input) => { seen.push(input); return { queued: true }; },
    forget: async () => { throw Object.assign(new Error('private transcript and token'), { code: 'cleanup_failed', status: 503 }); },
  });
  const captured = await fetch(`${url}/api/conversation-memory/capture`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'ses1', directory: '/work/a' }) });
  expect(await captured.json()).toEqual({ queued: true });
  expect(seen).toEqual([{ sessionId: 'ses1', directory: '/work/a' }]);
  const failed = await fetch(`${url}/api/conversation-memory/entries/card1?directory=/work/a`, { method: 'DELETE' });
  expect(failed.status).toBe(503);
  expect(await failed.json()).toEqual({ error: 'cleanup_failed', code: 'cleanup_failed' });
});


test('bounds explicit methodology proposals and prevents source scope overrides', async () => {
  const seen = [];
  const url = await serve({ consolidate: async (input) => { seen.push(input); return { queued: true }; } });
  const post = (body) => fetch(`${url}/api/conversation-memory/consolidate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect((await post({ directory: '/work/a', entryIds: ['e1'] })).status).toBe(400);
  expect((await post({ directory: '/work/a', entryIds: ['e1', 'e2'], projectId: 'other' })).status).toBe(400);
  const input = { directory: '/work/a', entryIds: ['e1', 'e2'] };
  expect((await post(input)).status).toBe(200);
  expect(seen).toEqual([input]);
});
