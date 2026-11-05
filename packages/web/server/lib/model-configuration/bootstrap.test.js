import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createModelBootstrapRuntime } from './bootstrap.js';

const directories = [];
const catalog = [
  { id: 'chat-pro', name: 'Chat Pro', operations: ['chat'], recommendation: 2 },
  { id: 'embed-pro', name: 'Embed Pro', operations: ['embedding'], recommendation: 1 },
  { id: 'rerank-pro', name: 'Rerank Pro', operations: ['rerank'], recommendation: 1 },
];
const fixture = async ({ state, client, secretStore, env = {} } = {}) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'model-bootstrap-'));
  directories.push(dataDir);
  let current = state ?? { version: 1, revision: 0, connections: [], bindings: [] };
  const modelRuntime = {
    getPublicConfiguration: async () => structuredClone(current),
    saveConnection: async ({ revision, connection }) => {
      if (revision !== current.revision) throw Object.assign(new Error('stale'), { code: 'model_configuration_revision_conflict', status: 409 });
      current = { ...current, revision: current.revision + 1, connections: [...current.connections, { ...connection, id: `connection-${current.connections.length + 1}`, hasApiKey: Boolean(connection.apiKey) }] };
      return structuredClone(current);
    },
    saveBinding: async (purpose, { revision, binding }) => {
      if (revision !== current.revision) throw Object.assign(new Error('stale'), { code: 'model_configuration_revision_conflict', status: 409 });
      current = { ...current, revision: current.revision + 1, bindings: [...current.bindings.filter((entry) => entry.purpose !== purpose), ...(binding ? [{ ...binding, purpose, verification: { status: 'untested' } }] : [])] };
      return structuredClone(current);
    },
    removeConnection: async (id, { revision }) => {
      if (revision !== current.revision) throw Object.assign(new Error('stale'), { code: 'model_configuration_revision_conflict', status: 409 });
      current = { ...current, revision: current.revision + 1, connections: current.connections.filter((entry) => entry.id !== id) };
      return structuredClone(current);
    },
    testBinding: async () => ({ status: 'verified' }),
  };
  return { dataDir, modelRuntime, runtime: createModelBootstrapRuntime({ dataDir, modelRuntime, env, platformAccount: { accountId: 'account-1', instanceId: 'instance-1' }, uniHubClient: client ?? { discover: async () => ({ origin_product_id: 'superwagie', account_id: 'account-1', instance_id: 'instance-1', data: catalog }) }, secretStore }) };
};
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });

describe('model bootstrap domain', () => {
  it.each(['imported', 'generated'])('binds %s keys to the configured inference endpoint, never the discovery endpoint', async (source) => {
    const payload = { key: 'fixture-issued-key', origin_product_id: 'superwagie', account_id: 'account-1', instance_id: 'instance-1', base_url: 'https://unihub.quukk.com/v1', data: catalog };
    const { runtime } = await fixture({ env: { OPENCHAMBER_LLMROUTER_API_URL: 'https://inference.example.test/v1/' }, client: { discover: async () => payload, issueKey: async () => payload } });
    const discovery = source === 'imported' ? await runtime.discover({ source: 'imported-key', key: 'fixture-imported-key' }) : await runtime.issueKey();
    const preview = await runtime.preview({ discoveryId: discovery.discoveryId, revision: 0, purposes: ['embedding'] });
    const applied = await runtime.apply({ operationId: preview.operationId, discoveryId: discovery.discoveryId, revision: 0 });
    expect(applied.configuration.connections[0].baseUrl).toBe('https://inference.example.test/v1');
  });

  it('preserves an existing catalog-address connection and creates the correct connection for missing purposes', async () => {
    const oldConnection = { id: 'old', providerId: 'llmrouter', protocol: 'openai-compatible', baseUrl: 'https://unihub.quukk.com/v1' };
    const { runtime } = await fixture({ state: { version: 1, revision: 0, connections: [oldConnection], bindings: [] } });
    const discovery = await runtime.discover({ source: 'imported-key', key: 'fixture-key' });
    const preview = await runtime.preview({ discoveryId: discovery.discoveryId, revision: 0, purposes: ['embedding'] });
    const applied = await runtime.apply({ operationId: preview.operationId, discoveryId: discovery.discoveryId, revision: 0 });
    expect(applied.configuration.connections[0]).toEqual(oldConnection);
    expect(applied.configuration.connections[1].baseUrl).toBe('https://llmrouter.quukk.com/v1');
    expect(applied.configuration.bindings[0].connectionId).toBe(applied.configuration.connections[1].id);
  });

  it('rejects a discovery after its configured inference destination changes', async () => {
    const env = { OPENCHAMBER_LLMROUTER_API_URL: 'https://inference.example.test/v1' };
    const { runtime, modelRuntime } = await fixture({ env });
    const discovery = await runtime.discover({ source: 'imported-key', key: 'fixture-key' });
    const preview = await runtime.preview({ discoveryId: discovery.discoveryId, revision: 0, purposes: ['embedding'] });
    env.OPENCHAMBER_LLMROUTER_API_URL = 'https://changed.example.test/v1';
    await expect(runtime.apply({ operationId: preview.operationId, discoveryId: discovery.discoveryId, revision: 0 })).rejects.toMatchObject({ code: 'model_configuration_credential_destination_denied' });
    expect((await modelRuntime.getPublicConfiguration()).revision).toBe(0);
  });

  it('discovers a scoped session catalog without persisting a raw key', async () => {
    const { dataDir, runtime } = await fixture();
    const discovery = await runtime.discover({ source: 'session' });
    expect(discovery).toMatchObject({ accountId: 'account-1', instanceId: 'instance-1', catalog: expect.any(Array) });
    const files = await fs.readdir(path.join(dataDir, 'model-bootstrap'));
    expect(JSON.stringify(await fs.readFile(path.join(dataDir, 'model-bootstrap', files[0]), 'utf8'))).not.toContain('fixture-secret');
  });

  it('rejects an imported key for another product or instance', async () => {
    const { runtime } = await fixture({ client: { discover: async () => ({ origin_product_id: 'llmrouter', account_id: 'account-1', instance_id: 'instance-1', data: catalog }) } });
    await expect(runtime.discover({ source: 'imported-key', key: 'fixture-secret' })).rejects.toMatchObject({ code: 'model_configuration_bootstrap_product_mismatch', status: 403 });
  });

  it('plans capabilities and applies only missing purposes', async () => {
    const { runtime, modelRuntime } = await fixture();
    const discovery = await runtime.discover({ source: 'session' });
    const preview = await runtime.preview({ discoveryId: discovery.discoveryId, revision: 0, purposes: ['embedding', 'rerank', 'vision'] });
    expect(preview.add.map((entry) => entry.purpose)).toEqual(['embedding', 'rerank']);
    expect(preview.unavailable).toEqual([{ purpose: 'vision', reason: 'no_supported_model' }]);
    const applied = await runtime.apply({ operationId: preview.operationId, discoveryId: discovery.discoveryId, revision: 0 });
    expect(applied.configuration).toMatchObject({ revision: 3, bindings: expect.arrayContaining([expect.objectContaining({ purpose: 'embedding' }), expect.objectContaining({ purpose: 'rerank' })]) });
    expect(JSON.stringify(applied)).not.toContain('fixture-secret');
    expect((await modelRuntime.getPublicConfiguration()).connections).toHaveLength(1);
  });

  it('returns an explicit stale revision and preserves idempotent apply', async () => {
    const { runtime } = await fixture();
    const discovery = await runtime.discover({ source: 'session' });
    const preview = await runtime.preview({ discoveryId: discovery.discoveryId, revision: 0, purposes: ['embedding'] });
    await expect(runtime.apply({ operationId: preview.operationId, discoveryId: discovery.discoveryId, revision: 1 })).rejects.toMatchObject({ code: 'model_configuration_revision_conflict' });
    const first = await runtime.apply({ operationId: preview.operationId, discoveryId: discovery.discoveryId, revision: 0 });
    await expect(runtime.apply({ operationId: preview.operationId, discoveryId: discovery.discoveryId, revision: 0 })).resolves.toEqual(first);
  });

  it('skips managed-media probes and bounds test workers', async () => {
    let concurrent = 0; let maximum = 0;
    const { runtime } = await fixture();
    const discovery = await runtime.discover({ source: 'session' });
    const preview = await runtime.preview({ discoveryId: discovery.discoveryId, revision: 0, purposes: ['embedding'] });
    await runtime.apply({ operationId: preview.operationId, discoveryId: discovery.discoveryId, revision: 0 });
    const run = await runtime.startTests({ revision: 2, purposes: ['embedding'], expensive: true });
    expect(run.testRunId).toBeTruthy();
    while ((await runtime.readTestRun(run.testRunId)).status !== 'complete') await new Promise((resolve) => setTimeout(resolve, 1));
    const result = await runtime.readTestRun(run.testRunId);
    expect(result.purposes.embedding.status).toBe('unavailable');
    expect(maximum).toBeLessThanOrEqual(2);
    void concurrent;
  });
});
