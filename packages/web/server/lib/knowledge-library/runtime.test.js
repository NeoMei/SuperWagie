import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createKnowledgeLibraryRuntime } from './runtime.js';

const respond = (res, status, body) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
};

/**
 * A stand-in for the knowledge backend endpoints the runtime actually calls. The runtime
 * adopts it through `/health`, so no process is spawned.
 */
const startFakeBackend = async () => {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push({ method: req.method, url: req.url });
    if (req.url === '/health') return respond(res, 200, { status: 'ok' });
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
});

const setup = async () => {
  const backend = await startFakeBackend();
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
  return { runtime, backend, libraryRoot, settings };
};

describe('knowledge library runtime end to end', () => {
  it('adopts the backend, indexes a folder, searches it, reads it and removes it', async () => {
    const { runtime, backend, libraryRoot } = await setup();
    const status = await runtime.start();
    expect(status.backend.state).toBe('running');

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
});
