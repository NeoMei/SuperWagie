import { describe, expect, test } from 'bun:test';
import { createMemoryProjection } from './projection.js';

test('memory indexing uses typed shared nodes without document Wiki policy or parser calls', async () => {
  const calls = [];
  const projection = createMemoryProjection({ backend: async (action, input) => {
    calls.push({ action, input });
    if (action === 'embed') return { vectors: [[1, 0]], space_id: 'fixture-space', dimensions: 2 };
    if (action === 'nodes/upsert') return { ids: input.nodes.map((node) => node.id) };
    return { nodes: [] };
  } });
  const result = await projection.upsertManagedDocument({ projectId: 'p', id: 'card', title: 'Lesson', markdown: 'Split long slides.' });
  expect(result).toEqual({ documentId: 'card', knowledgeId: 'card', state: 'ready' });
  expect(calls.map((call) => call.action)).toEqual(['embed', 'nodes/upsert']);
  expect(calls[1].input.namespace.endsWith(':cards')).toBe(true);
  expect(calls[1].input.nodes[0].payload).toMatchObject({ entry_id: 'card', project_id: 'p' });
});

test('large canonical allowlists partition both retrieval channels before global ranking', async () => {
  const calls = [];
  const projection = createMemoryProjection({ backend: async (action, input) => {
    if (action === 'embed') return { vectors: [[1, 0]], space_id: 'fixture-space', dimensions: 2 };
    calls.push(input);
    if (input.filters.node_ids.length > 256) throw Object.assign(new Error('Backend filter limit'), { code: 'invalid_memory_index_request' });
    const nodes = input.filters.node_ids.includes('last') ? [{ id: 'last', content: 'high relevance', score: 0.99, payload: {} }]
      : [{ id: 'first', content: 'lower relevance', score: 0.4, payload: {} }];
    return { nodes: input.query ? [] : nodes };
  } });
  const result = await projection.searchManagedDocuments({ projectId: 'p', query: 'method', limit: 1,
    documentIds: ['first', ...Array.from({ length: 255 }, (_, index) => `middle-${index}`), 'last'] });
  expect(result.passages.map((hit) => hit.documentId)).toEqual(['last']);
  expect(calls).toHaveLength(4);
  expect(calls.every((input) => input.filters.node_ids.length <= 256)).toBe(true);
});

test('a failed retrieval partition preserves complete partition results with degraded availability', async () => {
  const projection = createMemoryProjection({ backend: async (action, input) => {
    if (action === 'embed') return { vectors: [[1, 0]], space_id: 'fixture-space', dimensions: 2 };
    if (input.filters.node_ids.includes('last')) throw Object.assign(new Error('Partition unavailable'), { code: 'unavailable' });
    return { nodes: [{ id: 'first', content: 'retained', payload: {}, score: 0.9 }] };
  } });
  const result = await projection.searchManagedDocuments({ projectId: 'p', query: 'method', documentIds: ['first', ...Array.from({ length: 255 }, (_, index) => `middle-${index}`), 'last'] });
  expect(result.passages.map((hit) => hit.documentId)).toEqual(['first']);
  expect(result.availability).toEqual({ state: 'degraded', reason: 'unavailable' });
});

test('duplicate model-space hits retain their highest channel score', async () => {
  const projection = createMemoryProjection({ backend: async (action, input) => {
    if (action === 'embed') throw Object.assign(new Error('Semantic model unavailable'), { code: 'unavailable' });
    return { nodes: [{ id: 'same', content: 'best', score: 0.9, payload: {} }, { id: 'other', content: 'other', score: 0.6, payload: {} },
      { id: 'same', content: 'old', score: 0.1, payload: {} }] };
  } });
  const result = await projection.searchManagedDocuments({ projectId: 'p', query: 'lesson', documentIds: ['same', 'other'], limit: 2 });
  expect(result.passages.map((hit) => [hit.documentId, hit.score])).toEqual([['same', 0.9], ['other', 0.6]]);
});
