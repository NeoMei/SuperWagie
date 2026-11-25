import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { registerRoutingPromptRewrite, registerRoutingRoutes } from './routes.js';
import { createRoutingRuntime } from './runtime.js';
import { resolveEffectiveConfig } from './store.js';

/**
 * The send rewrite sits in front of the generic OpenCode proxy, which replays
 * `req.body` when a middleware parsed it. These tests mount the rewrite ahead
 * of a stand-in proxy that records what it would forward.
 */
const createApp = ({ routeSend, prepareSend, routePreparedSend, autoSessions = new Set() } = {}) => {
  const forwarded = [];
  const runtime = {
    noteModelSelection: vi.fn((sessionId, model) => {
      const auto = model?.providerID === 'openchamber' && model?.id === 'auto';
      if (auto) autoSessions.add(sessionId);
      else autoSessions.delete(sessionId);
      return auto;
    }),
    isAutoSession: (sessionId) => autoSessions.has(sessionId),
    prepareSend,
    routePreparedSend,
    routeSend: routeSend ?? vi.fn(async ({ body }) => {
      if (typeof body?.command === 'string') body.model = { providerID: 'openai', id: 'gpt-6-astra' };
      return {};
    }),
    describe: async () => ({ available: true, autoReady: true, tokenPresent: true, jevSource: 'typesafe', config: null, builtins: [] }),
    heldPermissions: () => [],
    updateConfig: vi.fn(async () => ({ available: true })),
    setToken: vi.fn(async () => ({ available: true, tokenPresent: true })),
    clearToken: vi.fn(async () => ({ available: true, tokenPresent: false })),
    setClassifierSource: vi.fn(async () => ({ available: true })),
    setCustomEndpoint: vi.fn(async () => ({ available: true })),
    clearCustomEndpoint: vi.fn(async () => ({ available: true })),
  };
  const app = express();
  registerRoutingRoutes(app, runtime);
  registerRoutingPromptRewrite(app, runtime);
  // Stand-in for the OpenCode proxy: a parsed body arrives as `req.body`, an
  // untouched stream arrives as raw bytes.
  app.use('/api', (req, res) => {
    if (req.body !== undefined) {
      forwarded.push({ path: req.path, parsed: true, body: req.body });
      return res.status(204).end();
    }
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      forwarded.push({ path: req.path, parsed: false, raw });
      res.status(204).end();
    });
  });
  return { app, runtime, forwarded };
};

describe('routing send rewrite', () => {
  it('swallows the Auto sentinel on a model switch instead of forwarding it', async () => {
    const { app, runtime, forwarded } = createApp();
    await request(app)
      .post('/api/session/s1/model?directory=%2Frepo')
      .send({ model: { providerID: 'openchamber', id: 'auto' } })
      .expect(204);
    expect(forwarded).toEqual([]);
    expect(runtime.noteModelSelection).toHaveBeenCalledWith('s1', { providerID: 'openchamber', id: 'auto' }, '/repo');
    expect(runtime.isAutoSession('s1')).toBe(true);
  });

  it('drops the Auto sentinel from a session create so OpenCode never stores it', async () => {
    const { app, forwarded, runtime } = createApp();
    await request(app)
      .post('/api/session?directory=%2Frepo')
      .send({ title: 'btw', model: { providerID: 'openchamber', id: 'auto' }, agent: 'build' })
      .expect(204);
    expect(forwarded).toEqual([{ path: '/session', parsed: true, body: { title: 'btw', agent: 'build' } }]);
    expect(runtime.noteModelSelection).not.toHaveBeenCalled();

    await request(app).post('/api/session').send({ model: { providerID: 'anthropic', id: 'claude-opus-5' } }).expect(204);
    expect(forwarded[1]).toEqual({ path: '/session', parsed: true, body: { model: { providerID: 'anthropic', id: 'claude-opus-5' } } });
  });

  it('forwards a real model switch untouched and takes the session off Auto', async () => {
    const { app, forwarded, runtime } = createApp();
    await request(app).post('/api/session/s1/model').send({ model: { providerID: 'openchamber', id: 'auto' } }).expect(204);
    await request(app).post('/api/session/s1/model').send({ model: { providerID: 'anthropic', id: 'claude-opus-5' } }).expect(204);
    expect(forwarded).toEqual([{ path: '/session/s1/model', parsed: true, body: { model: { providerID: 'anthropic', id: 'claude-opus-5' } } }]);
    expect(runtime.isAutoSession('s1')).toBe(false);
  });

  it('routes a prompt in an Auto session and passes the directory along', async () => {
    const autoSessions = new Set(['s1']);
    const { app, runtime, forwarded } = createApp({ autoSessions });
    await request(app)
      .post('/api/session/s1/prompt?directory=%2Frepo')
      .send({ text: 'hi' })
      .expect(204);
    expect(forwarded).toEqual([{ path: '/session/s1/prompt', parsed: true, body: { text: 'hi' } }]);
    expect(runtime.routeSend).toHaveBeenCalledWith({ sessionId: 's1', directory: '/repo', body: { text: 'hi' } });
  });

  it('decodes a URI-encoded directory header the way OpenCode reads it', async () => {
    const { app, runtime } = createApp({ autoSessions: new Set(['s1']) });
    await request(app)
      .post('/api/session/s1/prompt')
      .set('x-opencode-directory', '%2Frepo')
      .send({ text: 'hi' })
      .expect(204);
    expect(runtime.routeSend).toHaveBeenCalledWith({ sessionId: 's1', directory: '/repo', body: { text: 'hi' } });
  });

  it('decodes a directory header marked as URI-encoded', async () => {
    const { app, runtime } = createApp();
    await request(app)
      .post('/api/session/s1/model')
      .set('x-opencode-directory', '%2Frepo')
      .set('x-opencode-directory-encoding', 'uri')
      .send({ model: { providerID: 'openchamber', id: 'auto' } })
      .expect(204);
    expect(runtime.noteModelSelection).toHaveBeenCalledWith('s1', { providerID: 'openchamber', id: 'auto' }, '/repo');
  });

  it('forwards a directory header without percent-escapes untouched', async () => {
    const { app, runtime } = createApp({ autoSessions: new Set(['s1']) });
    await request(app)
      .post('/api/session/s1/prompt')
      .set('x-opencode-directory', '/repo')
      .send({ text: 'hi' })
      .expect(204);
    expect(runtime.routeSend).toHaveBeenCalledWith({ sessionId: 's1', directory: '/repo', body: { text: 'hi' } });
  });

  it('keeps a directory header with malformed escapes as it arrived', async () => {
    const { app, runtime } = createApp({ autoSessions: new Set(['s1']) });
    await request(app)
      .post('/api/session/s1/prompt')
      .set('x-opencode-directory', '%2Frepo%ZZ')
      .send({ text: 'hi' })
      .expect(204);
    expect(runtime.routeSend).toHaveBeenCalledWith({ sessionId: 's1', directory: '%2Frepo%ZZ', body: { text: 'hi' } });
  });

  it('leaves a send in a session that is not on Auto unread', async () => {
    const { app, runtime, forwarded } = createApp();
    await request(app).post('/api/session/s1/prompt').send({ text: 'hi' }).expect(204);
    expect(runtime.routeSend).not.toHaveBeenCalled();
    expect(forwarded[0].parsed).toBe(false);
  });

  it('leaves the stream untouched when the body is not JSON', async () => {
    const text = createApp({ autoSessions: new Set(['s1']) });
    await request(text.app).post('/api/session/s1/command').set('content-type', 'text/plain').send('raw').expect(204);
    expect(text.forwarded[0]).toEqual({ path: '/session/s1/command', parsed: false, raw: 'raw' });
  });


  it('answers with the runtime error instead of forwarding an unroutable send', async () => {
    const { app, forwarded } = createApp({
      autoSessions: new Set(['s1']),
      routeSend: vi.fn(async () => { throw Object.assign(new Error('no fallback'), { status: 400 }); }),
    });
    const response = await request(app).post('/api/session/s1/prompt').send({ text: 'hi' });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'no fallback' });
    expect(forwarded).toEqual([]);
  });

  it('uses Auto’s selected model and scoped kernel for attachment delivery before admitting context or forwarding', async () => {
    const config = resolveEffectiveConfig(null);
    config.enabled = true;
    config.fallback = { model: { providerID: 'custom', modelID: 'text' }, variant: null };
    const operations = [];
    let failWrite = false;
    const listCatalogModels = vi.fn(async () => [
      { providerID: 'custom', modelID: 'text', variants: [], capabilities: { input: ['text'] } },
    ]);
    const runtime = createRoutingRuntime({
      dataDir: '/unused', buildOpenCodeUrl: (route) => `http://opencode.test${route}`, getOpenCodeAuthHeaders: () => ({}),
      store: { readConfig: async () => config, readToken: async () => null, readClassifierSource: async () => 'off', readCustomEndpoint: async () => null },
      readProviderKeys: async () => ({}), enterpriseMode: () => false, readPinnedEndpoint: () => null,
      listCatalogModels,
      fetchImpl: async (input, init) => {
        const req = new Request(input, init);
        const url = new URL(req.url);
        if (url.pathname === '/api/info') return Response.json({ paths: { tmp: '/kernel/tmp' } });
        if (url.pathname === '/api/experimental/fs/write') {
          const target = url.searchParams.get('path');
          operations.push({ target, directory: req.headers.get('x-opencode-directory'), bytes: [...new Uint8Array(await req.arrayBuffer())] });
          if (failWrite) return new Response(null, { status: 500 });
          return Response.json({ location: { directory: '/repo' }, data: { path: target } });
        }
        if (url.pathname.endsWith('/model')) {
          operations.push(await req.json());
          return new Response(null, { status: 204 });
        }
        return new Response(null, { status: 404 });
      },
    });
    runtime.noteModelSelection('s1', { providerID: 'openchamber', id: 'auto' }, '/repo');
    const { app, forwarded } = createApp({
      autoSessions: new Set(['s1']), routeSend: runtime.routeSend,
      prepareSend: runtime.prepareSend, routePreparedSend: runtime.routePreparedSend,
    });
    const scope = '?directory=%2Frepo';
    const preflight = '/api/routing/sessions/s1/prepare-send' + scope;
    const prompt = '/api/session/s1/prompt' + scope;
    const body = { id: 'msg_prompt', text: 'Read this', files: [
      { name: 'scan.pdf', uri: 'data:application/pdf;base64,AQID' },
      { name: 'notes.docx', uri: 'data:text/plain;base64,dGV4dA==' },
    ] };

    failWrite = true;
    const failure = await request(app).post(preflight).send(body).expect(400);
    expect(failure.body).toMatchObject({ _tag: 'InvalidRequestError', message: 'Could not prepare attachment paths.' });
    expect(forwarded).toEqual([]);
    expect(operations).toHaveLength(1);

    failWrite = false;
    operations.length = 0;
    const { body: prepared } = await request(app).post(preflight).send(body).expect(200);
    const [{ target }] = operations;
    expect(operations).toEqual([
      { target: expect.stringMatching(/^\/kernel\/tmp\/openchamber\/[a-f0-9]+\/1-scan\.pdf$/), directory: '%2Frepo', bytes: [1, 2, 3] },
    ]);
    expect(prepared).toMatchObject({
      ticket: expect.stringMatching(/^oc-auto-/), text: `Read this\n\n[scan.pdf](<${target}>)`, files: [body.files[1]],
    });
    const dispatch = { id: body.id, text: prepared.text, files: prepared.files };
    // A stale or modified dispatch may not fall through to legacy routing.
    await request(app).post(prompt).set('Idempotency-Key', prepared.ticket).send({ ...dispatch, text: 'other text' }).expect(409);
    await request(app).post('/api/session/s1/prompt?directory=%2Fother')
      .set('Idempotency-Key', prepared.ticket).send(dispatch).expect(409);
    expect(forwarded).toEqual([]);
    expect(operations).toHaveLength(1);

    const context = { id: 'msg_memory', text: 'remembered context', resume: false };
    await request(app).post('/api/session/s1/synthetic' + scope).send(context).expect(204);
    // Skill fallback can reuse this same preparation even when a new write
    // would fail. Nothing in either dispatch reclassifies or writes files.
    failWrite = true;
    await request(app).post(prompt).set('Idempotency-Key', prepared.ticket).send({ ...dispatch, skills: [{ id: 'deploy' }] }).expect(204);
    await request(app).post(prompt).set('Idempotency-Key', prepared.ticket).send(dispatch).expect(204);
    expect(operations).toEqual([
      expect.objectContaining({ target }),
      { model: { providerID: 'custom', id: 'text' } },
      { model: { providerID: 'custom', id: 'text' } },
    ]);
    expect(forwarded.map((entry) => entry.parsed ? entry.body : JSON.parse(entry.raw))).toEqual([
      context, { ...dispatch, skills: [{ id: 'deploy' }] }, dispatch,
    ]);
    expect(listCatalogModels.mock.calls).toEqual([['/repo'], ['/repo']]);

    failWrite = false;
    const { body: command } = await request(app).post(preflight)
      .send({ name: 'review', text: body.text, files: body.files }).expect(200);
    const commandBody = { name: 'review', text: command.text, files: command.files };
    await request(app).post(prompt).set('Idempotency-Key', command.ticket).send(commandBody).expect(409);
    const commandRoute = '/api/session/s1/command' + scope;
    await request(app).post(commandRoute).set('Idempotency-Key', command.ticket).send(commandBody).expect(204);
    await request(app).post(commandRoute).set('Idempotency-Key', command.ticket).send(commandBody).expect(409);
  });

  it('refuses a stale Auto fallback before switching the kernel or forwarding the prompt', async () => {
    const config = resolveEffectiveConfig(null);
    config.enabled = true;
    config.fallback = { model: { providerID: 'deepseek', modelID: 'deepseek-flash' }, variant: null };
    const buildOpenCodeUrl = vi.fn(() => { throw new Error('unexpected kernel request'); });
    const runtime = createRoutingRuntime({
      dataDir: '/unused', buildOpenCodeUrl, getOpenCodeAuthHeaders: () => ({}),
      store: { readConfig: async () => config, readToken: async () => null, readClassifierSource: async () => 'off', readCustomEndpoint: async () => null },
      readProviderKeys: async () => ({}), enterpriseMode: () => false, readPinnedEndpoint: () => null,
      listCatalogModels: async () => [{ providerID: 'superwagie-account-test', modelID: 'deepseek-flash', variants: [] }],
    });
    const { app, forwarded } = createApp({ autoSessions: new Set(['s1']), routeSend: runtime.routeSend });
    const response = await request(app).post('/api/session/s1/prompt?directory=%2Frepo').send({ text: 'hello' });
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'Auto routing fallback model is unavailable. Choose an available fallback model in Settings > Routing.' });
    expect(buildOpenCodeUrl).not.toHaveBeenCalled();
    expect(forwarded).toEqual([]);
  });
});

describe('routing routes', () => {
  it('serves state, saves config and manages the token', async () => {
    const { app, runtime } = createApp();
    const state = await request(app).get('/api/routing').expect(200);
    expect(state.body).toMatchObject({ available: true, autoReady: true, heldPermissions: [] });
    await request(app).put('/api/routing').send({ config: { enabled: true } }).expect(200);
    expect(runtime.updateConfig).toHaveBeenCalledWith({ enabled: true });
    await request(app).put('/api/routing/token').send({ token: 'ts-key' }).expect(200);
    expect(runtime.setToken).toHaveBeenCalledWith('ts-key');
    await request(app).delete('/api/routing/token').expect(200);
    expect(runtime.clearToken).toHaveBeenCalled();
    await request(app).put('/api/routing/classifier').send({ source: 'zen-key' }).expect(200);
    expect(runtime.setClassifierSource).toHaveBeenCalledWith('zen-key');
    await request(app).put('/api/routing/classifier/custom').send({ url: 'https://jev.example.com/v1', model: 'jev-latest', key: 'k', extra: true }).expect(200);
    expect(runtime.setCustomEndpoint).toHaveBeenCalledWith({ url: 'https://jev.example.com/v1', model: 'jev-latest', key: 'k' });
    await request(app).delete('/api/routing/classifier/custom').expect(200);
    expect(runtime.clearCustomEndpoint).toHaveBeenCalled();
  });

});
