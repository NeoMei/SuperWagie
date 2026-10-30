import { describe, expect, it } from 'vitest';

import { createSearch } from './search.js';

const createStore = (documents) => ({ readDocuments: async () => structuredClone(documents) });

const document = (overrides = {}) => ({
  id: 'd1',
  libraryId: 'l1',
  relPath: 'q/收益法说明.png',
  absPath: '/a/q/收益法说明.png',
  size: 100,
  state: 'ready',
  knowledgeId: 'k1',
  parseStatus: 'completed',
  ...overrides,
});

const hit = (overrides = {}) => ({
  knowledge_id: 'k1',
  knowledge_title: '收益法说明.png',
  content: 'x'.repeat(2000),
  chunk_index: 0,
  start_at: 0,
  end_at: 2000,
  score: 0.9,
  ...overrides,
});

describe('merged search', () => {
  it('returns name matches separately from passages and trims passage text', async () => {
    const client = { hybridSearch: async () => [hit()] };
    const search = createSearch({
      client,
      store: createStore({ d1: document() }),
      getKnowledgeBaseId: () => 'kb1',
    });

    const result = await search.search({ query: '收益法' });

    expect(result.documents).toEqual([
      expect.objectContaining({ documentId: 'd1', title: '收益法说明.png', path: '/a/q/收益法说明.png', matched: 'name' }),
    ]);
    expect(result.passages).toHaveLength(1);
    expect(result.passages[0].content).toHaveLength(1201); // 1200 chars + ellipsis
    expect(result.passages[0]).toMatchObject({ documentId: 'd1', startAt: 0, endAt: 2000 });
  });

  it('never returns a document that is not ready', async () => {
    const client = { hybridSearch: async () => [hit(), hit({ knowledge_id: 'k2' })] };
    const search = createSearch({
      client,
      store: createStore({
        d1: document(),
        d2: document({ id: 'd2', relPath: '旧.pdf', knowledgeId: 'k2', state: 'failed' }),
      }),
      getKnowledgeBaseId: () => 'kb1',
    });

    const result = await search.search({ query: '收益法' });
    expect(result.documents.map((entry) => entry.documentId)).toEqual(['d1']);
    expect(result.passages.map((entry) => entry.documentId)).toEqual(['d1']);
  });

  it('scopes a library search by knowledge ids and leaves a global search unscoped', async () => {
    const calls = [];
    const client = {
      hybridSearch: async (input) => {
        calls.push(input);
        return [];
      },
    };
    const search = createSearch({
      client,
      store: createStore({
        d1: document(),
        d2: document({ id: 'd2', libraryId: 'l2', relPath: 'other.md', knowledgeId: 'k2' }),
      }),
      getKnowledgeBaseId: () => 'kb1',
    });

    await search.search({ query: 'x', libraryId: 'l1' });
    expect(calls[0].knowledgeIds).toEqual(['k1']);

    await search.search({ query: 'x' });
    expect(calls[1].knowledgeIds).toBeUndefined();
  });

  it('drops out-of-library and unknown backend hits before applying the result limit', async () => {
    const search = createSearch({
      client: { hybridSearch: async () => [
        hit({ knowledge_id: 'k2', content: 'Other library private text' }),
        hit({ knowledge_id: 'unknown', content: 'Unknown document' }),
        hit({ content: '收益法按预期收益计算价值。' }),
      ] },
      store: createStore({
        d1: document(),
        d2: document({ id: 'd2', libraryId: 'l2', knowledgeId: 'k2' }),
      }),
      getKnowledgeBaseId: () => 'kb1',
    });

    const result = await search.search({ query: '收益法', libraryId: 'l1', limit: 1 });
    expect(result.passages).toEqual([
      expect.objectContaining({ documentId: 'd1', libraryId: 'l1', content: '收益法按预期收益计算价值。' }),
    ]);
  });

  it('skips the backend entirely when nothing is ready', async () => {
    let called = false;
    const search = createSearch({
      client: {
        hybridSearch: async () => {
          called = true;
          return [];
        },
      },
      store: createStore({ d1: document({ state: 'parsing', knowledgeId: null }) }),
      getKnowledgeBaseId: () => 'kb1',
    });

    const result = await search.search({ query: '收益法' });
    expect(called).toBe(false);
    expect(result.passages).toEqual([]);
    expect(result.documents).toEqual([]);
  });

  it('ranks an exact file name before a path-only match', async () => {
    const search = createSearch({
      client: { hybridSearch: async () => [] },
      store: createStore({
        d1: document({ id: 'd1', relPath: 'notes/收益法.md', knowledgeId: null, state: 'ready' }),
        d2: document({ id: 'd2', relPath: '收益法.md', knowledgeId: null, state: 'ready' }),
      }),
      getKnowledgeBaseId: () => 'kb1',
    });

    const result = await search.search({ query: '收益法.md' });
    expect(result.documents.map((entry) => entry.documentId)).toEqual(['d2', 'd1']);
  });

  it('caps passages at the requested limit', async () => {
    const hits = Array.from({ length: 12 }, (_, index) => hit({ knowledge_id: 'k1', chunk_index: index }));
    const search = createSearch({
      client: { hybridSearch: async () => hits },
      store: createStore({ d1: document() }),
      getKnowledgeBaseId: () => 'kb1',
    });

    const result = await search.search({ query: '收益法', limit: 8 });
    expect(result.passages).toHaveLength(8);
  });

  it('returns an empty result for an empty query', async () => {
    const search = createSearch({
      client: { hybridSearch: async () => [] },
      store: createStore({ d1: document() }),
      getKnowledgeBaseId: () => 'kb1',
    });
    await expect(search.search({ query: '   ' })).resolves.toEqual({ query: '', documents: [], passages: [] });
  });
});
