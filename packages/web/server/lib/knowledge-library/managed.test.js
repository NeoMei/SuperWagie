import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createKnowledgeLibraryRuntime } from './runtime.js';
import { createKnowledgeLibraryStore } from './store.js';
import { DEFAULTS_VERSION } from '../embedded-knowledge/provision.js';
import { createConversationMemoryRuntime } from '../conversation-memory/runtime.js';

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

const setup = async ({ fsPromises = fs } = {}) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sw-managed-knowledge-'));
  const calls = [];
  const records = new Map();
  let parseStatus = 'completed';
  let deletionFails = false;
  let knowledgeBases = [{ id: 'kb1', indexing_strategy: { vector_enabled: true, keyword_enabled: true, wiki_enabled: false, graph_enabled: false } }];
  let knowledgeBaseReadFails = false;
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, options = {}) => {
    const route = new URL(url).pathname;
    const method = options.method ?? 'GET';
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ route, method, body });
    if (route === '/health') return json({ status: 'ok' });
    if (route === '/api/v1/knowledge-bases') return knowledgeBaseReadFails ? json({ error: 'fixture policy unavailable' }, 500) : json({ data: knowledgeBases });
    if (route === '/api/v1/knowledge-bases/kb1/knowledge/ref') {
      const record = { id: `k${records.size + 1}`, ...body };
      records.set(record.id, record);
      return json({ data: record });
    }
    if (route.endsWith('/reparse')) return json({ success: true });
    if (route.startsWith('/api/v1/knowledge/')) {
      const id = route.split('/').pop();
      if (method === 'DELETE') {
        if (deletionFails) return json({ error: 'fixture cleanup failed' }, 500);
        records.delete(id);
        return json({ success: true });
      }
      return json({ data: { id, parse_status: parseStatus, pending_subtasks_count: parseStatus === 'completed' ? 0 : 1 } });
    }
    if (route.endsWith('/hybrid-search')) return json({ data: [...records.keys()].map((id) => ({ knowledge_id: id, content: 'fixture passage' })) });
    throw new Error(`Unexpected fixture route ${route}`);
  };
  const settings = {
    knowledgeLibraryEnabled: true, embeddedKnowledgePort: 17808,
    embeddedKnowledgeTenantId: 5, embeddedKnowledgeApiKey: 'fixture-token',
    embeddedKnowledgeBaseId: 'kb1', embeddedKnowledgeDefaultsVersion: DEFAULTS_VERSION,
  };
  const runtime = createKnowledgeLibraryRuntime({
    dataDir, readSettings: async () => settings, resolveBinaryPath: () => '/fixture/backend', fetchImpl, fsPromises,
    schedule: () => ({ unref() {} }), cancelSchedule() {}, log: { warn() {} },
  });
  cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
  cleanups.push(() => runtime.stop());
  await runtime.start();
  return { runtime, dataDir, calls, records, store: createKnowledgeLibraryStore({ dataDir }), setParseStatus: (state) => { parseStatus = state; }, failDeletion: () => { deletionFails = true; }, allowDeletion: () => { deletionFails = false; }, setKnowledgeBases: (bases) => { knowledgeBases = bases; }, setKnowledgeBaseReadFailure: (failed) => { knowledgeBaseReadFails = failed; } };
};

const input = { projectId: 'project-a', id: 'experience-1', title: 'Build result', markdown: '# Build result\n\nVerified fixture result.' };

describe('managed conversation knowledge', () => {
  it.each([
    { name: 'wiki enabled', bases: [{ id: 'kb1', indexing_strategy: { wiki_enabled: true, graph_enabled: false } }] },
    { name: 'graph enabled', bases: [{ id: 'kb1', indexing_strategy: { wiki_enabled: false, graph_enabled: true } }] },
    { name: 'missing strategy', bases: [{ id: 'kb1' }] },
    { name: 'missing graph flag', bases: [{ id: 'kb1', indexing_strategy: { wiki_enabled: false } }] },
    { name: 'invalid flag type', bases: [{ id: 'kb1', indexing_strategy: { wiki_enabled: 'false', graph_enabled: false } }] },
    { name: 'missing current knowledge base', bases: [{ id: 'other', indexing_strategy: { wiki_enabled: false, graph_enabled: false } }] },
    { name: 'malformed list', bases: { id: 'kb1', indexing_strategy: { wiki_enabled: false, graph_enabled: false } } },
  ])('refuses managed reference indexing when the current policy is $name', async ({ bases }) => {
    const { runtime, calls, store, setKnowledgeBases } = await setup();
    setKnowledgeBases(bases);
    const result = await runtime.upsertManagedDocument(input);
    expect(result).toMatchObject({ state: 'failed', error: { code: 'managed_derivation_scope_unavailable' } });
    expect(calls.filter((call) => call.route.endsWith('/ref') || call.route.endsWith('/reparse'))).toEqual([]);
    expect(calls.some((call) => call.method === 'PUT' || call.method === 'PATCH')).toBe(false);
    const row = (await store.readDocuments())[result.documentId];
    expect(await fs.readFile(row.absPath, 'utf8')).toBe(input.markdown);
  });

  it('fails closed on unreadable policy and retries retained Markdown after policy reads recover', async () => {
    const { runtime, calls, setKnowledgeBaseReadFailure } = await setup();
    setKnowledgeBaseReadFailure(true);
    expect(await runtime.upsertManagedDocument(input)).toMatchObject({ state: 'failed', error: { code: 'managed_derivation_scope_unavailable' } });
    expect(calls.filter((call) => call.route.endsWith('/ref'))).toEqual([]);
    setKnowledgeBaseReadFailure(false);
    expect(await runtime.ensureManagedDocumentIndexed(input)).toMatchObject({ state: 'ready' });
    expect(calls.filter((call) => call.route.endsWith('/ref'))).toHaveLength(1);
  });

  it('checks the current policy before reparsing and leaves unrelated knowledge-base policies unchanged', async () => {
    const { runtime, calls, setKnowledgeBases } = await setup();
    await runtime.upsertManagedDocument(input);
    const changed = { ...input, markdown: '# Updated local observation' };
    setKnowledgeBases([{ id: 'kb1', indexing_strategy: { wiki_enabled: true, graph_enabled: false } }]);
    expect(await runtime.upsertManagedDocument(changed)).toMatchObject({ state: 'failed', error: { code: 'managed_derivation_scope_unavailable' } });
    expect(calls.filter((call) => call.route.endsWith('/reparse'))).toEqual([]);
    setKnowledgeBases([{ id: 'unrelated-with-unknown-policy', indexing_strategy: { wiki_enabled: 'unknown' } }, { id: 'kb1', indexing_strategy: { wiki_enabled: false, graph_enabled: false } }]);
    expect(await runtime.ensureManagedDocumentIndexed(input)).toMatchObject({ state: 'ready' });
    expect(calls.filter((call) => call.route.endsWith('/reparse'))).toHaveLength(1);
    expect(calls.filter((call) => call.route === '/api/v1/knowledge-bases')).toHaveLength(3);
  });

  it('reads policy for reference indexing without repeating that read for parse status polls', async () => {
    const { runtime, calls, setParseStatus } = await setup();
    setParseStatus('processing');
    const initial = await runtime.upsertManagedDocument(input);
    expect(initial.state).toBe('parsing');
    expect(await runtime.ensureManagedDocumentIndexed(input)).toMatchObject({ state: 'parsing' });
    setParseStatus('completed');
    expect(await runtime.ensureManagedDocumentIndexed(input)).toMatchObject({ state: 'ready' });
    expect(calls.filter((call) => call.route === '/api/v1/knowledge-bases')).toHaveLength(1);
    expect(calls.filter((call) => call.route.endsWith('/ref'))).toHaveLength(1);
    expect(calls.filter((call) => call.route.endsWith('/reparse'))).toHaveLength(0);
  });

  it('requires current safe policy when retrying a backend parse failure', async () => {
    const { runtime, calls, setKnowledgeBases, setParseStatus } = await setup();
    setParseStatus('failed');
    expect(await runtime.upsertManagedDocument(input)).toMatchObject({ state: 'failed', error: { code: 'parse_failed' } });
    setParseStatus('completed');
    setKnowledgeBases([{ id: 'kb1', indexing_strategy: { wiki_enabled: false, graph_enabled: true } }]);
    expect(await runtime.ensureManagedDocumentIndexed(input)).toMatchObject({ state: 'failed', error: { code: 'managed_derivation_scope_unavailable' } });
    expect(calls.filter((call) => call.route.endsWith('/reparse'))).toEqual([]);
    setKnowledgeBases([{ id: 'kb1', indexing_strategy: { wiki_enabled: false, graph_enabled: false } }]);
    expect(await runtime.ensureManagedDocumentIndexed(input)).toMatchObject({ state: 'ready' });
    expect(calls.filter((call) => call.route.endsWith('/reparse'))).toHaveLength(1);
  });

  it('keeps document, path and backend identity stable and avoids indexing identical content', async () => {
    const { runtime, dataDir, calls, store } = await setup();
    const first = await runtime.upsertManagedDocument(input);
    expect(first).toMatchObject({ state: 'ready', knowledgeId: 'k1' });
    const duplicate = await runtime.upsertManagedDocument(input);
    expect(duplicate).toEqual(first);
    const rows = Object.values(await store.readDocuments());
    expect(rows).toHaveLength(1);
    expect(rows[0].absPath.startsWith(path.join(dataDir, 'knowledge-library', 'managed'))).toBe(true);
    expect((await fs.stat(rows[0].absPath)).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(rows[0].absPath, 'utf8')).toBe(input.markdown);
    expect(await store.readLibraries()).toMatchObject([{ managedBy: 'conversation-memory', projectId: 'project-a' }]);
    const changed = await runtime.upsertManagedDocument({ ...input, markdown: '# Changed result' });
    expect(changed).toEqual(first);
    expect(Object.values(await store.readDocuments())[0].absPath).toBe(rows[0].absPath);
    expect(calls.filter((call) => call.route.endsWith('/ref'))).toHaveLength(1);
    expect(calls.filter((call) => call.route.endsWith('/reparse'))).toHaveLength(1);
    expect(calls.filter((call) => call.route === '/api/v1/knowledge-bases')).toHaveLength(2);
  });

  it('reports actual parsing, polls to readiness and retries failed parsing with the existing knowledge id', async () => {
    const { runtime, setParseStatus, calls } = await setup();
    setParseStatus('processing');
    const first = await runtime.upsertManagedDocument(input);
    expect(first).toMatchObject({ state: 'parsing', knowledgeId: 'k1' });
    expect((await runtime.searchManagedDocuments({ projectId: input.projectId, query: 'result' })).passages).toEqual([]);
    setParseStatus('failed');
    expect(await runtime.ensureManagedDocumentIndexed(input)).toMatchObject({ state: 'failed', error: { code: 'parse_failed' } });
    setParseStatus('completed');
    expect(await runtime.upsertManagedDocument(input)).toMatchObject({ state: 'ready', documentId: first.documentId, knowledgeId: 'k1' });
    expect(calls.filter((call) => call.route.endsWith('/ref'))).toHaveLength(1);
    expect(calls.filter((call) => call.route.endsWith('/reparse'))).toHaveLength(1);
  });

  it('does not read old indexed chunks while the managed revision is parsing', async () => {
    const { runtime, setParseStatus } = await setup();
    const first = await runtime.upsertManagedDocument(input);
    setParseStatus('processing');
    expect(await runtime.upsertManagedDocument({ ...input, markdown: '# Updated body' })).toMatchObject({ state: 'parsing' });
    expect(await runtime.readContent(first.documentId, { projectId: input.projectId })).toEqual({ error: 'not_indexed' });
  });

  it('restricts managed retrieval before topK and filters hostile cross-project hits', async () => {
    const { runtime, calls } = await setup();
    const own = await runtime.upsertManagedDocument(input);
    await runtime.upsertManagedDocument({ ...input, projectId: 'project-b' });
    const scoped = await runtime.searchManagedDocuments({ projectId: 'project-a', query: 'result', documentIds: [own.documentId] });
    expect(scoped.passages.map((entry) => entry.documentId)).toEqual([own.documentId]);
    expect(calls.at(-1).body.knowledge_ids).toEqual(['k1']);
    const global = await runtime.search({ query: 'result' });
    expect(global.documents).toEqual([]);
    expect(global.passages).toEqual([]);
    expect(await runtime.readManagedDocument({ projectId: 'project-b', id: 'absent' })).toBeNull();
  });

  it('hides a forgotten document immediately and retains a failed cleanup for retry', async () => {
    const { runtime, failDeletion, allowDeletion, store, dataDir } = await setup();
    const first = await runtime.upsertManagedDocument(input);
    failDeletion();
    await expect(runtime.removeManagedDocument(input)).rejects.toThrow();
    expect((await runtime.searchManagedDocuments({ projectId: input.projectId, query: 'result' })).passages).toEqual([]);
    const row = (await store.readDocuments())[first.documentId];
    expect(row.state).toBe('deleting');
    expect(await fs.readFile(row.absPath, 'utf8')).toBe(input.markdown);
    await runtime.rescan();
    expect((await store.readDocuments())[first.documentId].state).toBe('deleting');
    expect(row.absPath.startsWith(dataDir)).toBe(true);
    await expect(runtime.upsertManagedDocument(input)).rejects.toMatchObject({ code: 'cleanup_pending' });
    allowDeletion();
    expect(await runtime.removeManagedDocument(input)).toEqual({ removed: true, documentId: first.documentId });
    expect(await store.readDocuments()).toEqual({});
  });

  it('removes managed disk/backend state and never resurrects it during a rescan', async () => {
    const { runtime, records, store } = await setup();
    await runtime.upsertManagedDocument(input);
    const row = Object.values(await store.readDocuments())[0];
    expect(await runtime.removeManagedDocument(input)).toEqual({ removed: true, documentId: row.id });
    expect(records.size).toBe(0);
    await expect(fs.stat(row.absPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await runtime.rescan();
    expect(Object.values(await store.readDocuments())).toEqual([]);
    expect(await runtime.removeManagedDocument(input)).toEqual({ removed: false });
  });

  it('rejects path-like IDs without writing a library or touching the backend', async () => {
    const { runtime, calls, store } = await setup();
    const count = calls.length;
    await expect(runtime.upsertManagedDocument({ ...input, id: '../../outside' })).rejects.toThrow();
    expect(await store.readLibraries()).toEqual([]);
    expect(calls).toHaveLength(count);
  });

  it('protects direct document and file reads unless a matching project is supplied', async () => {
    const { runtime, store } = await setup();
    const first = await runtime.upsertManagedDocument(input);
    const row = (await store.readDocuments())[first.documentId];
    expect(await runtime.findDocument({ id: first.documentId })).toBeNull();
    expect(await runtime.findDocument({ path: row.absPath, projectId: 'project-b' })).toBeNull();
    expect(await runtime.findDocument({ id: first.documentId, projectId: input.projectId })).toMatchObject({ id: first.documentId });
    expect(await runtime.getFile(first.documentId)).toEqual({ error: 'not_found' });
    expect(await runtime.readContent(first.documentId)).toEqual({ error: 'not_indexed' });
    expect(await runtime.listDocuments()).toEqual({ total: 0, documents: [] });
    expect(await runtime.readLibraries()).toEqual([]);
    expect(await runtime.readLibraries({ projectId: input.projectId })).toHaveLength(1);
    expect(await runtime.readManagedDocument(input)).toMatchObject({ state: 'ready', title: 'Build result', markdown: input.markdown });
    expect(await runtime.removeDocument(first.documentId)).toEqual({ error: 'not_found' });
    expect(await runtime.removeLibrary(row.libraryId)).toEqual({ error: 'not_found' });
  });

  it('persists pending Markdown while unavailable and resumes only through explicit indexing', async () => {
    const { runtime, store, calls } = await setup();
    await runtime.stop();
    const pending = await runtime.upsertManagedDocument(input);
    expect(pending).toMatchObject({ state: 'pending', error: { code: 'backend_unavailable' } });
    await runtime.start();
    await runtime.rescan();
    expect(calls.filter((call) => call.route.endsWith('/ref'))).toHaveLength(0);
    expect(Object.values(await store.readDocuments())).toMatchObject([{ state: 'queued' }]);
    expect(await runtime.ensureManagedDocumentIndexed(input)).toMatchObject({ state: 'ready', documentId: pending.documentId });
  });

  it('refuses managed indexing and search in enterprise mode before model or backend calls', async () => {
    const { runtime, calls } = await setup();
    await runtime.upsertManagedDocument(input);
    const count = calls.length;
    vi.stubEnv('OPENCHAMBER_ENTERPRISE_MODE', '1');
    await expect(runtime.upsertManagedDocument(input)).rejects.toMatchObject({ code: 'enterprise_mode' });
    await expect(runtime.searchManagedDocuments({ projectId: input.projectId, query: 'result' })).rejects.toMatchObject({ code: 'enterprise_mode' });
    expect(calls).toHaveLength(count);
    const ordinary = await runtime.search({ projectId: input.projectId, query: 'result' });
    expect(ordinary).toEqual({ query: 'result', documents: [], passages: [] });
  });

  it('leaves a changed document hidden if its ledger write fails after the atomic file replacement', async () => {
    let documentWrites = 0;
    let failAt = Infinity;
    const fixture = await setup({ fsPromises: { ...fs, rename: async (from, to) => {
      if (to.endsWith('documents.json') && ++documentWrites === failAt) throw new Error('fixture ledger write failed');
      return fs.rename(from, to);
    } } });
    const first = await fixture.runtime.upsertManagedDocument(input);
    failAt = documentWrites + 2;
    await expect(fixture.runtime.upsertManagedDocument({ ...input, markdown: '# A new result' })).rejects.toThrow('fixture ledger write failed');
    expect((await fixture.store.readDocuments())[first.documentId].state).toBe('pending');
    expect((await fixture.runtime.searchManagedDocuments({ projectId: input.projectId, query: 'result' })).passages).toEqual([]);
    expect(await fixture.runtime.upsertManagedDocument({ ...input, markdown: '# A new result' })).toMatchObject({ state: 'ready', documentId: first.documentId, knowledgeId: 'k1' });
  });

  it('restores a missing managed Markdown file without embedding the same indexed bytes again', async () => {
    const { runtime, store, calls } = await setup();
    const first = await runtime.upsertManagedDocument(input);
    const row = (await store.readDocuments())[first.documentId];
    await fs.rm(path.dirname(row.absPath), { recursive: true });
    expect(await runtime.upsertManagedDocument(input)).toEqual(first);
    expect(await fs.readFile(row.absPath, 'utf8')).toBe(input.markdown);
    expect(calls.filter((call) => call.route.endsWith('/ref'))).toHaveLength(1);
    expect(calls.filter((call) => call.route.endsWith('/reparse'))).toHaveLength(0);
  });

  it('keeps ordinary ancestor libraries and symlink aliases from importing managed files globally', async () => {
    const { runtime, dataDir, store } = await setup();
    const first = await runtime.upsertManagedDocument(input);
    const row = (await store.readDocuments())[first.documentId];
    expect((await runtime.previewLibrary(dataDir)).indexable).toBe(0);
    await runtime.addLibrary(dataDir);
    expect(Object.values(await store.readDocuments())).toHaveLength(1);
    const alias = path.join(dataDir, 'managed-alias');
    await fs.symlink(path.dirname(row.absPath), alias);
    expect(await runtime.addLibrary(alias)).toEqual({ error: 'managed_path' });
    const ancestorAlias = path.join(dataDir, 'data-alias');
    await fs.symlink(dataDir, ancestorAlias);
    await runtime.addLibrary(ancestorAlias);
    expect(Object.values(await store.readDocuments())).toHaveLength(1);
  });

  it('polls and retries the actual reference adapter through the durable conversation runtime', async () => {
    const { runtime, dataDir, setParseStatus, calls } = await setup();
    let generated = 0;
    const source = {
      id: 'segment-1', sessionId: 'session-1', projectId: input.projectId, directory: '/fixture/project-a',
      title: 'Build', createdAt: 100, sourceHash: 'a'.repeat(64), messageIds: ['user-1', 'assistant-1'], outcome: 'succeeded',
      messages: [{ id: 'user-1', role: 'user', text: 'Build the project' }, { id: 'assistant-1', role: 'assistant', text: 'Build passed' }],
    };
    const memory = createConversationMemoryRuntime({
      dataDir, knowledgeLibrary: runtime, indexPollMs: 0,
      resolveProjectId: async () => input.projectId, createClient: () => ({}),
      readSegments: async () => ({ segments: [source], checkpoint: null, reset: false, complete: true }),
      distill: async () => { generated++; return [{ id: input.id, kind: 'experience', title: input.title, body: 'Build passed.', status: 'active', verification: 'observed', sourceMessageIds: source.messageIds, sourcePartIds: [], limitations: ['Fixture only.'] }]; },
      renderMarkdown: ({ card }) => `# ${card.title}\n\n${card.body}`,
    });
    cleanups.push(() => memory.stop());
    await memory.start(); await memory.setEnabled(true);
    setParseStatus('processing');
    await memory.capture({ sessionId: source.sessionId, directory: source.directory }); await memory.idle();
    expect((await memory.listEntries({ directory: source.directory })).entries[0].indexState).toBe('pending');
    setParseStatus('failed');
    await memory.retry({ id: input.id, directory: source.directory }); await memory.idle();
    expect((await memory.listEntries({ directory: source.directory })).entries[0]).toMatchObject({ indexState: 'failed', error: 'parse_failed' });
    setParseStatus('completed');
    await memory.retry({ id: input.id, directory: source.directory }); await memory.idle();
    expect((await memory.listEntries({ directory: source.directory })).entries[0].indexState).toBe('ready');
    expect(generated).toBe(1);
    expect(calls.filter((call) => call.route.endsWith('/ref'))).toHaveLength(1);
    expect(calls.filter((call) => call.route.endsWith('/reparse'))).toHaveLength(1);
    expect(await memory.forget({ id: input.id, directory: source.directory })).toEqual({ forgotten: true, pendingCleanup: false });
    expect(await memory.recall({ directory: source.directory, query: 'Build' })).toBe('');
  });
});
