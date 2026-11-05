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

const fixture = async ({ models = catalog, knowledgeConsumer = false, invalidEmbedding = false, beforeEmbedding, scopedKeys = false, prepareBindingChange } = {}) => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const key = req.headers.authorization === 'Bearer fixture-imported-private-key' ? 'A' : req.headers.authorization === 'Bearer fixture-second-private-key' ? 'B' : 'other';
    const request = { method: req.method, path: req.url, body: body ? JSON.parse(body) : null };
    if (scopedKeys) request.key = key;
    requests.push(request);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/models') {
      res.setHeader('x-unihub-origin-product-id', 'superwagie');
      res.setHeader('x-unihub-account-id', 'account-1');
      res.setHeader('x-unihub-instance-id', 'instance-1');
      res.end(JSON.stringify({ data: scopedKeys ? models.filter((model) => model.operations.includes(key === 'A' ? 'embedding' : 'rerank')) : models, base_url: 'https://untrusted.example.test/v1' }));
    } else if (req.url === '/v1/accounts/account-1/model-discovery') res.end(JSON.stringify({ models, origin_product_id: 'superwagie', account_id: 'account-1', instance_id: 'instance-1' }));
    else if (req.url === '/v1/accounts/account-1/api-keys') res.end(JSON.stringify({ token: 'fixture-issued-private-key' }));
    else if (knowledgeConsumer && req.url === '/v1/embeddings') {
      if (scopedKeys && key !== 'A') { res.statusCode = 403; res.end('{}'); return; }
      if (!scopedKeys) expect(req.headers.authorization).toBe('Bearer fixture-imported-private-key');
      await beforeEmbedding?.();
      res.end(JSON.stringify({ data: [{ index: 0, embedding: invalidEmbedding ? [0.25] : [0.25, 0.75] }] }));
    } else if (knowledgeConsumer && req.url === '/v1/rerank') {
      if (scopedKeys && key !== 'B') { res.statusCode = 403; res.end('{}'); return; }
      if (!scopedKeys) expect(req.headers.authorization).toBe('Bearer fixture-imported-private-key');
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
    prepareBindingChange: prepareBindingChange ?? (knowledgeConsumer ? (...args) => knowledgeRuntime.prepareModelBindingChange(...args) : undefined),
  });
  if (knowledgeConsumer) knowledgeRuntime = createKnowledgeLibraryRuntime({ dataDir, readSettings: async () => ({}), resolveModelBinding: (...args) => modelRuntime.resolveBinding(...args) });
  const uniHubClient = createUniHubBootstrapClient({ platformAccount, env });
  const runtime = createModelBootstrapRuntime({ dataDir, store, modelRuntime, platformAccount, uniHubClient, env });
  return { dataDir, requests, runtime, modelRuntime, uniHubClient, store };
};

describe('quick setup service endpoints', () => {
  it('keeps embedding on its imported key and uses the newly imported key for rerank at the same endpoint', async () => {
    const { runtime, modelRuntime, dataDir, requests, store } = await fixture({ knowledgeConsumer: true, scopedKeys: true, models: [...catalog, { id: 'fixture-rerank', operations: ['rerank'] }] });
    const importPurpose = async (key, purpose) => {
      const discovery = await runtime.discover({ source: 'imported-key', key });
      const revision = (await modelRuntime.getPublicConfiguration()).revision;
      const preview = await runtime.preview({ discoveryId: discovery.discoveryId, revision, purposes: ['embedding', 'rerank'] });
      const applied = await runtime.apply({ operationId: preview.operationId, discoveryId: discovery.discoveryId, revision });
      const tested = await modelRuntime.testBinding(purpose, { revision: applied.revision });
      return { discovery, preview, applied, tested };
    };
    const first = await importPurpose('fixture-imported-private-key', 'embedding');
    const originalBinding = first.tested.bindings.find((binding) => binding.purpose === 'embedding');
    const second = await importPurpose('fixture-second-private-key', 'rerank');
    expect(second.tested.bindings.find((binding) => binding.purpose === 'rerank').verification.status).toBe('verified');
    expect(second.applied.configuration.connections).toHaveLength(2);
    expect(second.tested.bindings.find((binding) => binding.purpose === 'embedding')).toEqual(originalBinding);
    const retested = await modelRuntime.testBinding('embedding', { revision: second.tested.revision });
    expect(retested.bindings.every((binding) => binding.verification.status === 'verified')).toBe(true);
    expect(requests.filter((entry) => entry.method === 'POST').map(({ path, key }) => ({ path, key }))).toEqual([
      { path: '/v1/embeddings', key: 'A' }, { path: '/v1/rerank', key: 'B' }, { path: '/v1/embeddings', key: 'A' },
    ]);
    for (const response of [first, second, retested]) {
      for (const secret of ['fixture-imported-private-key', 'fixture-second-private-key', 'model-bootstrap-', 'credentialFingerprint']) expect(JSON.stringify(response)).not.toContain(secret);
    }
    const saved = await fs.readFile(path.join(dataDir, 'model-configuration.json'), 'utf8');
    expect(saved).not.toContain('private-key');
    // Discovery cleanup cannot revoke either durable connection credential.
    await store.remove(first.discovery.discoveryId);
    await store.remove(second.discovery.discoveryId);
    expect((await modelRuntime.resolveBinding('embedding')).apiKey === 'fixture-imported-private-key').toBe(true);
    expect((await modelRuntime.resolveBinding('rerank')).apiKey === 'fixture-second-private-key').toBe(true);
  });

  it.each([{ label: 'same key', secondKey: 'fixture-imported-private-key' }, { label: 'different key', secondKey: 'fixture-second-private-key' }])('rolls back only the new purpose and its own credential after importing $label', async ({ secondKey }) => {
    const { runtime, modelRuntime, store, dataDir } = await fixture({ knowledgeConsumer: true, models: [...catalog, { id: 'fixture-rerank', operations: ['rerank'] }] });
    const first = await runtime.discover({ source: 'imported-key', key: 'fixture-imported-private-key' });
    const preview = await runtime.preview({ discoveryId: first.discoveryId, revision: 0, purposes: ['embedding'] });
    const before = await runtime.apply({ operationId: preview.operationId, discoveryId: first.discoveryId, revision: 0 });
    const original = JSON.parse(await fs.readFile(path.join(dataDir, 'model-configuration.json'), 'utf8'));
    const second = await runtime.discover({ source: 'imported-key', key: secondKey });
    const next = await runtime.preview({ discoveryId: second.discoveryId, revision: before.revision, purposes: ['embedding', 'rerank'] });
    expect(next.preserve.map((item) => item.purpose)).toEqual(['embedding']);
    const applied = await runtime.apply({ operationId: next.operationId, discoveryId: second.discoveryId, revision: before.revision });
    const sameKey = secondKey === 'fixture-imported-private-key';
    expect(applied.configuration.connections).toHaveLength(sameKey ? 1 : 2);
    expect(new Set(applied.configuration.bindings.map((binding) => binding.connectionId)).size).toBe(sameKey ? 1 : 2);
    expect((await modelRuntime.resolveBinding('rerank')).apiKey === secondKey).toBe(true);
    const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'model-configuration.json'), 'utf8'));
    const addedRef = sameKey ? null : saved.connections[1].credentialSource.ref;
    const restored = await runtime.rollback({ operationId: next.operationId, revision: applied.revision });
    expect(restored.configuration.connections).toEqual(before.configuration.connections);
    expect(restored.configuration.bindings).toEqual(before.configuration.bindings);
    expect(Boolean(await store.getSecret(original.connections[0].credentialSource.ref))).toBe(true);
    if (addedRef) expect(await store.getSecret(addedRef)).toBeNull();
    expect((await modelRuntime.resolveBinding('embedding')).apiKey === 'fixture-imported-private-key').toBe(true);
  });

  it.each(['revision-conflict', 'write-failure'])('preserves existing credentials when applying a second key encounters %s', async (failure, context) => {
    if (failure === 'write-failure' && process.platform === 'win32') context.skip('Directory mode bits do not deny writes on Windows');
    const { runtime, modelRuntime, dataDir } = await fixture({ models: [...catalog, { id: 'fixture-rerank', operations: ['rerank'] }] });
    const first = await runtime.discover({ source: 'imported-key', key: 'fixture-imported-private-key' });
    const preview = await runtime.preview({ discoveryId: first.discoveryId, revision: 0, purposes: ['embedding'] });
    const before = await runtime.apply({ operationId: preview.operationId, discoveryId: first.discoveryId, revision: 0 });
    const second = await runtime.discover({ source: 'imported-key', key: 'fixture-second-private-key' });
    const next = await runtime.preview({ discoveryId: second.discoveryId, revision: before.revision, purposes: ['rerank'] });
    const beforeSecrets = await fs.readFile(path.join(dataDir, 'model-bootstrap/secrets.json'), 'utf8');
    if (failure === 'revision-conflict') await modelRuntime.saveBinding('rerank', { revision: before.revision, binding: null });
    const beforeFile = await fs.readFile(path.join(dataDir, 'model-configuration.json'), 'utf8');
    if (failure === 'write-failure') await fs.chmod(dataDir, 0o500);
    try {
      await expect(runtime.apply({ operationId: next.operationId, discoveryId: second.discoveryId, revision: before.revision })).rejects.toMatchObject({ code: failure === 'revision-conflict' ? 'model_configuration_revision_conflict' : 'model_configuration_write_failed' });
    } finally {
      await fs.chmod(dataDir, 0o700);
    }
    expect(await fs.readFile(path.join(dataDir, 'model-configuration.json'), 'utf8')).toBe(beforeFile);
    expect(await fs.readFile(path.join(dataDir, 'model-bootstrap/secrets.json'), 'utf8')).toBe(beforeSecrets);
    expect((await modelRuntime.resolveBinding('embedding')).apiKey === 'fixture-imported-private-key').toBe(true);
    const applied = await runtime.store.read(next.operationId);
    expect(applied.status).toBe('previewed');
  });

  it('refuses a credential changed after reuse selection without altering bindings or revision', async () => {
    const { runtime, modelRuntime, dataDir } = await fixture({ models: [...catalog, { id: 'fixture-rerank', operations: ['rerank'] }] });
    const first = await runtime.discover({ source: 'imported-key', key: 'fixture-imported-private-key' });
    const preview = await runtime.preview({ discoveryId: first.discoveryId, revision: 0, purposes: ['embedding'] });
    const before = await runtime.apply({ operationId: preview.operationId, discoveryId: first.discoveryId, revision: 0 });
    const second = await runtime.discover({ source: 'imported-key', key: 'fixture-imported-private-key' });
    const replacement = await runtime.discover({ source: 'imported-key', key: 'fixture-second-private-key' });
    const next = await runtime.preview({ discoveryId: second.discoveryId, revision: before.revision, purposes: ['rerank'] });
    const findConnection = modelRuntime.findBootstrapConnection;
    modelRuntime.findBootstrapConnection = async (input) => {
      const id = await findConnection(input);
      const state = JSON.parse(await fs.readFile(path.join(dataDir, 'model-configuration.json'), 'utf8'));
      const replacementRecord = await runtime.store.read(replacement.discoveryId);
      const secretsPath = path.join(dataDir, 'model-bootstrap/secrets.json');
      const secrets = JSON.parse(await fs.readFile(secretsPath, 'utf8'));
      secrets[state.connections.find((connection) => connection.id === id).credentialSource.ref] = secrets[replacementRecord.secretRef];
      await fs.writeFile(secretsPath, JSON.stringify(secrets));
      return id;
    };
    const beforeFile = await fs.readFile(path.join(dataDir, 'model-configuration.json'), 'utf8');
    await expect(runtime.apply({ operationId: next.operationId, discoveryId: second.discoveryId, revision: before.revision })).rejects.toMatchObject({ code: 'model_configuration_credential_changed' });
    expect(await fs.readFile(path.join(dataDir, 'model-configuration.json'), 'utf8')).toBe(beforeFile);
  });

  it.each([{ label: 'reused', reuse: true }, { label: 'new', reuse: false }])('refuses a $label credential rotated during async preparation and cleans up only uncommitted state', async ({ reuse }) => {
    const entered = Promise.withResolvers();
    const resume = Promise.withResolvers();
    const { runtime, modelRuntime, dataDir, store } = await fixture({
      models: [...catalog, { id: 'fixture-rerank', operations: ['rerank'] }],
      prepareBindingChange: async (purpose) => {
        if (purpose !== 'rerank') return;
        entered.resolve();
        await resume.promise;
      },
    });
    const first = await runtime.discover({ source: 'imported-key', key: 'fixture-imported-private-key' });
    const preview = await runtime.preview({ discoveryId: first.discoveryId, revision: 0, purposes: ['embedding'] });
    const before = await runtime.apply({ operationId: preview.operationId, discoveryId: first.discoveryId, revision: 0 });
    const second = await runtime.discover({ source: 'imported-key', key: reuse ? 'fixture-imported-private-key' : 'fixture-second-private-key' });
    const replacement = await runtime.discover({ source: 'imported-key', key: reuse ? 'fixture-second-private-key' : 'fixture-imported-private-key' });
    const next = await runtime.preview({ discoveryId: second.discoveryId, revision: before.revision, purposes: ['rerank'] });
    const configurationPath = path.join(dataDir, 'model-configuration.json');
    const secretsPath = path.join(dataDir, 'model-bootstrap/secrets.json');
    const beforeFile = await fs.readFile(configurationPath, 'utf8');
    const beforeEntries = (await fs.readdir(dataDir)).sort();
    const beforeSecrets = JSON.parse(await fs.readFile(secretsPath, 'utf8'));
    const pending = runtime.apply({ operationId: next.operationId, discoveryId: second.discoveryId, revision: before.revision })
      .then(() => ({ status: 'committed' }), (error) => ({ status: 'refused', code: error.code, message: error.message }));
    await entered.promise;
    const secrets = JSON.parse(await fs.readFile(secretsPath, 'utf8'));
    const originalRef = JSON.parse(beforeFile).connections[0].credentialSource.ref;
    const targetRef = reuse ? originalRef : Object.keys(secrets).find((ref) => !Object.hasOwn(beforeSecrets, ref));
    expect(Boolean(targetRef)).toBe(true);
    const replacementRecord = await store.read(replacement.discoveryId);
    secrets[targetRef] = secrets[replacementRecord.secretRef];
    try {
      await fs.writeFile(secretsPath, JSON.stringify(secrets));
    } finally {
      resume.resolve();
    }
    expect(await pending).toEqual({ status: 'refused', code: 'model_configuration_credential_changed', message: 'model_configuration_credential_changed' });
    expect(await fs.readFile(configurationPath, 'utf8')).toBe(beforeFile);
    expect((await fs.readdir(dataDir)).sort()).toEqual(beforeEntries);
    const expectedSecrets = { ...secrets };
    if (!reuse) delete expectedSecrets[targetRef];
    expect(JSON.parse(await fs.readFile(secretsPath, 'utf8'))).toEqual(expectedSecrets);
    expect((await store.read(next.operationId)).status).toBe('previewed');
    if (!reuse) {
      expect(await store.getSecret(targetRef)).toBeNull();
      expect((await modelRuntime.resolveBinding('embedding')).apiKey === 'fixture-imported-private-key').toBe(true);
    }
  });

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

  it.each(['result', 'probe-error', 'conflict', 'remaining-stale', 'complete', 'missing-record'])('ends the run when its %s write fails without dispatching another probe', async (phase) => {
    let editConfiguration;
    const conflict = ['conflict', 'remaining-stale'].includes(phase);
    const { runtime, modelRuntime, requests } = await fixture({ knowledgeConsumer: true, beforeEmbedding: conflict ? () => editConfiguration() : undefined, models: [...catalog, { id: 'qwen3-rerank', operations: ['rerank'] }] });
    const discovery = await runtime.discover({ source: 'imported-key', key: 'fixture-imported-private-key' });
    const preview = await runtime.preview({ discoveryId: discovery.discoveryId, revision: 0, purposes: phase === 'probe-error' ? ['rerank'] : ['embedding', 'rerank'] });
    const applied = await runtime.apply({ operationId: preview.operationId, discoveryId: discovery.discoveryId, revision: 0 });
    editConfiguration = () => modelRuntime.saveBinding('rerank', { revision: applied.revision, binding: { connectionId: applied.configuration.connections[0].id, model: 'edited-rerank', parameters: {} } });
    const update = runtime.store.update;
    let failed = false;
    runtime.store.update = async (id, change) => {
      const current = await runtime.store.read(id);
      const next = change instanceof Function ? await change(current) : { ...current, ...change };
      const matches = phase === 'complete' ? next.status === 'complete'
        : phase === 'remaining-stale' ? next.statuses.rerank.status === 'stale'
          : next.statuses.embedding.status !== 'pending';
      if (!failed && matches) {
        failed = true;
        if (phase === 'missing-record') return null;
        throw new Error('fixture-private-storage-error');
      }
      return update(id, change);
    };
    const run = await runtime.startTests({ revision: applied.revision, purposes: ['embedding', 'rerank'] });
    await expect.poll(() => runtime.readTestRun(run.testRunId), { timeout: 500 }).toMatchObject({ status: 'failed' });
    const result = await runtime.readTestRun(run.testRunId);
    expect(result.purposes.embedding).toEqual(phase === 'probe-error'
      ? { status: 'failed', errorCode: 'model_configuration_binding_missing' }
      : conflict ? { status: 'stale', errorCode: 'model_configuration_revision_conflict' } : { status: 'verified' });
    expect(result.purposes.rerank).toEqual(phase === 'complete' ? { status: 'verified' }
      : phase === 'remaining-stale' ? { status: 'stale', errorCode: 'model_configuration_revision_conflict' }
        : { status: 'failed', errorCode: 'model_configuration_bootstrap_test_state_failed' });
    await expect.poll(() => runtime.store.read(run.testRunId)).toMatchObject({ status: 'failed' });
    expect(requests.map((entry) => entry.path)).toEqual(phase === 'probe-error' ? ['/v1/models']
      : phase === 'complete' ? ['/v1/models', '/v1/embeddings', '/v1/rerank'] : ['/v1/models', '/v1/embeddings']);
    expect(JSON.stringify(result)).not.toContain('fixture-private-storage-error');
    expect(failed).toBe(true);
  });

  it.each([false, true])('keeps a safe terminal result readable when failure writes persist and read failure is %s', async (failRead) => {
    const { runtime, modelRuntime, requests } = await fixture({ knowledgeConsumer: true, models: [...catalog, { id: 'qwen3-rerank', operations: ['rerank'] }] });
    const discovery = await runtime.discover({ source: 'imported-key', key: 'fixture-imported-private-key' });
    const preview = await runtime.preview({ discoveryId: discovery.discoveryId, revision: 0, purposes: ['embedding', 'rerank'] });
    const applied = await runtime.apply({ operationId: preview.operationId, discoveryId: discovery.discoveryId, revision: 0 });
    const update = runtime.store.update;
    const read = runtime.store.read;
    let unavailable = false;
    runtime.store.update = async (id, change) => {
      if (unavailable) throw new Error('fixture-private-write-error');
      const current = await read(id);
      const next = change instanceof Function ? await change(current) : { ...current, ...change };
      if (next.statuses.embedding.status === 'verified') {
        unavailable = true;
        throw new Error('fixture-private-write-error');
      }
      return update(id, change);
    };
    runtime.store.read = async (id) => {
      if (unavailable && failRead) throw new Error('fixture-private-read-error');
      return read(id);
    };
    const run = await runtime.startTests({ revision: applied.revision, purposes: ['embedding', 'rerank'] });
    await expect.poll(() => runtime.readTestRun(run.testRunId), { timeout: 500 }).toMatchObject({ status: 'failed' });
    for (let index = 0; index < 3; index++) {
      const result = await runtime.readTestRun(run.testRunId);
      expect(result).toMatchObject({ status: 'failed', purposes: { embedding: { status: 'verified' }, rerank: { status: 'failed', errorCode: 'model_configuration_bootstrap_test_state_failed' } } });
      expect(JSON.stringify(result)).not.toContain('fixture-private-');
    }
    expect(requests.map((entry) => entry.path)).toEqual(['/v1/models', '/v1/embeddings']);
    runtime.store.update = update;
    runtime.store.read = read;
    const current = await modelRuntime.getPublicConfiguration();
    const next = await runtime.startTests({ revision: current.revision, purposes: ['rerank'] });
    await expect.poll(() => runtime.readTestRun(next.testRunId)).toMatchObject({ status: 'complete', purposes: { rerank: { status: 'verified' } } });
    expect((await runtime.readTestRun(run.testRunId)).status).toBe('failed');
    expect(requests.map((entry) => entry.path)).toEqual(['/v1/models', '/v1/embeddings', '/v1/rerank']);
  });

  it.each([[false, false], [false, true], [true, false], [true, true]])('prefers a newly failed run over an in-flight read: read failure %s, terminal persistence %s', async (rejectRead, persistTerminal) => {
    const probeGate = Promise.withResolvers();
    const readGate = Promise.withResolvers();
    const readStarted = Promise.withResolvers();
    const { runtime, requests } = await fixture({ knowledgeConsumer: true, beforeEmbedding: () => probeGate.promise, models: [...catalog, { id: 'qwen3-rerank', operations: ['rerank'] }] });
    const discovery = await runtime.discover({ source: 'imported-key', key: 'fixture-imported-private-key' });
    const preview = await runtime.preview({ discoveryId: discovery.discoveryId, revision: 0, purposes: ['embedding', 'rerank'] });
    const applied = await runtime.apply({ operationId: preview.operationId, discoveryId: discovery.discoveryId, revision: 0 });
    const update = runtime.store.update;
    const read = runtime.store.read;
    let holdRead = true;
    runtime.store.read = async (id) => {
      const before = await read(id);
      if (!holdRead) return before;
      holdRead = false;
      readStarted.resolve();
      await readGate.promise;
      if (rejectRead) throw new Error('fixture-private-delayed-read-error');
      return before;
    };
    runtime.store.update = async (id, change) => {
      const current = await read(id);
      const next = change instanceof Function ? await change(current) : { ...current, ...change };
      if (next.statuses.embedding.status === 'verified' && (!persistTerminal || next.status !== 'failed')) throw new Error('fixture-private-write-error');
      return update(id, change);
    };
    const run = await runtime.startTests({ revision: applied.revision, purposes: ['embedding', 'rerank'] });
    const pendingRead = runtime.readTestRun(run.testRunId).then((value) => ({ value }), (error) => ({ error }));
    await readStarted.promise;
    probeGate.resolve();
    await expect.poll(() => runtime.readTestRun(run.testRunId)).toMatchObject({ status: 'failed' });
    if (persistTerminal) await expect.poll(() => read(run.testRunId)).toMatchObject({ status: 'failed' });
    readGate.resolve();
    const observed = await pendingRead;
    expect(observed).toMatchObject({ value: { status: 'failed', purposes: { embedding: { status: 'verified' }, rerank: { status: 'failed' } } } });
    expect(observed.error).toBeUndefined();
    expect(requests.map((entry) => entry.path)).toEqual(['/v1/models', '/v1/embeddings']);
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
