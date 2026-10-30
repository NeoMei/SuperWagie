import { describe, expect, it } from 'vitest';

import { createLibraryActions } from './library.js';

const createRuntime = (overrides = {}) => ({
  readLibraries: async () => [{ id: 'l1', name: 'Docs', slug: 'docs' }],
  isReady: () => true,
  search: async (input) => ({
    query: input.query,
    documents: [{ path: '/a/b.md', title: 'b.md', relPath: 'b.md', libraryId: 'l1', matched: 'name' }],
    passages: [
      {
        path: '/a/b.md',
        title: 'b.md',
        content: 'x'.repeat(700),
        startAt: 0,
        endAt: 700,
        score: 1,
        chunkIndex: 0,
      },
    ],
  }),
  findDocument: async ({ id, path }) => (path === '/missing.md' ? null : { id: id ?? 'd1', absPath: path ?? '/a/b.md', relPath: 'b.md' }),
  readContent: async (id) => ({ documentId: id, content: 'indexed text', truncated: false }),
  ...overrides,
});

describe('library agent actions', () => {
  const card = (overrides = {}) => ({
    id: 'experience-1', title: '架构优化检查', body: 'Retained local result', kind: 'experience',
    status: 'active', indexState: 'ready', verification: 'observed', sourceHash: 'revision-1',
    sourceReferences: [{ sessionId: 's1', messageId: 'u1' }], sourcePartIds: ['t1'], limitations: ['Local observation only.'],
    availability: { state: 'eligible', reason: null }, ...overrides,
  });
  const retrieval = (entries) => ({ entries, scope: { projectId: 'project-a' }, availability: { state: 'ready', reason: null } });

  it('merges ordinary documents and eligible memories while preserving retrieval scope and rank', async () => {
    const calls = [];
    const actions = createLibraryActions({ runtime: createRuntime(), resolveProjectId: async () => 'project-a',
      retrieveMemory: async (input) => { calls.push(input); return retrieval([card({ id: 'second-stored' }), card({ id: 'first-stored', title: 'Another result' })]); },
    });
    const result = await actions.execute('library.search', { query: '架构优化检查', projectId: 'project-b' }, '/work/a');
    expect(result.documents[0].path).toBe('/a/b.md');
    expect(result.memories.map((entry) => entry.entryId)).toEqual(['second-stored', 'first-stored']);
    expect(result.memories[0]).toMatchObject({ content: 'Retained local result', verification: 'observed', sourceHash: 'revision-1' });
    expect(result.scope).toEqual({ projectId: 'project-a' });
    expect(calls[0]).toEqual({ directory: '/work/a', query: '架构优化检查', limit: 8, mode: 'eligible' });
  });

  it('exposes candidate and indexing failures only through explicit inspection', async () => {
    const calls = [];
    const actions = createLibraryActions({ runtime: createRuntime(), retrieveMemory: async (input) => {
      calls.push(input);
      return retrieval([card({ status: 'candidate', verification: 'observed', indexState: 'failed', error: 'embedding_unavailable', availability: { state: 'unverified', reason: 'candidate' } })]);
    } });
    const inspected = await actions.execute('library.inspect', { title: '架构优化检查' }, '/work/a');
    expect(calls[0]).toMatchObject({ title: '架构优化检查', directory: '/work/a', mode: 'inspect' });
    expect(inspected.memories[0]).toMatchObject({ status: 'candidate', verification: 'unverified', indexState: 'failed', error: 'embedding_unavailable', availability: { state: 'unverified', reason: 'candidate' } });
    const searched = await actions.execute('library.search', { query: '架构优化检查' }, '/work/a');
    expect(searched.memories).toEqual([]);
  });

  it('reads an explicit candidate title without requiring the semantic backend', async () => {
    const actions = createLibraryActions({ runtime: createRuntime({ isReady: () => false }), retrieveMemory: async (input) => {
      if (input.title !== '架构优化检查' || input.mode !== 'inspect') throw new Error('wrong lookup');
      return { ...retrieval([card({ status: 'candidate', verification: 'unverified', availability: { state: 'unverified', reason: 'candidate' } })]), availability: { state: 'degraded', reason: 'semantic_unavailable' } };
    } });
    const result = await actions.execute('library.read', { title: '架构优化检查' }, '/work/a');
    expect(result).toMatchObject({ memory: { entryId: 'experience-1', verification: 'unverified', content: 'Retained local result' }, availability: { state: 'degraded', reason: 'semantic_unavailable' }, scope: { projectId: 'project-a' } });
  });

  it('reports an unavailable lookup without pretending that no records exist', async () => {
    const actions = createLibraryActions({ runtime: createRuntime(), retrieveMemory: async () => ({ entries: [], scope: { projectId: 'project-a' }, availability: { state: 'unavailable', reason: 'source_unavailable' } }) });
    await expect(actions.execute('library.read', { entryId: 'experience-1' }, '/work/a')).resolves.toMatchObject({ memory: null, availability: { state: 'unavailable', reason: 'source_unavailable' } });
    await expect(actions.execute('library.inspect', {}, '')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('keeps document hits when memory retrieval fails and reports the failed component', async () => {
    const actions = createLibraryActions({ runtime: createRuntime(), retrieveMemory: async () => { throw new Error('private detail'); } });
    const result = await actions.execute('library.search', { query: 'architecture' }, '/work/a');
    expect(result.documents).toHaveLength(1);
    expect(result.memoryAvailability).toEqual({ state: 'unavailable', reason: 'memory_retrieval_unavailable' });
    expect(JSON.stringify(result)).not.toContain('private detail');
  });

  it('keeps eligible memories when document retrieval fails', async () => {
    const actions = createLibraryActions({ runtime: createRuntime({ search: async () => { throw new Error('private document backend error'); } }), retrieveMemory: async () => retrieval([card()]) });
    await expect(actions.execute('library.search', { query: 'architecture' }, '/work/a')).resolves.toMatchObject({
      documents: [], passages: [], memories: [{ entryId: 'experience-1' }], availability: { state: 'unavailable', reason: 'document_retrieval_unavailable' },
    });
  });

  it('returns scoped retrieval health when the semantic backend is stopped', async () => {
    const actions = createLibraryActions({ runtime: createRuntime({ isReady: () => false }), retrieveMemory: async () => ({ ...retrieval([]), availability: { state: 'degraded', reason: 'semantic_unavailable' } }) });
    await expect(actions.execute('library.status', {}, '/work/a')).resolves.toMatchObject({ documents: { state: 'unavailable', reason: 'backend_unavailable' }, memories: { state: 'degraded', reason: 'semantic_unavailable' }, scope: { projectId: 'project-a' } });
  });

  it('reads an existing managed document reference through current memory eligibility while the backend is stopped', async () => {
    const calls = [];
    const actions = createLibraryActions({
      runtime: createRuntime({ isReady: () => false, findDocument: async () => ({ id: 'managed-doc', managedBy: 'conversation-memory', absPath: '/memory.md', relPath: 'memory.md' }) }),
      resolveProjectId: async () => 'project-a', retrieveMemory: async (input) => { calls.push(input); return retrieval([card()]); },
    });
    const result = await actions.execute('library.read', { documentId: 'managed-doc' }, '/work/a');
    expect(calls[0]).toMatchObject({ documentIds: ['managed-doc'], mode: 'eligible', directory: '/work/a' });
    expect(result).toMatchObject({ path: '/memory.md', content: 'Retained local result', reference: { sourceHash: 'revision-1', entryId: 'experience-1' } });
  });

  it('keeps an ordinary library filter from returning memories outside that library', async () => {
    const actions = createLibraryActions({ runtime: createRuntime(), retrieveMemory: async () => retrieval([card()]) });
    const result = await actions.execute('library.search', { query: 'architecture', library: 'Docs' }, '/work/a');
    expect(result.documents).toHaveLength(1);
    expect(result.memories).toEqual([]);
  });
  it('derives managed experience scope from the caller rather than input fields', async () => {
    const calls = [];
    const actions = createLibraryActions({ resolveProjectId: async (directory) => directory === '/work/a' ? 'project-a' : '',
      allowedManagedDocuments: async () => ['allowed-doc'],
      runtime: createRuntime({ search: async (input) => { calls.push(input); return { query: input.query, documents: [], passages: [] }; } }),
    });
    await actions.execute('library.search', { query: 'build', projectId: 'project-b' }, '/work/a');
    expect(calls[0]).toMatchObject({ projectId: 'project-a', managedDocumentIds: ['allowed-doc'] });
  });
  it('rechecks experience eligibility after an asynchronous search and preserves provenance', async () => {
    let eligible = true;
    let searches = 0;
    const reference = { documentId: 'm1', kind: 'experience', verification: 'observed', sourceHash: 'revision1', sourceReferences: [{ sessionId: 's1', messageId: 'u1' }], sourcePartIds: ['t1'], limitations: ['Local test only.'] };
    const hit = { documentId: 'm1', managedBy: 'conversation-memory', path: '/memory.md', title: 'Build', relPath: 'memory.md', libraryId: 'memory', content: 'Run the build', startAt: 0, endAt: 13 };
    const actions = createLibraryActions({
      resolveProjectId: async () => 'p1', allowedManagedDocuments: async () => eligible ? ['m1'] : [],
      describeManagedDocuments: async () => eligible ? [reference] : [],
      runtime: createRuntime({ search: async () => { if (++searches > 1) eligible = false; return { query: 'build', documents: [hit], passages: [hit] }; } }),
    });
    const first = await actions.execute('library.search', { query: 'build' }, '/project');
    expect(first.passages[0].reference).toMatchObject(reference);
    const second = await actions.execute('library.search', { query: 'build' }, '/project');
    expect(second.documents).toEqual([]);
    expect(second.passages).toEqual([]);
  });

  it('does not return an experience forgotten during a read', async () => {
    let eligible = true;
    const actions = createLibraryActions({
      resolveProjectId: async () => 'p1', allowedManagedDocuments: async () => eligible ? ['m1'] : [],
      describeManagedDocuments: async () => eligible ? [{ documentId: 'm1' }] : [],
      runtime: createRuntime({
        findDocument: async () => ({ id: 'm1', managedBy: 'conversation-memory', absPath: '/memory.md', relPath: 'memory.md' }),
        readContent: async () => { eligible = false; return { content: 'stale experience', truncated: false }; },
      }),
    });
    await expect(actions.execute('library.read', { documentId: 'm1' }, '/project')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('compacts search results and keeps the absolute path', async () => {
    const actions = createLibraryActions({ runtime: createRuntime() });
    const result = await actions.execute('library.search', { query: '收益法' });

    expect(result.documents[0]).toEqual({ path: '/a/b.md', title: 'b.md', relPath: 'b.md', libraryId: 'l1' });
    expect(result.passages[0].content).toHaveLength(601);
    expect(result.passages[0].content.endsWith('…')).toBe(true);
  });

  it('resolves a library by name and rejects an unknown one', async () => {
    const calls = [];
    const actions = createLibraryActions({
      runtime: createRuntime({
        search: async (input) => {
          calls.push(input);
          return { query: input.query, documents: [], passages: [] };
        },
      }),
    });

    await actions.execute('library.search', { query: 'x', library: 'Docs' });
    expect(calls[0].libraryId).toBe('l1');

    await expect(actions.execute('library.search', { query: 'x', library: 'Other' })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('reads a document by path', async () => {
    const actions = createLibraryActions({ runtime: createRuntime() });
    await expect(actions.execute('library.read', { path: '/a/b.md' })).resolves.toMatchObject({
      path: '/a/b.md',
      content: 'indexed text',
      truncated: false,
    });
  });

  it('rejects a read without a document and an unknown path', async () => {
    const actions = createLibraryActions({ runtime: createRuntime() });
    await expect(actions.execute('library.read', {})).rejects.toMatchObject({ statusCode: 400 });
    await expect(actions.execute('library.read', { path: '/missing.md' })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('refuses document content when the backend is not ready and refuses every action when the tool is off', async () => {
    const down = createLibraryActions({ runtime: createRuntime({ isReady: () => false }) });
    await expect(down.execute('library.read', { documentId: 'd1' })).rejects.toMatchObject({ statusCode: 503 });

    const off = createLibraryActions({ runtime: createRuntime(), isEnabled: async () => false });
    await expect(off.execute('library.search', { query: 'x' })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('requires a query', async () => {
    const actions = createLibraryActions({ runtime: createRuntime() });
    await expect(actions.execute('library.search', {})).rejects.toMatchObject({ statusCode: 400 });
  });
});

it('rechecks the current native tool owner after asynchronous citation projection', async () => {
  let current = true;
  const actions = createLibraryActions({
    resolveProjectId: async () => 'project', allowedManagedDocuments: async () => [],
    describeManagedDocuments: async () => { current = false; return []; },
    runtime: createRuntime({ managedAgentExecution: async () => { if (!current) throw new Error('actor changed'); return { identity: 'fixture' }; } }),
  });
  await expect(actions.execute('library.search', { action: 'library.search', query: 'needle' }, '/project', { contextSessionId: 'session', contextCallId: 'call' })).rejects.toThrow('actor changed');
});
