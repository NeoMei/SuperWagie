import crypto from 'node:crypto';
import nativeRequestSummary from './fixtures/native-request-summary.json' with { type: 'json' };
import http from 'node:http';
import express from 'express';
import request from 'supertest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { createPlatformAccountRuntime } from './runtime.js';
import { registerPlatformAccountRoutes } from './routes.js';
import { createPlatformProfileRuntime } from './profile.js';
import { registerPlatformProfileRoutes } from './profile-routes.js';
import { createPlatformAccessGate } from './access-gate.js';
import { createUiAuth } from '../ui-auth/ui-auth.js';
import { createRequestSecurityRuntime } from '../security/request-security.js';

const servers = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => {
    server.closeAllConnections(); server.close(resolve);
  })));
});
const identity = { type: 'client', token: 'headless-device' };
const password = 'SyntheticPassword9!';
const fixture = async ({ refreshTokens = false } = {}) => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'headless', alg: 'RS256' };
  const app = express(); app.use(express.json());
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); servers.push(server);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const requests = [];
  let authorization; let nonceOverride; let audienceOverride; let stateOverride; let authError; let profileName='Alice';
  let tokenError; let registrationState = 'CREATED'; let registrationError; let accessToken; let refreshCounter = 0;
  app.get('/.well-known/openid-configuration', (_req, res) => res.json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, jwks_uri: `${origin}/keys` }));
  app.get('/keys', (_req, res) => res.json({ keys: [jwk] }));
  app.use('/v1', (req, _res, next) => { requests.push({ method: req.method, path: req.path, body: req.body, key: req.get('Idempotency-Key') }); next(); });
  app.post('/v1/identity/registrations', (req, res) => {
    expect(req.body.client_id).toBe('superwagie-headless-fixture');
    if (registrationError) return res.status(503).json({ error: registrationError });
    res.status(registrationState === 'UNKNOWN' ? 202 : 201).json({ registration_id: 'registration-a', status: registrationState, login_required: registrationState === 'CREATED', retry_after: registrationState === 'UNKNOWN' ? 2 : undefined });
  });
  app.post('/v1/identity/authorize/password', (req, res) => {
    if (authError) return res.status(authError.status).json(authError.body);
    authorization = req.body;
    expect(authorization).toMatchObject({ client_id: 'superwagie-headless-fixture', redirect_uri: `${origin}/api/platform-account/callback`, scope: 'openid profile email', code_challenge_method: 'S256' });
    res.json({ authorization_id: 'A'.repeat(43), code: 'a'.repeat(64), state: stateOverride ?? authorization.state });
  });
  app.post('/v1/identity/token', async (req, res) => {
    if (tokenError) return res.status(503).json({ error: 'authorization_result_unknown', debug: password });
    expect(req.body.client_id).toBe('superwagie-headless-fixture');
    expect(req.body.redirect_uri).toBe(`${origin}/api/platform-account/callback`);
    expect(req.body.authorization_id).toBe('A'.repeat(43));
    expect(req.body.code).toBe('a'.repeat(64));
    expect(crypto.createHash('sha256').update(req.body.code_verifier).digest('base64url')).toBe(authorization.code_challenge);
    expect(req.body.password).toBeUndefined(); expect(req.body.client_secret).toBeUndefined();
    const audience = audienceOverride ?? 'superwagie-headless-fixture';
    accessToken = await new SignJWT({ tokenType: 'access-token', scope: 'openid profile email' }).setProtectedHeader({ alg: 'RS256', kid: 'headless' }).setIssuer(origin).setSubject('subject-a').setAudience(audience).setIssuedAt().setExpirationTime('2h').sign(privateKey);
    const idToken = await new SignJWT({ tokenType: 'id-token', nonce: nonceOverride ?? authorization.nonce }).setProtectedHeader({ alg: 'RS256', kid: 'headless' }).setIssuer(origin).setSubject('subject-a').setAudience(audience).setIssuedAt().setExpirationTime('2h').sign(privateKey);
    const token = { access_token: accessToken, id_token: idToken, token_type: 'Bearer', scope: 'openid profile email', expires_in: 7200 };
    if (refreshTokens) token.refresh_token = 'headless-refresh-0';
    res.json(token);
  });
  app.post('/v1/identity/token', async (req, res) => {
    if (!refreshTokens || req.body.grant_type !== 'refresh_token') return res.status(400).json({ error: 'invalid_grant' });
    expect(req.body.client_id).toBe('superwagie-headless-fixture');
    expect(req.body.refresh_token).toMatch(/^headless-refresh-/);
    accessToken = await new SignJWT({ tokenType: 'access-token', scope: 'openid profile email' }).setProtectedHeader({ alg: 'RS256', kid: 'headless' }).setIssuer(origin).setSubject('subject-a').setAudience('superwagie-headless-fixture').setIssuedAt().setExpirationTime('2h').sign(privateKey);
    const idToken = await new SignJWT({ tokenType: 'id-token' }).setProtectedHeader({ alg: 'RS256', kid: 'headless' }).setIssuer(origin).setSubject('subject-a').setAudience('superwagie-headless-fixture').setIssuedAt().setExpirationTime('2h').sign(privateKey);
    res.json({ access_token: accessToken, id_token: idToken, refresh_token: `headless-refresh-${++refreshCounter}`, token_type: 'Bearer', expires_in: 7200 });
  });
  app.use('/v1', (req, _res, next) => { expect(req.get('Authorization')).toBe(`Bearer ${accessToken}`); next(); });
  app.get('/v1/me', (_req, res) => res.json({ id: 'actor-a', name: profileName, email: '' }));
  app.get('/v1/accounts', (_req, res) => res.json([{ id: 'personal-a', kind: 'personal', name: 'Alice', role: 'owner' }, { id: 'team-a', kind: 'team', name: 'Team A', role: 'owner' }]));
  app.get('/v1/accounts/:id/subscriptions', (_req, res) => res.json([]));
  app.get('/v1/accounts/:id/credits', (_req, res) => res.json([]));
  app.get('/v1/capabilities', (_req, res) => res.json({ sandbox: true }));
  const env = { OPENCHAMBER_UNIHUB_ISSUER: origin, OPENCHAMBER_UNIHUB_API_URL: origin, OPENCHAMBER_UNIHUB_HEADLESS_CLIENT_ID: 'superwagie-headless-fixture', OPENCHAMBER_UNIHUB_REDIRECT_URI: `${origin}/api/platform-account/callback` };
  const runtime = createPlatformAccountRuntime({ env });
  return { runtime, env, origin, requests, app, renameUser: (value) => { profileName=value; }, badNonce: () => { nonceOverride = 'wrong'; }, badAudience: () => { audienceOverride = 'legacy-client'; }, badState: () => { stateOverride = 'wrong'; }, authError: (status, body) => { authError = { status, body }; }, tokenError: () => { tokenError = true; }, unknownRegistration: () => { registrationState = 'UNKNOWN'; }, registrationError: (error) => { registrationError = error; } };
};

const profileBrowserFixture = async () => {
  const f = await fixture();
  f.app.get('/v1/me/profile', (_req, res) => res.json({ id: 'actor-a', username: 'alice', display_name: 'Alice',
    email: '', avatar_url: '/v1/me/avatar', version: '1' }));
  f.app.get('/v1/me/avatar', (_req, res) => res.type('image/png').send(Buffer.from([137, 80, 78, 71])));
  const auth = createUiAuth();
  const gate = createPlatformAccessGate({ getAccountRuntime: () => f.runtime,
    resolveIdentity: (req, res, options) => auth.resolvePlatformAccessContext(req, res, options), env: {} });
  const security = createRequestSecurityRuntime({ readSettingsFromDiskMigrated: async () => ({}) });
  const local = express();
  local.use(auth.requireAuth);
  local.use(gate.middleware);
  const deps = { isRequestOriginAllowed: security.isRequestOriginAllowed,
    resolveIdentity: (req, res) => auth.resolvePlatformAuthContext(req, res) };
  registerPlatformAccountRoutes(local, { ...deps, runtime: f.runtime });
  registerPlatformProfileRoutes(local, { ...deps, runtime: createPlatformProfileRuntime(f.runtime) });
  const server = http.createServer(local);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); servers.push(server);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = request.agent(server);
  try {
    const initial = await browser.get('/api/platform-account/session').expect(200);
    expect(initial.body.status).toBe('signed-out');
    expect(initial.headers['set-cookie'].some((cookie) => cookie.startsWith('oc_platform_runtime_'))).toBe(true);
    const login = await browser.post('/api/platform-account/password-login').set('Origin', origin)
      .send({ username: 'alice', password }).expect(200);
    expect(login.body.status).toBe('signed-in');
    await browser.get('/api/platform-account').expect(200);
  } catch (error) {
    gate.dispose(); auth.dispose(); throw error;
  }
  return { ...f, browser, server, origin, dispose: () => { gate.dispose(); auth.dispose(); } };
};

describe('authenticated profile browser reads', () => {
  it.each(['get', 'head'].flatMap((method) => ['profile', 'avatar'].map((resource) => ({ method, resource }))))
  ('reads $resource with $method and a signed runtime cookie without Origin or Referer', async ({ method, resource }) => {
    const f = await profileBrowserFixture();
    try {
      const result = await f.browser[method](`/api/platform-account/${resource}`).set('Sec-Fetch-Site', 'same-origin').expect(200);
      expect(result.headers['cache-control']).toBe('no-store');
      if (method === 'get' && resource === 'profile') expect(result.body).toMatchObject({ id: 'actor-a', displayName: 'Alice', avatarAvailable: true });
      if (method === 'get' && resource === 'avatar') expect(result.body).toEqual(Buffer.from([137, 80, 78, 71]));
      await request(f.server)[method](`/api/platform-account/${resource}`).set('Sec-Fetch-Site', 'same-origin').expect(401);
    } finally { f.dispose(); }
  });

  it.each(['profile', 'avatar'])('keeps cross-origin %s reads and unproven origins forbidden', async (resource) => {
    const f = await profileBrowserFixture();
    try {
      for (const headers of [
        { Origin: 'https://outside.example', 'Sec-Fetch-Site': 'same-origin' },
        { Origin: 'null', 'Sec-Fetch-Site': 'same-origin' },
        { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }, {},
      ]) {
        const result = await f.browser.get(`/api/platform-account/${resource}`).set(headers).expect(403);
        expect(result.body).toEqual({ error: 'platform_origin_forbidden' });
      }
      expect(f.requests.some(({ path }) => path === `/me/${resource}`)).toBe(false);
      await f.browser.get(`/api/platform-account/${resource}`).set('Origin', f.origin).expect(200);
      await f.browser.get(`/api/platform-account/${resource}`).set('Origin', 'openchamber-ui://app').set('Sec-Fetch-Site', 'cross-site').expect(200);
    } finally { f.dispose(); }
  });

  it.each([{ method: 'patch', resource: 'profile' }, { method: 'put', resource: 'avatar' }, { method: 'post', resource: 'password' }])
  ('still requires an allowed Origin for $method $resource', async ({ method, resource }) => {
    const f = await profileBrowserFixture();
    try {
      const result = await f.browser[method](`/api/platform-account/${resource}`).set('Sec-Fetch-Site', 'same-origin').send({}).expect(403);
      expect(result.body).toEqual({ error: 'platform_origin_forbidden' });
      expect(f.requests.some(({ path }) => path === `/me/${resource}`)).toBe(false);
    } finally { f.dispose(); }
  });
});

describe('headless platform identity', () => {
  it('upgrades the captured account key scope through the exact authenticated POST route', async () => {
    const f = await fixture();
    const route = '/v1/accounts/personal-a/api-keys/key-a/scope';
    const body = { model_scope: 'llmrouter_available', origin_product_id: 'superwagie', instance_id: 'default' };
    f.app.post(route, (req, res) => res.json({ id: 'key-a', ...req.body, credential_version: 2 }));
    await f.runtime.passwordLogin(identity, { username: 'alice', password });
    await f.runtime.selectAccount(identity, 'personal-a');
    const session = f.runtime.captureCommerceSession(identity);
    const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    await expect(session.request(route, init)).resolves.toEqual({ id: 'key-a', ...body, credential_version: 2 });
    await expect(session.request('/v1/accounts/team-a/api-keys/key-a/scope', init)).rejects.toMatchObject({ code: 'platform_account_forbidden', status: 403 });
    for (const target of [route + '/extra', route + '?admin=true', route.replace('/scope', '/revoke')]) {
      await expect(session.request(target, init)).rejects.toMatchObject({ code: 'platform_request_forbidden', status: 403 });
    }
    for (const method of ['GET', 'PATCH', 'DELETE']) {
      await expect(session.request(route, { method })).rejects.toMatchObject({ code: 'platform_request_forbidden', status: 403 });
    }
    await f.runtime.selectAccount(identity, 'team-a');
    await expect(session.request(route, init)).rejects.toMatchObject({ code: 'platform_session_changed', status: 409 });
    expect(f.requests.filter(({ path }) => path.includes('/api-keys/')).map(({ method, path, body }) => ({ method, path, body })))
      .toEqual([{ method: 'POST', path: '/accounts/personal-a/api-keys/key-a/scope', body }]);
  });

  it('allows only the scoped model discovery POST used by quick setup', async () => {
    const f = await fixture();
    f.app.post('/v1/accounts/personal-a/model-discovery', (_req, res) => res.json({ account_id: 'personal-a', models: [{ id: 'fixture-chat' }] }));
    await f.runtime.passwordLogin(identity, { username: 'alice', password });
    await f.runtime.selectAccount(identity, 'personal-a');
    const discovery = '/v1/accounts/personal-a/model-discovery';
    const init = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
    await expect(f.runtime.request(identity, discovery, init)).resolves.toEqual({ account_id: 'personal-a', models: [{ id: 'fixture-chat' }] });
    await expect(f.runtime.request(identity, discovery)).rejects.toMatchObject({ code: 'platform_request_forbidden', status: 403 });
    await expect(f.runtime.request(identity, discovery + '/extra', init)).rejects.toMatchObject({ code: 'platform_request_forbidden', status: 403 });
    expect(f.requests.filter(({ path }) => path.includes('model-discovery')).map(({ method }) => method)).toEqual(['POST']);
  });

  it('reads only the selected SuperWagie usage and recent calls and keeps errors distinct from empty results', async () => {
    const f = await fixture();
    const scope = { account_id: 'personal-a', origin_product_id: 'superwagie', visibility: 'account' };
    let usageStatus = 200;
    f.app.get('/v1/accounts/personal-a/usage/summary', (_req, res) => res.status(usageStatus).json(usageStatus !== 200
      ? { error: 'forbidden' }
      : { scope, financial_details: true, calls_total: '1', settled_calls: '1', pending_calls: '0', unknown_calls: '0',
          missing_usage_calls: '0', unknown_time: '0', usage: { input: '9007199254740993', output: '3' },
          usage_complete: true, charges_by_asset: { 'CREDIT/6': '17', 'CNY/6': '81' }, debug: 'private fixture field' }));
    f.app.get('/v1/accounts/personal-a/calls', (_req, res) => res.json({
      scope, financial_details: true, has_more: false,
      items: [{ account_id: 'personal-a', origin_product_id: 'superwagie', actor_id: 'actor-a', call_id: 'call-a', model: 'demo',
        status: 'SETTLED', created_at: null, asset: 'CREDIT/6', charged: '17', task_id: 'private-task' }],
    }));
    const local = express();
    registerPlatformAccountRoutes(local, { runtime: f.runtime, resolveIdentity: () => identity });
    await f.runtime.passwordLogin(identity, { username: 'alice', password });
    await f.runtime.selectAccount(identity, 'personal-a');
    const summary = await request(local).get('/api/platform-account/usage/personal-a/summary').expect(200);
    expect(summary.body).toMatchObject({ calls_total: '1', usage: { input: '9007199254740993' }, charges_by_asset: { 'CNY/6': '81' } });
    expect(summary.body.debug).toBeUndefined();
    const calls = await request(local).get('/api/platform-account/usage/personal-a/calls').expect(200);
    expect(calls.body.items).toEqual([{ call_id: 'call-a', model: 'demo', status: 'SETTLED', created_at: null, asset: 'CREDIT/6', charged: '17' }]);
    await request(local).get('/api/platform-account/usage/team-a/summary').expect(409);
    expect(f.requests.some(({ path }) => path === '/accounts/team-a/usage/summary')).toBe(false);
    usageStatus = 403;
    await request(local).get('/api/platform-account/usage/personal-a/summary').expect(403, { error: 'forbidden' });
  });

  it.each(['superwagie', 'llmrouter'])('preserves confirmed %s charges during an unknown refund without settling the call', async (product) => {
    const f = await fixture();
    const scope = { account_id: 'personal-a', origin_product_id: product, visibility: 'account', actor_id: 'actor-a',
      instance_id: 'default', source: 'product_runtime' };
    let financialDetails = true;
    const upstream = `/v1/accounts/personal-a/${product === 'llmrouter' ? 'model-pool/' : ''}`;
    f.app.get(upstream + 'usage/summary', (_req, res) => res.json({
      scope, financial_details: financialDetails, calls_total: '2', settled_calls: '0', pending_calls: '0', unknown_calls: '2',
      missing_usage_calls: '0', unknown_time: '0', usage: {}, usage_complete: false,
      charges_by_asset: { 'CNY/6': '100' }, refunds_by_asset: { 'CNY/6': '0' },
    }));
    f.app.get(upstream + 'calls', (_req, res) => res.json({
      scope, filter: { source: 'product_runtime' }, financial_details: financialDetails, has_more: false,
      items: [
        { ...scope, call_id: 'confirmed-charge', model: 'confirmed', status: 'UNKNOWN', created_at: null,
          asset: 'CNY/6', held: '100', charged: '100', refunded: '0' },
        { ...scope, call_id: 'unconfirmed-charge', model: 'unconfirmed', status: 'UNKNOWN', created_at: null,
          asset: 'CNY/6', held: '500', charged: '0', refunded: '0' },
      ],
    }));
    const local = express();
    registerPlatformAccountRoutes(local, { runtime: f.runtime, resolveIdentity: () => identity });
    await f.runtime.passwordLogin(identity, { username: 'alice', password });
    await f.runtime.selectAccount(identity, 'personal-a');
    const base = `/api/platform-account/usage/personal-a${product === 'llmrouter' ? '/llmrouter' : ''}`;
    const summary = await request(local).get(base + '/summary').expect(200);
    expect(summary.body).toMatchObject({ settled_calls: '0', unknown_calls: '2', usage_complete: false,
      charges_by_asset: { 'CNY/6': '100' }, refunds_by_asset: { 'CNY/6': '0' } });
    const calls = await request(local).get(base + '/calls').expect(200);
    expect(calls.body.items).toEqual([
      { call_id: 'confirmed-charge', model: 'confirmed', status: 'UNKNOWN', created_at: null,
        asset: 'CNY/6', held: '100', charged: '100', refunded: '0' },
      { call_id: 'unconfirmed-charge', model: 'unconfirmed', status: 'UNKNOWN', created_at: null,
        asset: 'CNY/6', held: '500', charged: '0', refunded: '0' },
    ]);
    financialDetails = false;
    if (product === 'llmrouter') {
      await request(local).get(base + '/calls').expect(502, { error: 'platform_response_invalid' });
      return;
    }
    for (const visibility of ['account', 'actor']) {
      scope.visibility = visibility;
      financialDetails = visibility === 'actor';
      const restrictedSummary = await request(local).get(base + '/summary').expect(200);
      expect(restrictedSummary.body.charges_by_asset).toBeUndefined();
      expect(restrictedSummary.body.refunds_by_asset).toBeUndefined();
      const restrictedCalls = await request(local).get(base + '/calls').expect(200);
      for (const call of restrictedCalls.body.items) {
        expect(call.status).toBe('UNKNOWN');
        expect(call.charged).toBeUndefined();
        expect(call.held).toBeUndefined();
        expect(call.refunded).toBeUndefined();
      }
    }
  });

  it('requires explicit LLMRouter runtime scope and never projects a mismatched pool response', async () => {
    const f = await fixture();
    const scope = { account_id: 'personal-a', origin_product_id: 'llmrouter', instance_id: 'default', visibility: 'account', source: 'product_runtime' };
    let allowed = false;
    let source = 'product_runtime';
    f.app.get('/v1/accounts/personal-a/model-pool/usage/summary', (_req, res) => {
      if (!allowed) return res.status(403).json({ error: 'forbidden' });
      res.json({ scope: { ...scope, source }, financial_details: true, calls_total: '1', settled_calls: '1', pending_calls: '0',
        unknown_calls: '0', missing_usage_calls: '0', unknown_time: '0', usage: { input: '0', output: '0' },
        usage_complete: false, charges_by_asset: { 'LR_QUOTA/0': '42' }, refunds_by_asset: { 'CNY/6': '17' } });
    });
    f.app.get('/v1/accounts/personal-a/model-pool/calls', (_req, res) => res.json({
      scope, filter: { source: 'product_runtime' }, financial_details: true, has_more: false,
      items: [{ ...scope, source, source_call_id: 'native-a', call_id: 'product_runtime:native-a', actor_id: 'actor-a',
        model: 'native fixture', status: 'UNKNOWN', created_at: null, asset: 'LR_QUOTA/0', held: '40', usage_status: 'unavailable' }],
    }));
    const local = express();
    registerPlatformAccountRoutes(local, { runtime: f.runtime, resolveIdentity: () => identity });
    await f.runtime.passwordLogin(identity, { username: 'alice', password });
    await f.runtime.selectAccount(identity, 'personal-a');
    const base = '/api/platform-account/usage/personal-a/llmrouter';
    await request(local).get(base + '/summary').expect(403, { error: 'forbidden' });
    allowed = true;
    const summary = await request(local).get(base + '/summary').expect(200);
    expect(summary.body).toMatchObject({ usage: {}, charges_by_asset: { 'LR_QUOTA/0': '42' }, refunds_by_asset: { 'CNY/6': '17' } });
    const calls = await request(local).get(base + '/calls').expect(200);
    expect(calls.body.items[0]).toMatchObject({ model: 'native fixture', status: 'UNKNOWN', asset: 'LR_QUOTA/0', held: '40', usage_status: 'unavailable' });
    source = 'managed_model';
    await request(local).get(base + '/summary').expect(502, { error: 'platform_response_invalid' });
    await request(local).get(base + '/calls').expect(502, { error: 'platform_response_invalid' });
  });

  it.each(['superwagie', 'llmrouter'].flatMap((product) => ['summary', 'calls'].flatMap((kind) =>
    ['login', 'account', 'current'].map((transition) => ({ product, kind, transition })))))
  ('scopes a delayed $product $kind 401 to its captured session after $transition', async ({ product, kind, transition }) => {
    const f = await fixture();
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    const upstream = `/v1/accounts/personal-a/${product === 'llmrouter' ? 'model-pool/' : ''}${kind === 'summary' ? 'usage/summary' : 'calls'}`;
    f.app.get(upstream, async (_req, res) => {
      started.resolve();
      await release.promise;
      res.status(401).json({ error: 'unauthenticated' });
    });
    const local = express();
    registerPlatformAccountRoutes(local, { runtime: f.runtime, resolveIdentity: () => identity });
    await f.runtime.passwordLogin(identity, { username: 'alice', password });
    await f.runtime.selectAccount(identity, 'personal-a');
    const pending = request(local).get(`/api/platform-account/usage/personal-a${product === 'llmrouter' ? '/llmrouter' : ''}/${kind}`).then((response) => response);
    await started.promise;
    try {
      if (transition === 'login') {
        f.runtime.logout(identity);
        f.renameUser('Replacement login');
        await f.runtime.passwordLogin(identity, { username: 'alice', password });
        await f.runtime.selectAccount(identity, 'personal-a');
      } else if (transition === 'account') {
        await f.runtime.selectAccount(identity, 'team-a');
      }
    } finally {
      release.resolve();
    }
    const response = await pending;
    if (transition === 'current') {
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'platform_session_expired' });
      expect(await f.runtime.identitySession(identity)).toEqual({ status: 'signed-out' });
      return;
    }
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'platform_session_changed' });
    expect(await f.runtime.publicSession(identity)).toMatchObject({ status: 'signed-in',
      accountId: transition === 'account' ? 'team-a' : 'personal-a',
      user: { name: transition === 'login' ? 'Replacement login' : 'Alice' } });
  });

  it.each(['json', 'malformed', 'avatar'])('revokes local access after authoritative upstream 401 from %s', async (kind) => {
    const f = await fixture(); let revoked = false;
    const runtime = createPlatformAccountRuntime({ env: f.env, fetchImpl: async (url, init) => {
      if (revoked && (String(url).endsWith('/v1/me') || String(url).endsWith('/v1/me/avatar'))) {
        return new Response(kind === 'malformed' ? 'Unauthorized' : JSON.stringify({ error: 'unauthenticated' }), { status: 401 });
      }
      return fetch(url, init);
    } });
    await runtime.passwordLogin(identity, { username: 'alice', password });
    revoked = true;
    const pending = kind === 'avatar' ? runtime.captureIdentitySession(identity).readAvatar() : runtime.identitySession(identity);
    await expect(pending).rejects.toMatchObject({ code: 'platform_session_expired', status: 401 });
    expect(() => runtime.actor(identity)).toThrow('platform_session_expired');
    expect(await runtime.identitySession(identity)).toEqual({ status: 'signed-out' });
  });
  it('keeps a replacement login when an older identity check returns 401 late', async () => {
    const f = await fixture(); let hold = false; let release; let entered;
    const blocked = new Promise((resolve) => { release = resolve; });
    const reached = new Promise((resolve) => { entered = resolve; });
    const runtime = createPlatformAccountRuntime({ env: f.env, fetchImpl: async (url, init) => {
      const response = await fetch(url, init);
      if (hold && String(url).endsWith('/v1/me')) {
        hold = false; entered(); await blocked;
        return new Response(JSON.stringify({ error: 'unauthenticated' }), { status: 401 });
      }
      return response;
    } });
    await runtime.passwordLogin(identity, { username: 'alice', password });
    hold = true;
    const pending = runtime.identitySession(identity);
    await reached;
    await runtime.passwordLogin(identity, { username: 'alice', password });
    release();
    await expect(pending).rejects.toMatchObject({ code: 'platform_session_expired' });
    expect(runtime.actor(identity).actingUserId).toBe('actor-a');
  });
  it('revokes every local user session when logout races a successful password change', async () => {
    const f = await fixture(); let release; let entered;
    const blocked = new Promise((resolve) => { release = resolve; });
    const reached = new Promise((resolve) => { entered = resolve; });
    const runtime = createPlatformAccountRuntime({ env: f.env, fetchImpl: async (url, init) => {
      if (String(url).endsWith('/v1/me/password')) { entered(); await blocked; return new Response(null, { status: 204 }); }
      return fetch(url, init);
    } });
    const other = { type: 'client', token: 'other-profile-device' };
    await runtime.passwordLogin(identity, { username: 'alice', password });
    await runtime.passwordLogin(other, { username: 'alice', password });
    const pending = createPlatformProfileRuntime(runtime).changePassword(identity, { currentPassword: password, newPassword: 'NewPassword123!' });
    await reached;
    runtime.logout(identity);
    release();
    await expect(pending).rejects.toMatchObject({ code: 'platform_password_unknown' });
    expect(() => runtime.actor(other)).toThrow('platform_session_expired');
  });
  it('reads identity without billing and refuses sessions after identity configuration changes', async () => {
    const f = await fixture();
    expect(await f.runtime.identitySession(identity)).toEqual({ status: 'signed-out' });
    await f.runtime.passwordLogin(identity, { username: 'alice', password });
    f.requests.length = 0;
    expect(await f.runtime.identitySession(identity)).toMatchObject({ status: 'signed-in', user: { id: 'actor-a' } });
    expect(f.requests.map((r) => r.path)).toEqual(['/me']);
    delete f.env.OPENCHAMBER_UNIHUB_API_URL;
    expect(() => f.runtime.actor(identity)).toThrow('platform_unconfigured');
  });
  it('captures personal identity without billing and cannot use a capture after logout', async () => {
    const f = await fixture();
    await f.runtime.passwordLogin(identity, { username: 'alice', password });
    const captured = f.runtime.captureIdentitySession(identity);
    expect(captured.userId).toBe('actor-a');
    expect(await captured.request('/v1/me')).toMatchObject({ id: 'actor-a' });
    f.runtime.logout(identity);
    await expect(captured.request('/v1/me')).rejects.toMatchObject({ code: 'platform_session_changed' });
  });
  it('keeps personal identity valid while the billing account changes', async () => {
    const f = await fixture(); let release; let entered; let hold = false;
    const blocked = new Promise((resolve) => { release = resolve; });
    const reached = new Promise((resolve) => { entered = resolve; });
    const runtime = createPlatformAccountRuntime({ env: f.env, fetchImpl: async (url, init) => {
      const response = await fetch(url, init);
      if (hold && String(url).endsWith('/v1/me')) { hold = false; entered(); await blocked; }
      return response;
    } });
    await runtime.passwordLogin(identity, { username: 'alice', password });
    const captured = runtime.captureIdentitySession(identity);
    hold = true;
    const pending = runtime.identitySession(identity);
    await reached;
    await runtime.selectAccount(identity, 'team-a');
    release();
    expect(await pending).toMatchObject({ status: 'signed-in', user: { id: 'actor-a' } });
    expect(await captured.request('/v1/me')).toMatchObject({ id: 'actor-a' });
  });
  it('revokes the current login when an identity request fails after an account switch', async () => {
    const f = await fixture(); let release; let entered; let hold = false;
    const blocked = new Promise((resolve) => { release = resolve; });
    const reached = new Promise((resolve) => { entered = resolve; });
    const runtime = createPlatformAccountRuntime({ env: f.env, fetchImpl: async (url, init) => {
      const response = await fetch(url, init);
      if (hold && String(url).endsWith('/v1/me')) { hold = false; entered(); await blocked; return new Response(JSON.stringify({ error: 'unauthenticated' }), { status: 401 }); }
      return response;
    } });
    await runtime.passwordLogin(identity, { username: 'alice', password });
    hold = true;
    const pending = runtime.captureIdentitySession(identity).request('/v1/me');
    await reached;
    await runtime.selectAccount(identity, 'team-a');
    release();
    await expect(pending).rejects.toMatchObject({ code: 'platform_session_expired' });
    expect(() => runtime.actor(identity)).toThrow('platform_session_expired');
  });
  it('uses the explicitly configured headless client and keeps credentials in the backend', async () => {
    const f = await fixture();
    expect(f.runtime.authMethods(identity)).toEqual({ passwordLogin: true, registration: true, browserLogin: false, passwordRecoveryUrl: `${f.origin}/forget` });
    expect(await f.runtime.publicSession(identity)).toEqual({ status: 'signed-out' });
    const state = await f.runtime.passwordLogin(identity, { username: 'alice', password });
    expect(state).toMatchObject({ status: 'signed-in', user: { id: 'actor-a' } });
    expect(state.accountId).toBeUndefined();
    expect(f.requests.some((r) => r.path.startsWith('/accounts'))).toBe(false);
    expect(JSON.stringify(state)).not.toMatch(/access_token|id_token|must-not-persist|SyntheticPassword/);
    expect(await f.runtime.publicSession({ type: 'client', token: 'other-device' })).toEqual({ status: 'signed-out' });
    expect(f.requests.filter((r) => r.path === '/identity/token')).toHaveLength(1);
  });
  it('does not treat the legacy browser audience as a headless client', async () => {
    const f = await fixture();
    delete f.env.OPENCHAMBER_UNIHUB_HEADLESS_CLIENT_ID;
    f.env.OPENCHAMBER_UNIHUB_CLIENT_ID = 'legacy-client';
    expect(f.runtime.authMethods(identity)).toEqual({ passwordLogin: false, registration: false, browserLogin: true, passwordRecoveryUrl: `${f.origin}/forget` });
    await expect(f.runtime.passwordLogin(identity, { username: 'alice', password })).rejects.toMatchObject({ code: 'platform_headless_unconfigured' });
    expect(f.requests).toHaveLength(0);
  });
  it('accepts an explicitly registered JSON redirect while retaining the browser callback path', async () => {
    const f = await fixture();
    f.env.OPENCHAMBER_UNIHUB_HEADLESS_REDIRECT_URI = 'http://127.0.0.1:57992/callback';
    expect(f.runtime.authMethods(identity)).toEqual({ passwordLogin: true, registration: true, browserLogin: false, passwordRecoveryUrl: `${f.origin}/forget` });
    f.env.OPENCHAMBER_UNIHUB_CLIENT_ID = 'browser-client';
    f.env.OPENCHAMBER_UNIHUB_REDIRECT_URI = 'http://127.0.0.1:57992/callback';
    expect(() => f.runtime.authMethods(identity)).toThrow('platform_configuration_invalid');
  });
  it('returns registration uncertainty and reuses the caller key without keeping the password', async () => {
    const f = await fixture(); f.unknownRegistration();
    const metadata = { username: 'alice', email: 'alice@example.test', displayName: 'Alice', idempotencyKey: 'registration-key' };
    expect(await f.runtime.register(identity, { ...metadata, password })).toEqual({ registrationId: 'registration-a', status: 'UNKNOWN', loginRequired: false, retryAfter: 2 });
    await f.runtime.register(identity, metadata);
    const registrations = f.requests.filter((r) => r.path === '/identity/registrations');
    expect(registrations).toHaveLength(2);
    expect(registrations.map((r) => r.key)).toEqual(['registration-key', 'registration-key']);
    expect(registrations[1].body).toEqual({ client_id: 'superwagie-headless-fixture', username: 'alice', email: 'alice@example.test', display_name: 'Alice' });
    expect(await f.runtime.publicSession(identity)).toEqual({ status: 'signed-out' });
  });
  it('requires password re-entry on the original key when no registration reached UniHub', async () => {
    const f = await fixture();
    const submissions = [];
    let recoveryUnavailable = false;
    const runtime = createPlatformAccountRuntime({ env: f.env, fetchImpl: async (url, init) => {
      if (String(url).endsWith('/identity/registrations')) {
        const body = JSON.parse(init.body);
        submissions.push({ key: init.headers['Idempotency-Key'], body });
        if (!body.password) return Response.json({ error: 'invalid_password' }, { status: recoveryUnavailable ? 503 : 400 });
      }
      return fetch(url, init);
    } });
    const input = { username: 'alice', idempotencyKey: 'original-registration' };
    await expect(runtime.register(identity, input)).rejects.toMatchObject({ code: 'platform_registration_password_required', status: 400 });
    expect(await runtime.register(identity, { ...input, password })).toMatchObject({ status: 'CREATED' });
    expect(submissions).toEqual([
      { key: 'original-registration', body: { client_id: 'superwagie-headless-fixture', username: 'alice' } },
      { key: 'original-registration', body: { client_id: 'superwagie-headless-fixture', username: 'alice', password } },
    ]);
    expect(f.requests.filter((r) => r.path === '/identity/registrations').map((r) => r.key)).toEqual(['original-registration']);
    recoveryUnavailable = true;
    await expect(runtime.register(identity, input)).rejects.toMatchObject({ code: 'platform_registration_unknown' });
  });
  it('enforces registration byte and Unicode limits before dispatch', async () => {
    const f = await fixture();
    for (const invalidPassword of ['A9' + 'a'.repeat(71), 'A9a' + '密'.repeat(24)]) {
      await expect(f.runtime.register(identity, { username: 'alice', password: invalidPassword, idempotencyKey: 'limits' })).rejects.toMatchObject({ code: 'invalid_password' });
    }
    await expect(f.runtime.register(identity, { username: 'alice', password, displayName: '名'.repeat(81), idempotencyKey: 'limits' })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(f.requests).toHaveLength(0);
    expect(await f.runtime.register(identity, { username: 'alice', password: 'A9a' + '密'.repeat(23), displayName: '😀'.repeat(80), idempotencyKey: 'limits' })).toMatchObject({ status: 'CREATED' });
    expect(f.requests).toHaveLength(1);
  });
  it('allows eight-character registration passwords without local composition or identity restrictions', async () => {
    const f = await fixture();
    expect(await f.runtime.register(identity, { username: 'alice', email: 'alice@example.test', password: 'aliceabc', idempotencyKey: 'simple-password' })).toMatchObject({ status: 'CREATED' });
    expect(f.requests[0].body.password).toBe('aliceabc');
  });
  it.each([
    ['abcdefg', ['too_short']],
    ['😀'.repeat(7), ['too_short']],
    ['a'.repeat(129), ['too_long', 'too_many_bytes']],
    ['密'.repeat(25), ['too_many_bytes']],
    ['abcd\u0085efgh', ['control_character']],
  ])('explains registration password violations before dispatch for %j', async (invalidPassword, passwordIssues) => {
    const f = await fixture();
    await expect(f.runtime.register(identity, { username: 'alice', password: invalidPassword, idempotencyKey: 'password-issues' })).rejects.toMatchObject({ code: 'invalid_password', status: 400, passwordIssues });
    expect(f.requests).toHaveLength(0);
  });
  it.each([
    [{ error: 'invalid_password', password_issues: ['letter_case_and_digit_required', 'special_character_required', 'repeated_character'], debug: password }, { error: 'invalid_password', password_issues: ['letter_case_and_digit_required', 'special_character_required', 'repeated_character'] }],
    [{ error: 'invalid_password' }, { error: 'invalid_password' }],
    [{ error: 'invalid_password', password_issues: 'debug-secret' }, { error: 'invalid_password' }],
    [{ error: 'invalid_password', password_issues: ['special_character_required', 'debug-secret'] }, { error: 'invalid_password' }],
    [{ error: 'invalid_password', password_issues: Array(8).fill('too_short') }, { error: 'invalid_password' }],
    [{ error: 'invalid_credentials', password_issues: ['too_short'] }, { error: 'invalid_credentials' }],
  ])('returns only known upstream password issues without exposing provider details for %j', async (upstream, expected) => {
    const f = await fixture();
    const runtime = createPlatformAccountRuntime({ env: f.env, fetchImpl: async () => Response.json(upstream, { status: 400 }) });
    const app = express();
    registerPlatformAccountRoutes(app, { runtime, resolveIdentity: async () => identity, isRequestOriginAllowed: () => true });
    const result = await request(app).post('/api/platform-account/register').send({ username: 'alice', password, idempotencyKey: 'safe-password-error' });
    expect(result.status).toBe(400);
    expect(result.body).toEqual(expected);
  });
  it.each(['register', 'password-login'])('returns the upstream wait time for a rate-limited %s request', async (operation) => {
    const f = await fixture();
    const upstreamPath = operation === 'register' ? '/v1/identity/registrations' : '/v1/identity/authorize/password';
    const runtime = createPlatformAccountRuntime({ env: f.env, fetchImpl: async (url, init) => {
      if (String(url).endsWith(upstreamPath)) return Response.json({ error: 'rate_limited', retry_after: 90, debug: password }, { status: 429, headers: { 'Retry-After': '90' } });
      return fetch(url, init);
    } });
    const app = express();
    registerPlatformAccountRoutes(app, { runtime, resolveIdentity: async () => identity, isRequestOriginAllowed: () => true });
    const input = { username: 'alice', password };
    if (operation === 'register') input.idempotencyKey = 'limited-registration';
    const result = await request(app).post(`/api/platform-account/${operation}`).send(input);
    expect(result.status).toBe(429);
    expect(result.body).toEqual({ error: 'rate_limited', retry_after: 90 });
    expect(result.headers['retry-after']).toBe('90');
    expect(f.requests.filter((entry) => entry.path === '/identity/token')).toHaveLength(0);
  });
  it.each([
    [{}, undefined, undefined],
    [{ retry_after: null }, undefined, undefined],
    [{ retry_after: '60' }, undefined, undefined],
    [{ retry_after: -1 }, undefined, undefined],
    [{ retry_after: 0 }, undefined, undefined],
    [{ retry_after: 1.5 }, undefined, undefined],
    [{ retry_after: 86401 }, undefined, undefined],
    [{ retry_after: 86400 }, undefined, 86400],
    [{}, '60', 60],
    [{ retry_after: 30 }, '60', 30],
    [{ retry_after: -1 }, '60', 60],
    [{}, '-1', undefined],
    [{}, '1.5', undefined],
    [{}, '86401', undefined],
    [{}, '60 seconds', undefined],
  ])('accepts only bounded numeric rate-limit metadata for body %j and header %j', async (metadata, header, expectedRetryAfter) => {
    const f = await fixture();
    const runtime = createPlatformAccountRuntime({ env: f.env, fetchImpl: async () => Response.json({ error: 'rate_limited', ...metadata }, { status: 429, headers: header === undefined ? {} : { 'Retry-After': header } }) });
    const app = express();
    registerPlatformAccountRoutes(app, { runtime, resolveIdentity: async () => identity, isRequestOriginAllowed: () => true });
    const result = await request(app).post('/api/platform-account/register').send({ username: 'alice', password, idempotencyKey: 'bounded-cooldown' });
    expect(result.status).toBe(429);
    const expectedBody = { error: 'rate_limited' };
    if (expectedRetryAfter !== undefined) expectedBody.retry_after = expectedRetryAfter;
    expect(result.body).toEqual(expectedBody);
    expect(result.headers['retry-after']).toBe(expectedRetryAfter === undefined ? undefined : String(expectedRetryAfter));
  });
  it('does not attach wait metadata to another error code', async () => {
    const f = await fixture();
    const runtime = createPlatformAccountRuntime({ env: f.env, fetchImpl: async () => Response.json({ error: 'invalid_credentials', retry_after: 90 }, { status: 400, headers: { 'Retry-After': '90' } }) });
    const app = express();
    registerPlatformAccountRoutes(app, { runtime, resolveIdentity: async () => identity, isRequestOriginAllowed: () => true });
    const result = await request(app).post('/api/platform-account/register').send({ username: 'alice', password, idempotencyKey: 'unrelated-error' });
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: 'invalid_credentials' });
    expect(result.headers['retry-after']).toBeUndefined();
  });
  it('preserves a rate-limited authorization-code exchange wait time without retrying the token request', async () => {
    const f = await fixture(); let tokenRequests = 0;
    const runtime = createPlatformAccountRuntime({ env: f.env, fetchImpl: async (url, init) => {
      if (String(url).endsWith('/v1/identity/token')) { tokenRequests += 1; return Response.json({ error: 'rate_limited', retry_after: 45 }, { status: 429 }); }
      return fetch(url, init);
    } });
    await expect(runtime.passwordLogin(identity, { username: 'alice', password })).rejects.toMatchObject({ code: 'rate_limited', status: 429, retryAfter: 45 });
    expect(tokenRequests).toBe(1);
  });
  it('rejects altered state before exchange and mismatched signed tokens before login', async () => {
    const state = await fixture(); state.badState();
    await expect(state.runtime.passwordLogin(identity, { username: 'alice', password })).rejects.toMatchObject({ code: 'platform_authorization_invalid' });
    expect(state.requests.filter((r) => r.path === '/identity/token')).toHaveLength(0);
    for (const mutate of ['badNonce', 'badAudience']) {
      const f = await fixture(); f[mutate]();
      await expect(f.runtime.passwordLogin(identity, { username: 'alice', password })).rejects.toMatchObject({ code: 'platform_token_invalid' });
      expect(await f.runtime.publicSession(identity)).toEqual({ status: 'signed-out' });
    }
  });
  it('never retries an uncertain token exchange', async () => {
    const f = await fixture(); f.tokenError();
    await expect(f.runtime.passwordLogin(identity, { username: 'alice', password })).rejects.toMatchObject({ code: 'authorization_result_unknown' });
    expect(f.requests.filter((r) => r.path === '/identity/token')).toHaveLength(1);
    expect(await f.runtime.publicSession(identity)).toEqual({ status: 'signed-out' });
  });
  it('preserves an uncertain registration outcome after a failed persistence response', async () => {
    const f = await fixture(); f.registrationError('service_unavailable');
    await expect(f.runtime.register(identity, { username: 'alice', password, idempotencyKey: 'stable-key' })).rejects.toMatchObject({ code: 'platform_registration_unknown' });
    expect(f.requests).toHaveLength(1);
    f.registrationError('registration_policy_unavailable');
    await expect(f.runtime.register(identity, { username: 'alice', password, idempotencyKey: 'stable-key' })).rejects.toMatchObject({ code: 'registration_policy_unavailable' });
  });
  it('does not exchange a code after logout while password authorization was pending', async () => {
    const f = await fixture(); let release; let entered;
    const blocked = new Promise((resolve) => { release = resolve; });
    const reached = new Promise((resolve) => { entered = resolve; });
    const runtime = createPlatformAccountRuntime({ env: f.env, fetchImpl: async (url, init) => {
      const response = await fetch(url, init);
      if (String(url).endsWith('/identity/authorize/password')) { entered(); await blocked; }
      return response;
    } });
    const pending = runtime.passwordLogin(identity, { username: 'alice', password });
    await reached; runtime.logout(identity); release();
    await expect(pending).rejects.toMatchObject({ code: 'platform_login_expired' });
    expect(f.requests.filter((r) => r.path === '/identity/token')).toHaveLength(0);
    expect(await runtime.publicSession(identity)).toEqual({ status: 'signed-out' });
  });
  it('captures the exact session and rejects use after an account change or logout', async () => {
    const f = await fixture(); await f.runtime.passwordLogin(identity, { username: 'alice', password });
    await f.runtime.publicSession(identity);
    const captured = f.runtime.captureCommerceSession(identity);
    expect(captured).toMatchObject({ actingUserId: 'actor-a', billingAccountId: 'personal-a' });
    expect(captured.serviceId).toMatch(/^[0-9a-f]{64}$/);
    expect(await captured.request('/v1/capabilities')).toEqual({ sandbox: true });
    await expect(captured.request('/v1/accounts/team-a/orders')).rejects.toMatchObject({ code: 'platform_account_forbidden' });
    await f.runtime.selectAccount(identity, 'team-a');
    await expect(captured.request('/v1/capabilities')).rejects.toMatchObject({ code: 'platform_session_changed' });
    const next = f.runtime.captureCommerceSession(identity); f.runtime.logout(identity);
    await expect(next.request('/v1/capabilities')).rejects.toMatchObject({ code: 'platform_session_changed' });
  });
  it('rejects a captured response when logout happens after the request was sent', async () => {
    const f = await fixture(); let release; let entered;
    const blocked = new Promise((resolve) => { release = resolve; });
    const reached = new Promise((resolve) => { entered = resolve; });
    const runtime = createPlatformAccountRuntime({ env: f.env, fetchImpl: async (url, init) => {
      const response = await fetch(url, init);
      if (String(url).endsWith('/v1/capabilities')) { entered(); await blocked; }
      return response;
    } });
    await runtime.passwordLogin(identity, { username: 'alice', password });
    await runtime.publicSession(identity);
    const pending = runtime.captureCommerceSession(identity).request('/v1/capabilities');
    await reached; runtime.logout(identity); release();
    await expect(pending).rejects.toMatchObject({ code: 'platform_session_changed' });
    expect(f.requests.filter((r) => r.path === '/capabilities')).toHaveLength(1);
  });
  it.each(['account projection','account selection','captured commerce request'])('allows %s to finish across a same-login identity refresh', async operation => {
    const f=await fixture(); let release, entered, hold=false;
    const blocked=new Promise(resolve=>{release=resolve}), reached=new Promise(resolve=>{entered=resolve});
    const runtime=createPlatformAccountRuntime({env:f.env,fetchImpl:async(url,init)=>{
      const response=await fetch(url,init);
      if(hold && (String(url).endsWith('/accounts/personal-a/credits') || String(url).endsWith('/accounts/team-a/credits') || String(url).endsWith('/v1/capabilities'))) {hold=false;entered();await blocked;}
      return response;
    }});
    await runtime.passwordLogin(identity,{username:'alice',password});
    if(operation==='captured commerce request') await runtime.publicSession(identity);
    hold=true;
    const pending=operation==='account projection' ? runtime.publicSession(identity) : operation==='account selection' ? runtime.selectAccount(identity,'team-a') : runtime.captureCommerceSession(identity).request('/v1/capabilities');
    await reached; expect((await runtime.identitySession(identity)).status).toBe('signed-in'); release();
    const result=await pending;
    if(operation==='account projection') expect(result.accountId).toBe('personal-a');
    else if(operation==='account selection') expect(result.accountId).toBe('team-a');
    else expect(result).toEqual({sandbox:true});
  });
  it.each(['account switch', 'logout', 'new login'])('rejects an old account projection after %s', async (change) => {
    const f = await fixture(); let release; let entered; let hold = false;
    const blocked = new Promise((resolve) => { release = resolve; });
    const reached = new Promise((resolve) => { entered = resolve; });
    const runtime = createPlatformAccountRuntime({ env: f.env, fetchImpl: async (url, init) => {
      const response = await fetch(url, init);
      if (hold && String(url).endsWith('/accounts/personal-a/credits')) { hold = false; entered(); await blocked; }
      return response;
    } });
    await runtime.passwordLogin(identity, { username: 'alice', password });
    hold = true;
    const pending = runtime.publicSession(identity);
    await reached;
    if (change === 'account switch') {
      expect((await runtime.selectAccount(identity, 'team-a')).accountId).toBe('team-a');
    } else if (change === 'logout') {
      runtime.logout(identity);
    } else {
      await runtime.passwordLogin(identity, { username: 'alice', password });
    }
    release();
    await expect(pending).rejects.toMatchObject({ code: 'platform_session_changed' });
    expect((await runtime.publicSession(identity)).status).toBe(change === 'logout' ? 'signed-out' : 'signed-in');
  });
  it('does not let a concurrent read cancel a user account selection', async () => {
    const f=await fixture(); let release,entered,hold=false;
    const blocked=new Promise(resolve=>{release=resolve}),reached=new Promise(resolve=>{entered=resolve});
    const runtime=createPlatformAccountRuntime({env:f.env,fetchImpl:async(url,init)=>{const response=await fetch(url,init);if(hold && String(url).endsWith('/accounts/team-a/credits')){hold=false;entered();await blocked;}return response;}});
    await runtime.passwordLogin(identity,{username:'alice',password}); await runtime.publicSession(identity);
    hold=true;const selected=runtime.selectAccount(identity,'team-a');await reached;
    expect((await runtime.publicSession(identity)).accountId).toBe('personal-a'); release();
    expect((await selected).accountId).toBe('team-a'); expect(runtime.actor(identity).billingAccountId).toBe('team-a');
  });
  it('does not auto-select a default account while the user selection is in progress', async () => {
    const f=await fixture(); let release,entered,hold=false;
    const blocked=new Promise(resolve=>{release=resolve}),reached=new Promise(resolve=>{entered=resolve});
    const runtime=createPlatformAccountRuntime({env:f.env,fetchImpl:async(url,init)=>{const response=await fetch(url,init);if(hold && String(url).endsWith('/accounts/team-a/credits')){hold=false;entered();await blocked;}return response;}});
    await runtime.passwordLogin(identity,{username:'alice',password}); hold=true;
    const selected=runtime.selectAccount(identity,'team-a'); await reached;
    await expect(runtime.publicSession(identity)).rejects.toMatchObject({code:'platform_session_changed'});
    release(); expect((await selected).accountId).toBe('team-a'); expect(runtime.actor(identity).billingAccountId).toBe('team-a');
  });
  it('returns the newest user on an account projection overlapping an identity refresh', async () => {
    const f=await fixture();let release,entered,hold=false;
    const blocked=new Promise(resolve=>{release=resolve}),reached=new Promise(resolve=>{entered=resolve});
    const runtime=createPlatformAccountRuntime({env:f.env,fetchImpl:async(url,init)=>{const response=await fetch(url,init);if(hold && String(url).endsWith('/accounts/personal-a/credits')){hold=false;entered();await blocked;}return response;}});
    await runtime.passwordLogin(identity,{username:'alice',password}); await runtime.publicSession(identity);
    hold=true;const projection=runtime.publicSession(identity);await reached;f.renameUser('Updated');await runtime.identitySession(identity);release();
    expect((await projection).user.name).toBe('Updated');
  });
  it('coalesces concurrent initial account reads without a false session change', async () => {
    const f=await fixture(); await f.runtime.passwordLogin(identity,{username:'alice',password});
    const results=await Promise.all([f.runtime.publicSession(identity),f.runtime.publicSession(identity)]);
    expect(results.map(value=>value.accountId)).toEqual(['personal-a','personal-a']);
  });
  it.each(['identity', 'account'])('serves same-session HTTP reads when the %s response arrives last', async (delayed) => {
    const f = await fixture();
    let release; let entered; let hold = false;
    const blocked = new Promise((resolve) => { release = resolve; });
    const reached = new Promise((resolve) => { entered = resolve; });
    const runtime = createPlatformAccountRuntime({ env: f.env, fetchImpl: async (url, init) => {
      const response = await fetch(url, init);
      const endpoint = delayed === 'identity' ? '/v1/me' : '/accounts/personal-a/credits';
      if (hold && String(url).endsWith(endpoint)) { hold = false; entered(); await blocked; }
      return response;
    } });
    const sid = { type: 'session', token: 'synthetic-browser-session' };
    await runtime.passwordLogin(sid, { username: 'alice', password });
    const app = express();
    registerPlatformAccountRoutes(app, { runtime, resolveIdentity: async (req) => {
      expect(req.get('Cookie')).toBe('sid=synthetic-browser-session');
      return sid;
    } });
    const identityPath = '/api/platform-account/session';
    const accountPath = '/api/platform-account';
    hold = true;
    const pending = request(app).get(delayed === 'identity' ? identityPath : accountPath)
      .set('Cookie', 'sid=synthetic-browser-session').then((result) => result);
    await reached;
    const first = await request(app).get(delayed === 'identity' ? accountPath : identityPath)
      .set('Cookie', 'sid=synthetic-browser-session');
    release();
    const last = await pending;
    expect(first.status).toBe(200);
    expect(last.status).toBe(200);
    expect(first.body.status).toBe('signed-in');
    expect(last.body.status).toBe('signed-in');
    const account = delayed === 'identity' ? first : last;
    expect(account.body.accountId).toBe('personal-a');
    expect(runtime.actor(sid).billingAccountId).toBe('personal-a');
  });
  it('does not let a delayed account selection overwrite a newer selection', async () => {
    const f = await fixture(); let release; let entered; let hold = false;
    const blocked = new Promise((resolve) => { release = resolve; });
    const reached = new Promise((resolve) => { entered = resolve; });
    const runtime = createPlatformAccountRuntime({ env: f.env, fetchImpl: async (url, init) => {
      const response = await fetch(url, init);
      if (hold && String(url).endsWith('/v1/accounts')) { hold = false; entered(); await blocked; }
      return response;
    } });
    await runtime.passwordLogin(identity, { username: 'alice', password });
    hold = true;
    const pending = runtime.selectAccount(identity, 'team-a');
    await reached;
    expect((await runtime.selectAccount(identity, 'personal-a')).accountId).toBe('personal-a');
    release();
    await expect(pending).rejects.toMatchObject({ code: 'platform_session_changed' });
    expect(runtime.actor(identity).billingAccountId).toBe('personal-a');
  });
  it('keeps the previous selection when the new account resource read fails', async () => {
    const f = await fixture();
    const runtime = createPlatformAccountRuntime({ env: f.env, fetchImpl: async (url, init) => String(url).endsWith('/accounts/team-a/credits') ? new Response('', { status: 503 }) : fetch(url, init) });
    await runtime.passwordLogin(identity, { username: 'alice', password });
    await runtime.publicSession(identity);
    await expect(runtime.selectAccount(identity, 'team-a')).rejects.toMatchObject({ code: 'platform_unavailable' });
    expect(runtime.actor(identity).billingAccountId).toBe('personal-a');
  });
  it('enforces route methods and rejects traversal before network IO', async () => {
    const f = await fixture(); await f.runtime.passwordLogin(identity, { username: 'alice', password });
    const count = f.requests.length;
    for (const [path, method] of [['/v1/catalog', 'POST'], ['/v1/accounts/personal-a/orders/../model-credentials', 'POST'], ['/v1/me?token=secret', 'GET'], ['/v1/identity/token', 'POST']]) {
      await expect(f.runtime.request(identity, path, { method })).rejects.toMatchObject({ code: 'platform_request_forbidden' });
    }
    expect(f.requests).toHaveLength(count);
  });
  it('denies unsafe origins and exposes only safe structured identity errors', async () => {
    const f = await fixture(); f.authError(409, { error: 'interaction_required', interaction: { kind: 'mfa', secret: password }, debug: password });
    const app = express();
    registerPlatformAccountRoutes(app, { runtime: f.runtime, resolveIdentity: async () => identity, isRequestOriginAllowed: (req) => req.get('Origin') === 'http://app.test' });
    const denied = await request(app).post('/api/platform-account/password-login').send({ username: 'alice', password });
    expect(denied.status).toBe(403); expect(f.requests).toHaveLength(0);
    const result = await request(app).post('/api/platform-account/password-login').set('Origin', 'http://app.test').send({ username: 'alice', password });
    expect(result.status).toBe(409); expect(result.body).toEqual({ error: 'interaction_required', interaction: { kind: 'mfa' } });
    expect(result.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(result.body)).not.toContain(password);
  });
});


describe('native usage summary transport', () => {
  it('retains the saved request-only quantities and explicit coverage through authenticated routes', async () => {
    const f = await fixture();
    let summary = structuredClone(nativeRequestSummary);
    f.app.get('/v1/accounts/personal-a/usage/summary', (_req, res) => res.json(summary));
    const local = express();
    registerPlatformAccountRoutes(local, { runtime: f.runtime, resolveIdentity: () => identity });
    await f.runtime.passwordLogin(identity, { username: 'alice', password });
    await f.runtime.selectAccount(identity, 'personal-a');
    const read = () => request(local).get('/api/platform-account/usage/personal-a/summary');
    const result = await read().expect(200);
    expect(result.body.native_usage).toEqual([{ operation: 'chat', measurements: [{ key: 'requests', unit: 'request', quantity: { value: '1', scale: 0 } }] }]);
    expect(result.body.usage_coverage).toEqual({ legacy_token_calls: '0', native_metered_calls: '1' });
    summary.native_usage[0].measurements[0].quantity.value = '9007199254740993';
    expect((await read().expect(200)).body.native_usage[0].measurements[0].quantity.value).toBe('9007199254740993');
    for (const quantity of [{ value: '01', scale: 0 }, { value: '-1', scale: 0 }, { value: '1', scale: 10 }, { value: '1', scale: 0.5 }]) {
      summary.native_usage[0].measurements[0].quantity = quantity;
      await read().expect(502, { error: 'platform_response_invalid' });
    }
    summary = structuredClone(nativeRequestSummary);
    summary.native_usage[0].measurements[0].key = 'input';
    await read().expect(502, { error: 'platform_response_invalid' });
    summary = structuredClone(nativeRequestSummary);
    summary.scope.account_id = 'another-account';
    await read().expect(502, { error: 'platform_response_invalid' });
  });
  it('preserves producer-valid literal image keys and provider namespaces with byte bounds', async () => {
    const f = await fixture();
    const image = (key) => ({ operation: 'image_generation', measurements: [{ key, unit: 'image', quantity: { value: '1', scale: 0 } }] });
    const video = (provider_unit) => ({ operation: 'video', measurements: [{ key: 'provider', unit: 'provider_unit', provider_unit, quantity: { value: '1', scale: 0 } }] });
    const summary = { ...structuredClone(nativeRequestSummary), native_usage: [image(' small '), video(' provider.units ')] };
    f.app.get('/v1/accounts/personal-a/usage/summary', (_req, res) => res.json(summary));
    const local = express();
    registerPlatformAccountRoutes(local, { runtime: f.runtime, resolveIdentity: () => identity });
    await f.runtime.passwordLogin(identity, { username: 'alice', password });
    await f.runtime.selectAccount(identity, 'personal-a');
    const read = () => request(local).get('/api/platform-account/usage/personal-a/summary');
    const result = await read().expect(200);
    expect(result.body.native_usage).toEqual([image(' small '), video(' provider.units ')]);
    expect(result.body.charges_by_asset).toEqual({ 'CNY/6': '73' });
    summary.native_usage = [image(' small ')];
    summary.native_usage[0].measurements.push({ key: 'small', unit: 'image', quantity: { value: '2', scale: 0 } });
    expect((await read().expect(200)).body.native_usage[0].measurements.map((item) => item.key)).toEqual([' small ', 'small']);
    for (const valid of [image('图'.repeat(42)), video('图'.repeat(42)), image('\ufeff')]) {
      summary.native_usage = [valid];
      expect((await read().expect(200)).body.native_usage).toEqual([valid]);
    }
    for (const invalid of [image(' \t\n'), video(' \t\n'), image('\u0085'), video('\u0085'), image('图'.repeat(43)), video('图'.repeat(43))]) {
      summary.native_usage = [invalid];
      await read().expect(502, { error: 'platform_response_invalid' });
    }
  });
  it('preserves the stable credit-rates rejection from the real upstream error parser', async () => {
    const f = await fixture();
    f.app.post('/v1/accounts/personal-a/orders', (_req, res) => res.status(409).json({ error: 'credit_rates_unavailable' }));
    await f.runtime.passwordLogin(identity, { username: 'alice', password });
    await f.runtime.selectAccount(identity, 'personal-a');
    await expect(f.runtime.captureCommerceSession(identity).request('/v1/accounts/personal-a/orders', { method: 'POST' })).rejects.toMatchObject({ code: 'credit_rates_unavailable', status: 409 });
  });
});
