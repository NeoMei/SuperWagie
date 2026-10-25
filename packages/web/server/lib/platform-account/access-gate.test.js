import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createPlatformAccessGate, isBootstrapRequest, isCapabilityReadRequest } from './access-gate.js';

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
    expect(isBootstrapRequest(request('POST', '/api/platform-account/password-login'))).toBe(true);
    expect(isBootstrapRequest(request('GET', '/api/system/info'))).toBe(true);
    expect(isBootstrapRequest(request('GET', '/api/config/settings'))).toBe(false);
    expect(isBootstrapRequest(request('GET', '/api/platform-account/session/extra'))).toBe(false);
    expect(isBootstrapRequest(request('POST', '/api/platform-account/session'))).toBe(false);
    expect(isBootstrapRequest(request('GET', '/api/client-auth/clients'))).toBe(false);
    expect(isCapabilityReadRequest(request('GET', '/api/fs/preview/grant-1/workspace/index.html'))).toBe(true);
    expect(isCapabilityReadRequest(request('GET', '/api/guest-files/grant-1/main.js'))).toBe(true);
    expect(isCapabilityReadRequest(request('GET', '/api/guests/frame-test/oauth/callback'))).toBe(true);
    expect(isCapabilityReadRequest(request('POST', '/api/fs/preview/grant-1/workspace/index.html'))).toBe(false);
    expect(isCapabilityReadRequest(request('GET', '/api/fs/raw'))).toBe(false);
    expect(isCapabilityReadRequest(request('GET', '/api/guests/frame-test/request'))).toBe(false);
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
