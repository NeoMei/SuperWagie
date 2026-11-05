import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { credentialDestinationAllowed } from './credentials.js';
import { createModelConfigurationRuntime } from './runtime.js';

const directories = [];
const noPolicyFile = () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); };
const fixture = async (options = {}) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'model-credential-reference-'));
  directories.push(dataDir);
  return { dataDir, runtime: createModelConfigurationRuntime({ dataDir, enterpriseOptions: { env: {}, readFile: noPolicyFile }, ...options }) };
};
const source = { type: 'opencode', providerId: 'openai' };
const connection = (changes = {}) => ({ name: 'Native key reference', providerId: 'openai', protocol: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', credentialSource: source, ...changes });
const connectAndBind = async (runtime, changes = {}) => {
  const state = await runtime.saveConnection({ revision: 0, connection: connection(changes) });
  return runtime.saveBinding('embedding', { revision: state.revision, binding: { connectionId: state.connections[0].id, model: 'fixture-embedding', parameters: { dimensions: 2 } } });
};
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });

describe('OpenCode API key references', () => {
  it('binds bootstrap references to the configured inference URL on save and on later resolution', async () => {
    const env = { OPENCHAMBER_LLMROUTER_API_URL: 'https://inference.example.test/' };
    const { runtime } = await fixture({ env, readModelBootstrapCredential: async () => 'fixture-bootstrap-key' });
    const changes = { providerId: 'llmrouter', credentialSource: { type: 'model-bootstrap', providerId: 'llmrouter', ref: 'fixture-ref' }, baseUrl: 'https://inference.example.test/v1' };
    for (const baseUrl of ['https://unihub.quukk.com/v1', 'https://inference.example.test/platform/v1', 'https://inference.example.test/v1/other', 'https://inference.example.test.attacker.test/v1']) {
      await expect(runtime.saveConnection({ revision: 0, connection: connection({ ...changes, baseUrl }) })).rejects.toMatchObject({ code: 'model_configuration_credential_destination_denied' });
    }
    await connectAndBind(runtime, changes);
    expect(await runtime.resolveBinding('embedding')).toMatchObject({ apiKey: 'fixture-bootstrap-key', baseUrl: changes.baseUrl });
    env.OPENCHAMBER_LLMROUTER_API_URL = 'https://changed.example.test/v1';
    await expect(runtime.resolveBinding('embedding')).rejects.toMatchObject({ code: 'model_configuration_credential_destination_denied' });
    expect((await runtime.getPublicConfiguration()).connections[0].hasApiKey).toBe(false);
  });

  it('keeps bootstrap verification and hasApiKey tied to the current readable credential', async () => {
    let key = 'fixture-bootstrap-key';
    const env = { OPENCHAMBER_LLMROUTER_API_URL: 'https://inference.example.test/v1' };
    const { runtime, dataDir } = await fixture({ env, readModelBootstrapCredential: async () => key, fetchImpl: async () => Response.json({ data: [{ embedding: [1, 2] }] }) });
    let state = await connectAndBind(runtime, { providerId: 'llmrouter', protocol: 'openai-compatible', baseUrl: env.OPENCHAMBER_LLMROUTER_API_URL, credentialSource: { type: 'model-bootstrap', providerId: 'llmrouter', ref: 'fixture-ref' } });
    state = await runtime.testBinding('embedding', { revision: state.revision });
    const verified = await runtime.getPublicConfiguration();
    expect(verified.bindings[0].verification.status).toBe('verified');
    const stored = JSON.parse(await fs.readFile(path.join(dataDir, 'model-configuration.json'), 'utf8'));
    const fingerprint = stored.bindings[0].verification.credentialFingerprint;
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    key = 'fixture-rotated-key';
    const rotated = await runtime.getPublicConfiguration();
    expect(rotated.bindings[0].verification).toEqual({ status: 'untested' });
    expect(rotated.connections[0].hasApiKey).toBe(true);
    key = '';
    const missing = await runtime.getPublicConfiguration();
    expect(missing.bindings[0].verification).toEqual({ status: 'untested' });
    expect(missing.connections[0].hasApiKey).toBe(false);
    for (const value of [verified, rotated, missing]) {
      const serialized = JSON.stringify(value);
      for (const secret of ['fixture-bootstrap-key', 'fixture-rotated-key', 'fixture-ref', fingerprint, 'credentialFingerprint']) expect(serialized).not.toContain(secret);
    }
  });

  it('invalidates bootstrap verification when the secret reader throws or is unavailable', async () => {
    let failRead = false;
    const env = { OPENCHAMBER_LLMROUTER_API_URL: 'https://inference.example.test/v1' };
    const { runtime, dataDir } = await fixture({ env, readModelBootstrapCredential: async () => {
      if (failRead) throw new Error('private-reader-error');
      return 'fixture-bootstrap-key';
    }, fetchImpl: async () => Response.json({ data: [{ embedding: [1, 2] }] }) });
    let state = await connectAndBind(runtime, { providerId: 'llmrouter', baseUrl: env.OPENCHAMBER_LLMROUTER_API_URL, credentialSource: { type: 'model-bootstrap', providerId: 'llmrouter', ref: 'fixture-ref' } });
    state = await runtime.testBinding('embedding', { revision: state.revision });
    const persisted = await fs.readFile(path.join(dataDir, 'model-configuration.json'), 'utf8');
    failRead = true;
    const withoutReader = createModelConfigurationRuntime({ dataDir, env, enterpriseOptions: { env: {}, readFile: noPolicyFile } });
    for (const reader of [runtime, withoutReader]) {
      const current = await reader.getPublicConfiguration();
      expect(current.revision).toBe(state.revision);
      expect(current.connections[0].hasApiKey).toBe(false);
      expect(current.bindings[0].verification).toEqual({ status: 'untested' });
      for (const secret of ['fixture-bootstrap-key', 'fixture-ref', 'credentialFingerprint', 'private-reader-error']) expect(JSON.stringify(current)).not.toContain(secret);
    }
    expect(await fs.readFile(path.join(dataDir, 'model-configuration.json'), 'utf8')).toBe(persisted);
  });

  it('preserves failed bootstrap verification while the same credential is current', async () => {
    let key = 'fixture-bootstrap-key';
    const env = { OPENCHAMBER_LLMROUTER_API_URL: 'https://inference.example.test/v1' };
    const { runtime } = await fixture({ env, readModelBootstrapCredential: async () => key, fetchImpl: async () => Response.json({ error: 'quota' }, { status: 429 }) });
    let state = await connectAndBind(runtime, { providerId: 'llmrouter', baseUrl: env.OPENCHAMBER_LLMROUTER_API_URL, credentialSource: { type: 'model-bootstrap', providerId: 'llmrouter', ref: 'fixture-ref' } });
    state = await runtime.testBinding('embedding', { revision: state.revision });
    expect(state.bindings[0].verification).toMatchObject({ status: 'failed', errorCode: 'model_configuration_provider_http_429' });
    expect((await runtime.getPublicConfiguration()).bindings[0].verification).toEqual(state.bindings[0].verification);
    key = 'fixture-rotated-key';
    expect((await runtime.getPublicConfiguration()).bindings[0].verification).toEqual({ status: 'untested' });
  });

  it('uses one bootstrap credential snapshot for verification and hasApiKey within a public read', async () => {
    let oneReadOnly = false;
    let reads = 0;
    const env = { OPENCHAMBER_LLMROUTER_API_URL: 'https://inference.example.test/v1' };
    const { runtime } = await fixture({ env, readModelBootstrapCredential: async () => {
      if (oneReadOnly && ++reads > 1) return undefined;
      return 'fixture-bootstrap-key';
    }, fetchImpl: async () => Response.json({ data: [{ embedding: [1, 2] }] }) });
    let state = await connectAndBind(runtime, { providerId: 'llmrouter', baseUrl: env.OPENCHAMBER_LLMROUTER_API_URL, credentialSource: { type: 'model-bootstrap', providerId: 'llmrouter', ref: 'fixture-ref' } });
    state = await runtime.testBinding('embedding', { revision: state.revision });
    oneReadOnly = true;
    const current = await runtime.getPublicConfiguration();
    expect(reads).toBe(1);
    expect(current.connections[0].hasApiKey).toBe(true);
    expect(current.bindings[0].verification).toEqual(state.bindings[0].verification);
    expect(current.bindings[0].verification.status).toBe('verified');
    const missing = await runtime.getPublicConfiguration();
    expect(reads).toBe(2);
    expect(missing.connections[0].hasApiKey).toBe(false);
    expect(missing.bindings[0].verification).toEqual({ status: 'untested' });
  });

  it('does not expose a bootstrap key or keep verification when its destination is changed', async () => {
    const env = { OPENCHAMBER_LLMROUTER_API_URL: 'https://inference.example.test/v1' };
    const { runtime } = await fixture({ env, readModelBootstrapCredential: async () => 'fixture-bootstrap-key', fetchImpl: async () => Response.json({ data: [{ embedding: [1, 2] }] }) });
    let state = await connectAndBind(runtime, { providerId: 'llmrouter', protocol: 'openai-compatible', baseUrl: env.OPENCHAMBER_LLMROUTER_API_URL, credentialSource: { type: 'model-bootstrap', providerId: 'llmrouter', ref: 'fixture-ref' } });
    state = await runtime.testBinding('embedding', { revision: state.revision });
    env.OPENCHAMBER_LLMROUTER_API_URL = 'https://changed.example.test/v1';
    const publicState = await runtime.getPublicConfiguration();
    expect(publicState.connections[0].hasApiKey).toBe(false);
    expect(publicState.bindings[0].verification).toEqual({ status: 'untested' });
    expect(JSON.stringify(publicState)).not.toContain('fixture-bootstrap-key');
  });

  it('stores only a reference, resolves fresh rotations and invalidates verification without publishing a fingerprint', async () => {
    let apiKey = 'fixture-native-private-key';
    const { runtime, dataDir } = await fixture({ readOpenCodeCredentials: async () => ({ openai: { type: 'api', key: apiKey } }), fetchImpl: async () => Response.json({ data: [{ embedding: [1, 2] }] }) });
    let state = await connectAndBind(runtime);
    expect(state.credentialSources).toEqual({ status: 'available', sources: [source] });
    expect(state.connections[0]).toMatchObject({ credentialSource: source, hasApiKey: true });
    state = await runtime.testBinding('embedding', { revision: state.revision });
    expect(state.bindings[0].verification.status).toBe('verified');
    const persisted = await fs.readFile(path.join(dataDir, 'model-configuration.json'), 'utf8');
    expect(persisted).not.toContain(apiKey);
    expect(persisted).not.toContain('"apiKey"');
    expect(persisted).toContain('credentialFingerprint');
    expect(JSON.stringify(state)).not.toContain('credentialFingerprint');
    expect(JSON.stringify(state)).not.toContain(apiKey);
    expect((await runtime.resolveBinding('embedding')).apiKey).toBe(apiKey);
    apiKey = 'fixture-rotated-private-key';
    expect((await runtime.resolveBinding('embedding')).apiKey).toBe(apiKey);
    expect((await runtime.getPublicConfiguration()).bindings[0].verification).toEqual({ status: 'untested' });
    expect((await runtime.getPublicConfiguration()).revision).toBe(state.revision);
  });

  it('excludes OAuth and refuses missing or unreadable sources, without treating failed reads as empty', async () => {
    let credentials = { openai: { type: 'api', key: 'fixture-key' }, anthropic: { type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh' } };
    let failRead = false;
    const { runtime } = await fixture({ readOpenCodeCredentials: async () => { if (failRead) throw new Error('unreachable'); return credentials; } });
    await connectAndBind(runtime);
    expect((await runtime.getPublicConfiguration()).credentialSources.sources).toEqual([source]);
    credentials = { openai: { type: 'oauth', access: 'not-a-key' } };
    const oauth = await runtime.getPublicConfiguration();
    expect(oauth.credentialSources).toEqual({ status: 'available', sources: [] });
    expect(oauth.connections[0].hasApiKey).toBe(false);
    expect(JSON.stringify(oauth)).not.toContain('not-a-key');
    await expect(runtime.resolveBinding('embedding')).rejects.toMatchObject({ code: 'model_configuration_credential_missing' });
    credentials = {};
    await expect(runtime.resolveBinding('embedding')).rejects.toMatchObject({ code: 'model_configuration_credential_missing' });
    failRead = true;
    expect((await runtime.getPublicConfiguration()).credentialSources.status).toBe('failed');
    await expect(runtime.resolveBinding('embedding')).rejects.toMatchObject({ code: 'model_configuration_credential_unavailable' });
    const unavailable = await fixture();
    expect((await unavailable.runtime.getPublicConfiguration()).credentialSources.status).toBe('unavailable');
    await expect(unavailable.runtime.saveConnection({ revision: 0, connection: connection() })).rejects.toMatchObject({ code: 'model_configuration_credential_unavailable' });
  });
  it('keeps manual key models usable while the native source is down and rejects ambiguous credentials', async () => {
    const { runtime } = await fixture({ readOpenCodeCredentials: async () => { throw new Error('unreachable'); } });
    await expect(runtime.saveConnection({ revision: 0, connection: connection({ apiKey: 'manual-key' }) })).rejects.toMatchObject({ code: 'model_configuration_invalid_input' });
    await connectAndBind(runtime, { credentialSource: undefined, apiKey: 'manual-key', baseUrl: 'https://custom.example.test/v1' });
    expect((await runtime.getPublicConfiguration()).credentialSources.status).toBe('failed');
    expect((await runtime.resolveBinding('embedding')).apiKey).toBe('manual-key');
  });
  it('blocks stored keys from user-selected hosts, mismatched families, ports, HTTP and subscription endpoints', async () => {
    const { runtime } = await fixture({ readOpenCodeCredentials: async () => ({ openai: { type: 'api', key: 'native-key' }, 'zai-coding-plan': { type: 'api', key: 'subscription-key' } }) });
    for (const changes of [
      { baseUrl: 'https://api.openai.com.attacker.test/v1' }, { baseUrl: 'https://api.openai.com:9443/v1' },
      { baseUrl: 'http://api.openai.com/v1' }, { baseUrl: 'http://127.0.0.1:8181/v1' },
      { baseUrl: 'https://api.anthropic.com/v1', providerId: 'anthropic' },
      { credentialSource: { type: 'opencode', providerId: 'zai-coding-plan' }, providerId: 'glm', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
    ]) await expect(runtime.saveConnection({ revision: 0, connection: connection(changes) })).rejects.toMatchObject({ code: 'model_configuration_credential_destination_denied' });
    const state = await runtime.saveConnection({ revision: 0, connection: connection() });
    const { hasApiKey, ...editable } = state.connections[0];
    expect(hasApiKey).toBe(true);
    await expect(runtime.saveConnection({ revision: state.revision, connection: { ...editable, baseUrl: 'https://custom.example.test/v1' } })).rejects.toMatchObject({ code: 'model_configuration_credential_destination_denied' });
    expect((await runtime.getPublicConfiguration()).revision).toBe(state.revision);
  });
  it('allows a custom destination only when authoritative native metadata matches it exactly', async () => {
    let baseUrl = 'https://company.example.test/v1';
    const { runtime } = await fixture({ readOpenCodeCredentials: async () => ({ corporate: { type: 'api', key: 'company-key' } }), readOpenCodeProviderMetadata: async () => [{ providerId: 'corporate', name: 'Company', baseUrl }] });
    await connectAndBind(runtime, { providerId: 'corporate', credentialSource: { type: 'opencode', providerId: 'corporate' }, baseUrl });
    expect((await runtime.getPublicConfiguration()).credentialSources.sources).toEqual([{ type: 'opencode', providerId: 'corporate', name: 'Company' }]);
    expect((await runtime.resolveBinding('embedding')).apiKey).toBe('company-key');
    baseUrl = 'https://company.example.test/other';
    await expect(runtime.resolveBinding('embedding')).rejects.toMatchObject({ code: 'model_configuration_credential_destination_denied' });
    expect((await runtime.getPublicConfiguration()).connections[0].hasApiKey).toBe(false);
  });
  it('switches between reference and manual credentials and resets verification on source changes', async () => {
    const { runtime, dataDir } = await fixture({ readOpenCodeCredentials: async () => ({ openai: { type: 'api', key: 'native-key' } }), fetchImpl: async () => Response.json({ data: [{ embedding: [1, 2] }] }) });
    let state = await connectAndBind(runtime);
    state = await runtime.testBinding('embedding', { revision: state.revision });
    let { hasApiKey, ...editable } = state.connections[0];
    state = await runtime.saveConnection({ revision: state.revision, connection: { ...editable, credentialSource: undefined, apiKey: 'manual-key' } });
    expect(hasApiKey).toBe(true);
    expect(state.connections[0].credentialSource).toBeUndefined();
    expect(state.bindings[0].verification.status).toBe('untested');
    expect((await runtime.resolveBinding('embedding')).apiKey).toBe('manual-key');
    ({ hasApiKey, ...editable } = state.connections[0]);
    state = await runtime.saveConnection({ revision: state.revision, connection: { ...editable, credentialSource: source } });
    expect(hasApiKey).toBe(true);
    expect((await runtime.resolveBinding('embedding')).apiKey).toBe('native-key');
    expect(await fs.readFile(path.join(dataDir, 'model-configuration.json'), 'utf8')).not.toContain('manual-key');
  });
  it('does not record a verification after a native credential rotates during its request', async () => {
    let key = 'before-request';
    const { runtime } = await fixture({ readOpenCodeCredentials: async () => ({ openai: { type: 'api', key } }), fetchImpl: async () => { key = 'rotated-during-request'; return Response.json({ data: [{ embedding: [1, 2] }] }); } });
    const state = await connectAndBind(runtime);
    await expect(runtime.testBinding('embedding', { revision: state.revision })).rejects.toMatchObject({ code: 'model_configuration_credential_changed' });
    expect((await runtime.getPublicConfiguration()).bindings[0].verification.status).toBe('untested');
  });
  it('rejects bootstrap credential rotation during a probe without advancing revision or retrying', async () => {
    let key = 'fixture-bootstrap-before-request';
    let requests = 0;
    const env = { OPENCHAMBER_LLMROUTER_API_URL: 'https://inference.example.test/v1' };
    const { runtime } = await fixture({ env, readModelBootstrapCredential: async () => key, fetchImpl: async () => {
      requests += 1;
      key = 'fixture-bootstrap-rotated-during-request';
      return Response.json({ data: [{ embedding: [1, 2] }] });
    } });
    const state = await connectAndBind(runtime, { providerId: 'llmrouter', baseUrl: env.OPENCHAMBER_LLMROUTER_API_URL, credentialSource: { type: 'model-bootstrap', providerId: 'llmrouter', ref: 'fixture-ref' } });
    await expect(runtime.testBinding('embedding', { revision: state.revision })).rejects.toMatchObject({ code: 'model_configuration_credential_changed' });
    const current = await runtime.getPublicConfiguration();
    expect(current.revision).toBe(state.revision);
    expect(current.bindings[0].verification).toEqual({ status: 'untested' });
    expect(requests).toBe(1);
  });
  it('restricts official Alibaba and provider aliases without allowing arbitrary sibling domains', () => {
    const input = connection({ providerId: 'aliyun', protocol: 'aliyun', credentialSource: { type: 'opencode', providerId: 'alibaba-cn' }, baseUrl: 'https://workspace.cn-beijing.maas.aliyuncs.com' });
    expect(credentialDestinationAllowed(input)).toBe(true);
    expect(credentialDestinationAllowed({ ...input, baseUrl: 'https://workspace.cn-beijing.maas.aliyuncs.com.attacker.test' })).toBe(false);
    expect(credentialDestinationAllowed({ ...input, baseUrl: 'https://arbitrary.aliyuncs.com' })).toBe(false);
    expect(credentialDestinationAllowed({ ...input, protocol: 'openai-compatible' })).toBe(false);
  });
});
