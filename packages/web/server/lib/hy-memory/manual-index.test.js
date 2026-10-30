import { expect, test } from 'bun:test';
import { createManualMemoryIndex } from './manual-index.js';

const row = (id, projectId = 'p', extra = {}) => ({ collection: 'manual', id, projectId, value: {
  id, title: 'Editable slides', body: 'Keep the exported text editable.', type: 'preference', createdAt: 1, updatedAt: 2,
  scope: projectId === 'global' ? 'global' : 'project', ...extra,
} });
function fixture(records, { atomicIndex = true } = {}) {
  let state = { engine: { records: structuredClone(records), dirtyProjects: ['p'] } };
  const nodes = new Map(); const calls = []; let configuration = 'config-1'; let failCommit = false; let afterEmbed;
  const apply = (operations) => {
    for (const op of operations) {
      if (op.operation === 'nodes/delete') for (const [key, saved] of nodes) {
        if (saved.namespace === op.namespace && (!op.space_id || saved.space_id === op.space_id) && op.ids.includes(saved.node.id)) nodes.delete(key);
      }
      if (op.operation === 'nodes/upsert') for (const node of op.nodes) nodes.set(`${op.namespace}:${op.space_id}:${node.id}`, { namespace: op.namespace, space_id: op.space_id, node: structuredClone(node) });
    }
  };
  const store = { atomicIndex,
    async read() { return structuredClone(state); },
    async update(change, { indexOperations = [] } = {}) {
      const next = structuredClone(state); change(next);
      if (failCommit) throw new Error('commit unavailable');
      apply(indexOperations); state = next; return structuredClone(state);
    },
  };
  const backend = async (action, input = {}) => {
    calls.push({ action, input: structuredClone(input) });
    if (action === 'capabilities') return { max_batch: 100, embedding_configuration_id: configuration };
    if (action === 'embed') {
      const result = { vectors: input.texts.map(() => [1, 0]), dimensions: 2, space_id: `${configuration}-space` };
      if (afterEmbed && input.input_role === 'document') { const fn = afterEmbed; afterEmbed = undefined; await fn(); }
      return result;
    }
    if (action === 'nodes/search') {
      const selected = [...nodes.values()].filter((saved) => saved.namespace === input.namespace && saved.space_id === input.space_id && input.filters.node_ids.includes(saved.node.id));
      return { nodes: selected.slice(0, input.limit).map((saved) => ({ ...structuredClone(saved.node), score: 0.9 })) };
    }
    if (action === 'nodes/upsert' || action === 'nodes/delete') { apply([{ ...input, operation: action }]); return {}; }
    throw new Error(`Unexpected ${action}`);
  };
  return { index: createManualMemoryIndex({ store, backend }), store, backend, nodes, calls,
    configure(value) { configuration = value; }, fail(value) { failCommit = value; }, race(fn) { afterEmbed = fn; } };
}

test('manual semantic index retains scope and type, and unchanged records cost no document embeddings', async () => {
  const f = fixture([row('same'), row('same', 'global')]);
  await f.index.sync({ projectId: 'p' }); await f.index.sync({ projectId: 'global' });
  const initial = f.calls.filter((call) => call.action === 'embed' && call.input.input_role === 'document').length;
  await f.index.sync({ projectId: 'p' });
  expect(f.calls.filter((call) => call.action === 'embed' && call.input.input_role === 'document')).toHaveLength(initial);
  expect([...f.nodes.values()].map((saved) => saved.node.payload.manual_type)).toEqual(['preference', 'preference']);
  expect(new Set([...f.nodes.values()].map((saved) => saved.namespace)).size).toBe(2);
  const result = await f.index.search({ projectId: 'p', query: 'slides', limit: 10 });
  expect(result.hits.map((hit) => [hit.id, hit.scope])).toEqual([['same', 'project'], ['same', 'global']]);
  expect(f.calls.filter((call) => call.action === 'embed').at(-1).input.input_role).toBe('query');
  expect((await f.store.read()).engine.dirtyProjects).toEqual(['p']);
});

test('changed, flagged and deleted canonical records disappear before pending index cleanup', async () => {
  const f = fixture([row('changed'), row('flagged'), row('deleted')]);
  await f.index.sync({ projectId: 'p' });
  await f.store.update((state) => {
    state.engine.records = state.engine.records.filter((saved) => saved.collection !== 'manual' || saved.id !== 'deleted');
    state.engine.records.find((saved) => saved.collection === 'manual' && saved.id === 'changed').value.body = 'Use another workflow.';
    state.engine.records.find((saved) => saved.collection === 'manual' && saved.id === 'flagged').value.flagged = true;
  });
  expect((await f.index.search({ projectId: 'p', query: 'slides' })).hits).toEqual([]);
  await f.index.sync({ projectId: 'p' });
  expect(f.nodes.size).toBe(1);
  expect([...f.nodes.values()][0].node.content).toContain('Use another workflow.');
});

test('embedding configuration changes reindex without mixing model spaces', async () => {
  const f = fixture([row('a')]); await f.index.sync({ projectId: 'p' });
  f.configure('config-2'); await f.index.sync({ projectId: 'p' });
  expect([...f.nodes.values()].map((saved) => saved.space_id)).toEqual(['config-2-space']);
  const markers = (await f.store.read()).engine.records.filter((saved) => saved.collection === 'manual-index');
  expect(markers[0].value.configurationId).toBe('config-2');
  expect((await f.index.search({ projectId: 'p', query: 'slides' })).hits).toHaveLength(1);
});

test('canonical mutation during embedding cannot atomically publish stale text or marker', async () => {
  const f = fixture([row('a')]);
  f.race(() => f.store.update((state) => { state.engine.records[0].value.body = 'New source body.'; }));
  const result = await f.index.sync({ projectId: 'p' });
  expect(result.indexed).toBe(0); expect(f.nodes.size).toBe(0);
  expect((await f.store.read()).engine.records.some((saved) => saved.collection === 'manual-index')).toBe(false);
  await f.index.sync({ projectId: 'p' });
  expect([...f.nodes.values()][0].node.content).toContain('New source body.');
});

test('failed atomic commit preserves previous vectors and index markers', async () => {
  const f = fixture([row('a')]); await f.index.sync({ projectId: 'p' });
  const before = structuredClone([...f.nodes.values()]);
  await f.store.update((state) => { state.engine.records.find((saved) => saved.collection === 'manual').value.body = 'Updated.'; });
  f.fail(true); await expect(f.index.sync({ projectId: 'p' })).rejects.toThrow('commit unavailable'); f.fail(false);
  expect([...f.nodes.values()]).toEqual(before);
  expect((await f.index.search({ projectId: 'p', query: 'slides' })).hits).toEqual([]);
});

test('manual indexing bounds each paid batch and resumes from ledger markers', async () => {
  const f = fixture(Array.from({ length: 37 }, (_, i) => row(`a${i}`)));
  const first = await f.index.sync({ projectId: 'p', limit: 20 });
  expect(first.indexed).toBe(20); expect(first.pending).toBe(17);
  const second = await f.index.sync({ projectId: 'p', limit: 20 });
  expect(second.indexed).toBe(17); expect(second.pending).toBe(0);
  expect(f.nodes.size).toBe(37);
});

test('semantic failures return explicit degraded availability for caller lexical fallback', async () => {
  const f = fixture([row('a')]); await f.index.sync({ projectId: 'p' });
  const index = createManualMemoryIndex({ store: f.store, backend: async (action, input) => {
    if (action === 'embed') throw Object.assign(new Error('Embedding offline'), { code: 'embedding_offline' });
    return f.backend(action, input);
  } });
  const result = await index.search({ projectId: 'p', query: 'slides' });
  expect(result.hits).toEqual([]); expect(result.availability).toEqual({ state: 'degraded', reason: 'embedding_offline' });
});

test('non-atomic index failures keep pending cleanup markers and never enter search', async () => {
  const f = fixture([row('a')], { atomicIndex: false });
  const broken = createManualMemoryIndex({ store: f.store, backend: async (action, input) => {
    if (action === 'nodes/upsert') throw new Error('index write unavailable');
    return f.backend(action, input);
  } });
  await expect(broken.sync({ projectId: 'p' })).rejects.toThrow('index write unavailable');
  expect((await f.store.read()).engine.records.find((saved) => saved.collection === 'manual-index').value.state).toBe('pending');
  expect((await f.index.search({ projectId: 'p', query: 'slides' })).hits).toEqual([]);
  await f.store.update((state) => { state.engine.records = state.engine.records.filter((saved) => saved.collection !== 'manual'); });
  await f.index.sync({ projectId: 'p' });
  expect((await f.store.read()).engine.records.some((saved) => saved.collection === 'manual-index')).toBe(false);
});

test('canonical withdrawal during semantic search excludes returned vector hits', async () => {
  const f = fixture([row('a')]); await f.index.sync({ projectId: 'p' });
  const index = createManualMemoryIndex({ store: f.store, backend: async (action, input) => {
    const result = await f.backend(action, input);
    if (action === 'nodes/search') await f.store.update((state) => { state.engine.records = state.engine.records.filter((saved) => saved.collection !== 'manual'); });
    return result;
  } });
  expect((await index.search({ projectId: 'p', query: 'slides' })).hits).toEqual([]);
});
