import { describe, expect, it } from 'vitest';
import { createPlatformAccountRuntime, PUBLIC_UNIHUB_DEFAULTS } from './runtime.js';

const identity = { type: 'client', token: 'configuration-test-device' };

describe('public UniHub identity configuration', () => {
  it('enables JSON identity with the registered public client and leaves browser OIDC disabled', async () => {
    const requests = [];
    const runtime = createPlatformAccountRuntime({
      env: {}, usePublicDefaults: true,
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(init.body) });
        return Response.json({ registration_id: 'registered-user', status: 'CREATED' });
      },
    });
    expect(runtime.authMethods(identity)).toEqual({ passwordLogin: true, registration: true, browserLogin: false });
    expect(await runtime.identitySession(identity)).toEqual({ status: 'signed-out' });
    await runtime.register(identity, { username: 'public-user', idempotencyKey: 'public-default-key' });
    expect(requests).toEqual([{ url: `${PUBLIC_UNIHUB_DEFAULTS.apiUrl}/v1/identity/registrations`, body: { client_id: PUBLIC_UNIHUB_DEFAULTS.headlessClientId, username: 'public-user' } }]);
    expect(PUBLIC_UNIHUB_DEFAULTS.headlessRedirectUri).toBe('http://127.0.0.1:57991/api/platform-account/callback');
    await expect(runtime.begin(identity)).rejects.toMatchObject({ code: 'platform_unconfigured' });
  });

  it('uses complete environment overrides and never sends an OIDC client secret', async () => {
    let request;
    const runtime = createPlatformAccountRuntime({
      env: { OPENCHAMBER_UNIHUB_ISSUER: 'https://identity.example.test', OPENCHAMBER_UNIHUB_API_URL: 'https://api.example.test', OPENCHAMBER_UNIHUB_HEADLESS_CLIENT_ID: 'private-deployment-public-client', OPENCHAMBER_UNIHUB_HEADLESS_REDIRECT_URI: 'http://127.0.0.1:3100/callback' },
      usePublicDefaults: true,
      fetchImpl: async (url, init) => {
        request = { url: String(url), body: JSON.parse(init.body) };
        return Response.json({ registration_id: 'registered-user', status: 'CREATED' });
      },
    });
    await runtime.register(identity, { username: 'override-user', idempotencyKey: 'override-key' });
    expect(request).toEqual({ url: 'https://api.example.test/v1/identity/registrations', body: { client_id: 'private-deployment-public-client', username: 'override-user' } });
  });

  it.each([{ OPENCHAMBER_UNIHUB_DISABLED: '1' }, { OPENCHAMBER_UNIHUB_MODE: 'off' }])('fails closed when explicitly disabled through %j', async (env) => {
    const runtime = createPlatformAccountRuntime({ env, usePublicDefaults: true, fetchImpl: () => { throw new Error('disabled identity must not make requests'); } });
    expect(await runtime.identitySession(identity)).toEqual({ status: 'unconfigured' });
    expect(runtime.authMethods(identity)).toEqual({ passwordLogin: false, registration: false, browserLogin: false });
    await expect(runtime.register(identity, { username: 'disabled-user', idempotencyKey: 'disabled-key' })).rejects.toMatchObject({ code: 'platform_headless_unconfigured' });
    expect(() => runtime.actor(identity)).toThrow('platform_unconfigured');
  });

  it('keeps injected test configuration isolated from production defaults', async () => {
    const runtime = createPlatformAccountRuntime({ env: {} });
    expect(await runtime.identitySession(identity)).toEqual({ status: 'unconfigured' });
    expect(runtime.authMethods(identity)).toEqual({ passwordLogin: false, registration: false, browserLogin: false });
  });
});
