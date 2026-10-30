import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createPlatformModelRuntime } from './runtime.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it.each(['oversized', 'interrupted'])('keeps an %s video response unresolved and refuses a second dispatch', async (responseKind) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-media-response-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  let sends = 0;
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume the request */ }
    sends += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    const chunk = Buffer.alloc(128 * 1024, 65);
    if (responseKind === 'interrupted') {
      res.write(chunk);
      setImmediate(() => res.destroy());
      return;
    }
    for (let i = 0; i < 16; i++) res.write(chunk);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const identity = { type: 'client', token: 'fixture-client' };
  const account = {
    actor: () => ({ actingUserId: 'alice', billingAccountId: 'personal', authSession: 'login' }),
    request: async (_identity, target, init) => {
      const body = JSON.parse(init.body);
      return { token: 'fixture-grant', actor_id: 'alice', account_id: target.split('/')[3], task_id: body.task_id, origin_product_id: 'superwagie', models: body.models, expires_at: new Date(Date.now() + 600000).toISOString() };
    },
  };
  const runtime = await createPlatformModelRuntime({
    dataDir: dir, instanceDir: path.join(dir, 'instance'),
    env: {
      OPENCHAMBER_UNIHUB_GATEWAY_URL: `http://127.0.0.1:${server.address().port}/platform/v1`,
      OPENCHAMBER_UNIHUB_MODELS: JSON.stringify([{ id: 'chat', name: 'Chat', context: 8192, maxOutput: 100 }]),
      OPENCHAMBER_UNIHUB_MEDIA_MODELS: JSON.stringify(['wan2.6-t2v']),
    },
    getAccountRuntime: () => account, readExecution: async () => null, isManaged: () => true, enterprise: () => false,
  });
  cleanups.push(() => runtime.close());
  await runtime.admit(identity, { id: 'session', model: { providerID: 'unihub', id: 'chat' } }, 'msg_test');
  const call = { identity, sessionID: 'session', model: 'wan2.6-t2v', operation: 'video', inputs: { prompt: 'cat', seconds: 5, size: '1280*720' } };
  await expect(runtime.mediaDispatch({ ...call, callID: 'video-first' })).rejects.toMatchObject({ code: 'native_media_invalid_response', local: false });
  expect(runtime.status(identity, 'session')).toMatchObject({ blocked: true, calls: [{ callID: 'video-first', status: 'DISPATCHED' }] });
  await expect(runtime.mediaDispatch({ ...call, callID: 'video-retry' })).rejects.toMatchObject({ code: 'platform_reconciliation_required' });
  expect(sends).toBe(1);
});
