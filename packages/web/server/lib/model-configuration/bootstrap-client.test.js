import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createUniHubBootstrapClient } from './bootstrap-client.js';
import { llmRouterInferenceApiUrl } from './bootstrap-endpoints.js';
import { createModelBootstrapStore } from './bootstrap-store.js';
import { createModelBootstrapRuntime } from './bootstrap.js';
import { createModelConfigurationRuntime } from './runtime.js';
import { createKnowledgeLibraryRuntime } from '../knowledge-library/runtime.js';

const cleanup = [];
const catalog = [{ id: 'fixture-embedding', operations: ['embedding'], dimensions: 2 }];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((close) => close())); });

const fixture = async ({ models = catalog, knowledgeConsumer = false, invalidEmbedding = false, beforeEmbedding } = {}) => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    requests.push({ method: req.method, path: req.url, body: body ? JSON.parse(body) : null });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/models') {
      res.setHeader('x-unihub-origin-product-id', 'superwagie');
      res.setHeader('x-unihub-account-id', 'account-1');
      res.setHeader('x-unihub-instance-id', 'instance-1');
      res.end(JSON.stringify({ data: models, base_url: 'https://untrusted.example.test/v1' }));
    } else if (req.url === '/v1/accounts/account-1/model-discovery') res.end(JSON.stringify({ models, origin_product_id: 'superwagie', account_id: 'account-1', instance_id: 'instance-1' }));
    else if (req.url === '/v1/accounts/account-1/api-keys') res.end(JSON.stringify({ token: 'fixture-issued-private-key' }));
    else if (knowledgeConsumer && req.url === '/v1/embeddings') {
      expect(req.headers.authorization).toBe('Bearer fixture-imported-private-key');
      await beforeEmbedding?.();
      res.end(JSON.stringify({ data: [{ index: 0, embedding: invalidEmbedding ? [0.25] : [0.25, 0.75] }] }));
    } else if (knowledgeConsumer && req.url === '/v1/rerank') {
      expect(req.headers.authorization).toBe('Bearer fixture-imported-private-key');
      res.end(JSON.stringify({ results: [{ index: 0, relevance_score: 0.9 }, { index: 1, relevance_score: 0.1 }] }));
    } else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const env = { OPENCHAMBER_UNIHUB_API_URL: `${origin}/v1/`, OPENCHAMBER_LLMROUTER_API_URL: knowledgeConsumer ? `${origin}/v1` : 'https://inference.example.test/' };
  const platformAccount = {
    actor: () => ({ billingAccountId: 'account-1', actingUserId: 'user-1', authSession: 'session-1' }),
    instanceId: 'instance-1',
    request: async (_identity, pathname, options) => (await fetch(`${origin}${pathname}`, options)).json(),
  };
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'model-bootstrap-client-'));
  cleanup.push(() => fs.rm(dataDir, { recursive: true, force: true }));
  const store = createModelBootstrapStore({ dataDir });
  let knowledgeRuntime;
  const modelRuntime = createModelConfigurationRuntime({ dataDir, env, enterpriseOptions: { env: {}, readFile: () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); } }, readModelBootstrapCredential: store.getSecret,
    prepareBindingChange: knowledgeConsumer ? (...args) => knowledgeRuntime.prepareModelBindingChange(...args) : undefined,
  });
  if (knowledgeConsumer) knowledgeRuntime = createKnowledgeLibraryRuntime({ dataDir, readSettings: async () => ({}), resolveModelBinding: (...args) => modelRuntime.resolveBinding(...args) });
  const uniHubClient = createUniHubBootstrapClient({ platformAccount, env });
  const runtime = createModelBootstrapRuntime({ dataDir, store, modelRuntime, platformAccount, uniHubClient, env });
  return { dataDir, requests, runtime, modelRuntime, uniHubClient };
};

describe('quick setup service endpoints', () => {
  it('applies embedding and rerank through the real knowledge consumer before probing both endpoints', async () => {
    const { runtime, modelRuntime, dataDir, requests } = await fixture({ knowledgeConsumer: true, models: [...catalog, { id: 'qwen3-rerank', operations: ['rerank'] }] });
    const discovery = await runtime.discover({ source: 'imported-key', key: 'fixture-imported-private-key' });
    const preview = await runtime.preview({ discoveryId: discovery.discoveryId, revision: 0, purposes: ['embedding', 'rerank'] });
    expect(preview.add.map((item) => item.purpose)).toEqual(['embedding', 'rerank']);
    const applied = await runtime.apply({ operationId: preview.operationId, discoveryId: discovery.discoveryId, revision: 0 });
    expect(applied.configuration.connections).toHaveLength(1);
    expect(applied.configuration.connections[0]).toMatchObject({ providerId: 'llmrouter', protocol: 'openai-compatible' });
    expect(applied.configuration.bindings.map((binding) => binding.purpose)).toEqual(['embedding', 'rerank']);
    expect(requests.map((entry) => entry.path)).toEqual(['/v1/models']);
    let state = await modelRuntime.testBinding('embedding', { revision: applied.revision });
    state = await modelRuntime.testBinding('rerank', { revision: state.revision });
    const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'model-configuration.json'), 'utf8'));
    expect(saved.bindings.map((binding) => binding.verification.status)).toEqual(['verified', 'verified']);
    expect(requests.map((entry) => entry.path)).toEqual(['/v1/models', '/v1/embeddings', '/v1/rerank']);
    expect(requests[2].body).toMatchObject({ model: 'qwen3-rerank', query: 'model configuration', documents: expect.any(Array), top_n: 2 });
  });

  it('runs real binding probes serially and advances the revision returned by each probe', async () => {
    const { runtime, modelRuntime, requests } = await fixture({ knowledgeConsumer: true, models: [...catalog, { id: 'qwen3-rerank', operations: ['rerank'] }] });
    const discovery = await runtime.discover({ source: 'imported-key', key: 'fixture-imported-private-key' });
    const preview = await runtime.preview({ discoveryId: discovery.discoveryId, revision: 0, purposes: ['embedding', 'rerank'] });
    const applied = await runtime.apply({ operationId: preview.operationId, discoveryId: discovery.discoveryId, revision: 0 });
    const run = await runtime.startTests({ revision: applied.revision, purposes: ['embedding', 'rerank', 'embedding', 'rerank'], expensive: true });
    await expect.poll(() => runtime.readTestRun(run.testRunId)).toMatchObject({ status: 'complete' });
    const result = await runtime.readTestRun(run.testRunId);
    expect(result.purposes).toMatchObject({ embedding: { status: 'verified' }, rerank: { status: 'verified' } });
    expect(requests.map((entry) => entry.path)).toEqual(['/v1/models', '/v1/embeddings', '/v1/rerank']);
    expect((await modelRuntime.getPublicConfiguration()).revision).toBe(applied.revision + 2);
  });

  it('records a real provider probe failure and does not mark it verified', async () => {
    const { runtime, modelRuntime, requests } = await fixture({ knowledgeConsumer: true, invalidEmbedding: true, models: [...catalog, { id: 'qwen3-rerank', operations: ['rerank'] }] });
    const discovery = await runtime.discover({ source: 'imported-key', key: 'fixture-imported-private-key' });
    const preview = await runtime.preview({ discoveryId: discovery.discoveryId, revision: 0, purposes: ['embedding', 'rerank'] });
    const applied = await runtime.apply({ operationId: preview.operationId, discoveryId: discovery.discoveryId, revision: 0 });
    const run = await runtime.startTests({ revision: applied.revision, purposes: ['embedding', 'rerank'], expensive: true });
    await expect.poll(() => runtime.readTestRun(run.testRunId)).toMatchObject({ status: 'complete' });
    const result = await runtime.readTestRun(run.testRunId);
    expect(result.purposes.embedding).toMatchObject({ status: 'failed', errorCode: 'model_configuration_dimension_mismatch' });
    expect(result.purposes.rerank).toMatchObject({ status: 'verified' });
    expect(requests.map((entry) => entry.path)).toEqual(['/v1/models', '/v1/embeddings', '/v1/rerank']);
    expect((await modelRuntime.getPublicConfiguration()).revision).toBe(applied.revision + 2);
  });

  it('stops later probes after a concurrent configuration edit without retrying the dispatched probe', async () => {
    let editConfiguration;
    const { runtime, modelRuntime, requests } = await fixture({ knowledgeConsumer: true, beforeEmbedding: () => editConfiguration(), models: [...catalog, { id: 'qwen3-rerank', operations: ['rerank'] }] });
    const discovery = await runtime.discover({ source: 'imported-key', key: 'fixture-imported-private-key' });
    const preview = await runtime.preview({ discoveryId: discovery.discoveryId, revision: 0, purposes: ['embedding', 'rerank'] });
    const applied = await runtime.apply({ operationId: preview.operationId, discoveryId: discovery.discoveryId, revision: 0 });
    editConfiguration = () => modelRuntime.saveBinding('rerank', { revision: applied.revision, binding: { connectionId: applied.configuration.connections[0].id, model: 'edited-rerank', parameters: {} } });
    const run = await runtime.startTests({ revision: applied.revision, purposes: ['embedding', 'rerank'] });
    await expect.poll(() => runtime.readTestRun(run.testRunId)).toMatchObject({ status: 'complete' });
    const result = await runtime.readTestRun(run.testRunId);
    expect(result.purposes).toEqual({
      embedding: { status: 'stale', errorCode: 'model_configuration_revision_conflict' },
      rerank: { status: 'stale', errorCode: 'model_configuration_revision_conflict' },
    });
    expect(requests.map((entry) => entry.path)).toEqual(['/v1/models', '/v1/embeddings']);
    const state = await modelRuntime.getPublicConfiguration();
    expect(state.revision).toBe(applied.revision + 1);
    expect(state.bindings.find((binding) => binding.purpose === 'rerank').model).toBe('edited-rerank');
    expect(state.bindings.map((binding) => binding.verification.status)).toEqual(['untested', 'untested']);
  });

  it.each(['imported', 'generated'])('keeps %s key discovery on UniHub and persists only the configured LLMRouter inference endpoint', async (source) => {
    const { runtime, modelRuntime, dataDir, requests } = await fixture();
    const identity = { fixture: true };
    const expiresAt = '2030-01-01T00:00:00Z';
    const discovery = source === 'imported'
      ? await runtime.discover({ source: 'imported-key', key: 'fixture-imported-private-key', identity })
      : await runtime.issueKey({ identity, models: ['fixture-embedding'], expiresAt });
    const preview = await runtime.preview({ discoveryId: discovery.discoveryId, revision: 0, purposes: ['embedding'], identity });
    const applied = await runtime.apply({ operationId: preview.operationId, discoveryId: discovery.discoveryId, revision: 0, identity });
    expect(applied.configuration.connections[0]).toMatchObject({ providerId: 'llmrouter', protocol: 'openai-compatible', baseUrl: 'https://inference.example.test/v1', credentialSource: { type: 'model-bootstrap', providerId: 'llmrouter' } });
    expect(await modelRuntime.resolveBinding('embedding')).toMatchObject({ baseUrl: 'https://inference.example.test/v1', apiKey: source === 'imported' ? 'fixture-imported-private-key' : 'fixture-issued-private-key' });
    const saved = await fs.readFile(path.join(dataDir, 'model-configuration.json'), 'utf8');
    expect(saved).toContain('https://inference.example.test/v1');
    expect(saved).not.toContain('private-key');
    expect(saved).not.toContain('untrusted.example.test');
    expect(requests).toEqual(source === 'imported' ? [{ method: 'GET', path: '/v1/models', body: null }] : [
      { method: 'POST', path: '/v1/accounts/account-1/model-discovery', body: null },
      { method: 'POST', path: '/v1/accounts/account-1/api-keys', body: { name: 'SuperWagie quick setup', origin_product_id: 'superwagie', instance_id: 'instance-1', models: ['fixture-embedding'], expires_at: expiresAt } },
    ]);
  });

  it('preserves the managed session platform endpoint', async () => {
    const { runtime, requests } = await fixture();
    const identity = { fixture: true };
    const discovery = await runtime.discover({ source: 'session', identity });
    const preview = await runtime.preview({ discoveryId: discovery.discoveryId, revision: 0, purposes: ['embedding'], identity });
    const applied = await runtime.apply({ operationId: preview.operationId, discoveryId: discovery.discoveryId, revision: 0, identity });
    expect(applied.configuration.connections[0]).toMatchObject({ protocol: 'managed-media', baseUrl: 'https://llmrouter.quukk.com/platform/v1' });
    expect(requests).toEqual([{ method: 'POST', path: '/v1/accounts/account-1/model-discovery', body: null }]);
  });

  it('rolls back mixed additions and managed replacements without removing original bindings or connections', async () => {
    const { runtime, modelRuntime } = await fixture({ models: [...catalog, { id: 'fixture-rerank', operations: ['rerank'] }, { id: 'fixture-chat', operations: ['chat'] }] });
    let state = await modelRuntime.saveConnection({ revision: 0, connection: { name: 'Original managed', providerId: 'unihub', protocol: 'managed-media', baseUrl: 'https://llmrouter.quukk.com/platform/v1' } });
    const managedId = state.connections[0].id;
    state = await modelRuntime.saveBinding('embedding', { revision: state.revision, binding: { connectionId: managedId, presetId: 'unihub-text-embedding-v4', model: 'unihub-text-embedding-v4', parameters: { dimensions: 1024 } } });
    state = await modelRuntime.saveConnection({ revision: state.revision, connection: { name: 'Original routing', providerId: 'jev', protocol: 'jev', baseUrl: 'https://routing.example.test/v1', apiKey: 'fixture-routing-key' } });
    state = await modelRuntime.saveBinding('routing', { revision: state.revision, binding: { connectionId: state.connections[1].id, model: 'original-routing', parameters: {} } });
    const before = state;
    const identity = { fixture: true };
    const discovery = await runtime.discover({ source: 'imported-key', key: 'fixture-imported-key', identity });
    const preview = await runtime.preview({ discoveryId: discovery.discoveryId, revision: before.revision, mode: 'replace-managed', purposes: ['embedding', 'rerank', 'routing'], identity });
    expect(preview.add.map((item) => item.purpose)).toEqual(['rerank']);
    expect(preview.replace.map((item) => item.purpose)).toEqual(['embedding']);
    expect(preview.preserve.map((item) => item.purpose)).toEqual(['routing']);
    const applied = await runtime.apply({ operationId: preview.operationId, discoveryId: discovery.discoveryId, revision: before.revision, mode: 'replace-managed', identity });
    expect(applied.configuration.connections).toHaveLength(3);
    expect(applied.configuration.bindings.find((binding) => binding.purpose === 'embedding').model).toBe('fixture-embedding');
    const rolledBack = await runtime.rollback({ operationId: preview.operationId, revision: applied.revision, identity });
    expect(rolledBack.rolledBack).toBe(true);
    expect(rolledBack.configuration.connections).toEqual(before.connections);
    expect(rolledBack.configuration.bindings).toHaveLength(before.bindings.length);
    expect(rolledBack.configuration.bindings).toEqual(expect.arrayContaining(before.bindings));
    expect((await modelRuntime.getPublicConfiguration()).bindings).toEqual(rolledBack.configuration.bindings);
  });

  it.each(['https://inference.example.test', 'https://inference.example.test/', 'https://inference.example.test/v1', 'https://inference.example.test/v1/'])('normalizes the explicit inference configuration %s once', (value) => {
    expect(llmRouterInferenceApiUrl({ OPENCHAMBER_LLMROUTER_API_URL: value })).toBe('https://inference.example.test/v1');
  });

  it('uses the verified public inference endpoint independently of UniHub configuration', () => {
    expect(llmRouterInferenceApiUrl({ OPENCHAMBER_UNIHUB_API_URL: 'https://catalog.example.test' })).toBe('https://llmrouter.quukk.com/v1');
  });

  it.each(['https://llmrouter.quukk.com/platform/v1', 'https://user:secret@inference.example.test', 'http://inference.example.test', 'https://inference.example.test/v1?key=secret'])('rejects an invalid inference endpoint before issuing a key: %s', async (value) => {
    let called = false;
    const client = createUniHubBootstrapClient({ env: { OPENCHAMBER_LLMROUTER_API_URL: value }, platformAccount: { request: async () => { called = true; } } });
    await expect(client.issueKey({ identity: {}, accountId: 'fixture' })).rejects.toMatchObject({ code: 'model_configuration_bootstrap_endpoint_invalid' });
    expect(called).toBe(false);
  });
});
