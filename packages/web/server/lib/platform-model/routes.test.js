import express from 'express';
import http from 'node:http';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { registerPlatformModelRoutes } from './routes.js';
import { PlatformModelError } from './runtime.js';
import { registerCommonRequestMiddleware } from '../opencode/core-routes.js';
import { registerOpenCodeProxy } from '../opencode/proxy.js';

describe('platform prompt admission routes', () => {
  it('requires authenticated origin and exact prompt admission while forwarding ordinary providers unchanged', async () => {
    const app = express(); app.use(express.json());
    let provider = 'unihub'; let permitted = false; let admitted; let forwarded = 0;
    registerPlatformModelRoutes(app, { runtime: { authorizeSession: () => false, admit: async (identity, session, promptID) => { if (identity.token !== 'owner') throw new PlatformModelError('platform_task_owner_mismatch', 403); admitted = { session, promptID }; } }, resolveIdentity: (req) => ({ type: 'client', token: req.headers.authorization }), readSession: async (id) => ({ id, model: { providerID: provider, id: 'fixture' } }), isRequestOriginAllowed: () => permitted });
    app.post('/api/session/:sessionID/prompt', (req, res) => { forwarded += 1; res.json(req.body); });
    expect((await request(app).post('/api/session/ses_one/prompt').set('Authorization','owner').send({ text: 'hi' })).status).toBe(403);
    permitted = true;
    expect((await request(app).post('/api/session/ses_one/prompt').set('Authorization','other').send({ text: 'hi' })).status).toBe(403);
    const accepted = await request(app).post('/api/session/ses_one/prompt').set('Authorization','owner').send({ text: 'hi' });
    expect(accepted.status).toBe(200); expect(accepted.body.id).toMatch(/^msg_/); expect(admitted.promptID).toBe(accepted.body.id);
    expect(forwarded).toBe(1);
    expect((await request(app).post('/api/session/ses_one/generate').set('Authorization','owner').send({ prompt: 'auxiliary' })).status).toBe(403);
    provider = 'byok'; permitted = false;
    const legacy = await request(app).post('/api/session/ses_one/prompt').send({ text: 'byok' });
    expect(legacy.status).toBe(200); expect(legacy.body.id).toBeUndefined(); expect(forwarded).toBe(2);
  });
  it('parses only platform JSON in the production middleware chain and replays it through the real proxy', async () => {
    const upstream = http.createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ body, length: req.headers['content-length'], transfer: req.headers['transfer-encoding'] }));
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    try {
      const baseURL = `http://127.0.0.1:${upstream.address().port}`;
      const app = express(); registerCommonRequestMiddleware(app, { express });
      let provider = 'unihub'; let admitted;
      registerPlatformModelRoutes(app, { runtime: { authorizeSession: () => false, admit: async (_identity, _session, promptID) => { admitted = promptID; } }, resolveIdentity: () => ({ type: 'client', token: 'owner' }), readSession: async (id) => ({ id, model: { providerID: provider, id: 'fixture' } }), isRequestOriginAllowed: () => true });
      registerOpenCodeProxy(app, { OPEN_CODE_READY_GRACE_MS: 0, LONG_REQUEST_TIMEOUT_MS: 1000, getRuntime: () => ({ openCodePort: upstream.address().port, openCodeBaseUrl: baseURL, isOpenCodeReady: true }), getOpenCodeAuthHeaders: () => ({}), buildOpenCodeUrl: (pathname) => `${baseURL}${pathname}`, ensureOpenCodeApiPrefix: (pathname) => pathname });
      const accepted = await request(app).post('/api/session/ses_one/prompt').send({ parts: [{ type: 'text', text: 'hi' }] });
      expect(accepted.status).toBe(200);
      expect(JSON.parse(accepted.body.body)).toEqual({ id: admitted, parts: [{ type: 'text', text: 'hi' }] });
      expect(admitted).toMatch(/^msg_/);
      expect(Number(accepted.body.length)).toBe(Buffer.byteLength(accepted.body.body));
      expect(accepted.body.transfer).toBeUndefined();
      expect((await request(app).post('/api/session/ses_one/prompt').set('Content-Type', 'application/json').send('{')).status).toBe(400);
      expect((await request(app).post('/api/session/ses_one/prompt').send({ text: 'x'.repeat(1_048_577) })).status).toBe(413);
      provider = 'byok'; admitted = null;
      const raw = '{ "parts" : [] }';
      const legacy = await request(app).post('/api/session/ses_one/prompt').set('Content-Type', 'application/json').send(raw);
      expect(legacy.status).toBe(200); expect(legacy.body.body).toBe(raw); expect(admitted).toBeNull();
    } finally { upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)); }
  });
});
