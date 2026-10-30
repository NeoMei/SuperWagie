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

  it('refuses when the backend is not ready or the tool is off', async () => {
    const down = createLibraryActions({ runtime: createRuntime({ isReady: () => false }) });
    await expect(down.execute('library.search', { query: 'x' })).rejects.toMatchObject({ statusCode: 503 });

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
