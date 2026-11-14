import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import { createPlatformAccountRuntime } from '../../packages/web/server/lib/platform-account/runtime.js';
import { startPlatformAccountFixture } from './platform-account-fixture.mjs';

test('loopback fixture completes existing password, PKCE, JWT and account selection contracts', async (t) => {
  const fixture = await startPlatformAccountFixture();
  t.after(fixture.stop);
  assert.equal(new URL(fixture.origin).hostname, '127.0.0.1');
  const runtime = createPlatformAccountRuntime({ env: fixture.env, enterprise: () => false });
  const identity = { type: 'client', token: randomBytes(32).toString('base64url') };
  assert.equal((await runtime.identitySession(identity)).status, 'signed-out');
  await assert.rejects(runtime.passwordLogin(identity, { username: fixture.username, password: 'wrong-password' }), { code: 'invalid_credentials' });
  const session = await runtime.passwordLogin(identity, { username: fixture.username, password: fixture.password });
  assert.equal(session.status, 'signed-in');
  assert.equal(session.user.id, 'local-acceptance-user');
  assert.equal(runtime.instancePrincipal(identity).issuer, fixture.origin);
  const selected = await runtime.selectAccount(identity, fixture.accountId);
  assert.equal(selected.accountId, fixture.accountId);
  assert.equal(selected.credits.available, '0');
  assert.deepEqual(selected.membership, []);
  assert.equal(runtime.actor(identity).billingAccountId, fixture.accountId);
  assert.equal(fixture.counts().tokens, 1);
  assert.equal(runtime.logout(identity).status, 'signed-out');
  assert.equal((await runtime.identitySession(identity)).status, 'signed-out');
});

test('fixture consumes one-time grants and refuses invalid PKCE, unauthenticated reads and model routes', async (t) => {
  const fixture = await startPlatformAccountFixture();
  t.after(fixture.stop);
  const post = (route, body) => fetch(fixture.origin + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await fetch(`${fixture.origin}/v1/me`)).status, 401);
  assert.equal((await post('/platform/v1/chat/completions', {})).status, 401);
  const verifier = randomBytes(32).toString('base64url');
  const body = {
    client_id: fixture.env.OPENCHAMBER_UNIHUB_HEADLESS_CLIENT_ID,
    redirect_uri: fixture.env.OPENCHAMBER_UNIHUB_HEADLESS_REDIRECT_URI,
    scope: 'openid profile email', state: randomBytes(32).toString('base64url'), nonce: randomBytes(32).toString('base64url'),
    code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    username: fixture.username, password: fixture.password,
  };
  const response = await post('/v1/identity/authorize/password', body);
  assert.equal(response.status, 200);
  const grant = await response.json();
  const token = { grant_type: 'authorization_code', authorization_id: grant.authorization_id, client_id: body.client_id, redirect_uri: body.redirect_uri, code: grant.code, code_verifier: randomBytes(32).toString('base64url') };
  assert.equal((await post('/v1/identity/token', token)).status, 400);
  token.code_verifier = verifier;
  assert.equal((await post('/v1/identity/token', token)).status, 400);
  assert.equal(fixture.counts().tokens, 0);
  const wrong = { ...body, redirect_uri: 'https://example.invalid/callback' };
  assert.equal((await post('/v1/identity/authorize/password', wrong)).status, 400);
});

test('fixture isolates two actors and keeps account changes within their verified membership', async (t) => {
  const fixture = await startPlatformAccountFixture();
  t.after(fixture.stop);
  const runtime = createPlatformAccountRuntime({ env: fixture.env, enterprise: () => false });
  const owner = { type: 'client', token: randomBytes(32).toString('base64url') };
  const other = { type: 'client', token: randomBytes(32).toString('base64url') };
  await runtime.passwordLogin(owner, { username: fixture.username, password: fixture.password });
  await runtime.passwordLogin(other, { username: fixture.otherUsername, password: fixture.otherPassword });
  const own = await runtime.selectAccount(owner, fixture.accountId);
  const alternate = await runtime.selectAccount(owner, fixture.alternateAccountId);
  const outsider = await runtime.selectAccount(other, fixture.otherAccountId);
  assert.equal(own.accounts.length, 2);
  assert.equal(alternate.accountId, fixture.alternateAccountId);
  assert.equal(outsider.accounts.length, 1);
  assert.equal(runtime.actor(owner).actingUserId, 'local-acceptance-user');
  assert.equal(runtime.actor(other).actingUserId, 'local-acceptance-outsider');
  assert.equal(runtime.instancePrincipal(owner).issuer, runtime.instancePrincipal(other).issuer);
  await assert.rejects(runtime.selectAccount(other, fixture.accountId), { code: 'platform_account_forbidden' });
  await assert.rejects(runtime.selectAccount(owner, fixture.otherAccountId), { code: 'platform_account_forbidden' });
  runtime.logout(owner);
  assert.equal((await runtime.identitySession(owner)).status, 'signed-out');
  assert.equal((await runtime.identitySession(other)).status, 'signed-in');
});
