import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { createKnowledgeLibraryRuntime } from './runtime.js';
import { createModelConfigurationRuntime } from '../model-configuration/runtime.js';
import { DEFAULTS_VERSION } from '../embedded-knowledge/provision.js';
import { createKnowledgeLibraryStore } from './store.js';

const respond = (res, status, body) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
};

/**
 * A stand-in for the knowledge backend endpoints the runtime actually calls. The runtime
 * adopts it through `/health`, so no process is spawned.
 */
const startFakeBackend = async ({ images = [] } = {}) => {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push({ method: req.method, url: req.url });
    if (req.url === '/health') return respond(res, 200, { status: 'ok' });
    if (req.url.startsWith('/api/v1/knowledge-bases/kb1/images?')) return respond(res, 200, { data: images, total: images.length });
    if (req.url === '/api/v1/knowledge-bases/kb1/knowledge/ref') return respond(res, 200, { data: { id: 'k1' } });
    if (req.url === '/api/v1/knowledge/k1/reparse') return respond(res, 200, { success: true });
    if (req.url === '/api/v1/knowledge/k1' && req.method === 'GET') {
      return respond(res, 200, { data: { id: 'k1', parse_status: 'completed', pending_subtasks_count: 0 } });
    }
    if (req.url === '/api/v1/knowledge/k1' && req.method === 'DELETE') return respond(res, 200, { success: true });
    if (req.url === '/api/v1/chunks/k1') {
      return respond(res, 200, { data: [{ seq_id: 2, content: 'beta' }, { seq_id: 1, content: 'alpha' }] });
    }
    if (req.url === '/api/v1/knowledge-bases/kb1/hybrid-search') {
      return respond(res, 200, {
        data: [{ knowledge_id: 'k1', content: 'alpha', score: 1, chunk_index: 0, start_at: 0, end_at: 5 }],
      });
    }
    return respond(res, 404, { error: 'unexpected ' + req.url });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, calls, port: server.address().port };
};

const waitFor = async (predicate, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
};

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

const setup = async ({ images = [] } = {}) => {
  const backend = await startFakeBackend({ images });
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sw-kb-runtime-'));
  const libraryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sw-kb-files-'));
  await fs.writeFile(path.join(libraryRoot, 'a.md'), '# alpha\n\nbody');
  await fs.writeFile(path.join(libraryRoot, 'skip.exe'), 'binary');
  const past = new Date(Date.now() - 60_000);
  await fs.utimes(path.join(libraryRoot, 'a.md'), past, past);

  const settings = {
    knowledgeLibraryEnabled: true,
    embeddedKnowledgePort: backend.port,
    embeddedKnowledgeTenantId: 5,
    embeddedKnowledgeApiKey: 'runtime-token',
    embeddedKnowledgeBaseId: 'kb1',
    embeddedKnowledgeDefaultsVersion: DEFAULTS_VERSION,
  };
  const runtime = createKnowledgeLibraryRuntime({
    dataDir,
    readSettings: async () => settings,
    saveSettings: async (patch) => Object.assign(settings, patch),
    resolveBinaryPath: () => '/bin/true',
    fetchImpl: fetch,
  });
  cleanups.push(() => runtime.stop());
  cleanups.push(() => new Promise((resolve) => backend.server.close(resolve)));
  return { runtime, backend, libraryRoot, settings, dataDir };
};

const setupConfiguredBackend = async ({ adopted = false, provisioned = true } = {}) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sw-kb-model-hosts-'));
  vi.stubEnv('OPENCHAMBER_EMBEDDED_KNOWLEDGE_IMPORT_DB', path.join(dataDir, 'absent-import.db'));
  const enterpriseEnv = {};
  const store = createKnowledgeLibraryStore({ dataDir });
  const modelConfiguration = createModelConfigurationRuntime({
    dataDir,
    enterpriseOptions: {
      env: enterpriseEnv,
      readFile: () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); },
    },
  });
  const settings = {
    knowledgeLibraryEnabled: true,
    embeddedKnowledgePort: 17809,
    embeddedKnowledgeTenantId: 5,
    embeddedKnowledgeLocalEmail: 'fixture@local.invalid',
    embeddedKnowledgeLocalPassword: 'fixture-password',
    embeddedKnowledgeDefaultsVersion: provisioned ? DEFAULTS_VERSION : 0,
  };
  if (provisioned) {
    settings.embeddedKnowledgeApiKey = 'fixture-runtime-token';
    settings.embeddedKnowledgeBaseId = 'kb1';
  }
  const models = provisioned ? [
    { id: 'e1', name: 'text-embedding-v4', type: 'Embedding', parameters: { base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1' } },
    { id: 'v1', name: 'legacy-vision', type: 'VLLM', parameters: { base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1' } },
  ] : [];
  const base = { id: 'kb1', name: 'Fixture', embedding_model_id: 'e1', vlm_config: { enabled: true, model_id: 'v1' } };
  let baseCreated = provisioned;
  const spawns = [];
  const updates = [];
  let child = null;
  let kills = 0;
  let rejectModelUpdates = false;
  let activeHosts = 'dashscope.aliyuncs.com';
  let searchBarrier = null;
  let searchEntered = null;
  let spawnFailure = null;
  let externalRunning = adopted;
  let adoptOnRestart = false;
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, options = {}) => {
    const route = new URL(url).pathname;
    if (route === '/health') return json({ status: child || externalRunning ? 'ok' : 'stopped' }, child || externalRunning ? 200 : 503);
    if (route === '/api/v1/auth/login') return json({ token: 'fixture-session', user: { tenant_id: 5 } });
    if (route === '/api/v1/models') {
      if (options.method === 'POST') {
        const model = JSON.parse(options.body);
        const host = new URL(model.parameters.base_url).hostname.replace(/^\[|\]$/g, '');
        if (!activeHosts.split(',').includes(host)) return json({ error: 'SSRF rejected fixture model host' }, 500);
        const created = { ...model, id: `m${models.length + 1}` };
        models.push(created);
        return json({ data: created });
      }
      return json({ data: models });
    }
    if (route.startsWith('/api/v1/models/') && options.method === 'PUT') {
      const model = JSON.parse(options.body);
      const host = new URL(model.parameters.base_url).hostname.replace(/^\[|\]$/g, '');
      if (rejectModelUpdates || !activeHosts.split(',').includes(host)) return json({ error: 'SSRF rejected fixture model host' }, 500);
      Object.assign(models.find((entry) => route.endsWith(`/${entry.id}`)), model);
      updates.push(model);
      return json({ data: model });
    }
    if (route === '/api/v1/knowledge-bases') {
      if (options.method === 'POST') {
        Object.assign(base, JSON.parse(options.body));
        baseCreated = true;
        return json({ data: base });
      }
      return json({ data: baseCreated ? [base] : [] });
    }
    if (route === '/api/v1/knowledge-bases/kb1') {
      if (options.method === 'PUT') Object.assign(base, JSON.parse(options.body));
      return json({ data: base });
    }
    if (route === '/api/v1/system/parser-engines') return json({ data: [] });
    if (route === '/api/v1/tenants/5/api-keys') return json({ data: { id: 'key1', token: 'fixture-runtime-token' } });
    if (route === '/api/v1/knowledge-bases/kb1/knowledge') return json({ data: [], total: 0 });
    if (route === '/api/v1/knowledge-bases/kb1/hybrid-search') {
      searchEntered?.();
      if (searchBarrier) await searchBarrier;
      return json({ data: [] });
    }
    throw new Error(`Unexpected fixture backend route ${route}`);
  };
  const runtime = createKnowledgeLibraryRuntime({
    dataDir,
    readSettings: async () => settings,
    saveSettings: async (patch) => Object.assign(settings, patch),
    resolveBinaryPath: () => '/fixture/embedded-knowledge',
    resolveModelBinding: modelConfiguration.resolveBinding,
    fetchImpl,
    spawnImpl: (_binary, _args, options) => {
      spawns.push(options.env);
      if (spawnFailure) {
        const error = spawnFailure;
        spawnFailure = null;
        throw error;
      }
      activeHosts = options.env.SSRF_WHITELIST_EXTRA;
      const current = new EventEmitter();
      current.exitCode = null;
      current.stderr = new EventEmitter();
      current.kill = () => {
        kills += 1;
        current.exitCode = 0;
        child = null;
        if (adoptOnRestart) externalRunning = true;
        current.emit('exit', 0, null);
      };
      child = current;
      return current;
    },
    log: { warn() {} },
  });
  cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
  cleanups.push(() => runtime.stop());
  const connectPurpose = async (purpose, baseUrl, apiKey, model) => {
    const { revision, connections } = await modelConfiguration.getPublicConfiguration();
    const name = `Fixture ${purpose}`;
    const existing = connections.find((connection) => connection.name === name);
    const connectionInput = { name, providerId: 'deepseek', protocol: 'openai-compatible', baseUrl, apiKey };
    if (existing) connectionInput.id = existing.id;
    const configuration = await modelConfiguration.saveConnection({ revision, connection: connectionInput });
    const connection = configuration.connections.find((entry) => entry.name === name);
    return modelConfiguration.saveBinding(purpose, { revision: configuration.revision, binding: { connectionId: connection.id, model, parameters: {} } });
  };
  return {
    runtime, modelConfiguration, enterpriseEnv, models, spawns, updates, store,
    connectVision: (baseUrl = 'https://api.deepseek.com/v1', apiKey = 'fixture-vision-key') => connectPurpose('vision', baseUrl, apiKey, 'deepseek-flash'),
    connectEmbedding: () => connectPurpose('embedding', 'https://embed.fixture.example/v1', 'fixture-embedding-key', 'fixture-embedding'),
    kills: () => kills,
    rejectModelUpdates: () => { rejectModelUpdates = true; },
    failNextSpawn: () => { spawnFailure = new Error('Fixture spawn failed'); },
    adoptOnNextRestart: () => { adoptOnRestart = true; },
    holdSearch: () => {
      let release;
      searchBarrier = new Promise((resolve) => { release = resolve; });
      const entered = new Promise((resolve) => { searchEntered = resolve; });
      return { entered, release: () => { searchBarrier = null; searchEntered = null; release(); } };
    },
  };
};

describe('knowledge model hosts', () => {
  it('applies a newly bound host before activating an unprovisioned backend', async () => {
    const { runtime, connectEmbedding, spawns, models } = await setupConfiguredBackend({ provisioned: false });
    await runtime.start();
    await connectEmbedding();
    await expect(runtime.provision('fixture-legacy-key')).resolves.toEqual({ ok: true, knowledgeBaseId: 'kb1' });
    expect(models).toMatchObject([{ name: 'fixture-embedding', parameters: { base_url: 'https://embed.fixture.example/v1' } }]);
    expect(spawns).toHaveLength(3);
    expect(spawns[1].SSRF_WHITELIST_EXTRA.split(',')).toContain('embed.fixture.example');
  });

  it('starts with exact bound hosts and the observed PaddleOCR result hosts', async () => {
    const { runtime, connectVision, spawns, updates, modelConfiguration } = await setupConfiguredBackend();
    await connectVision();
    const { revision } = await modelConfiguration.getPublicConfiguration();
    await modelConfiguration.saveConnection({ revision, connection: {
      name: 'Unbound', providerId: 'custom', protocol: 'openai-compatible', baseUrl: 'https://unbound.example/v1', apiKey: 'fixture-unbound-key',
    } });
    await runtime.start();
    expect(spawns[0].SSRF_WHITELIST_EXTRA.split(',')).toEqual(expect.arrayContaining([
      'api.deepseek.com',
      'paddleocr-store.bj.bcebos.com',
      'paddleocr-store-2.bj.bcebos.com',
      'paddleocr-store-3.bj.bcebos.com',
    ]));
    expect(spawns[0].SSRF_WHITELIST_EXTRA).not.toMatch(/unbound\.example|\*|fixture-vision-key/);
    expect(updates.at(-1)).toMatchObject({ name: 'deepseek-flash', parameters: { base_url: 'https://api.deepseek.com/v1' } });
  });

  it('applies a new bound host before concurrent consumers and retains it on key rotation and unbinding', async () => {
    const { runtime, connectVision, spawns, updates, modelConfiguration, kills } = await setupConfiguredBackend();
    await runtime.start();
    await connectVision('https://coding.dashscope.aliyuncs.com/v1');
    const results = await Promise.all([runtime.search({ query: 'one' }), runtime.search({ query: 'two' })]);
    expect(results.every((result) => Array.isArray(result.passages))).toBe(true);
    expect(spawns).toHaveLength(2);
    expect(kills()).toBe(1);
    expect(spawns[1].SSRF_WHITELIST_EXTRA.split(',')).toContain('coding.dashscope.aliyuncs.com');
    await connectVision('https://coding.dashscope.aliyuncs.com/v1', 'fixture-rotated-key');
    await runtime.search({ query: 'rotated' });
    expect(updates.at(-1).parameters.api_key).toBe('fixture-rotated-key');
    const { revision } = await modelConfiguration.getPublicConfiguration();
    await modelConfiguration.saveBinding('vision', { revision, binding: null });
    await runtime.search({ query: 'unbound' });
    expect(spawns).toHaveLength(2);
    expect(kills()).toBe(1);
  });

  it('does not restart an adopted backend when a new bound host needs its owner', async () => {
    const { runtime, connectVision, spawns, kills } = await setupConfiguredBackend({ adopted: true });
    await runtime.start();
    await connectVision();
    await expect(runtime.search({ query: 'one' })).rejects.toMatchObject({ code: 'model_configuration_knowledge_restart_required' });
    await expect(runtime.search({ query: 'retry' })).rejects.toMatchObject({ code: 'model_configuration_knowledge_restart_required' });
    expect(spawns).toEqual([]);
    expect(kills()).toBe(0);
  });

  it('does not claim the refreshed environment was applied when restart adopts another owner', async () => {
    const { runtime, connectVision, adoptOnNextRestart, spawns, updates, kills } = await setupConfiguredBackend();
    await runtime.start();
    await connectVision();
    adoptOnNextRestart();
    await expect(runtime.search({ query: 'first' })).rejects.toMatchObject({ code: 'model_configuration_knowledge_restart_required' });
    await expect(runtime.search({ query: 'retry' })).rejects.toMatchObject({ code: 'model_configuration_knowledge_restart_required' });
    expect(spawns).toHaveLength(1);
    expect(kills()).toBe(1);
    expect(updates).toEqual([]);
  });

  it('preserves an adopted backend rejection code without claiming its environment was applied', async () => {
    const { runtime, connectVision, spawns, kills } = await setupConfiguredBackend({ adopted: true });
    await connectVision();
    await expect(runtime.start()).rejects.toMatchObject({ code: 'backend_error', name: 'ProvisionError' });
    expect(spawns).toEqual([]);
    expect(kills()).toBe(0);
  });

  it('waits for an in-flight search before restarting for a newly bound host', async () => {
    const { runtime, connectVision, holdSearch, spawns, kills, store } = await setupConfiguredBackend();
    await runtime.start();
    await store.writeDocuments({ d1: { id: 'd1', libraryId: 'l1', relPath: 'a.md', absPath: '/fixture/a.md', state: 'ready', knowledgeId: 'k1' } });
    const held = holdSearch();
    const first = runtime.search({ query: 'first' });
    await held.entered;
    await connectVision();
    const second = runtime.search({ query: 'second' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(kills()).toBe(0);
    held.release();
    await Promise.all([first, second]);
    expect(spawns).toHaveLength(2);
    expect(kills()).toBe(1);
  });

  it('uses an exact unbracketed IPv6 host for a local knowledge binding', async () => {
    const { runtime, connectVision, spawns } = await setupConfiguredBackend();
    await connectVision('http://[::1]:11434/v1');
    await runtime.start();
    expect(spawns[0].SSRF_WHITELIST_EXTRA.split(',')).toContain('::1');
    expect(spawns[0].SSRF_WHITELIST_EXTRA).not.toContain('[::1]');
  });

  it('retries a failed environment refresh without treating its host as applied', async () => {
    const { runtime, connectVision, failNextSpawn, spawns, kills } = await setupConfiguredBackend();
    await runtime.start();
    await connectVision();
    failNextSpawn();
    await expect(runtime.search({ query: 'first' })).rejects.toThrow('Fixture spawn failed');
    await expect(runtime.search({ query: 'retry' })).resolves.toMatchObject({ query: 'retry', passages: [] });
    expect(spawns).toHaveLength(3);
    expect(kills()).toBe(1);
  });

  it('refuses enterprise external binding resolution before any restart or model write', async () => {
    const { runtime, connectVision, enterpriseEnv, spawns, updates } = await setupConfiguredBackend();
    await runtime.start();
    await connectVision();
    enterpriseEnv.OPENCHAMBER_ENTERPRISE_MODE = '1';
    await expect(runtime.search({ query: 'one' })).rejects.toMatchObject({ code: 'enterprise_mode' });
    expect(spawns).toHaveLength(1);
    expect(updates).toEqual([]);
  });

  it.each(['https://safe.example,*.example/v1', 'https://safe.example%2cother.example/v1', 'https://*.example/v1'])(
    'rejects whitelist rule syntax in a saved endpoint %s', async (baseUrl) => {
      const { runtime, connectVision, spawns } = await setupConfiguredBackend();
      await connectVision(baseUrl);
      await expect(runtime.start()).rejects.toMatchObject({ code: 'model_configuration_invalid_input' });
      expect(spawns).toEqual([]);
    },
  );

  it('maps an asynchronous post-provision synchronization failure into the provision result', async () => {
    const { runtime, connectVision, rejectModelUpdates } = await setupConfiguredBackend();
    await connectVision('https://dashscope.aliyuncs.com/compatible-mode/v1');
    await runtime.start();
    rejectModelUpdates();
    await expect(runtime.provision('fixture-legacy-key')).resolves.toEqual({ error: 'backend_error' });
    expect(runtime.status().error).toBe('backend_error');
  });
});

describe('knowledge library runtime end to end', () => {
  it('links gallery images to their exact source beyond the limited document list', async () => {
    const { runtime, dataDir } = await setup({ images: [
      { id: 'i1', knowledge_id: 'k2', source_name: 'report.pdf', caption: 'Second report', url: 'resource://second' },
      { id: 'i2', knowledge_id: 'k1', source_name: 'report.pdf', caption: 'First report', url: 'resource://first' },
    ] });
    await runtime.start();
    const store = createKnowledgeLibraryStore({ dataDir });
    await store.writeDocuments({
      d1: { id: 'd1', libraryId: 'l1', relPath: 'reports/report.pdf', absPath: '/first/reports/report.pdf', state: 'ready', knowledgeId: 'k1' },
      d2: { id: 'd2', libraryId: 'l2', relPath: 'report.pdf', absPath: '/second/report.pdf', state: 'ready', knowledgeId: 'k2' },
    });

    const visibleDocuments = await runtime.listDocuments({ limit: 1 });
    expect(visibleDocuments.documents.map(({ id }) => id)).toEqual(['d2']);
    await expect(runtime.listImages()).resolves.toEqual({ images: [
      { id: 'i1', source: { documentId: 'd2', path: '/second/report.pdf', relPath: 'report.pdf' }, sourceName: 'report.pdf', caption: 'Second report', url: 'resource://second' },
      { id: 'i2', source: { documentId: 'd1', path: '/first/reports/report.pdf', relPath: 'reports/report.pdf' }, sourceName: 'report.pdf', caption: 'First report', url: 'resource://first' },
    ], total: 2 });
  });

  it('leaves gallery sources unlinked when their knowledge record has no ready ledger document', async () => {
    const { runtime, dataDir } = await setup({ images: [
      { id: 'unknown', knowledge_id: 'external', source_name: 'report.pdf', caption: '', url: 'resource://unknown' },
      { id: 'missing', knowledge_id: 'missing', source_name: 'report.pdf', caption: '', url: 'resource://missing' },
      { id: 'parsing', knowledge_id: 'parsing', source_name: 'report.pdf', caption: '', url: 'resource://parsing' },
      { id: 'no-source', source_name: 'report.pdf', caption: '', url: 'resource://no-source' },
    ] });
    await runtime.start();
    const store = createKnowledgeLibraryStore({ dataDir });
    await store.writeDocuments({
      d1: { id: 'd1', libraryId: 'l1', relPath: 'report.pdf', absPath: '/first/report.pdf', state: 'ready', knowledgeId: 'k1' },
      d2: { id: 'd2', libraryId: 'l1', relPath: 'old/report.pdf', absPath: '/first/old/report.pdf', state: 'missing', knowledgeId: 'missing' },
      d3: { id: 'd3', libraryId: 'l1', relPath: 'new/report.pdf', absPath: '/first/new/report.pdf', state: 'parsing', knowledgeId: 'parsing' },
      d4: { id: 'd4', libraryId: 'l1', relPath: 'draft/report.pdf', absPath: '/first/draft/report.pdf', state: 'ready' },
    });

    const result = await runtime.listImages();
    expect(result.images.map(({ id, source }) => ({ id, source }))).toEqual([
      { id: 'unknown', source: null },
      { id: 'missing', source: null },
      { id: 'parsing', source: null },
      { id: 'no-source', source: null },
    ]);
  });

  it('adopts the backend, indexes a folder, searches it, reads it and removes it', async () => {
    const { runtime, backend, libraryRoot } = await setup();
    const status = await runtime.start();
    expect(status.backend.state).toBe('running');

    const preview = await runtime.previewLibrary(libraryRoot);
    expect(preview).toMatchObject({ total: 2, indexable: 1, skipped: 1 });
    expect(preview.estimate.tokensMin).toBeGreaterThan(0);
    expect(preview.estimate.tokensMax).toBeGreaterThanOrEqual(preview.estimate.tokensMin);
    expect(preview.estimate.secondsMax).toBeGreaterThan(0);

    const added = await runtime.addLibrary(libraryRoot);
    expect(added.library).toMatchObject({ root: libraryRoot, enabled: true });

    const ready = await waitFor(async () => {
      const { documents } = await runtime.listDocuments({ libraryId: added.library.id });
      return documents.some((document) => document.state === 'ready');
    });
    expect(ready).toBe(true);

    const { documents } = await runtime.listDocuments({ libraryId: added.library.id });
    // Unsupported files are counted, not listed: the tree is the index.
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({ relPath: 'a.md', state: 'ready' });
    const libraries = await runtime.readLibraries();
    expect(libraries[0].stats).toMatchObject({ files: 2, indexable: 1, skipped: 1 });
    const registration = backend.calls.find((call) => call.url.endsWith('/knowledge/ref'));
    expect(registration).toBeTruthy();

    const found = await runtime.search({ query: 'a' });
    expect(found.documents.map((entry) => entry.relPath)).toContain('a.md');
    expect(found.passages).toHaveLength(1);

    const document = documents.find((entry) => entry.relPath === 'a.md');
    const content = await runtime.readContent(document.id);
    expect(content.content).toBe('alpha\n\nbeta');

    const removed = await runtime.removeLibrary(added.library.id);
    expect(removed).toEqual({ ok: true });
    expect(await runtime.readLibraries()).toEqual([]);
    expect((await runtime.listDocuments()).documents).toEqual([]);
  });

  it('removes one file from the library and keeps it out of the next scan', async () => {
    const { runtime, backend, libraryRoot } = await setup();
    await runtime.start();
    const added = await runtime.addLibrary(libraryRoot);
    await waitFor(async () => {
      const { documents } = await runtime.listDocuments({ libraryId: added.library.id });
      return documents.some((document) => document.relPath === 'a.md' && document.state === 'ready');
    });

    const { documents } = await runtime.listDocuments({ libraryId: added.library.id });
    const target = documents.find((document) => document.relPath === 'a.md');
    expect(target).toBeTruthy();
    expect(await runtime.removeDocument(target.id)).toEqual({ ok: true });
    expect((await runtime.listDocuments({ libraryId: added.library.id })).documents).toEqual([]);
    expect(backend.calls.some((call) => call.method === 'DELETE' && call.url === '/api/v1/knowledge/k1')).toBe(true);

    // The file still exists on disk, but a rescan must not bring it back.
    await runtime.rescan(added.library.id);
    expect((await runtime.listDocuments({ libraryId: added.library.id })).documents).toEqual([]);
  });

  it('holds a freshly written file until it settles, then indexes it', async () => {
    const { runtime, libraryRoot } = await setup();
    await runtime.start();
    const fresh = path.join(libraryRoot, 'fresh.md');
    await fs.writeFile(fresh, '# fresh');
    const added = await runtime.addLibrary(libraryRoot);
    expect(added.library).toBeTruthy();

    const indexed = await waitFor(async () => {
      const { documents } = await runtime.listDocuments({ libraryId: added.library.id });
      return documents.some((document) => document.relPath === 'fresh.md' && document.state === 'ready');
    }, 10_000);
    expect(indexed).toBe(true);
  });

  it('rejects a relative path before touching the backend', async () => {
    const { runtime } = await setup();
    await runtime.start();
    await expect(runtime.addLibrary('relative/dir')).resolves.toEqual({ error: 'path_not_absolute' });
  });

  it('reports not-installed when no binary is configured', async () => {
    const { settings } = await setup();
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sw-kb-none-'));
    const runtime = createKnowledgeLibraryRuntime({
      dataDir,
      readSettings: async () => settings,
      resolveBinaryPath: () => null,
    });
    cleanups.push(() => runtime.stop());
    const status = await runtime.start();
    expect(status.supported).toBe(false);
    expect(status.backend.state).toBe('not-installed');
  });

  it('keeps the actual start failure after an explicit retry', async () => {
    const backend = await startFakeBackend();
    cleanups.push(() => new Promise((resolve) => backend.server.close(resolve)));
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sw-kb-start-error-'));
    let failStart = true;
    const runtime = createKnowledgeLibraryRuntime({
      dataDir,
      readSettings: async () => ({
        knowledgeLibraryEnabled: true,
        embeddedKnowledgePort: backend.port,
        embeddedKnowledgeApiKey: 'runtime-token',
        embeddedKnowledgeBaseId: 'kb1',
      }),
      resolveBinaryPath: () => '/fixture/embedded-knowledge',
      resolveModelBinding: async () => {
        if (failStart) {
          throw Object.assign(new Error('invalid saved endpoint'), { code: 'model_configuration_invalid_input' });
        }
        return null;
      },
    });
    cleanups.push(() => runtime.stop());
    cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));

    await expect(runtime.start()).rejects.toMatchObject({ code: 'model_configuration_invalid_input' });
    expect(runtime.status().backend).toMatchObject({
      state: 'stopped',
      error: 'model_configuration_invalid_input',
      logPath: path.join(dataDir, 'embedded-knowledge', 'app.log'),
    });

    const retried = await runtime.reconnect();
    expect(retried.backend).toMatchObject({
      state: 'stopped',
      error: 'model_configuration_invalid_input',
    });

    failStart = false;
    const recovered = await runtime.reconnect();
    expect(recovered.backend).toMatchObject({ state: 'running', error: null });
  });
});
