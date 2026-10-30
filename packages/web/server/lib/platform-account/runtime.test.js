import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { createPlatformAccountRuntime } from './runtime.js';
import { createPlatformAccessGate } from './access-gate.js';
import { registerPlatformAccountRoutes } from './routes.js';

const servers = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }))); });
const identity = { type: 'client', token: 'client:device-a' };
const secondIdentity = { type: 'client', token: 'client:device-b' };
const fixture = async (options = {}) => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'fixture', alg: 'RS256' };
  const app = express(); app.use(express.urlencoded({ extended: false })); app.use(express.json({ verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); } }));
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
  const env = { OPENCHAMBER_UNIHUB_ISSUER: origin, OPENCHAMBER_UNIHUB_CLIENT_ID: 'superwagie-fixture', OPENCHAMBER_UNIHUB_REDIRECT_URI: `${origin}/api/platform-account/callback`, OPENCHAMBER_UNIHUB_API_URL: origin, OPENCHAMBER_UNIHUB_CONSOLE_URL: origin };
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
  return { app, runtime, env, begin, tokenRequests: () => tokenRequests, expire: () => { clock += 3_600_001; }, failCredits: () => { failCredits = true; }, badNonce: () => { nonceOverride = 'wrong'; }, badAudience: () => { audienceOverride = 'another-app'; }, badAccessSubject: () => { accessSubject = 'another-user'; } };
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
    expect(f.runtime.instancePrincipal(identity)).toEqual({ issuer: f.env.OPENCHAMBER_UNIHUB_ISSUER, userId: 'actor-a' });
    await expect(f.runtime.selectAccount(identity, 'team-b')).rejects.toMatchObject({ code: 'platform_account_forbidden' });
    expect(f.runtime.actor(identity).billingAccountId).toBe('team-a');
    expect(f.runtime.logout(identity)).toEqual({ status: 'signed-out' });
    expect(identity.token).toBe('client:device-a');
    expect(await f.runtime.publicSession(identity)).toEqual({ status: 'signed-out' });
  });
  it('enforces instance ownership using the verified login issuer and user', async () => {
    const f = await fixture();
    await f.runtime.callback(await f.begin());
    const env = { OPENCHAMBER_UNIHUB_INSTANCE_OWNER_ISSUER: f.env.OPENCHAMBER_UNIHUB_ISSUER, OPENCHAMBER_UNIHUB_INSTANCE_OWNER_USER_ID: 'actor-a' };
    const gate = createPlatformAccessGate({ env, resolveIdentity: async () => identity, getAccountRuntime: () => f.runtime });
    const app = express();
    app.use(gate.middleware);
    app.get('/api/session', (_req, res) => res.json({ title: 'private fixture' }));
    expect((await request(app).get('/api/session')).status).toBe(200);
    env.OPENCHAMBER_UNIHUB_INSTANCE_OWNER_USER_ID = 'actor-b';
    const denied = await request(app).get('/api/session');
    expect(denied.status).toBe(403);
    expect(JSON.stringify(denied.body)).not.toContain('private fixture');
    gate.dispose();
  });
  it('reports model configuration availability from the owning runtime at read time', async () => {
    let available = false;
    let historyAvailable = true;
    const f = await fixture({ isModelAvailable: () => available, isModelHistoryAvailable: () => historyAvailable });
    await f.runtime.callback(await f.begin());
    expect(await f.runtime.publicSession(identity)).toMatchObject({ modelService: 'unavailable', modelRecoveryAvailable: true });
    available = true;
    expect((await f.runtime.publicSession(identity)).modelService).toBe('available');
    historyAvailable = false;
    expect((await f.runtime.publicSession(identity)).modelRecoveryAvailable).toBe(false);
  });
  it('restores an encrypted session and account selection after a runtime restart', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'superwagie-platform-session-'));
    try {
      const f = await fixture({ dataDir });
      await f.runtime.callback(await f.begin());
      await f.runtime.selectAccount(identity, 'team-a');
      const storePath = path.join(dataDir, 'platform-account-sessions.json');
      const stored = await fs.readFile(storePath, 'utf8');
      expect(stored).not.toContain('fixture-user');
      expect(stored).not.toContain('must-discard');
      if (process.platform !== 'win32') expect((await fs.stat(storePath)).mode & 0o777).toBe(0o600);
      const restarted = createPlatformAccountRuntime({ env: f.env, now: Date.now, dataDir });
      expect(await restarted.identitySession(identity)).toMatchObject({ status: 'signed-in', user: { id: 'actor-a' } });
      expect((await restarted.publicSession(identity)).accountId).toBe('team-a');
      expect(restarted.logout(identity)).toEqual({ status: 'signed-out' });
      expect(await restarted.publicSession(identity)).toEqual({ status: 'signed-out' });
      expect(JSON.parse(await fs.readFile(storePath, 'utf8')).sessions).toEqual({});
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
  it('removes a persisted session when its UniHub configuration changes', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'superwagie-platform-session-config-'));
    try {
      const f = await fixture({ dataDir });
      await f.runtime.callback(await f.begin());
      f.env.OPENCHAMBER_UNIHUB_CLIENT_ID = 'changed-client';
      await expect(f.runtime.publicSession(identity)).rejects.toMatchObject({ code: 'platform_session_changed' });
      expect(JSON.parse(await fs.readFile(path.join(dataDir, 'platform-account-sessions.json'), 'utf8')).sessions).toEqual({});
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
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

describe('platform account managed knowledge authority', () => {
  const routePin = 'a'.repeat(64);
  const routeGeneration = 'b'.repeat(64);
  const taskId = 'sw-task-20261030';
  const callId = `wk_${'c'.repeat(60)}`;
  const addKnowledgeRoutes = (f, { receiptMutation = (value) => value, routeMutation = (value) => value, duplicateReceiptField = false, duplicateReceiptHeader = false, grantStatus = 201, routeStatus = 200, dispatchStatus = 200, dispatchRedirect = false, resultModel = 'qwen3-rerank', resultWire = 'rerank.create', waitForRoute = null } = {}) => {
    const origin = new URL(f.env.OPENCHAMBER_UNIHUB_API_URL).origin;
    f.env.OPENCHAMBER_UNIHUB_GATEWAY_URL = `${origin}/platform/v1`;
    const grants = [];
    let dispatchCount = 0; let escapeHits = 0; const dispatchRequests = [];
    let credentialCounter = 0;
    f.app.post('/v1/accounts/:account/model-credentials', (req, res) => {
      expect(req.headers.authorization).toMatch(/^Bearer /);
      expect(req.body).toEqual({ origin_product_id: 'superwagie', models: [req.body.models[0]], task_id: taskId });
      const model = req.body.models[0];
      const id = `credential-${++credentialCounter}`;
      const grant = { funding_mode: 'credits', asset: 'CREDIT/6', billing_profile_version: 1, id, audience: 'llmrouter', actor_id: 'actor-a', account_id: req.params.account, origin_product_id: 'superwagie', models: [model], task_id: taskId, expires_at: new Date(Date.now() + 600_000).toISOString(), token: `uh_model_${id}` };
      grants.push(grant); res.status(grantStatus).json(grant);
    });
    const routeFor = (req, purpose = null) => {
      const model = req.body.model;
      const wireOperation = req.body.wire_operation;
      const pair = model === 'unihub-text-embedding-v4' ? 'embeddings.create' : 'rerank.create';
      if (purpose === 'index_read') return { version: 1, purpose, issuer: 'llmrouter-knowledge-v1', audience: 'superwagie', origin_product_id: 'superwagie', instance_id: 'default', actor_id: 'actor-a', account_id: req.body.account_id, access_version: 1, model, wire_operation: wireOperation, policy_digest: req.body.policy_digest, route_generation: routeGeneration, ...(pair === 'embeddings.create' ? { embedding_space: { provider: 'aliyun', model: 'text-embedding-v4', version: 'v4', dimensions: 1024, input_semantics: 'text' } } : {}), issued_at: Math.floor(Date.now() / 1000) - 1, expires_at: Math.floor(Date.now() / 1000) + 20 };
      const taskGrant = grants.find((grant) => grant.token === req.headers.authorization?.slice(7));
      return { version: 1, issuer: 'llmrouter-knowledge-v1', audience: 'superwagie', origin_product_id: 'superwagie', instance_id: 'default', actor_id: 'actor-a', account_id: taskGrant.account_id, task_id: taskId, authorized_credential_id: taskGrant.id, model, wire_operation: wireOperation, policy_digest: routePin, route_generation: routeGeneration, ...(pair === 'embeddings.create' ? { embedding_space: { provider: 'aliyun', model: 'text-embedding-v4', version: 'v4', dimensions: 1024, input_semantics: 'text' } } : {}), issued_at: Math.floor(Date.now() / 1000) - 1, expires_at: Math.floor(Date.now() / 1000) + 30 };
    };
    let routeStartedResolve;
    const routeStarted = new Promise((resolve) => { routeStartedResolve = resolve; });
    f.app.post('/platform/v1/knowledge/route', async (req, res) => {
      routeStartedResolve();
      if (waitForRoute) await waitForRoute;
      if (req.body.purpose === 'index_read') {
        expect(req.headers.authorization).toMatch(/^Bearer /);
        for (const header of ['x-unihub-task-id', 'x-unihub-actor-authorization', 'x-unihub-knowledge-policy', 'idempotency-key', 'x-call-id']) expect(req.headers[header]).toBeUndefined();
        res.set('Cache-Control', 'private, no-store').status(routeStatus); return res.json(routeMutation(routeFor(req, 'index_read')));
      }
      expect(req.headers.authorization).toMatch(/^Bearer uh_model_/);
      expect(req.headers['x-unihub-actor-authorization']).toMatch(/^Bearer /);
      expect(req.headers['x-unihub-task-id']).toBe(taskId);
      expect(req.body).toHaveProperty('model');
      res.set('Cache-Control', 'private, no-store').status(routeStatus); return res.json(routeMutation(routeFor(req)));
    });
    f.app.post('/escape', (_req, res) => { escapeHits += 1; res.status(200).end(); });
    f.app.post('/platform/v1/embeddings', (req, res) => {
      dispatchCount += 1; dispatchRequests.push({ path: req.path, body: req.rawBody });
      expect(req.headers.authorization).toMatch(/^Bearer uh_model_/);
      expect(req.headers['x-unihub-actor-authorization']).toMatch(/^Bearer /);
      expect(req.headers['x-unihub-task-id']).toBe(taskId);
      expect(req.headers['x-unihub-knowledge-policy']).toBe(routePin);
      if (dispatchRedirect) return res.redirect(302, `${origin}/escape`);
      res.status(dispatchStatus).end();
    });
    f.app.post('/platform/api/v1/services/rerank/text-rerank/text-rerank', (req, res) => {
      dispatchCount += 1; dispatchRequests.push({ path: req.path, body: req.rawBody });
      expect(req.headers.authorization).toMatch(/^Bearer uh_model_/);
      expect(req.headers['x-unihub-actor-authorization']).toMatch(/^Bearer /);
      expect(req.headers['x-unihub-task-id']).toBe(taskId);
      expect(req.headers['x-unihub-knowledge-policy']).toBe(routePin);
      res.status(dispatchStatus).end();
    });
    f.app.post('/platform/v1/knowledge/results/:callId', (req, res) => {
      expect(req.headers.authorization).toMatch(/^Bearer uh_model_/);
      expect(req.headers['x-unihub-actor-authorization']).toMatch(/^Bearer /);
      expect(req.headers['x-unihub-task-id']).toBe(taskId);
      const reader = grants.find((grant) => grant.token === req.headers.authorization.slice(7));
      const isEmbedding = resultModel === 'unihub-text-embedding-v4';
      const body = Buffer.from(isEmbedding ? '{"object":"list","model":"text-embedding-v4","data":[{"index":0,"embedding":[0.1]}]}' : '{"results":[{"index":0,"relevance_score":0.9}],"usage":{"total_tokens":3}}');
      const receipt = receiptMutation({ version: 1, issuer: 'llmrouter-knowledge-v1', audience: 'superwagie', origin_product_id: 'superwagie', instance_id: 'default', actor_id: 'actor-a', account_id: reader.account_id, task_id: taskId, call_id: req.params.callId, attempt_id: 1, status: 'SETTLED', producer_credential_id: 'historical-producer', authorized_credential_id: reader.id, model: resultModel, wire_operation: resultWire, policy_digest: routePin, route_generation: routeGeneration, ...(isEmbedding ? { embedding_space: { provider: 'aliyun', model: 'text-embedding-v4', version: 'v4', dimensions: 1024, input_semantics: 'text' } } : {}), content_sha256: crypto.createHash('sha256').update(body).digest('hex'), issued_at: Math.floor(Date.now() / 1000) - 1, expires_at: Math.floor(Date.now() / 1000) + 20 });
      const orderedFields = ['version', 'issuer', 'audience', 'origin_product_id', 'instance_id', 'actor_id', 'account_id', 'task_id', 'call_id', 'attempt_id', 'status', 'producer_credential_id', 'authorized_credential_id', 'model', 'wire_operation', 'policy_digest', 'route_generation', ...(isEmbedding ? ['embedding_space'] : []), 'content_sha256', 'issued_at', 'expires_at'];
      const ordered = Object.fromEntries([...orderedFields, ...Object.keys(receipt).filter((key) => !orderedFields.includes(key))].map((key) => [key, receipt[key]]));
      let receiptJson = JSON.stringify(ordered);
      if (duplicateReceiptField) receiptJson = `${receiptJson.slice(0, -1)},"version":1}`;
      res.set('Content-Type', 'application/json'); res.set('Cache-Control', 'private, no-store'); res.set('X-UniHub-Knowledge-Receipt', Buffer.from(receiptJson).toString('base64url'));
      if (duplicateReceiptHeader) res.append('X-UniHub-Knowledge-Receipt', Buffer.from(receiptJson).toString('base64url'));
      res.status(200).end(body);
    });
    return { grants, routeStarted, dispatchCount: () => dispatchCount, dispatchRequests: () => dispatchRequests, escapeHits: () => escapeHits };
  };
  it('uses distinct paid and index-read authority and verifies result bytes from one loopback response', async () => {
    const f = await fixture(); await f.runtime.callback(await f.begin()); const { grants, dispatchRequests } = addKnowledgeRoutes(f); await f.runtime.selectAccount(identity, 'personal-a');
    const preflight = await f.runtime.preflightKnowledgeRoute(identity, { taskId, model: 'unihub-text-embedding-v4', wireOperation: 'embeddings.create' });
    expect(preflight).toMatchObject({ actorId: 'actor-a', accountId: 'personal-a', policyDigest: routePin, routeGeneration });
    expect(JSON.stringify(preflight)).not.toContain('uh_model_');
    await f.runtime.readCurrentKnowledgeRoute(identity, { accountId: 'personal-a', model: 'unihub-text-embedding-v4', wireOperation: 'embeddings.create', expectedPolicyDigest: routePin });
    const body = Buffer.from('{"model":"unihub-text-embedding-v4","input":["a"],"dimensions":1024}');
    await f.runtime.dispatchKnowledgeEmbeddingPinned(identity, { taskId, callId, model: 'unihub-text-embedding-v4', policyDigest: routePin, body });
    const rerankBody = Buffer.from('{"model":"qwen3-rerank","input":{"query":"query","documents":["candidate"]},"parameters":{"top_n":1,"return_documents":false}}');
    await f.runtime.dispatchKnowledgeRerankPinned(identity, { taskId, callId: `wk_${'d'.repeat(60)}`, model: 'qwen3-rerank', policyDigest: routePin, body: rerankBody });
    expect(dispatchRequests().map(({ path, body: requestBody }) => [path, requestBody.toString('utf8')])).toEqual([
      ['/platform/v1/embeddings', body.toString('utf8')],
      ['/platform/api/v1/services/rerank/text-rerank/text-rerank', rerankBody.toString('utf8')],
    ]);
    const evidence = await f.runtime.readKnowledgeResultWithEvidence(identity, { taskId, callId, model: 'qwen3-rerank', wireOperation: 'rerank.create' });
    expect(evidence.rawBytes.toString('utf8')).toBe('{"results":[{"index":0,"relevance_score":0.9}],"usage":{"total_tokens":3}}');
    expect(evidence.receipt).toMatchObject({ producerCredentialId: 'historical-producer', authorizedCredentialId: grants.at(-1).id, status: 'SETTLED', policyDigest: routePin });
    expect(evidence.receipt.producerCredentialId).not.toBe(evidence.receipt.authorizedCredentialId);
  });
  it('rejects unapproved embedding fields and flat rerank bodies for the native endpoint', async () => {
    const f = await fixture(); await f.runtime.callback(await f.begin());
    const { dispatchCount, dispatchRequests } = addKnowledgeRoutes(f); await f.runtime.selectAccount(identity, 'personal-a');
    for (const body of [
      Buffer.from('{"model":"unihub-text-embedding-v4","input":["a"],"dimensions":512,"dimensions":1024}'),
      Buffer.from('{"model":"unihub-text-embedding-v4","input":["a"],"dimensions":1024,"encoding_format":"base64"}'),
    ]) {
      await expect(f.runtime.dispatchKnowledgeEmbeddingPinned(identity, { taskId, callId, model: 'unihub-text-embedding-v4', policyDigest: routePin, body })).rejects.toMatchObject({ code: 'platform_knowledge_request_invalid' });
    }
    await expect(f.runtime.dispatchKnowledgeRerankPinned(identity, { taskId, callId, model: 'qwen3-rerank', policyDigest: routePin, body: Buffer.from('{"model":"qwen3-rerank","query":"q","documents":["a"],"top_n":1,"return_documents":false}') })).rejects.toMatchObject({ code: 'platform_knowledge_request_invalid' });
    const floatBody = Buffer.from('{"model":"unihub-text-embedding-v4","input":["a"],"dimensions":1024,"encoding_format":"float"}');
    await f.runtime.dispatchKnowledgeEmbeddingPinned(identity, { taskId, callId, model: 'unihub-text-embedding-v4', policyDigest: routePin, body: floatBody });
    expect(dispatchCount()).toBe(1);
    expect(dispatchRequests()[0].body.toString('utf8')).toBe(floatBody.toString('utf8'));
  });
  it('rejects receipt body drift and duplicate receipt fields', async () => {
    const drift = await fixture(); await drift.runtime.callback(await drift.begin());
    addKnowledgeRoutes(drift, { receiptMutation: (receipt) => ({ ...receipt, content_sha256: 'd'.repeat(64) }) }); await drift.runtime.selectAccount(identity, 'personal-a');
    await expect(drift.runtime.readKnowledgeResultWithEvidence(identity, { taskId, callId, model: 'qwen3-rerank', wireOperation: 'rerank.create' })).rejects.toMatchObject({ code: 'platform_knowledge_result_unavailable' });
    const duplicate = await fixture(); await duplicate.runtime.callback(await duplicate.begin());
    addKnowledgeRoutes(duplicate, { duplicateReceiptField: true }); await duplicate.runtime.selectAccount(identity, 'personal-a');
    await expect(duplicate.runtime.readKnowledgeResultWithEvidence(identity, { taskId, callId, model: 'qwen3-rerank', wireOperation: 'rerank.create' })).rejects.toMatchObject({ code: 'platform_knowledge_result_unavailable' });
    const duplicateHeader = await fixture(); await duplicateHeader.runtime.callback(await duplicateHeader.begin());
    addKnowledgeRoutes(duplicateHeader, { duplicateReceiptHeader: true }); await duplicateHeader.runtime.selectAccount(identity, 'personal-a');
    await expect(duplicateHeader.runtime.readKnowledgeResultWithEvidence(identity, { taskId, callId, model: 'qwen3-rerank', wireOperation: 'rerank.create' })).rejects.toMatchObject({ code: 'platform_knowledge_result_unavailable' });
  });
  it('rejects receipt schema, actor, account, task, reader, route, model, wire, status and expiry mismatches', async () => {
    const mutations = [
      (receipt) => ({ ...receipt, extra: 'unknown' }),
      (receipt) => ({ ...receipt, actor_id: 'other-actor' }),
      (receipt) => ({ ...receipt, account_id: 'other-account' }),
      (receipt) => ({ ...receipt, task_id: 'other-task' }),
      (receipt) => ({ ...receipt, authorized_credential_id: 'another-reader' }),
      (receipt) => ({ ...receipt, model: 'other-model' }),
      (receipt) => ({ ...receipt, wire_operation: 'embeddings.create' }),
      (receipt) => ({ ...receipt, status: 'UNKNOWN' }),
      (receipt) => ({ ...receipt, issued_at: Math.floor(Date.now() / 1000) - 30, expires_at: Math.floor(Date.now() / 1000) - 1 }),
    ];
    for (const receiptMutation of mutations) {
      const f = await fixture(); await f.runtime.callback(await f.begin());
      addKnowledgeRoutes(f, { receiptMutation }); await f.runtime.selectAccount(identity, 'personal-a');
      await expect(f.runtime.readKnowledgeResultWithEvidence(identity, { taskId, callId, model: 'qwen3-rerank', wireOperation: 'rerank.create' })).rejects.toMatchObject({ code: 'platform_knowledge_result_unavailable' });
    }
    const wrongSpace = await fixture(); await wrongSpace.runtime.callback(await wrongSpace.begin());
    addKnowledgeRoutes(wrongSpace, { resultModel: 'unihub-text-embedding-v4', resultWire: 'embeddings.create', receiptMutation: (receipt) => ({ ...receipt, embedding_space: { ...receipt.embedding_space, dimensions: 512 } }) }); await wrongSpace.runtime.selectAccount(identity, 'personal-a');
    await expect(wrongSpace.runtime.readKnowledgeResultWithEvidence(identity, { taskId, callId, model: 'unihub-text-embedding-v4', wireOperation: 'embeddings.create' })).rejects.toMatchObject({ code: 'platform_knowledge_result_unavailable' });
  });
  it('reports the historical receipt pin without treating it as current route authority', async () => {
    const historicalPin = 'e'.repeat(64); const historicalGeneration = 'f'.repeat(64);
    const f = await fixture(); await f.runtime.callback(await f.begin());
    addKnowledgeRoutes(f, { receiptMutation: (receipt) => ({ ...receipt, policy_digest: historicalPin, route_generation: historicalGeneration }) }); await f.runtime.selectAccount(identity, 'personal-a');
    const evidence = await f.runtime.readKnowledgeResultWithEvidence(identity, { taskId, callId, model: 'qwen3-rerank', wireOperation: 'rerank.create' });
    expect(evidence.receipt).toMatchObject({ policyDigest: historicalPin, routeGeneration: historicalGeneration });
  });
  it('keeps the upstream access version separate from the local account-switch version', async () => {
    for (const version of [-1, 0, 77]) {
      const current = await fixture(); await current.runtime.callback(await current.begin());
      addKnowledgeRoutes(current, { routeMutation: (route) => ({ ...route, access_version: version }) }); await current.runtime.selectAccount(identity, 'personal-a');
      const read = current.runtime.readCurrentKnowledgeRoute(identity, { accountId: 'personal-a', model: 'unihub-text-embedding-v4', wireOperation: 'embeddings.create', expectedPolicyDigest: routePin });
      if (version < 0) await expect(read).rejects.toMatchObject({ code: 'platform_knowledge_route_unavailable' });
      else expect((await read).accessVersion).toBe(version);
    }
  });
  it('rejects a stale route pin and responses that race account change or logout', async () => {
    const stale = await fixture(); await stale.runtime.callback(await stale.begin());
    addKnowledgeRoutes(stale, { routeMutation: (route) => ({ ...route, policy_digest: 'd'.repeat(64) }) }); await stale.runtime.selectAccount(identity, 'personal-a');
    await expect(stale.runtime.readCurrentKnowledgeRoute(identity, { accountId: 'personal-a', model: 'unihub-text-embedding-v4', wireOperation: 'embeddings.create', expectedPolicyDigest: routePin })).rejects.toMatchObject({ code: 'platform_knowledge_route_unavailable' });

    const switching = await fixture(); await switching.runtime.callback(await switching.begin());
    let releaseRoute; const waitForRoute = new Promise((resolve) => { releaseRoute = resolve; });
    const { routeStarted } = addKnowledgeRoutes(switching, { waitForRoute }); await switching.runtime.selectAccount(identity, 'personal-a');
    const pending = switching.runtime.preflightKnowledgeRoute(identity, { taskId, model: 'unihub-text-embedding-v4', wireOperation: 'embeddings.create' });
    await routeStarted;
    await switching.runtime.selectAccount(identity, 'team-a'); releaseRoute();
    await expect(pending).rejects.toMatchObject({ code: 'platform_session_changed' });

    const loggingOut = await fixture(); await loggingOut.runtime.callback(await loggingOut.begin());
    let releaseLogoutRoute; const waitForLogoutRoute = new Promise((resolve) => { releaseLogoutRoute = resolve; });
    const logoutRoutes = addKnowledgeRoutes(loggingOut, { waitForRoute: waitForLogoutRoute }); await loggingOut.runtime.selectAccount(identity, 'personal-a');
    const pendingLogout = loggingOut.runtime.preflightKnowledgeRoute(identity, { taskId, model: 'unihub-text-embedding-v4', wireOperation: 'embeddings.create' });
    await logoutRoutes.routeStarted; loggingOut.runtime.logout(identity); releaseLogoutRoute();
    await expect(pendingLogout).rejects.toMatchObject({ code: 'platform_session_changed' });
  });
  it('blocks request DTO confusion, unapproved upstream URLs, redirects and upstream failures', async () => {
    const f = await fixture(); await f.runtime.callback(await f.begin()); const { grants } = addKnowledgeRoutes(f); await f.runtime.selectAccount(identity, 'personal-a');
    await expect(f.runtime.preflightKnowledgeRoute(identity, { taskId, model: 'unihub-text-embedding-v4', wireOperation: 'embeddings.create', actorId: 'spoofed' })).rejects.toMatchObject({ code: 'platform_knowledge_request_invalid' });
    await expect(f.runtime.readCurrentKnowledgeRoute(identity, { accountId: 'personal-a', model: 'unihub-text-embedding-v4', wireOperation: 'embeddings.create', expectedPolicyDigest: routePin, taskId })).rejects.toMatchObject({ code: 'platform_knowledge_request_invalid' });
    await expect(f.runtime.dispatchKnowledgeEmbeddingPinned(identity, { taskId, callId, model: 'unihub-text-embedding-v4', policyDigest: routePin, body: Buffer.from('{"model":"unihub-text-embedding-v4","input":"ok","dimensions":1024,"encoding_format":"float"}'), headers: { Authorization: 'Bearer arbitrary' } })).rejects.toMatchObject({ code: 'platform_knowledge_request_invalid' });
    f.env.OPENCHAMBER_UNIHUB_GATEWAY_URL = `${new URL(f.env.OPENCHAMBER_UNIHUB_API_URL).origin}/redirect/platform/v1`;
    await expect(f.runtime.preflightKnowledgeRoute(identity, { taskId, model: 'unihub-text-embedding-v4', wireOperation: 'embeddings.create' })).rejects.toMatchObject({ code: 'platform_knowledge_request_unavailable' });
    f.env.OPENCHAMBER_UNIHUB_GATEWAY_URL = `${new URL(f.env.OPENCHAMBER_UNIHUB_API_URL).origin}/platform/v1`;
    expect(grants).toHaveLength(0);

    const redirect = await fixture(); await redirect.runtime.callback(await redirect.begin());
    const escaped = addKnowledgeRoutes(redirect, { dispatchRedirect: true }); await redirect.runtime.selectAccount(identity, 'personal-a');
    await expect(redirect.runtime.dispatchKnowledgeEmbeddingPinned(identity, { taskId, callId, model: 'unihub-text-embedding-v4', policyDigest: routePin, body: Buffer.from('{"model":"unihub-text-embedding-v4","input":"ok","dimensions":1024,"encoding_format":"float"}') })).rejects.toMatchObject({ code: 'platform_knowledge_outcome_unknown' });
    expect(escaped.escapeHits()).toBe(0);

    const unknown = await fixture(); await unknown.runtime.callback(await unknown.begin());
    const unknownCall = addKnowledgeRoutes(unknown, { dispatchStatus: 503 }); await unknown.runtime.selectAccount(identity, 'personal-a');
    await expect(unknown.runtime.dispatchKnowledgeEmbeddingPinned(identity, { taskId, callId, model: 'unihub-text-embedding-v4', policyDigest: routePin, body: Buffer.from('{"model":"unihub-text-embedding-v4","input":"ok","dimensions":1024,"encoding_format":"float"}') })).rejects.toMatchObject({ code: 'platform_knowledge_outcome_unknown' });
    expect(unknownCall.dispatchCount()).toBe(1);
  });
  it('preserves original commerce capture while adding knowledge methods', async () => {
    const f = await fixture(); await f.runtime.callback(await f.begin());
    await f.runtime.selectAccount(identity, 'personal-a');
    const commerce = f.runtime.captureCommerceSession(identity);
    expect(commerce).toMatchObject({ actingUserId: 'actor-a', billingAccountId: 'personal-a' });
    expect(typeof commerce.request).toBe('function');
  });
  it('does not globally sign out on an opaque model-grant 401', async () => {
    const f = await fixture(); await f.runtime.callback(await f.begin());
    addKnowledgeRoutes(f, { grantStatus: 401 }); await f.runtime.selectAccount(identity, 'personal-a');
    await expect(f.runtime.preflightKnowledgeRoute(identity, { taskId, model: 'unihub-text-embedding-v4', wireOperation: 'embeddings.create' })).rejects.toMatchObject({ status: 401 });
    expect(await f.runtime.publicSession(identity)).toMatchObject({ status: 'signed-in', user: { id: 'actor-a' } });
  });
  it('keeps managed knowledge calls behind the enterprise boundary', async () => {
    const f = await fixture({ enterprise: () => true }); await f.runtime.callback(await f.begin());
    const { grants } = addKnowledgeRoutes(f); f.env.OPENCHAMBER_UNIHUB_GATEWAY_URL = 'https://llmrouter.test/platform/v1'; await f.runtime.selectAccount(identity, 'personal-a');
    await expect(f.runtime.preflightKnowledgeRoute(identity, { taskId, model: 'unihub-text-embedding-v4', wireOperation: 'embeddings.create' })).rejects.toMatchObject({ code: 'enterprise_mode' });
    expect(grants).toHaveLength(0);
  });
});
