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
