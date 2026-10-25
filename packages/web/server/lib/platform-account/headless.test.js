import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';
import request from 'supertest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { createPlatformAccountRuntime } from './runtime.js';
import { registerPlatformAccountRoutes } from './routes.js';
import { createPlatformProfileRuntime } from './profile.js';

const servers = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => {
    server.closeAllConnections(); server.close(resolve);
  })));
});
const identity = { type: 'client', token: 'headless-device' };
const password = 'SyntheticPassword9!';
const fixture = async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'headless', alg: 'RS256' };
  const app = express(); app.use(express.json());
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); servers.push(server);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const requests = [];
  let authorization; let nonceOverride; let audienceOverride; let stateOverride; let authError;
  let tokenError; let registrationState = 'CREATED'; let registrationError; let accessToken;
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
    res.json({ access_token: accessToken, id_token: idToken, refresh_token: 'must-not-persist', token_type: 'Bearer', scope: 'openid profile email', expires_in: 7200 });
  });
  app.use('/v1', (req, _res, next) => { expect(req.get('Authorization')).toBe(`Bearer ${accessToken}`); next(); });
  app.get('/v1/me', (_req, res) => res.json({ id: 'actor-a', name: 'Alice', email: '' }));
  app.get('/v1/accounts', (_req, res) => res.json([{ id: 'personal-a', kind: 'personal', name: 'Alice', role: 'owner' }, { id: 'team-a', kind: 'team', name: 'Team A', role: 'owner' }]));
  app.get('/v1/accounts/:id/subscriptions', (_req, res) => res.json([]));
  app.get('/v1/accounts/:id/credits', (_req, res) => res.json([]));
  app.get('/v1/capabilities', (_req, res) => res.json({ sandbox: true }));
  const env = { OPENCHAMBER_UNIHUB_ISSUER: origin, OPENCHAMBER_UNIHUB_API_URL: origin, OPENCHAMBER_UNIHUB_HEADLESS_CLIENT_ID: 'superwagie-headless-fixture', OPENCHAMBER_UNIHUB_REDIRECT_URI: `${origin}/api/platform-account/callback`, OPENCHAMBER_UNIHUB_DISABLED: '' };
  const runtime = createPlatformAccountRuntime({ env });
  return { runtime, env, requests, app, badNonce: () => { nonceOverride = 'wrong'; }, badAudience: () => { audienceOverride = 'legacy-client'; }, badState: () => { stateOverride = 'wrong'; }, authError: (status, body) => { authError = { status, body }; }, tokenError: () => { tokenError = true; }, unknownRegistration: () => { registrationState = 'UNKNOWN'; }, registrationError: (error) => { registrationError = error; } };
};

describe('headless platform identity', () => {
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
  it('uses the explicitly configured headless client and keeps credentials in the backend', async () => {
    const f = await fixture();
    expect(f.runtime.authMethods(identity)).toEqual({ passwordLogin: true, registration: true, browserLogin: false });
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
    expect(f.runtime.authMethods(identity)).toEqual({ passwordLogin: false, registration: false, browserLogin: true });
    await expect(f.runtime.passwordLogin(identity, { username: 'alice', password })).rejects.toMatchObject({ code: 'platform_headless_unconfigured' });
    expect(f.requests).toHaveLength(0);
  });
  it('accepts an explicitly registered JSON redirect while retaining the browser callback path', async () => {
    const f = await fixture();
    f.env.OPENCHAMBER_UNIHUB_HEADLESS_REDIRECT_URI = 'http://127.0.0.1:57992/callback';
    expect(f.runtime.authMethods(identity)).toEqual({ passwordLogin: true, registration: true, browserLogin: false });
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
