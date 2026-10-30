import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSharedMemoryStore } from './store.js';
import { createConversationMemoryStore, memoryEntrySchema } from '../conversation-memory/store.js';
import { applyHyProjection } from './results.js';
import { createHyWithdrawal } from './withdrawal.js';
import { memoryNamespace } from './organizer.js';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { force: true, recursive: true }); });
const refs = [{ sessionId: 's', messageId: 'u', sourceHash: 'hash', sourceRevision: 0 }];
const makeNode = (id) => ({ id, content: `private ${id}`, active: true, vector: [1, 0], payload: {
  user_id: `${memoryNamespace('p')}:core`, workspace_id: 'p', custom: { source_refs: refs },
} });
async function fixture(ids) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hy-projection-withdrawal-')); roots.push(dataDir);
  let revision = 0; let records = [];
  const nodes = new Map(ids.map((id) => [id, makeNode(id)]));
  const backend = async (operation, input) => {
    if (operation === 'state/read') return { revision, records: structuredClone(records) };
    expect(operation).toBe('state/commit');
    for (const op of input.index_operations) {
      expect((op.nodes ?? op.ids).length).toBeLessThanOrEqual(256);
      if (!op.namespace.endsWith(':core')) continue;
      if (op.operation === 'nodes/delete') for (const id of op.ids) nodes.delete(id);
      if (op.operation === 'nodes/upsert') for (const node of op.nodes) nodes.set(node.id, node);
    }
    for (const mutation of input.mutations) {
      records = records.filter((row) => row.collection !== mutation.collection || row.id !== mutation.id);
      if (!mutation.delete) records.push({ collection: mutation.collection, id: mutation.id, value: mutation.value });
    }
    return { revision: ++revision };
  };
  const store = createSharedMemoryStore({ dataDir, backend });
  await store.update((state) => {
    state.sessions.s = { directory: '/p', checkpoint: null, revision: 0 };
    state.engine.records = ids.map((id) => ({ id, projectId: 'p', collection: 'node-source', value: { id, sourceRefs: refs } }));
    state.engine.projections = [{ id: 'batch', projectId: 'p', sourceSessionIds: ['s'], state: 'pending', error: null,
      operations: [{ operation: 'nodes/upsert', space_id: 'space', nodes: ids.map(makeNode) }] }];
  });
  return { store, nodes, backend, withdrawal: createHyWithdrawal({ store, backend }) };
}

test('a stale completed projection cannot resurrect forgotten core nodes', async () => {
  const f = await fixture(['forgotten']);
  const stale = (await f.store.read()).engine.projections[0];
  await f.withdrawal.withdraw({ projectId: 'p', entryIds: ['forgotten'], forget: true });
  await applyHyProjection({ store: f.store, backend: f.backend, projection: stale });
  expect([...f.nodes.keys()]).toEqual([]);
  expect((await f.store.read()).engine.records.filter((record) => record.collection === 'node-source')).toEqual([]);
});

test('a superseded Hy fact retires its old card in the same index commit without forgetting the version anchor', async () => {
  const f = await fixture(['old']);
  await f.store.update((state) => {
    state.entries.push(memoryEntrySchema.parse({ id: 'old', kind: 'segment', title: 'Old wording', body: 'Historical body',
      status: 'active', verification: 'unverified', indexState: 'ready', documentId: 'old', knowledgeId: 'old',
      projectId: 'p', directory: '/p', sessionId: 's', segmentId: 'capture', sourceHash: 'hash',
      sourceMessageIds: ['u'], sourceReferences: [{ sessionId: 's', messageId: 'u' }], limitations: [], createdAt: 1, updatedAt: 1 }));
    const node = state.engine.projections[0].operations[0].nodes[0];
    node.active = false; node.payload.status = 'superseded';
  });
  const operations = [];
  const shared = { atomicIndex: true, read: f.store.read, update: (change, options) => {
    const work = f.store.update(change, options); return work.then((result) => { operations.push(...options.indexOperations); return result; });
  } };
  await applyHyProjection({ store: shared, backend: f.backend, projection: (await f.store.read()).engine.projections[0] });
  expect((await f.store.read()).entries[0]).toMatchObject({ status: 'superseded', cleanupPending: false, documentId: null, body: 'Historical body' });
  expect(operations).toContainEqual({ operation: 'nodes/delete', namespace: `${memoryNamespace('p')}:cards`, ids: ['old'] });
  expect(f.nodes.get('old')?.active).toBe(false);
});

test('a changed secondary source revision rejects the whole atomic projection', async () => {
  const f = await fixture(['derived']);
  await f.store.update((state) => {
    state.sessions.secondary = { directory: '/p', checkpoint: null, revision: 2 };
    state.engine.projections[0].operations[0].nodes[0].payload.custom.source_refs.push({ sessionId: 'secondary', messageId: 'u2', sourceHash: 'hash2', sourceRevision: 1 });
  });
  const projection = (await f.store.read()).engine.projections[0];
  await expect(applyHyProjection({ store: f.store, backend: f.backend, projection })).rejects.toMatchObject({ code: 'source_changed' });
  expect((await f.store.read()).engine.projections[0].state).toBe('pending');
});

test('a stale mixed projection commits only its surviving sibling operations', async () => {
  const f = await fixture(['forgotten', 'sibling']);
  const stale = (await f.store.read()).engine.projections[0];
  await f.withdrawal.withdraw({ projectId: 'p', entryIds: ['forgotten'], forget: true });
  await applyHyProjection({ store: f.store, backend: f.backend, projection: stale });
  expect([...f.nodes.keys()]).toEqual(['sibling']);
  expect((await f.store.read()).engine.records.filter((record) => record.collection === 'node-source').map((record) => record.id)).toEqual(['sibling']);
});

test('ordinary node deletion removes the matching authoritative node-source record', async () => {
  const f = await fixture(['obsolete']);
  await f.store.update((state) => { state.engine.projections[0].operations = [{ operation: 'nodes/delete', ids: ['obsolete'] }]; });
  await applyHyProjection({ store: f.store, backend: f.backend, projection: (await f.store.read()).engine.projections[0] });
  expect([...f.nodes.keys()]).toEqual([]);
  expect((await f.store.read()).engine.records.filter((record) => record.collection === 'node-source')).toEqual([]);
});

test('large atomic node projections respect the backend payload batch limit', async () => {
  const f = await fixture(Array.from({ length: 300 }, (_, index) => `node-${index}`));
  await applyHyProjection({ store: f.store, backend: f.backend, projection: (await f.store.read()).engine.projections[0] });
  expect(f.nodes.size).toBe(300);
  expect((await f.store.read()).engine.projections[0].state).toBe('done');
});

test('node upserts require an atomic store before any backend write', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hy-nonatomic-projection-')); roots.push(dataDir);
  const store = createConversationMemoryStore({ dataDir }); let writes = 0;
  await store.update((state) => {
    state.sessions.s = { directory: '/p', checkpoint: null, revision: 0 };
    state.engine.projections = [{ id: 'batch', projectId: 'p', sourceSessionIds: ['s'], state: 'pending', error: null,
      operations: [{ operation: 'nodes/upsert', space_id: 'space', nodes: [makeNode('private')] }] }];
  });
  await expect(applyHyProjection({ store, backend: async () => { writes++; }, projection: (await store.read()).engine.projections[0] })).rejects.toMatchObject({ code: 'hy_atomic_projection_required' });
  expect(writes).toBe(0);
  expect((await store.read()).engine.projections[0].state).toBe('pending');
});
