import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { BUNDLED_PRODUCT_HELP_CONTENT } from './content.js';
import { createProductHelpContentStore, getProductHelpContent } from './content-store.js';
import { answerProductHelp } from './service.js';

const folders = [];
const sourceUrl = 'https://help.example.test/product-help/v1/catalog.json';
beforeEach(() => {
  vi.stubEnv('OPENCHAMBER_PRODUCT_HELP_UPDATES', '1');
  vi.stubEnv('OPENCHAMBER_PRODUCT_HELP_URL', '');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(folders.splice(0).map((folder) => fs.rm(folder, { recursive: true, force: true })));
});

const fixture = async (options = {}) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'product-help-content-'));
  folders.push(folder);
  const cacheFile = path.join(folder, 'content-cache.json');
  const content = (revision = 900001, extra = {}) => ({
    schemaVersion: 1, catalogVersion: `help-${revision}`, revision, minAppVersion: '0.0.0',
    articles: [{ id: 'models-first-connection', keywords: ['new setup'],
      en: { title: `Model setup ${revision}`, text: 'Open model settings.' },
      'zh-CN': { title: `模型设置 ${revision}`, text: '打开模型设置。' } }],
    ...extra,
  });
  return {
    baseline: BUNDLED_PRODUCT_HELP_CONTENT, cacheFile, folder, content,
    create: (overrides = {}) => createProductHelpContentStore({
      sourceUrl, cacheFile, ...options, ...overrides,
    }),
  };
};

describe('product help content store', () => {
  it('downloads the version 2 public feed by default', async () => {
    const f = await fixture();
    const urls = [];
    await f.create({ sourceUrl: undefined, fetchImpl: async (url) => {
      urls.push(url);
      return Response.json(f.baseline);
    } }).getSnapshot();
    expect(urls).toEqual(['https://www.superwagie.com/product-help/v2/catalog.json']);
  });

  it('persists legacy feed mappings as schema 2 and restores them offline', async () => {
    const f = await fixture();
    const snapshot = await f.create({ fetchImpl: async () => Response.json(f.content()) }).getSnapshot();
    expect(snapshot.schemaVersion).toBe(2);
    const cached = JSON.parse(await fs.readFile(f.cacheFile, 'utf8'));
    expect(cached.sourceUrl).toBe(sourceUrl);
    expect(cached.content.schemaVersion).toBe(2);
    expect(cached.content.articles.find(article => article.id === 'models-first-connection').target).toBe('models');
    vi.stubEnv('OPENCHAMBER_PRODUCT_HELP_UPDATES', '0');
    const restored = await f.create({ fetchImpl: async () => { throw new Error('must stay offline'); } }).getSnapshot();
    const answer = await answerProductHelp({ question: 'new setup' }, { content: restored });
    expect(answer.actions.map(action => action.id)).toEqual(['models-locate', 'models-guide']);
  });

  it('keeps navigation from a legacy cache before a download starts', async () => {
    const f = await fixture();
    await fs.writeFile(f.cacheFile, JSON.stringify({ sourceUrl, content: f.content() }));
    const snapshot = await f.create({ fetchImpl: async () => { throw new Error('must not download'); } }).getSnapshot({ refresh: false });
    expect(snapshot.schemaVersion).toBe(2);
    const answer = await answerProductHelp({ question: 'new setup' }, { content: snapshot });
    expect(answer.actions.map(action => action.id)).toEqual(['models-locate', 'models-guide']);
  });

  it('uses the new bundle offline when the old official feed cache belongs to a different source', async () => {
    const f = await fixture();
    await fs.writeFile(f.cacheFile, JSON.stringify({
      sourceUrl: 'https://www.superwagie.com/product-help/v1/catalog.json', content: f.content(),
    }));
    vi.stubEnv('OPENCHAMBER_PRODUCT_HELP_UPDATES', '0');
    const snapshot = await f.create({ sourceUrl: undefined, fetchImpl: async () => { throw new Error('must stay offline'); } }).getSnapshot();
    expect(snapshot).toBe(f.baseline);
    expect(snapshot.articles.find(article => article.id === 'models-first-connection').target).toBe('models');
  });

  it('uses downloaded navigation changes in subsequent answers without restarting', async () => {
    const f = await fixture();
    const publication = (revision, target) => f.content(revision, { schemaVersion: 2,
      articles: [{ id: 'workspace-notes', keywords: ['workspace notes'], target,
        en: { title: 'Workspace notes', text: 'Open the notes area.' },
        'zh-CN': { title: '工作区便笺', text: '打开便笺区域。' } }],
    });
    let next = publication(900001, 'workbench');
    let downloads = 0;
    const store = f.create({ refreshIntervalMs: 0, fetchImpl: async () => { downloads++; return Response.json(next); } });
    const answer = async () => answerProductHelp({ question: 'How do workspace notes work?' }, { content: await store.getSnapshot({ refresh: false }) });
    await store.getSnapshot();
    const first = await answer();
    expect(first.actions.map(action => action.id)).toEqual(['workbench-locate', 'workbench-guide']);
    next = publication(900002, 'files');
    await store.getSnapshot();
    const second = await answer();
    expect(second.actions.map(action => action.id)).toEqual(['files-locate', 'files-guide']);
    expect(second.catalogVersion).not.toBe(first.catalogVersion);
    expect(first.actions.map(action => action.id)).toEqual(['workbench-locate', 'workbench-guide']);
    expect(downloads).toBe(2);
  });

  it.each(['unknown-target', 'selector', 'script'])('retains accepted navigation after a rejected publication with %s', async (invalid) => {
    const f = await fixture();
    const published = f.content(900001, { schemaVersion: 2 });
    published.articles[0].target = 'model-tests';
    const rejected = structuredClone(published);
    rejected.revision++;
    rejected.catalogVersion = 'rejected-navigation';
    if (invalid === 'unknown-target') rejected.articles[0].target = 'unregistered-target';
    else rejected.articles[0][invalid] = 'untrusted';
    let requests = 0;
    const store = f.create({ refreshIntervalMs: 0, fetchImpl: async () => Response.json(++requests === 1 ? published : rejected) });
    const first = await store.getSnapshot();
    expect(first.articles.find(article => article.id === 'models-first-connection').target).toBe('model-tests');
    expect(await store.getSnapshot()).toBe(first);
    const answer = await answerProductHelp({ question: 'new setup' }, { content: await store.getSnapshot({ refresh: false }) });
    expect(answer.actions.map(action => action.id)).toEqual(['model-tests-locate', 'model-tests-guide']);
    const cache = JSON.parse(await fs.readFile(f.cacheFile, 'utf8'));
    expect(cache.content.revision).toBe(900001);
  });

  it('loads newer validated help lazily and stores a reusable snapshot', async () => {
    const content = structuredClone(BUNDLED_PRODUCT_HELP_CONTENT);
    content.revision += 1;
    content.catalogVersion = 'test-new-help';
    content.articles[0].en.title = 'Updated setup instructions';
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'product-help-content-'));
    folders.push(folder);
    const cacheFile = path.join(folder, 'help', 'content-cache.json');
    const sourceUrl = 'https://help.example.test/product-help/v1/catalog.json';
    const requests = [];
    const store = createProductHelpContentStore({
      sourceUrl,
      cacheFile,
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return Response.json(content, { headers: { ETag: '"help-v2"' } });
      },
    });
    expect(requests).toHaveLength(0);
    const snapshot = await store.getSnapshot();
    expect(snapshot.catalogVersion).toBe('test-new-help');
    expect(snapshot.articles[0].en.title).toBe('Updated setup instructions');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ url: sourceUrl, options: {
      method: 'GET', redirect: 'error', credentials: 'omit', headers: { Accept: 'application/json' },
    } });
    expect(requests[0].options.body).toBeUndefined();
    const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
    expect(cached).toMatchObject({ sourceUrl, etag: '"help-v2"', content: { catalogVersion: 'test-new-help' } });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.articles[0].en)).toBe(true);
    expect(Object.isFrozen(snapshot.articles[0].keywords)).toBe(true);
  });

  it('reuses a snapshot for five minutes and revalidates with its ETag', async () => {
    const f = await fixture();
    let time = 1000;
    const requests = [];
    const store = f.create({ now: () => time, fetchImpl: async (_url, options) => {
      requests.push(options);
      return requests.length === 1
        ? Response.json(f.content(), { headers: { ETag: '"revision-900001"' } })
        : new Response(null, { status: 304 });
    } });
    const initial = await store.getSnapshot();
    time += 299999;
    expect(await store.getSnapshot()).toBe(initial);
    expect(requests).toHaveLength(1);
    time += 1;
    expect(await store.getSnapshot()).toBe(initial);
    expect(requests).toHaveLength(2);
    expect(requests[1].headers).toEqual({ Accept: 'application/json', 'If-None-Match': '"revision-900001"' });
  });

  it('reads bundled content without fetching and still permits a later refresh', async () => {
    const f = await fixture();
    let requests = 0;
    const store = f.create({ fetchImpl: async () => {
      requests += 1;
      return Response.json(f.content());
    } });
    expect(await store.getSnapshot({ refresh: false })).toBe(f.baseline);
    expect(requests).toBe(0);
    const updated = await store.getSnapshot();
    expect(updated.revision).toBe(900001);
    expect(await store.getSnapshot({ refresh: false })).toBe(updated);
    expect(requests).toBe(1);
  });

  it('initializes the local cache once for concurrent local-only reads without fetching', async () => {
    const f = await fixture();
    await fs.writeFile(f.cacheFile, JSON.stringify({ sourceUrl, content: f.content() }));
    let requests = 0;
    const store = f.create({ fetchImpl: async () => {
      requests += 1;
      return Response.json(f.content(900003));
    } });
    const [one, two] = await Promise.all([
      store.getSnapshot({ refresh: false }),
      store.getSnapshot({ refresh: false }),
    ]);
    expect(one.revision).toBe(900001);
    expect(two).toBe(one);
    expect(requests).toBe(0);
    await fs.writeFile(f.cacheFile, JSON.stringify({ sourceUrl, content: f.content(900002) }));
    expect(await store.getSnapshot({ refresh: false })).toBe(one);
    expect(requests).toBe(0);
  });

  it('serves local content during an in-flight refresh and switches only after it completes', async () => {
    const f = await fixture();
    await fs.writeFile(f.cacheFile, JSON.stringify({ sourceUrl, content: f.content() }));
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    let requests = 0;
    const store = f.create({ fetchImpl: async () => {
      requests += 1;
      started.resolve();
      await release.promise;
      return Response.json(f.content(900002));
    } });
    const refreshing = store.getSnapshot();
    await started.promise;
    try {
      const local = await Promise.race([
        store.getSnapshot({ refresh: false }),
        new Promise((resolve) => setImmediate(() => resolve('waiting-for-network'))),
      ]);
      expect(local).not.toBe('waiting-for-network');
      expect(local.revision).toBe(900001);
      expect(Object.isFrozen(local)).toBe(true);
      expect(requests).toBe(1);
    } finally {
      release.resolve();
      await refreshing;
    }
    const updated = await refreshing;
    expect(updated.revision).toBe(900002);
    expect(await store.getSnapshot({ refresh: false })).toBe(updated);
    expect(requests).toBe(1);
  });

  it('persists and restores an ETag for content identical to the bundled snapshot', async () => {
    const f = await fixture();
    const store = f.create({ fetchImpl: async () => Response.json(f.baseline, { headers: { ETag: '"bundled"' } }) });
    expect(await store.getSnapshot()).toBe(f.baseline);
    const cached = JSON.parse(await fs.readFile(f.cacheFile, 'utf8'));
    expect(cached.etag).toBe('"bundled"');
    expect(cached.content).toEqual(f.baseline);
    let headers;
    const restarted = f.create({ fetchImpl: async (_url, options) => {
      headers = options.headers;
      return new Response(null, { status: 304 });
    } });
    expect(await restarted.getSnapshot()).toBe(f.baseline);
    expect(headers['If-None-Match']).toBe('"bundled"');
  });

  it('keeps the accepted ETag when equal revision and version carry conflicting text', async () => {
    const f = await fixture();
    const conflicting = f.content();
    conflicting.articles[0].en.text = 'Conflicting instructions under the same version.';
    const headers = [];
    const store = f.create({ refreshIntervalMs: 0, fetchImpl: async (_url, options) => {
      headers.push(options.headers);
      if (headers.length === 1) return Response.json(f.content(), { headers: { ETag: '"accepted"' } });
      if (headers.length === 2) return Response.json(conflicting, { headers: { ETag: '"conflicting"' } });
      return new Response(null, { status: 304 });
    } });
    const good = await store.getSnapshot();
    expect(await store.getSnapshot()).toBe(good);
    expect(await store.getSnapshot()).toBe(good);
    expect(headers[2]['If-None-Match']).toBe('"accepted"');
    const cached = JSON.parse(await fs.readFile(f.cacheFile, 'utf8'));
    expect(cached.etag).toBe('"accepted"');
    expect(cached.content.articles.find((article) => article.id === 'models-first-connection').en.text).toBe('Open model settings.');
  });

  it('revalidates over HTTP, adopts a new release and restores it after the server goes offline', async () => {
    const f = await fixture();
    let published = f.baseline;
    let publishedEtag = '"bundled-over-http"';
    const requests = [];
    const server = http.createServer((request, response) => {
      const status = request.headers['if-none-match'] === publishedEtag ? 304 : 200;
      requests.push({ method: request.method, path: request.url, headers: request.headers, status });
      response.writeHead(status, { 'Content-Type': 'application/json', ETag: publishedEtag });
      response.end(status === 304 ? undefined : JSON.stringify(published));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const localUrl = `http://127.0.0.1:${address.port}/product-help/v1/catalog.json`;
    // Only transport changes: the store still validates the configured HTTPS source.
    const localFetch = async (url, options) => {
      expect(url).toBe(sourceUrl);
      const response = await fetch(localUrl, options);
      return new Response(response.body, { status: response.status, headers: response.headers });
    };
    try {
      const store = f.create({ refreshIntervalMs: 0, fetchImpl: localFetch });
      expect(await store.getSnapshot()).toBe(f.baseline);
      expect(await store.getSnapshot()).toBe(f.baseline);
      expect(requests.map((request) => request.status)).toEqual([200, 304]);
      expect(requests[0]).toMatchObject({ method: 'GET', path: '/product-help/v1/catalog.json', headers: { accept: 'application/json' } });
      expect(requests[0].headers['if-none-match']).toBeUndefined();
      expect(requests[1].headers['if-none-match']).toBe('"bundled-over-http"');
      expect(requests.every((request) => !request.headers.authorization && !request.headers.cookie)).toBe(true);

      published = f.content();
      publishedEtag = '"new-release-over-http"';
      const updated = await store.getSnapshot();
      expect(updated.revision).toBe(900001);
      expect(requests[2].status).toBe(200);
      expect(requests[2].headers['if-none-match']).toBe('"bundled-over-http"');
      await new Promise((resolve) => server.close(resolve));

      const offline = await f.create({ fetchImpl: localFetch, timeoutMs: 1000 }).getSnapshot();
      expect(offline).toEqual(updated);
      expect(Object.isFrozen(offline)).toBe(true);
      const cached = JSON.parse(await fs.readFile(f.cacheFile, 'utf8'));
      expect(cached.etag).toBe('"new-release-over-http"');
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('coalesces concurrent requests and keeps earlier snapshots unchanged', async () => {
    const f = await fixture();
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let requests = 0;
    const store = f.create({ refreshIntervalMs: 0, fetchImpl: async () => {
      requests += 1;
      if (requests === 1) await held;
      return Response.json(f.content(900000 + requests));
    } });
    const first = store.getSnapshot();
    const second = store.getSnapshot();
    release();
    const [one, two] = await Promise.all([first, second]);
    expect(one).toBe(two);
    expect(requests).toBe(1);
    const next = await store.getSnapshot();
    expect(next.revision).toBe(900002);
    expect(one.revision).toBe(900001);
    expect(one.articles.find((article) => article.id === 'models-first-connection').en.title).toBe('Model setup 900001');
    expect(() => { one.articles[0].en.title = 'mutated'; }).toThrow();
  });

  it.each([
    ['malformed JSON', () => new Response('{broken')],
    ['HTTP failure', () => new Response('unavailable', { status: 503 })],
    ['incompatible version', (f) => Response.json(f.content(900002, { minAppVersion: '999.0.0' }))],
    ['invalid schema', (f) => Response.json({ ...f.content(900002), actions: ['execute'] })],
    ['lower revision', (f) => Response.json(f.content(900000))],
    ['same revision', (f) => Response.json(f.content(900001, { catalogVersion: 'different-content' }))],
    ['unchanged version label', (f) => Response.json(f.content(900002, { catalogVersion: 'help-900001' }))],
    ['redirect response', () => new Response(null, { status: 302, headers: { Location: 'https://other.example.test/help' } })],
  ])('keeps last-good content after %s', async (_name, response) => {
    const f = await fixture();
    let requests = 0;
    const store = f.create({ refreshIntervalMs: 0, fetchImpl: async () => ++requests === 1
      ? Response.json(f.content()) : response(f) });
    const good = await store.getSnapshot();
    expect(good.revision).toBe(900001);
    expect(await store.getSnapshot()).toBe(good);
    const cached = JSON.parse(await fs.readFile(f.cacheFile, 'utf8'));
    expect(cached.content.revision).toBe(900001);
  });

  it('falls back to bundled help and bounds a fetch that ignores abort', async () => {
    const f = await fixture();
    let signal;
    const store = f.create({ timeoutMs: 10, fetchImpl: (_url, options) => {
      signal = options.signal;
      return new Promise(() => {});
    } });
    expect(await store.getSnapshot()).toBe(f.baseline);
    expect(signal.aborted).toBe(true);
  });

  it('bounds a stalled response body and cancels its stream', async () => {
    const f = await fixture();
    let cancelled = false;
    const store = f.create({ timeoutMs: 10, fetchImpl: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
      cancel() { cancelled = true; },
    })) });
    expect(await store.getSnapshot()).toBe(f.baseline);
    expect(cancelled).toBe(true);
  });

  it('rejects oversized streamed content without relying on Content-Length', async () => {
    const f = await fixture();
    let cancelled = false;
    const store = f.create({ fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(256000));
        controller.enqueue(new Uint8Array(256001));
      },
      cancel() { cancelled = true; },
    })) });
    expect(await store.getSnapshot()).toBe(f.baseline);
    expect(cancelled).toBe(true);
  });

  it('rejects oversized advertised content before reading it', async () => {
    const f = await fixture();
    let cancelled = false;
    const store = f.create({ fetchImpl: async () => new Response(new ReadableStream({
      cancel() { cancelled = true; },
    }), { headers: { 'Content-Length': '512001' } }) });
    expect(await store.getSnapshot()).toBe(f.baseline);
    expect(cancelled).toBe(true);
  });

  it('restores a source-matched cache across stores when updates are disabled', async () => {
    const f = await fixture();
    await f.create({ fetchImpl: async () => Response.json(f.content(), { headers: { ETag: '"cached"' } }) }).getSnapshot();
    vi.stubEnv('OPENCHAMBER_PRODUCT_HELP_UPDATES', '0');
    let requests = 0;
    const restarted = f.create({ fetchImpl: async () => { requests += 1; throw new Error('must not download'); } });
    const restored = await restarted.getSnapshot();
    expect(restored.revision).toBe(900001);
    expect(requests).toBe(0);
    expect(Object.isFrozen(restored.articles[0])).toBe(true);
  });

  it.each(['another-source', 'corrupt', 'incompatible', 'old', 'oversized'])('ignores an unusable disk cache: %s', async (kind) => {
    const f = await fixture();
    const cache = { sourceUrl, content: f.content() };
    if (kind === 'another-source') cache.sourceUrl = 'https://other.example.test/help';
    if (kind === 'incompatible') cache.content.minAppVersion = '999.0.0';
    if (kind === 'old') cache.content.revision = 1;
    await fs.writeFile(f.cacheFile, kind === 'corrupt' ? '{broken'
      : kind === 'oversized' ? ' '.repeat(600000) : JSON.stringify(cache));
    vi.stubEnv('OPENCHAMBER_PRODUCT_HELP_UPDATES', '0');
    const snapshot = await f.create({ fetchImpl: async () => { throw new Error('must not download'); } }).getSnapshot();
    expect(snapshot).toBe(f.baseline);
  });

  it('keeps the new in-memory content when an atomic cache write fails', async () => {
    const f = await fixture();
    await fs.mkdir(f.cacheFile);
    const store = f.create({ fetchImpl: async () => Response.json(f.content()) });
    expect((await store.getSnapshot()).revision).toBe(900001);
    expect((await fs.stat(f.cacheFile)).isDirectory()).toBe(true);
    expect(await fs.readdir(f.folder)).toEqual(['content-cache.json']);
  });

  it.each([
    'http://help.example.test/catalog.json',
    'https://user:password@help.example.test/catalog.json',
    'https://help.example.test/catalog.json?token=secret',
    'https://help.example.test/catalog.json#secret',
    'https://help.example.test/catalog.json?',
    'file:///catalog.json',
    'not-a-url',
  ])('refuses an unsafe source without making a request: %s', async (url) => {
    const f = await fixture();
    let requests = 0;
    const snapshot = await f.create({ sourceUrl: url, fetchImpl: async () => {
      requests += 1;
      return Response.json(f.content());
    } }).getSnapshot();
    expect(snapshot).toBe(f.baseline);
    expect(requests).toBe(0);
  });

  it('does not accept a new source cache or its ETag after changing the source', async () => {
    const f = await fixture();
    await fs.writeFile(f.cacheFile, JSON.stringify({ sourceUrl: 'https://old.example.test/help', etag: '"old"', content: f.content() }));
    let headers;
    const snapshot = await f.create({ fetchImpl: async (_url, options) => {
      headers = options.headers;
      return new Response(null, { status: 304 });
    } }).getSnapshot();
    expect(headers).toEqual({ Accept: 'application/json' });
    expect(snapshot).toBe(f.baseline);
  });

  it('uses the environment only when the default singleton is first requested', async () => {
    const f = await fixture();
    vi.stubEnv('OPENCHAMBER_DATA_DIR', f.folder);
    vi.stubEnv('OPENCHAMBER_PRODUCT_HELP_URL', 'https://private-help.example.test/catalog.json');
    const requests = [];
    vi.stubGlobal('fetch', async (url) => {
      requests.push(url);
      return Response.json(f.content());
    });
    expect(requests).toHaveLength(0);
    expect(await getProductHelpContent({ refresh: false })).toBe(f.baseline);
    expect(requests).toHaveLength(0);
    expect((await getProductHelpContent()).revision).toBe(900001);
    expect(requests).toEqual(['https://private-help.example.test/catalog.json']);
    const cached = JSON.parse(await fs.readFile(path.join(f.folder, 'product-help', 'content-cache.json'), 'utf8'));
    expect(cached.sourceUrl).toBe('https://private-help.example.test/catalog.json');
  });
});
