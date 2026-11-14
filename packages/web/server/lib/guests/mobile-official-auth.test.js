import { afterEach, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { createTunnelAuth } from '../opencode/tunnel-auth.js';
const { captureMobileOfficialTransport } = await import(process.env.OC_PILOT_TRANSPORT_MODULE || './mobile-official-transport.js');
import { createUiAuth } from '../ui-auth/ui-auth.js';
import { createRemoteClientAuthRuntime } from '../client-auth/remote-clients.js';
import { createPlatformAccessGate } from '../platform-account/access-gate.js';
import { PlatformAccountError } from '../platform-account/runtime.js';
const { createMobileOfficialAccess } = await import(process.env.OC_PILOT_AUTH_MODULE || './mobile-official-auth.js');
import { registerMobileOfficialRoutes } from './mobile-official.js';

const temporary = [];
const disposals = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) dispose();
  for (const root of temporary.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const HOST = '127.0.0.1:57123';
const ORIGIN = `http://${HOST}`;
const TUNNEL_HOST = 'selected-material.example.test';
const TUNNEL_ORIGIN = `http://${TUNNEL_HOST}`;
const cookieHeader = (response) => (response.headers['set-cookie'] ?? []).map((value) => value.split(';')[0]).join('; ');
const fixture = async (options = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'official-pilot-auth-')); temporary.push(root);
  const sessions = new Map();
  const accountState = (identity) => {
    const value = identity && sessions.get(identity.token);
    if (!value) throw new PlatformAccountError('platform_session_expired', 401);
    return value;
  };
  const runtime = {
    authMethods: () => ({ passwordLogin: true }),
    passwordLogin: async (identity, input) => {
      const userId = input.username === 'outsider' ? 'other-user' : 'owner';
      sessions.set(identity.token, { userId, accountId: null, authSession: crypto.randomUUID() });
      return runtime.identitySession(identity);
    },
    identitySession: async (identity) => sessions.has(identity.token)
      ? { status: 'signed-in', user: { id: accountState(identity).userId, name: 'Synthetic owner', email: 'owner@example.test' }, expiresAt: new Date(Date.now() + 3600_000).toISOString() }
      : { status: 'signed-out' },
    identityAccounts: async (identity, requested) => {
      const state = accountState(identity);
      if (requested !== undefined && !['personal', 'team'].includes(requested)) throw new PlatformAccountError('platform_account_forbidden', 403);
      state.accountId = requested ?? state.accountId ?? 'personal';
      return { accountId: state.accountId, accounts: [{ id: 'personal', name: 'Personal' }, { id: 'team', name: 'Team' }] };
    },
    actor: (identity) => {
      const value = accountState(identity);
      return { actingUserId: value.userId, billingAccountId: value.accountId, authSession: value.authSession, expiresAt: Date.now() + 3600_000 };
    },
    instancePrincipal: (identity) => ({ issuer: 'https://identity.example.test', userId: accountState(identity).userId }),
    logout: (identity) => { sessions.delete(identity.token); return { status: 'signed-out' }; },
  };
  runtime.refreshSession = async (identity) => runtime.actor(identity);
  const clients = createRemoteClientAuthRuntime({ fsPromises: fs, path, crypto, storePath: path.join(root, 'clients.json') });
  const uiAuth = createUiAuth({ password: options.password ?? 'runtime-password', sessionTtlMs: options.sessionTtlMs ?? 3_600_000, clientAuthController: clients, readSettingsFromDiskMigrated: async () => ({}) });
  const tunnel = createTunnelAuth();
  const access = createMobileOfficialAccess({ getAccountRuntime: () => runtime, resolveFullIdentity: (req, res, options) => uiAuth.resolvePlatformAccessContext(req, res, options),
    captureTransport: (req) => captureMobileOfficialTransport(req, { tunnelAuthController: tunnel, getUiAuthController: () => uiAuth }),
    isRequestOriginAllowed: (req) => [ORIGIN, TUNNEL_ORIGIN].includes(req.headers.origin) });
  const gate = createPlatformAccessGate({ getAccountRuntime: () => runtime, resolveIdentity: access.resolveIdentity, env: {} }); disposals.push(gate.dispose);
  const app = express();
  app.post('/auth/session', express.json(), uiAuth.handleSessionCreate);
  // The actual product gate precedes the unchanged actual runtime UI auth gate.
  app.use(gate.middleware); app.use('/api', (req, res, next) => {
    const scope = tunnel.classifyRequestScope(req);
    return scope === 'tunnel' || scope === 'unknown-public' ? tunnel.requireTunnelSession(req, res, next) : uiAuth.requireAuth(req, res, next);
  });
  app.post('/api/platform-account/password-login', express.json(), async (req, res) => {
    const identity = await uiAuth.resolvePlatformAuthContext(req, res);
    await runtime.passwordLogin(identity, req.body); await runtime.identityAccounts(identity);
    res.json(await runtime.identitySession(identity));
  });
  access.register(app);
  const settings = { projects: [] };
  for (const id of ['a', 'b']) {
    const directory = path.join(root, id); await fs.mkdir(directory); await fs.writeFile(path.join(directory, 'sample.md'), `${id} selected bytes`);
    settings.projects.push({ id, path: directory, label: `Project ${id}` });
  }
  let readSettingsCurrent = async () => settings;
  const native = registerMobileOfficialRoutes(app, { dataDir: root, getAccountRuntime: () => runtime,
    resolveIdentity: (req, res) => req.method ? access.resolveIdentity(req, res, { allowUrlToken: false }) : uiAuth.resolvePlatformAuthContext(req, res),
    readSettings: () => readSettingsCurrent(), readSession: async (id, directory) => ({ id, directory }),
    findGuest: async () => ({ source: 'bundled', enabled: true, capabilityGrants: ['files'] }),
  });
  let businessEffects = 0;
  for (const [method, target] of [['post', '/api/todo'], ['post', '/api/session/s/message'], ['post', '/api/guests/guest/service/request'], ['post', '/api/guests/openchamber-builtin-workbench/files'], ['put', '/api/config/settings'], ['put', '/api/projects/a/scheduled-tasks'], ['post', '/api/unknown-future-write']]) {
    app[method](target, (_req, res) => { businessEffects++; res.json({ changed: true }); });
  }
  app.get('/api/fs/raw', (_req, res) => res.send('host file'));
  const loginRuntime = async (kind) => options.password === ''
    ? (await clients.createClient({ label: kind, clientKind: kind })).token
    : (await request(app).post('/auth/session').set('Host', HOST).send({ password: 'runtime-password', issueClientToken: true, clientKind: kind }).expect(200)).body.clientToken;
  const desktop = await loginRuntime('desktop-local'); const phone = await loginRuntime('mobile');
  await request(app).post('/api/platform-account/password-login').set('Host', HOST).auth(desktop, { type: 'bearer' }).send({ username: 'owner', password: 'synthetic-password' }).expect(200);
  const selected = [];
  for (const projectId of ['a', 'b']) selected.push(await native.select({ authentication: { kind: 'bearer', token: desktop }, isCurrent: () => true,
    input: { extensionId: 'openchamber-builtin-creation', projectId, sessionId: null, title: `Selected ${projectId}`, source: { kind: 'artifact', path: 'sample.md' } } }));
  const call = (method, target, token = phone, cookie = '', host = HOST) => {
    const value = request(app)[method](target).set('Host', host).set('Origin', `http://${host}`);
    if (token) value.auth(token, { type: 'bearer' });
    if (cookie) value.set('Cookie', cookie);
    return value;
  };
  const loginCookie = async (host = HOST) => cookieHeader(await request(app).post('/auth/session').set('Host', host).send({ password: 'runtime-password' }).expect(200));
  const pauseSettings = () => {
    let enter; let release;
    const entered = new Promise((resolve) => { enter = resolve; });
    const held = new Promise((resolve) => { release = resolve; });
    readSettingsCurrent = async () => { enter(); await held; return settings; };
    return { entered, release: () => { readSettingsCurrent = async () => settings; release(); } };
  };
  return { app, call, phone, desktop, selected, native, runtime, clients, uiAuth, tunnel, loginCookie, pauseSettings, businessEffects: () => businessEffects, root };
};

test('issued pilot credential reads selected projects but cannot authorize ordinary API reads or writes', async () => {
  const f = await fixture();
  const session = await f.call('get', '/api/mobile-official/auth/session').expect(200);
  const cookie = cookieHeader(session);
  expect(cookie).toContain('oc_mobile_official_57123=');
  expect(session.headers['set-cookie'][0]).toContain('HttpOnly');
  const login = await f.call('post', '/api/mobile-official/auth/password-login', f.phone, cookie).send({ username: 'owner', password: 'synthetic-password' }).expect(200);
  expect(login.body.accountId).toBe('personal');
  expect(login.body).not.toHaveProperty('credits');
  const projects = await f.call('get', '/api/mobile-official/reader/projects', f.phone, cookie).expect(200);
  expect(projects.body.projects.map((entry) => entry.id).sort()).toEqual(['a', 'b']);
  expect(JSON.stringify(projects.body)).not.toContain(f.root);
  await f.call('get', `/api/mobile-official/reader/${f.selected[0].id}/content`, f.phone, cookie).expect(200, 'a selected bytes');
  for (const [method, target] of [['post', '/api/todo'], ['post', '/api/session/s/message'], ['post', '/api/guests/guest/service/request'], ['post', '/api/guests/openchamber-builtin-workbench/files'], ['put', '/api/config/settings'], ['put', '/api/projects/a/scheduled-tasks'], ['post', '/api/unknown-future-write'], ['post', '/api/mobile-official/auth/arbitrary']]) {
    await f.call(method, target, f.phone, cookie).send({ clientKind: 'desktop-local', approved: true, op: 'write', path: '任务.md', content: 'Unauthorized replacement' }).expect(401);
  }
  await f.call('get', '/api/fs/raw', f.phone, cookie).expect(401);
  await f.call('get', '/api/mobile-official/reader/projects', 'invalid-bearer', cookie).expect(401);
  await f.call('post', '/api/mobile-official/auth/password-login?directory=/spaces/a1b2c3d4e5f6/project', f.phone, cookie).send({ username: 'outsider', password: 'synthetic-password' }).expect(403);
  await f.call('get', '/api/mobile-official/reader/projects', '', cookie).expect(401);
  const pilotToken = cookie.split('=')[1];
  await f.call('post', '/api/todo', pilotToken).send({}).expect(401);
  expect(f.businessEffects()).toBe(0);
  // Independently full-authorized desktop authority remains valid with both credentials.
  await f.call('post', '/api/todo', f.desktop, cookie).send({}).expect(200);
  expect(f.businessEffects()).toBe(1);
});

test('pilot account, actor and logout changes revoke the previous material without granting full account access', async () => {
  const f = await fixture();
  const cookie = cookieHeader(await f.call('get', '/api/mobile-official/auth/session').expect(200));
  await f.call('post', '/api/mobile-official/auth/password-login', f.phone, cookie).send({ username: 'owner', password: 'synthetic-password' }).expect(200);
  await f.call('post', '/api/mobile-official/auth/account', f.phone, cookie).send({ accountId: 'team' }).expect(200);
  expect((await f.call('get', '/api/mobile-official/reader/projects', f.phone, cookie).expect(200)).body.projects).toEqual([]);
  await f.call('get', `/api/mobile-official/reader/${f.selected[0].id}/content`, f.phone, cookie).expect(404);
  await f.call('post', '/api/mobile-official/auth/account', f.phone, cookie).send({ accountId: 'personal' }).expect(200);
  expect((await f.call('get', '/api/mobile-official/reader/projects', f.phone, cookie).expect(200)).body.projects).toHaveLength(2);
  await f.call('post', '/api/mobile-official/auth/password-login', f.phone, cookie).send({ username: 'outsider', password: 'synthetic-password' }).expect(200);
  expect((await f.call('get', '/api/mobile-official/reader/projects', f.phone, cookie).expect(200)).body.projects).toEqual([]);
  await f.call('post', '/api/mobile-official/auth/logout', f.phone, cookie).send({}).expect(200);
  await f.call('get', '/api/mobile-official/reader/projects', f.phone, cookie).expect(401);
  await f.call('get', '/api/mobile-official/projects?directory=/spaces/a1b2c3d4e5f6/project', f.desktop).expect(403);
});

test('pilot cookie state never shadows full readers and pilot B never falls back to full A', async () => {
  const f = await fixture();
  const fullRead = async (cookie) => {
    expect((await f.call('get', '/api/mobile-official/projects', f.desktop, cookie).expect(200)).body.projects).toHaveLength(2);
    expect((await f.call('get', '/api/mobile-official?projectId=a', f.desktop, cookie).expect(200)).body.selections).toHaveLength(1);
    await f.call('get', `/api/mobile-official/${f.selected[0].id}/content`, f.desktop, cookie).expect(200, 'a selected bytes');
  };
  await fullRead('');
  const cookie = cookieHeader(await f.call('get', '/api/mobile-official/auth/session').expect(200));
  await fullRead(cookie);
  await f.call('get', '/api/mobile-official/reader/projects', f.desktop, cookie).expect(401);
  const validUiCookie = await f.loginCookie();
  await f.call('get', '/api/mobile-official/reader/projects', 'invalid-bearer', `${validUiCookie}; ${cookie}`).expect(401);
  await f.call('post', '/api/mobile-official/auth/password-login', f.desktop, cookie).send({ username: 'owner', password: 'synthetic-password' }).expect(200);
  await f.call('post', '/api/mobile-official/auth/account', f.desktop, cookie).send({ accountId: 'team' }).expect(200);
  expect((await f.call('get', '/api/mobile-official/reader/projects', f.desktop, cookie).expect(200)).body.projects).toEqual([]);
  await fullRead(cookie);
  await f.call('post', '/api/mobile-official/auth/password-login', f.desktop, cookie).send({ username: 'outsider', password: 'synthetic-password' }).expect(200);
  expect((await f.call('get', '/api/mobile-official/reader/projects', f.desktop, cookie).expect(200)).body.projects).toEqual([]);
  await f.call('get', `/api/mobile-official/reader/${f.selected[0].id}/content`, f.desktop, cookie).expect(404);
  await fullRead(cookie);
  await f.call('post', '/api/mobile-official/auth/logout', f.desktop, cookie).send({}).expect(200);
  await fullRead(cookie);
  await f.call('get', '/api/mobile-official/reader/projects', f.desktop, cookie).expect(401);
});

test('cookie-based host authority expires during held source IO before any selected bytes are sent', async () => {
  const f = await fixture({ sessionTtlMs: 1000 });
  const hostCookie = await f.loginCookie();
  const pilotCookie = cookieHeader(await f.call('get', '/api/mobile-official/auth/session', '', hostCookie).expect(200));
  const cookie = `${hostCookie}; ${pilotCookie}`;
  await f.call('post', '/api/mobile-official/auth/password-login', '', cookie).send({ username: 'owner', password: 'synthetic-password' }).expect(200);
  await f.call('get', `/api/mobile-official/reader/${f.selected[0].id}/content`, '', cookie).expect(200, 'a selected bytes');
  const pause = f.pauseSettings();
  const response = f.call('get', `/api/mobile-official/reader/${f.selected[0].id}/content`, '', cookie).then((result) => result);
  await pause.entered;
  await new Promise((resolve) => setTimeout(resolve, 1500));
  pause.release();
  const denied = await response;
  expect(denied.status).toBe(401);
  expect(denied.text).not.toContain('a selected bytes');
  await f.call('get', '/api/mobile-official/reader/projects', '', cookie).expect(401);
});

test('bearer revocation during held source IO ends the pilot transport authority', async () => {
  const f = await fixture();
  const cookie = cookieHeader(await f.call('get', '/api/mobile-official/auth/session').expect(200));
  await f.call('post', '/api/mobile-official/auth/password-login', f.phone, cookie).send({ username: 'owner', password: 'synthetic-password' }).expect(200);
  await f.call('get', `/api/mobile-official/reader/${f.selected[0].id}/content`, f.phone, cookie).expect(200, 'a selected bytes');
  const pause = f.pauseSettings();
  const response = f.call('get', `/api/mobile-official/reader/${f.selected[0].id}/content`, f.phone, cookie).then((result) => result);
  await pause.entered;
  const identity = await f.clients.authenticateBearerToken(f.phone);
  await f.clients.revokeClient(identity.clientId);
  pause.release();
  const denied = await response;
  expect(denied.status).toBe(401);
  expect(denied.text).not.toContain('a selected bytes');
});

test('tunnel revocation or stop during source IO cannot fall back to a still-valid local UI cookie', async () => {
  for (const reason of ['revoke', 'stop']) {
    const f = await fixture();
    const hostCookie = await f.loginCookie(TUNNEL_HOST);
    f.tunnel.setActiveTunnel({ tunnelId: 'controlled-tunnel', publicUrl: TUNNEL_ORIGIN });
    const bootstrap = f.tunnel.issueBootstrapToken({ ttlMs: 60_000 });
    let tunnelCookie = '';
    const exchange = f.tunnel.exchangeBootstrapToken({ req: { headers: { host: TUNNEL_HOST }, socket: { remoteAddress: '127.0.0.1' } },
      res: { setHeader: (_name, value) => { tunnelCookie = value.split(';')[0]; } }, token: bootstrap.token, sessionTtlMs: 3_600_000 });
    expect(exchange.ok).toBe(true);
    const context = `${hostCookie}; ${tunnelCookie}`;
    const pilotCookie = cookieHeader(await f.call('get', '/api/mobile-official/auth/session', '', context, TUNNEL_HOST).expect(200));
    const cookie = `${context}; ${pilotCookie}`;
    await f.call('post', '/api/mobile-official/auth/password-login', '', cookie, TUNNEL_HOST).send({ username: 'owner', password: 'synthetic-password' }).expect(200);
    await f.call('get', `/api/mobile-official/reader/${f.selected[0].id}/content`, '', cookie, TUNNEL_HOST).expect(200, 'a selected bytes');
    const pause = f.pauseSettings();
    const response = f.call('get', `/api/mobile-official/reader/${f.selected[0].id}/content`, '', cookie, TUNNEL_HOST).then((result) => result);
    await pause.entered;
    if (reason === 'revoke') f.tunnel.revokeTunnelArtifacts('controlled-tunnel'); else f.tunnel.clearActiveTunnel();
    expect(await f.uiAuth.hasRuntimeAccess({ headers: { host: TUNNEL_HOST, cookie: hostCookie } })).toBe(true);
    pause.release();
    const denied = await response;
    expect(denied.status).toBe(401);
    expect(denied.text).not.toContain('a selected bytes');
  }
});

test('passwordless open hosts keep pilot issuance separate from synthetic UI cookie issuance', async () => {
  const f = await fixture({ password: '' });
  const start = await f.call('get', '/api/mobile-official/auth/session', '').expect(200);
  const cookie = cookieHeader(start);
  expect(start.headers['set-cookie']).toHaveLength(1);
  expect(cookie).toContain('oc_mobile_official_57123=');
  await f.call('post', '/api/mobile-official/auth/password-login', '', cookie).send({ username: 'owner', password: 'synthetic-password' }).expect(200);
  await f.call('get', `/api/mobile-official/reader/${f.selected[0].id}/content`, '', cookie).expect(200, 'a selected bytes');
});
