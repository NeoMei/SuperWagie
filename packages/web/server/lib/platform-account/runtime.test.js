import http from 'node:http';
import express from 'express';
import request from 'supertest';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { createPlatformAccountRuntime } from './runtime.js';
import { registerPlatformAccountRoutes } from './routes.js';

const servers = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }))); });
const identity = { type: 'client', token: 'client:device-a' };
const secondIdentity = { type: 'client', token: 'client:device-b' };
const fixture = async (options = {}) => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'fixture', alg: 'RS256' };
  const app = express(); app.use(express.urlencoded({ extended: false }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); servers.push(server);
  const origin = `http://127.0.0.1:${server.address().port}`;
  let pending; let tokenRequests = 0; let clock = Date.now(); let failCredits = false; let nonceOverride; let audienceOverride; let accessSubject; let currentAccess;
  app.get('/.well-known/openid-configuration', (_req, res) => res.json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, jwks_uri: `${origin}/keys` }));
  app.get('/keys', (_req, res) => res.json({ keys: [jwk] }));
  app.post('/token', async (req, res) => {
    tokenRequests += 1;
    expect(req.body.client_secret).toBeUndefined();
    expect(req.body.client_id).toBe('superwagie-fixture');
    expect(req.body.redirect_uri).toBe(`${origin}/api/platform-account/callback`);
    const verifier = req.body.code_verifier;
    const crypto = await import('node:crypto');
    expect(crypto.createHash('sha256').update(verifier).digest('base64url')).toBe(pending.searchParams.get('code_challenge'));
    const jwt = await new SignJWT({ nonce: nonceOverride ?? pending.searchParams.get('nonce') }).setProtectedHeader({ alg: 'RS256', kid: 'fixture' }).setIssuer(origin).setSubject('fixture-user').setAudience(audienceOverride ?? 'superwagie-fixture').setIssuedAt().setExpirationTime('2h').sign(privateKey);
    currentAccess = await new SignJWT({ tokenType: 'access-token', scope: 'openid profile email' }).setProtectedHeader({ alg: 'RS256', kid: 'fixture' }).setIssuer(origin).setSubject(accessSubject ?? 'fixture-user').setAudience('superwagie-fixture').setIssuedAt().setExpirationTime('2h').sign(privateKey);
    res.json({ access_token: currentAccess, id_token: jwt, refresh_token: 'must-discard', expires_in: 7200, token_type: 'Bearer' });
  });
  app.use('/v1', (req, res, next) => { expect(req.headers.authorization).toBe(`Bearer ${currentAccess}`); next(); });
  app.get('/v1/me', (_req, res) => res.json({ id: 'actor-a', name: 'Alice', email: 'alice@example.test' }));
  app.get('/v1/accounts', (_req, res) => res.json([{ id: 'personal-a', name: 'Alice', kind: 'personal', role: 'owner' }, { id: 'team-a', name: 'Team A', kind: 'team', role: 'member' }]));
  app.get('/v1/accounts/:account/subscriptions', (_req, res) => res.json([{ id: 'sub-a', product_id: 'superwagie', status: 'active', paid_through: new Date(clock + 100000).toISOString(), offer: { name: 'Test plan' } }]));
  app.get('/v1/accounts/:account/credits', (_req, res) => failCredits ? res.status(503).end() : res.json([
    { id: 'credit-a', available: '9007199254740993', reserved: '7', starts_at: new Date(clock - 1000).toISOString(), expires_at: new Date(clock + 100000).toISOString(), frozen: false },
    { id: 'expired', available: '99', reserved: '3', starts_at: new Date(clock - 1000).toISOString(), expires_at: new Date(clock - 1).toISOString(), frozen: false },
  ]));
    const env = { OPENCHAMBER_UNIHUB_ISSUER: origin, OPENCHAMBER_UNIHUB_CLIENT_ID: 'superwagie-fixture', OPENCHAMBER_UNIHUB_REDIRECT_URI: `${origin}/api/platform-account/callback`, OPENCHAMBER_UNIHUB_API_URL: origin, OPENCHAMBER_UNIHUB_CONSOLE_URL: origin, OPENCHAMBER_UNIHUB_DISABLED: '' };
  const runtime = createPlatformAccountRuntime({ env, now: () => clock, ...options });
  const begin = async (who = identity) => {
    const { authorizationUrl } = await runtime.begin(who);
    const ticket = new URL(authorizationUrl).searchParams.get('ticket');
    const result = await runtime.start(ticket);
    pending = new URL(result.url);
    expect(pending.searchParams.get('code_challenge_method')).toBe('S256');
    expect(pending.searchParams.get('scope')).not.toContain('offline_access');
    return { state: pending.searchParams.get('state'), code: 'fixture-code', browser: result.browser, ticket };
  };
  return { runtime, env, begin, tokenRequests: () => tokenRequests, expire: () => { clock += 3_600_001; }, failCredits: () => { failCredits = true; }, badNonce: () => { nonceOverride = 'wrong'; }, badAudience: () => { audienceOverride = 'another-app'; }, badAccessSubject: () => { accessSubject = 'another-user'; } };
};

describe('platform account OIDC and runtime isolation', () => {
  it('runs signed Code+PKCE and keeps platform sessions and tokens isolated', async () => {
    const f = await fixture(); const login = await f.begin();
    await f.runtime.callback(login);
    const state = await f.runtime.publicSession(identity);
    expect(state).toMatchObject({ status: 'signed-in', user: { id: 'actor-a' }, accountId: 'personal-a', credits: { available: '9007199254740993', reserved: '10' } });
    expect(JSON.stringify(state)).not.toMatch(/only-backend-access|must-discard|id_token/);
    expect(await f.runtime.publicSession(secondIdentity)).toEqual({ status: 'signed-out' });
    await f.runtime.selectAccount(identity, 'team-a');
    expect(f.runtime.actor(identity)).toMatchObject({ actingUserId: 'actor-a', billingAccountId: 'team-a' });
    await expect(f.runtime.selectAccount(identity, 'team-b')).rejects.toMatchObject({ code: 'platform_account_forbidden' });
    expect(f.runtime.actor(identity).billingAccountId).toBe('team-a');
    expect(f.runtime.logout(identity)).toEqual({ status: 'signed-out' });
    expect(identity.token).toBe('client:device-a');
    expect(await f.runtime.publicSession(identity)).toEqual({ status: 'signed-out' });
  });
  it('reports model configuration availability from the owning runtime at read time', async () => {
    let available = false;
    const f = await fixture({ isModelAvailable: () => available });
    await f.runtime.callback(await f.begin());
    expect((await f.runtime.publicSession(identity)).modelService).toBe('unavailable');
    available = true;
    expect((await f.runtime.publicSession(identity)).modelService).toBe('available');
  });
  it('consumes tickets and callbacks once and rejects another browser', async () => {
    const f = await fixture(); const login = await f.begin();
    await expect(f.runtime.start(login.ticket)).rejects.toMatchObject({ code: 'platform_login_expired' });
    await expect(f.runtime.callback({ ...login, browser: 'another-browser' })).rejects.toMatchObject({ code: 'platform_login_expired' });
    await expect(f.runtime.callback(login)).rejects.toMatchObject({ code: 'platform_login_expired' });
    expect(f.tokenRequests()).toBe(0);
  });
  it('rejects nonce and audience mismatch after real signature verification', async () => {
    const f = await fixture(); f.badNonce();
    await expect(f.runtime.callback(await f.begin())).rejects.toMatchObject({ code: 'platform_token_invalid' });
    const other = await fixture(); other.badAudience();
    await expect(other.runtime.callback(await other.begin())).rejects.toMatchObject({ code: 'platform_token_invalid' });
  });
  it('rejects validly signed token pairs with different subjects', async () => {
    const f = await fixture(); f.badAccessSubject();
    await expect(f.runtime.callback(await f.begin())).rejects.toMatchObject({ code: 'platform_token_invalid' });
    expect(await f.runtime.publicSession(identity)).toEqual({ status: 'signed-out' });
  });
  it('preserves an explicit team selection before the first summary read', async () => {
    const f = await fixture(); await f.runtime.callback(await f.begin());
    const state = await f.runtime.selectAccount(identity, 'team-a');
    expect(state.accountId).toBe('team-a');
  });
  it('expires in one hour, cancels pending login on logout and reports failed reads', async () => {
    const f = await fixture(); await f.runtime.callback(await f.begin());
    f.failCredits(); await expect(f.runtime.publicSession(identity)).rejects.toMatchObject({ code: 'platform_unavailable' });
    f.expire(); expect(await f.runtime.publicSession(identity)).toEqual({ status: 'expired' });
    const login = await f.begin(); f.runtime.logout(identity);
    await expect(f.runtime.callback(login)).rejects.toMatchObject({ code: 'platform_login_expired' });
  });
  it('does not restore a login after logout during discovery', async () => {
    const f = await fixture(); let release; let entered;
    const gate = new Promise((resolve) => { release = resolve; });
    const reached = new Promise((resolve) => { entered = resolve; });
    const runtime = createPlatformAccountRuntime({ env: f.env, fetchImpl: async (url, init) => {
      const response = await fetch(url, init);
      if (String(url).includes('openid-configuration')) { entered(); await gate; }
      return response;
    } });
    const login = await runtime.begin(identity);
    const pending = runtime.start(new URL(login.authorizationUrl).searchParams.get('ticket'));
    await reached; runtime.logout(identity); release();
    await expect(pending).rejects.toMatchObject({ code: 'platform_login_expired' });
    expect(await runtime.publicSession(identity)).toEqual({ status: 'signed-out' });
  });
  it('fails closed for unsupported runtime, missing auth and unconfigured login', async () => {
    expect(await createPlatformAccountRuntime({ env: {}, isManaged: () => false }).publicSession(identity)).toEqual({ status: 'unsupported' });
    await expect(createPlatformAccountRuntime({ env: {} }).begin(identity)).rejects.toMatchObject({ code: 'platform_unconfigured' });
    const f = await fixture(); await expect(f.runtime.begin(null)).rejects.toMatchObject({ code: 'platform_runtime_auth_required' });
  });
  it('runs HTTP browser bridge without publishing platform credentials and denies unsafe origins', async () => {
    const f = await fixture(); const app = express(); app.use(express.json());
    registerPlatformAccountRoutes(app, { runtime: f.runtime, resolveIdentity: async () => identity, isRequestOriginAllowed: (req) => req.get('origin') === 'http://app.test' });
    const denied = await request(app).post('/api/platform-account/login'); expect(denied.status).toBe(403);
    const login = await request(app).post('/api/platform-account/login').set('Origin', 'http://app.test'); expect(login.status).toBe(200);
    const url = new URL(login.body.authorizationUrl);
    const start = await request(app).get(`${url.pathname}${url.search}`); expect(start.status).toBe(303);
    expect(start.headers['set-cookie'][0]).toMatch(/HttpOnly/); expect(start.headers['set-cookie'][0]).toMatch(/SameSite=Lax/);
    expect(start.headers['referrer-policy']).toBe('no-referrer');
    const invalid = await request(app).get('/api/platform-account/callback?state=bad&code=bad'); expect(invalid.status).toBe(400);
  });
});
