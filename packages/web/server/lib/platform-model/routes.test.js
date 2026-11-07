import express from 'express';
import http from 'node:http';
import request from 'supertest';
import { isSessionNotFoundError, OpenCode } from '@opencode/client';
import { describe, expect, it } from 'vitest';
import { registerPlatformModelRoutes } from './routes.js';
import { PlatformModelError } from './runtime.js';
import { registerCommonRequestMiddleware } from '../opencode/core-routes.js';
import { registerOpenCodeProxy } from '../opencode/proxy.js';
import { createUnavailablePlatformModelRuntime } from './degraded.js';
import { createOpenCodeRequestReadiness } from '../opencode/request-readiness.js';

describe('platform prompt admission routes', () => {
  it('stops before native session reads when the request readiness gate closes the request', async () => {
    const app = express();
    let read = 0;
    registerPlatformModelRoutes(app, {
      runtime: { authorizeSession() {} },
      resolveIdentity: () => ({ type: 'client', token: 'owner' }),
      waitForOpenCodeRequest: createOpenCodeRequestReadiness({ getRuntime: () => ({ openCodePort: null, isOpenCodeReady: false, isRestartingOpenCode: true }), readyGraceMs: 0 }),
      readSession: async () => { read += 1; throw new Error('engine port unavailable'); },
      isRequestOriginAllowed: () => true,
    });
    const response = await request(app).post('/api/session/ses_one/prompt').send({ parts: [] });
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'OpenCode is restarting', restarting: true });
    expect(read).toBe(0);
  });
  it('holds a prompt before native session admission in production registration order and forwards once after readiness', async () => {
    let forwarded = 0;
    const upstream = http.createServer(async (req, res) => {
      forwarded += 1;
      let body = ''; for await (const chunk of req) body += chunk;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    try {
      const runtime = { openCodePort: null, isOpenCodeReady: false, isRestartingOpenCode: true, openCodeNotReadySince: 0 };
      let markWaiting;
      const waiting = new Promise((resolve) => { markWaiting = resolve; });
      let reads = 0;
      let admitted = 0;
      const waitForOpenCodeRequest = createOpenCodeRequestReadiness({ getRuntime: () => { markWaiting(); return runtime; }, readyGraceMs: 6000 });
      const app = express();
      registerCommonRequestMiddleware(app, { express });
      registerPlatformModelRoutes(app, {
        runtime: { authorizeSession() {}, admit: async () => { admitted += 1; } },
        resolveIdentity: () => ({ type: 'client', token: 'owner' }),
        waitForOpenCodeRequest,
        readSession: async (id) => {
          reads += 1;
          if (!runtime.isOpenCodeReady) throw new Error('engine port unavailable');
          return { id, model: { providerID: 'unihub', id: 'fixture' } };
        },
        isRequestOriginAllowed: () => true,
      });
      registerOpenCodeProxy(app, { OPEN_CODE_READY_GRACE_MS: 6000, LONG_REQUEST_TIMEOUT_MS: 1000, getRuntime: () => runtime, getOpenCodeAuthHeaders: () => ({}), buildOpenCodeUrl: (pathname) => `http://127.0.0.1:${runtime.openCodePort}${pathname}`, ensureOpenCodeApiPrefix: () => {} });
      const pending = request(app).post('/api/session/ses_one/prompt').send({ parts: [{ type: 'text', text: 'hi' }] }).then((response) => response);
      await waiting;
      expect(reads).toBe(0);
      expect(admitted).toBe(0);
      runtime.openCodePort = upstream.address().port;
      runtime.isOpenCodeReady = true;
      runtime.isRestartingOpenCode = false;
      const response = await pending;
      expect(response.status).toBe(200);
      expect(response.body.parts).toEqual([{ type: 'text', text: 'hi' }]);
      expect(response.body.id).toMatch(/^msg_/);
      expect(reads).toBe(1);
      expect(admitted).toBe(1);
      expect(forwarded).toBe(1);
    } finally { upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)); }
  });
  it('abandons a disconnected prompt during readiness without reading or admitting it', async () => {
    const app = express();
    const runtime = { openCodePort: null, isOpenCodeReady: false, isRestartingOpenCode: true, openCodeNotReadySince: 0 };
    let markWaiting;
    const waiting = new Promise((resolve) => { markWaiting = resolve; });
    let markStopped;
    const stopped = new Promise((resolve) => { markStopped = resolve; });
    let read = 0;
    let admitted = 0;
    const gate = createOpenCodeRequestReadiness({ getRuntime: () => { markWaiting(); return runtime; }, readyGraceMs: 6000 });
    registerPlatformModelRoutes(app, {
      runtime: { authorizeSession() {}, admit: async () => { admitted += 1; } },
      resolveIdentity: () => ({ type: 'client', token: 'owner' }),
      waitForOpenCodeRequest: async (req, res) => { const ready = await gate(req, res); markStopped(ready); return ready; },
      readSession: async (id) => { read += 1; return { id, model: { providerID: 'unihub', id: 'fixture' } }; },
      isRequestOriginAllowed: () => true,
    });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const client = http.request(`http://127.0.0.1:${server.address().port}/api/session/ses_one/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' } });
    const closed = new Promise((resolve) => client.once('error', resolve));
    try {
      client.end(JSON.stringify({ parts: [] }));
      await waiting;
      client.destroy();
      await closed;
      runtime.openCodePort = 12345;
      runtime.isOpenCodeReady = true;
      runtime.isRestartingOpenCode = false;
      expect(await stopped).toBe(false);
      expect(read).toBe(0);
      expect(admitted).toBe(0);
    } finally { client.destroy(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  });
  it('preserves a missing native session as an SDK-readable 404 before prompt admission', async () => {
    const app = express();
    let admitted = 0;
    let forwarded = 0;
    registerPlatformModelRoutes(app, {
      runtime: { authorizeSession() {}, admit: async () => { admitted += 1; } },
      resolveIdentity: () => ({ type: 'client', token: 'owner' }),
      readSession: async (sessionID) => { throw Object.assign(new Error('native diagnostic detail'), { _tag: 'SessionNotFoundError', sessionID }); },
      isRequestOriginAllowed: () => true,
    });
    app.post('/api/session/:sessionID/prompt', (_req, res) => { forwarded += 1; res.json({}); });
    const response = await request(app).post('/api/session/ses_missing/prompt').send({ parts: [] });
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ _tag: 'SessionNotFoundError', sessionID: 'ses_missing', message: 'Session not found' });
    const client = OpenCode.make({ baseUrl: 'http://fixture.invalid', fetch: async () => new Response(JSON.stringify(response.body), { status: response.status, headers: { 'content-type': 'application/json' } }) });
    const error = await client.session.prompt({ sessionID: 'ses_missing', parts: [] }).catch((error) => error);
    expect(isSessionNotFoundError(error)).toBe(true);
    expect(admitted).toBe(0);
    expect(forwarded).toBe(0);
  });
  it('keeps failed native session reads unavailable without forwarding or exposing diagnostics', async () => {
    const app = express();
    let forwarded = 0;
    registerPlatformModelRoutes(app, {
      runtime: { authorizeSession() {} },
      resolveIdentity: () => ({ type: 'client', token: 'owner' }),
      readSession: async () => { throw new Error('private native connection detail'); },
      isRequestOriginAllowed: () => true,
    });
    app.post('/api/session/:sessionID/prompt', (_req, res) => { forwarded += 1; res.json({}); });
    const response = await request(app).post('/api/session/ses_one/prompt').send({ parts: [] });
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'platform_models_unavailable' });
    expect(forwarded).toBe(0);
  });
  it('authorizes the session owner before reading whether a native session exists', async () => {
    const app = express();
    let read = 0;
    registerPlatformModelRoutes(app, {
      runtime: { authorizeSession() { throw new PlatformModelError('platform_task_owner_mismatch', 403); } },
      resolveIdentity: () => ({ type: 'client', token: 'other' }),
      readSession: async (sessionID) => { read += 1; throw Object.assign(new Error('Session not found'), { _tag: 'SessionNotFoundError', sessionID }); },
      isRequestOriginAllowed: () => true,
    });
    const response = await request(app).post('/api/session/ses_missing/prompt').send({ parts: [] });
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'platform_task_owner_mismatch' });
    expect(read).toBe(0);
  });
  it('keeps read and unrelated APIs available but refuses session mutations when the journal is locked', async () => {
    const app = express();
    const runtime = createUnavailablePlatformModelRuntime('platform_store_busy');
    registerPlatformModelRoutes(app, { runtime, resolveIdentity: () => ({ type: 'client', token: 'owner' }), readSession: async () => ({ model: { providerID: 'byok' } }), isRequestOriginAllowed: () => true });
    app.use((req, res) => res.json({ passed: true }));
    expect((await request(app).get('/api/session/ses_one')).status).toBe(200);
    expect((await request(app).post('/api/config/settings')).status).toBe(200);
    for (const path of ['/api/session/ses_one/prompt', '/api/session/ses_one/model', '/API/SESSION/ses_one/prompt', '/api/%73ession/ses_one/prompt', '/api/%2525252573ession/ses_one/prompt', '/api/session']) {
      const response = await request(app).post(path).send({});
      expect(response.status, path).toBe(503);
      expect(response.body.error, path).toBe('platform_store_busy');
    }
    expect((await request(app).get('/api/platform-model/sessions/ses_one')).body.error).toBe('platform_store_busy');
  });
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
