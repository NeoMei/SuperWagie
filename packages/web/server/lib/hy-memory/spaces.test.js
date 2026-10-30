import { expect, test } from 'bun:test';
import { createHySpaceMaintenance } from './spaces.js';
import { memoryNamespace } from './organizer.js';

const source = { sessionId: 's', messageId: 'm', partId: 'part', sourceHash: 'a'.repeat(64), sourceRevision: 2 };
const core = (id) => ({ id, content: `Remember ${id}`, vector: [1, 0], active: id !== 'behavior',
  payload: { user_id: `${memoryNamespace('p')}:core`, workspace_id: 'p', status: id === 'behavior' ? 'shadow' : 'active',
    custom: { source_refs: [source], representation_role: id === 'behavior' ? 'behavior' : 'content' } } });
const fixture = ({ rows = [core('fact'), core('behavior')], cards = true, maxBatches = 32 } = {}) => {
  let state = { entries: cards ? [{ id: 'card', projectId: 'p', sessionId: 's', segmentId: 'capture', directory: '/p', sourceHash: source.sourceHash,
    sourceMessageIds: ['m'], sourcePartIds: ['part'], sourceReferences: [{ sessionId: 's', messageId: 'm' }], status: 'active', kind: 'segment',
    indexState: 'ready', title: 'Card', body: 'Remember card', cleanupPending: false, updatedAt: 1, supportingEntryIds: [] }] : [],
    sessions: { s: { directory: '/p', revision: 2, deleted: false, reconciling: false } }, tombstones: [],
    jobs: [{ id: 'capture', sourceRevision: 2, segment: { id: 'capture', projectId: 'p', sessionId: 's', sourceHash: source.sourceHash,
      messages: [{ id: 'm', partId: 'part' }] } }],
    engine: { records: [{ collection: 'model-space', projectId: 'p', id: 'current', value: { spaceId: 'old', configurationId: 'config-old', dimensions: 2 } },
      ...rows.map((row) => ({ collection: 'node-source', projectId: 'p', id: row.id, value: { id: row.id, sourceRefs: [source] } }))] } };
  const nodes = new Map(); const calls = []; let configuration = 'config-new'; let failAt = 0; let embedCount = 0; let afterEmbed;
  const key = (namespace, space, id) => `${namespace}:${space}:${id}`;
  const seed = (kind, row) => nodes.set(key(`${memoryNamespace('p')}:${kind}`, 'old', row.id), { namespace: `${memoryNamespace('p')}:${kind}`, space_id: 'old', node: structuredClone(row) });
  rows.forEach((row) => seed('core', row));
  if (cards) seed('cards', { id: 'card', content: 'Remember card', vector: [1, 0], active: true, payload: { entry_id: 'card', project_id: 'p', title: 'Card' } });
  const apply = (operations) => {
    for (const op of operations) {
      if (op.operation === 'nodes/upsert') for (const node of op.nodes) nodes.set(key(op.namespace, op.space_id, node.id), { namespace: op.namespace, space_id: op.space_id, node: structuredClone(node) });
      if (op.operation === 'nodes/delete') for (const [id, value] of nodes) if (value.namespace === op.namespace && (!op.space_id || value.space_id === op.space_id)
        && (!op.ids || op.ids.includes(value.node.id))) nodes.delete(id);
    }
  };
  const store = { atomicIndex: true,
    read: async () => structuredClone(state),
    update: async (change, { indexOperations = [] } = {}) => {
      const draft = structuredClone(state); change(draft); apply(indexOperations); state = draft; return structuredClone(state);
    },
  };
  const backend = async (action, input = {}) => {
    calls.push({ action, input: structuredClone(input) });
    if (action === 'capabilities') return { embedding_configuration_id: configuration, max_batch: 256 };
    if (action === 'nodes/list') {
      const selected = [...nodes.values()].filter((row) => row.namespace === input.namespace && (!input.space_id || row.space_id === input.space_id)).sort((a, b) => a.node.id.localeCompare(b.node.id));
      return { nodes: selected.slice(input.offset ?? 0, (input.offset ?? 0) + input.limit).map((row) => ({ ...structuredClone(row.node), space_id: row.space_id })), total: selected.length };
    }
    if (action === 'embed') {
      embedCount++; if (failAt === embedCount) throw Object.assign(new Error('Unavailable'), { code: 'unavailable' });
      const result = { vectors: input.texts.map(() => [0, 1]), space_id: 'new', dimensions: 2 };
      if (afterEmbed) { const next = afterEmbed; afterEmbed = null; await next(); }
      return result;
    }
    throw new Error(`Unexpected ${action}`);
  };
  return { store, backend, nodes, calls, spaces: createHySpaceMaintenance({ store, backend, batchSize: 1, maxBatches }),
    setConfiguration(value) { configuration = value; }, fail(value) { failAt = value; }, race(fn) { afterEmbed = fn; },
    count(space) { return [...nodes.values()].filter((row) => row.space_id === space).length; } };
};

test('an empty project never invokes the model just to establish its configuration', async () => {
  const f = fixture({ rows: [], cards: false });
  await f.store.update((state) => { state.engine.records = []; });
  expect(await f.spaces.ensure({ projectId: 'p' })).toEqual({ spaceId: undefined, configurationId: 'config-new' });
  expect(f.calls.some((call) => call.action === 'embed')).toBe(false);
});

test('unchanged bound configuration performs no embedding or index write', async () => {
  const f = fixture(); f.setConfiguration('config-old');
  expect(await f.spaces.ensure({ projectId: 'p' })).toMatchObject({ spaceId: 'old', configurationId: 'config-old' });
  expect(f.calls.map((call) => call.action)).toEqual(['capabilities']); expect(f.count('old')).toBe(3);
});

test('migrates core, behavior and cards with stable IDs and flags before the final binding swap', async () => {
  const f = fixture();
  expect(await f.spaces.ensure({ projectId: 'p' })).toMatchObject({ spaceId: 'new', configurationId: 'config-new' });
  expect(f.count('old')).toBe(0); expect(f.count('new')).toBe(3);
  const behavior = [...f.nodes.values()].find((row) => row.node.id === 'behavior').node;
  expect(behavior).toMatchObject({ active: false, vector: [0, 1], payload: { status: 'shadow', custom: { source_refs: [source], representation_role: 'behavior' } } });
  expect((await f.store.read()).entries[0]).toMatchObject({ status: 'active', indexState: 'ready', sourceHash: source.sourceHash });
  expect(f.calls.filter((call) => call.action === 'embed').every((call) => call.input.input_role === 'document')).toBe(true);
});

test('a failed copy keeps the complete old space and resumes without embedding completed batches again', async () => {
  const f = fixture(); f.fail(2);
  await expect(f.spaces.ensure({ projectId: 'p' })).rejects.toThrow('Unavailable');
  expect(f.count('old')).toBe(3); expect(f.count('new')).toBe(1);
  expect((await f.store.read()).engine.records.find((row) => row.collection === 'model-space').value.spaceId).toBe('old');
  f.fail(0); await f.spaces.ensure({ projectId: 'p' });
  expect(f.count('old')).toBe(0); expect(f.count('new')).toBe(3);
  const texts = f.calls.filter((call) => call.action === 'embed').flatMap((call) => call.input.texts);
  expect(texts.filter((text) => text === 'Remember behavior')).toHaveLength(1);
});

test('a source withdrawal during embedding prevents publishing the copied row', async () => {
  const f = fixture();
  f.race(() => f.store.update((state) => { state.sessions.s.reconciling = true; state.sessions.s.revision++; }));
  await expect(f.spaces.ensure({ projectId: 'p' })).rejects.toThrow('source_changed');
  expect(f.count('new')).toBe(0); expect(f.count('old')).toBe(3);
  expect((await f.store.read()).engine.records.find((row) => row.collection === 'model-space').value.spaceId).toBe('old');
});

test('bounded migration persists a continuation and finishes on its next invocation', async () => {
  const f = fixture({ maxBatches: 1 });
  await expect(f.spaces.ensure({ projectId: 'p' })).rejects.toThrow('hy_space_migration_pending');
  expect(f.count('old')).toBe(3); expect(f.count('new')).toBe(1);
  await expect(f.spaces.ensure({ projectId: 'p' })).rejects.toThrow('hy_space_migration_pending');
  expect(f.count('new')).toBe(2);
  await f.spaces.ensure({ projectId: 'p' }); expect(f.count('old')).toBe(0); expect(f.count('new')).toBe(3);
});

test('source guard rejects a core row that disagrees with the canonical provenance ledger', async () => {
  const f = fixture({ rows: [core('fact')], cards: false });
  await f.store.update((state) => { state.engine.records.find((row) => row.collection === 'node-source').value.sourceRefs[0].messageId = 'other'; });
  await expect(f.spaces.ensure({ projectId: 'p' })).rejects.toThrow('hy_space_source_invalid');
  expect(f.calls.some((call) => call.action === 'embed')).toBe(false); expect(f.count('new')).toBe(0);
});

test('a cancelled or blocked migration starts no backend or model calls', async () => {
  const f = fixture(); const controller = new AbortController(); controller.abort();
  await expect(f.spaces.ensure({ projectId: 'p', signal: controller.signal })).rejects.toThrow('hy_cancelled');
  const blocked = createHySpaceMaintenance({ store: f.store, backend: f.backend, canProcess: () => false });
  await expect(blocked.ensure({ projectId: 'p' })).rejects.toThrow('hy_space_migration_blocked');
  expect(f.calls).toHaveLength(0);
});

test('a concurrent binding change prevents final old-space deletion', async () => {
  const f = fixture();
  f.race(() => f.store.update((state) => { state.engine.records.find((row) => row.collection === 'model-space').value.configurationId = 'another-writer'; }));
  await expect(f.spaces.ensure({ projectId: 'p' })).rejects.toThrow('source_changed');
  expect(f.count('old')).toBe(3); expect(f.count('new')).toBe(0);
});
