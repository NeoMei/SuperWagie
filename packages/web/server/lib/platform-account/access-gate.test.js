import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createPlatformAccessGate, isBootstrapRequest } from './access-gate.js';

const request = (method, url) => ({ method, url, headers: {} });
const response = () => Object.assign(new EventEmitter(), {
  statusCode: 200,
  status(value) { this.statusCode = value; return this; },
  json(value) { this.body = value; return this; },
  destroy() { this.emit('close'); },
});

describe('UniHub global access gate', () => {
  it('allows only identity and runtime bootstrap routes before user login', () => {
    expect(isBootstrapRequest(request('GET', '/api/platform-account/session'))).toBe(true);
    expect(isBootstrapRequest(request('GET', '/API/platform-account/session'))).toBe(true);
    expect(isBootstrapRequest(request('POST', '/api/platform-account/password-login'))).toBe(true);
    expect(isBootstrapRequest(request('GET', '/api/system/info'))).toBe(true);
    expect(isBootstrapRequest(request('GET', '/api/config/settings'))).toBe(false);
    expect(isBootstrapRequest(request('GET', '/api/platform-account/session/extra'))).toBe(false);
    expect(isBootstrapRequest(request('POST', '/api/platform-account/session'))).toBe(false);
    expect(isBootstrapRequest(request('GET', '/api/client-auth/clients'))).toBe(false);
  });

  it('blocks every business API, including BYOK, before a valid actor exists', async () => {
    const gate = createPlatformAccessGate({ resolveIdentity: async () => ({ type: 'client', token: 'fixture' }), getAccountRuntime: () => ({ actor() { const error = new Error(); error.code = 'platform_session_expired'; throw error; } }) });
    for (const path of ['/api', '/API/provider', '/api/provider', '/api/session/s1/prompt', '/api/fs/raw', '/api/platform-account/commerce']) {
      const res = response(); let reached = false;
      await gate.middleware(request('POST', path), res, () => { reached = true; });
      expect(reached).toBe(false);
      expect(res.statusCode).toBe(401);
      expect(res.body.error).toBe('platform_session_expired');
    }
    gate.dispose();
  });

  it('keeps unconfigured and unsupported states blocked, then permits signed-in BYOK', async () => {
    let runtime = null;
    const gate = createPlatformAccessGate({ resolveIdentity: async () => ({ type: 'session', token: 'fixture' }), getAccountRuntime: () => runtime });
    let reached = 0;
    let res = response();
    await gate.middleware(request('GET', '/api/provider'), res, () => { reached++; });
    expect(res.statusCode).toBe(503);
    runtime = { actor() { const error = new Error(); error.code = 'platform_runtime_unsupported'; throw error; } };
    res = response();
    await gate.middleware(request('GET', '/api/provider'), res, () => { reached++; });
    expect(res.statusCode).toBe(409);
    runtime = { actor() { const error = new Error(); error.code = 'platform_session_changed'; throw error; } };
    res = response();
    await gate.middleware(request('GET', '/api/provider'), res, () => { reached++; });
    expect(res.statusCode).toBe(409);
    runtime = { actor: () => ({ actingUserId: 'actor', expiresAt: Date.now() + 1000 }) };
    await gate.middleware(request('GET', '/api/provider'), response(), () => { reached++; });
    expect(reached).toBe(1);
    gate.dispose();
  });

  it('refuses upgrades and closes accepted sockets when the actor logs out', async () => {
    let signedIn = false;
    const identity = { type: 'client', token: 'fixture' };
    const gate = createPlatformAccessGate({ resolveIdentity: async (_req, _res, options) => { expect(options.allowUrlToken).toBe(true); return identity; }, getAccountRuntime: () => ({ actor(who) { expect(who).toBe(identity); if (!signedIn) { const error = new Error(); error.code = 'platform_session_expired'; throw error; } return { actingUserId: 'actor', expiresAt: Date.now() + 1000 }; } }) });
    const socket = new EventEmitter(); let destroyed = false;
    socket.destroy = () => { destroyed = true; socket.emit('close'); };
    const refusals = [];
    expect(await gate.guardUpgrade(request('GET', '/api/terminal/ws'), socket, (_socket, status) => refusals.push(status))).toBe(false);
    expect(refusals).toEqual([401]);
    signedIn = true;
    expect(await gate.guardUpgrade(request('GET', '/api/terminal/ws'), socket, () => {})).toBe(true);
    signedIn = false;
    gate.validateLive();
    expect(destroyed).toBe(true);
    gate.dispose();
  });

  it('keeps callback exceptions behind both exact routing and service authority', async () => {
    let permitted = false;
    const gate = createPlatformAccessGate({
      resolveIdentity: async () => null,
      getAccountRuntime: () => ({ actor() { const error = new Error(); error.code = 'platform_session_expired'; throw error; } }),
      authorizeServiceRequest: () => permitted,
    });
    let reached = 0;
    await gate.middleware(request('POST', '/api/openchamber/agent-tool'), response(), () => { reached++; });
    expect(reached).toBe(0);
    permitted = true;
    await gate.middleware(request('POST', '/api/openchamber/agent-tool'), response(), () => { reached++; });
    expect(reached).toBe(1);
    await gate.middleware(request('GET', '/api/openchamber/agent-tool'), response(), () => { reached++; });
    await gate.middleware(request('POST', '/api/openchamber/agent-tool/extra'), response(), () => { reached++; });
    await gate.middleware(request('POST', '/api/session/s1/prompt'), response(), () => { reached++; });
    expect(reached).toBe(1);
    gate.dispose();
  });

  it('closes HTTP streams on same-user session replacement and stops tracking finished requests', async () => {
    let expiresAt = Date.now() + 60_000;
    const gate = createPlatformAccessGate({ resolveIdentity: async () => ({ type: 'session', token: 'fixture' }), getAccountRuntime: () => ({ actor: () => ({ actingUserId: 'actor', expiresAt }) }) });
    const stream = response(); let closed = false;
    stream.on('close', () => { closed = true; });
    await gate.middleware(request('GET', '/api/global/event'), stream, () => {});
    gate.validateLive();
    expect(closed).toBe(false);
    expiresAt += 1000;
    gate.validateLive();
    expect(closed).toBe(true);
    const completed = response(); let destroyed = false;
    completed.on('close', () => { destroyed = true; });
    await gate.middleware(request('GET', '/api/provider'), completed, () => {});
    completed.emit('finish');
    expiresAt += 1000;
    gate.validateLive();
    expect(destroyed).toBe(false);
    gate.dispose();
  });
});

describe('explicit instance owner access boundary', () => {
  it('allows the configured issuer and user across devices and denies other users on HTTP and upgrades', async () => {
    const env = { OPENCHAMBER_UNIHUB_INSTANCE_OWNER_ISSUER: 'https://identity.example', OPENCHAMBER_UNIHUB_INSTANCE_OWNER_USER_ID: 'owner' };
    let principal = { issuer: 'https://identity.example', userId: 'owner' };
    const gate = createPlatformAccessGate({ env, resolveIdentity: async () => ({ type: 'client', token: 'device' }), getAccountRuntime: () => ({ actor: () => ({ actingUserId: principal.userId, expiresAt: Date.now() + 60_000 }), instancePrincipal: () => principal }) });
    let calls = 0;
    const stream = response();
    await gate.middleware(request('GET', '/api/session'), stream, () => { calls++; });
    expect(calls).toBe(1);
    const socket = new EventEmitter(); socket.destroy = () => socket.emit('close');
    expect(await gate.guardUpgrade(request('GET', '/api/event'), socket, () => {})).toBe(true);
    principal = { issuer: 'https://identity.example', userId: 'another' };
    const refused = response();
    await gate.middleware(request('GET', '/api/session'), refused, () => { calls++; });
    expect(calls).toBe(1);
    expect(refused.statusCode).toBe(403);
    expect((await gate.authorizeUpgrade(request('GET', '/api/event'))).status).toBe(403);
    let closed = false; socket.on('close', () => { closed = true; });
    gate.validateLive();
    expect(closed).toBe(true);
    gate.dispose();
  });

  it('closes a live response when its configured owner is changed or removed', async () => {
    const env = { OPENCHAMBER_UNIHUB_INSTANCE_OWNER_ISSUER: 'https://identity.example', OPENCHAMBER_UNIHUB_INSTANCE_OWNER_USER_ID: 'owner' };
    const gate = createPlatformAccessGate({ env, resolveIdentity: async () => ({ type: 'session', token: 'device' }), getAccountRuntime: () => ({ actor: () => ({ actingUserId: 'owner', expiresAt: 4_000_000_000_000 }), instancePrincipal: () => ({ issuer: 'https://identity.example', userId: 'owner' }) }) });
    const stream = response(); let closed = false;
    stream.on('close', () => { closed = true; });
    await gate.middleware(request('GET', '/api/event'), stream, () => {});
    env.OPENCHAMBER_UNIHUB_INSTANCE_OWNER_USER_ID = 'other';
    gate.validateLive();
    expect(closed).toBe(true);
    env.OPENCHAMBER_UNIHUB_INSTANCE_OWNER_USER_ID = 'owner';
    const second = response(); let removedClosed = false;
    second.on('close', () => { removedClosed = true; });
    await gate.middleware(request('GET', '/api/event'), second, () => {});
    delete env.OPENCHAMBER_UNIHUB_INSTANCE_OWNER_USER_ID;
    delete env.OPENCHAMBER_UNIHUB_INSTANCE_OWNER_ISSUER;
    gate.validateLive();
    expect(removedClosed).toBe(true);
    gate.dispose();
  });

  it('fails closed for incomplete owner policy and issuer changes', async () => {
    const env = { OPENCHAMBER_UNIHUB_INSTANCE_OWNER_ISSUER: 'https://identity.example' };
    const gate = createPlatformAccessGate({ env, resolveIdentity: async () => ({ type: 'session', token: 'device' }), getAccountRuntime: () => ({ actor: () => ({ actingUserId: 'owner', expiresAt: Date.now() + 60_000 }), instancePrincipal: () => ({ issuer: 'https://other.example', userId: 'owner' }) }) });
    const missing = response();
    await gate.middleware(request('GET', '/api/session'), missing, () => {});
    expect(missing.statusCode).toBe(503);
    env.OPENCHAMBER_UNIHUB_INSTANCE_OWNER_USER_ID = 'owner';
    const wrongIssuer = response();
    await gate.middleware(request('GET', '/api/session'), wrongIssuer, () => {});
    expect(wrongIssuer.statusCode).toBe(403);
    gate.dispose();
  });
});

describe('live platform session scope', () => {
  it('closes streams when the login session or billing account changes without changing expiry', async () => {
    let actor = { actingUserId: 'owner', billingAccountId: 'account-a', authSession: 'session-a', expiresAt: 4_000_000_000_000 };
    const gate = createPlatformAccessGate({ env: {}, resolveIdentity: async () => ({ type: 'session', token: 'client' }), getAccountRuntime: () => ({ actor: () => ({ ...actor }) }) });
    const stream = response(); let streamClosed = false;
    stream.on('close', () => { streamClosed = true; });
    await gate.middleware(request('GET', '/api/event'), stream, () => {});
    actor = { ...actor, authSession: 'session-b' };
    gate.validateLive();
    expect(streamClosed).toBe(true);

    const socket = new EventEmitter(); let socketClosed = false;
    socket.destroy = () => { socketClosed = true; socket.emit('close'); };
    expect(await gate.guardUpgrade(request('GET', '/api/terminal/ws'), socket, () => {})).toBe(true);
    actor = { ...actor, billingAccountId: 'account-b' };
    gate.validateLive();
    expect(socketClosed).toBe(true);
    gate.dispose();
  });
});
