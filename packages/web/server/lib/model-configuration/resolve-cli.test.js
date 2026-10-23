import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveModelBindingFromDisk } from './resolve-cli.js';

const cleanups = [];
const fixture = async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'model-cli-reference-'));
  cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
  const state = {
    version: 1, revision: 2,
    connections: [{ id: 'native-openai', name: 'Native', providerId: 'openai', protocol: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', credentialSource: { type: 'opencode', providerId: 'openai' } }],
    bindings: [{ purpose: 'image-generation', connectionId: 'native-openai', model: 'fixture-image-model', parameters: {}, verification: { status: 'untested' } }],
  };
  await fs.writeFile(path.join(dataDir, 'model-configuration.json'), JSON.stringify(state));
  let value = { type: 'key', key: 'fixture-cli-private-key' };
  let integrations = [];
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization, directory: request.headers['x-opencode-directory'] });
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/credential') return response.end(JSON.stringify({ data: [{ id: 'credential-fixture', integrationID: 'openai', label: 'Fixture', active: true, value }] }));
    if (request.url === '/api/integration') return response.end(JSON.stringify({ data: integrations }));
    response.statusCode = 404;
    response.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  const environment = { OPENCHAMBER_DATA_DIR: dataDir, SUPERWAGIE_MODEL_OPENCODE_URL: `http://127.0.0.1:${server.address().port}`, OPENCODE_PASSWORD: 'fixture-first-password', OPENCODE_SERVER_PASSWORD: 'fixture-second-password' };
  return { dataDir, requests, environment, setValue: (next) => { value = next; }, setIntegrations: (next) => { integrations = next; } };
};
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

describe('bundled model resolver credential source', () => {
  it('uses the official SDK with injected loopback endpoint and password precedence, scoped to this working directory', async () => {
    const { environment, requests, setValue } = await fixture();
    expect((await resolveModelBindingFromDisk('image-generation', { environment })).apiKey).toBe('fixture-cli-private-key');
    expect(requests.map((request) => request.url).sort()).toEqual(['/api/credential', '/api/integration']);
    for (const request of requests) expect(request.authorization).toBe(`Basic ${Buffer.from('opencode:fixture-first-password').toString('base64')}`);
    expect(requests.find((request) => request.url === '/api/integration').directory).toBe(encodeURIComponent(process.cwd()));
    setValue({ type: 'key', key: 'fixture-rotated-cli-key' });
    expect((await resolveModelBindingFromDisk('image-generation', { environment })).apiKey).toBe('fixture-rotated-cli-key');
    setValue({ type: 'oauth', methodID: 'browser', access: 'never-use-oauth', refresh: 'private-refresh', expires: Date.now() + 60000 });
    await expect(resolveModelBindingFromDisk('image-generation', { environment })).rejects.toMatchObject({ code: 'model_configuration_credential_missing' });
  });
  it('supports inherited native environment keys but lets a stored OAuth selection exclude them', async () => {
    const { environment, setValue, setIntegrations } = await fixture();
    setIntegrations([{ id: 'openai', connections: [{ type: 'env', name: 'OPENAI_API_KEY' }] }]);
    const nativeEnvironment = { ...environment, OPENAI_API_KEY: 'fixture-environment-key' };
    setValue({ type: 'key', key: 'stored-wins' });
    expect((await resolveModelBindingFromDisk('image-generation', { environment: nativeEnvironment })).apiKey).toBe('stored-wins');
    setValue({ type: 'oauth', methodID: 'browser', access: 'never-use-oauth', refresh: 'private-refresh', expires: Date.now() + 60000 });
    await expect(resolveModelBindingFromDisk('image-generation', { environment: nativeEnvironment })).rejects.toMatchObject({ code: 'model_configuration_credential_missing' });
  });
  it('refuses unavailable and remote injected endpoints without sending a password to them', async () => {
    const { environment, requests } = await fixture();
    for (const value of [undefined, 'https://remote.example.test', 'http://127.0.0.1:1234/path', 'http://user:password@127.0.0.1:1234']) {
      await expect(resolveModelBindingFromDisk('image-generation', { environment: { ...environment, SUPERWAGIE_MODEL_OPENCODE_URL: value } })).rejects.toMatchObject({ code: 'model_configuration_credential_unavailable' });
    }
    expect(requests).toHaveLength(0);
  });
});
