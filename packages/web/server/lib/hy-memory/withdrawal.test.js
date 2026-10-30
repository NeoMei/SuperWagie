import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSharedMemoryStore } from './store.js';
import { createConversationMemoryStore, memoryEntrySchema } from '../conversation-memory/store.js';
import { memoryNamespace } from './organizer.js';
import { createHyWithdrawal } from './withdrawal.js';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const ref = (sessionId) => ({ sessionId, messageId: `message-${sessionId}`, sourceHash: `hash-${sessionId}` });
const entry = (id, sessionId = 's1', projectId = 'p') => memoryEntrySchema.parse({
  id, projectId, sessionId, kind: 'experience', status: 'active', verification: 'unverified', indexState: 'ready',
  directory: '/project', segmentId: `segment-${sessionId}`, sourceHash: `hash-${sessionId}`,
  sourceMessageIds: [`message-${sessionId}`], sourcePartIds: [], sourceReferences: [ref(sessionId)],
  title: `title ${id}`, body: `body ${id}`, limitations: [], createdAt: 1, updatedAt: 1, documentId: id, knowledgeId: id,
});
const node = (id, sessionId = 's1', projectId = 'p') => ({ collection: 'node-source', id, projectId, value: { id, sourceRefs: [ref(sessionId)] } });
const edge = (id, source, target, relation, projectId = 'p') => ({ collection: 'relation', id, projectId,
  value: { id, source_id: source, target_id: target, relation_type: relation, properties: {} } });
const coreNode = (id, sessionId = 's1') => ({ id, content: `body ${id}`, vector: [1, 0], active: true,
  payload: { user_id: `${memoryNamespace('p')}:core`, workspace_id: 'p', custom: { source_refs: [ref(sessionId)] } } });

async function fixture({ atomic = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hy-withdrawal-')); roots.push(root);
  let revision = 0; let records = []; let failNext = null;
  const indexes = new Map();
  const deletes = [];
  const remove = (input, target) => {
    expect(input.ids.length).toBeLessThanOrEqual(256);
    deletes.push(structuredClone(input));
    for (const id of input.ids) target.delete(`${input.namespace}:${id}`);
  };
  const backend = async (operation, input) => {
    if (operation === 'state/read') return { revision, records: structuredClone(records) };
    if (operation === 'state/commit') {
      const pending = new Map(indexes);
      for (const index of input.index_operations ?? []) {
        if (failNext === 'atomic') { failNext = null; throw Object.assign(new Error('private backend failure'), { code: 'delete_unavailable' }); }
        expect(index.operation).toBe('nodes/delete'); remove(index, pending);
      }
      const next = structuredClone(records);
      for (const mutation of input.mutations) {
        const i = next.findIndex((row) => row.collection === mutation.collection && row.id === mutation.id);
        if (i >= 0) next.splice(i, 1);
        if (!mutation.delete) next.push({ collection: mutation.collection, id: mutation.id, value: mutation.value });
      }
      records = next; indexes.clear(); for (const [key, value] of pending) indexes.set(key, value);
      return { revision: ++revision };
    }
    expect(operation).toBe('nodes/delete');
    if (failNext && input.namespace.endsWith(failNext)) { failNext = null; throw Object.assign(new Error('private backend failure'), { code: 'delete_unavailable' }); }
    remove(input, indexes); return { deleted: input.ids.length };
  };
  const store = atomic ? createSharedMemoryStore({ dataDir: root, backend }) : createConversationMemoryStore({ dataDir: root });
  const seed = async (change) => {
    await store.update(change);
    const state = await store.read();
    for (const row of state.engine.records.filter((row) => row.collection === 'node-source')) indexes.set(`${memoryNamespace(row.projectId)}:core:${row.id}`, row.id);
    for (const card of state.entries) indexes.set(`${memoryNamespace(card.projectId)}:cards:${card.id}`, card.body);
  };
  return { store, seed, indexes, deletes, withdrawal: createHyWithdrawal({ store, backend }), fail: (mode) => { failNext = mode; } };
}

test('source withdrawal erases every representation, derived schema, history and generated receipt in its project', async () => {
  const f = await fixture();
  await f.seed((state) => {
    state.entries = [entry('owner'), entry('derived', 's2'), entry('sibling', 's2'), entry('other-owner', 's1', 'other')];
    state.engine.records = [node('raw'), node('owner'), node('key'), node('derived', 's2'), node('behavior', 's2'), node('sibling', 's2'), node('raw', 's1', 'other'),
      edge('e1', 'owner', 'raw', 'DERIVED_FROM'), edge('e2', 'owner', 'key', 'EXPERIENCE_KEY'), edge('e3', 'owner', 'derived', 'CROSS_ABSTRACTS_TO'),
      edge('e4', 'derived', 'behavior', 'SCHEMA_BEHAVIOR'),
      { collection: 'trace', id: 'trace', projectId: 'p', value: { session_id: 's1', node_ids: ['owner', 'sibling'], messages: 'private source' } },
      { collection: 'code_history', id: 'history', projectId: 'p', value: { node_ids: ['owner'], patch: 'private patch' } }];
    state.jobs = [{ id: 'segment-s1', segment: { id: 'segment-s1', projectId: 'p', sessionId: 's1', directory: '/project', sourceHash: 'hash-s1', messages: [{ text: 'private source' }] },
      state: 'done', error: null, attempts: 1, generated: { cards: [{ id: 'owner', body: 'private generated' }], operations: [] } }];
    state.engine.projections = [{ id: 'old', projectId: 'p', sourceSessionIds: ['s1'], state: 'pending', error: null,
      operations: [{ operation: 'nodes/upsert', nodes: [coreNode('late')] }] }];
  });
  await f.withdrawal.withdraw({ projectId: 'p', sessionIds: ['s1'], forget: true });
  const state = await f.store.read();
  expect(state.engine.records.filter((row) => row.projectId === 'p' && row.collection === 'node-source').map((row) => row.id)).toEqual(['sibling']);
  expect(state.engine.records.filter((row) => ['trace', 'code_history', 'relation'].includes(row.collection))).toEqual([]);
  expect(state.entries.find((card) => card.id === 'owner' && card.projectId === 'p')).toMatchObject({ status: 'forgotten', body: '', cleanupPending: false, documentId: null });
  expect(state.entries.find((card) => card.id === 'derived')).toMatchObject({ status: 'superseded', body: '', cleanupPending: false });
  expect(state.entries.find((card) => card.id === 'sibling')).toMatchObject({ status: 'active', body: 'body sibling' });
  expect(state.entries.find((card) => card.projectId === 'other').body).toBe('body other-owner');
  expect(state.jobs[0].segment).toEqual({ id: 'segment-s1', projectId: 'p', sessionId: 's1', directory: '/project', sourceHash: 'hash-s1' });
  expect(state.jobs[0].generated).toBeNull();
  expect(state.engine.projections[0]).toMatchObject({ state: 'done', operations: [] });
  expect(JSON.stringify(state)).not.toContain('private');
  expect([...f.indexes.keys()].sort()).toEqual([
    `${memoryNamespace('other')}:cards:other-owner`, `${memoryNamespace('other')}:core:raw`,
    `${memoryNamespace('p')}:cards:sibling`, `${memoryNamespace('p')}:core:sibling`,
  ].sort());
});

test('single-card forget preserves sibling source evidence and pending projections', async () => {
  const f = await fixture();
  await f.seed((state) => {
    state.entries = [entry('owner'), entry('sibling')];
    state.engine.records = [node('owner'), node('key'), node('sibling'), node('raw'), edge('e', 'owner', 'key', 'EXPERIENCE_KEY'), edge('e2', 'owner', 'raw', 'DERIVED_FROM'),
      { collection: 'trace', id: 'shared', projectId: 'p', value: { node_ids: ['owner', 'sibling'], messages: 'shared source evidence' } }];
    state.jobs = [{ id: 'segment-s1', segment: { id: 'segment-s1', projectId: 'p', sessionId: 's1', directory: '/project', sourceHash: 'hash-s1', messages: [{ text: 'shared source evidence' }] },
      state: 'indexing', error: null, attempts: 1, generated: { cards: [{ id: 'owner', body: 'private prose' }, { id: 'sibling', body: 'body sibling' }], operations: [] } }];
    state.engine.projections = [{ id: 'mixed', projectId: 'p', sourceSessionIds: ['s1'], state: 'pending', error: null,
      operations: [{ operation: 'nodes/upsert', nodes: [coreNode('owner'), coreNode('sibling')] }] }];
  });
  await f.withdrawal.withdraw({ projectId: 'p', entryIds: ['owner'], forget: true });
  const state = await f.store.read();
  expect(state.engine.records.filter((row) => row.collection === 'node-source').map((row) => row.id)).toEqual(['sibling', 'raw']);
  expect(state.engine.records.find((row) => row.id === 'shared').value).toEqual({ node_ids: ['sibling'], messages: 'shared source evidence' });
  expect(state.jobs[0].segment.messages).toEqual([{ text: 'shared source evidence' }]);
  expect(state.jobs[0].state).toBe('indexing');
  expect(state.engine.projections[0]).toMatchObject({ state: 'pending', operations: [{ operation: 'nodes/upsert', nodes: [coreNode('sibling')] }] });
  expect(JSON.stringify(state)).not.toContain('private prose');
});

test('failed atomic removal retains both indexes, durable closure and private content until retry', async () => {
  const f = await fixture();
  await f.seed((state) => { state.entries = [entry('owner')]; state.engine.records = [node('owner'), node('key'), edge('e', 'owner', 'key', 'CONTENT_REPRESENTATION')]; });
  f.fail('atomic');
  await expect(f.withdrawal.withdraw({ projectId: 'p', entryIds: ['owner'], forget: true })).rejects.toThrow('private backend failure');
  const failed = await f.store.read();
  expect(failed.entries[0]).toMatchObject({ status: 'forgotten', cleanupPending: true, body: 'body owner', error: 'delete_unavailable' });
  expect(failed.engine.records.filter((row) => row.collection === 'node-source')).toHaveLength(2);
  expect([...f.indexes.values()].sort()).toEqual(['body owner', 'key', 'owner']);
  await f.withdrawal.withdraw({ projectId: 'p', entryIds: ['owner'], forget: true });
  expect((await f.store.read()).entries[0]).toMatchObject({ cleanupPending: false, body: '' });
  expect(f.indexes.size).toBe(0);
});

test('partial non-atomic deletion remains retryable and keeps shared state ineligible', async () => {
  const f = await fixture({ atomic: false });
  await f.seed((state) => { state.entries = [entry('owner')]; state.engine.records = [node('owner')]; });
  f.fail(':cards');
  await expect(f.withdrawal.withdraw({ projectId: 'p', sessionIds: ['s1'], forget: true })).rejects.toThrow();
  expect((await f.store.read()).entries[0]).toMatchObject({ cleanupPending: true, body: 'body owner' });
  expect(f.indexes.has(`${memoryNamespace('p')}:cards:owner`)).toBe(true);
  await f.withdrawal.withdraw({ projectId: 'p', sessionIds: ['s1'], forget: true });
  expect(f.indexes.size).toBe(0);
  expect((await f.store.read()).entries[0]).toMatchObject({ cleanupPending: false, body: '' });
});

test('source-only cleanup resumes its durable journal after the session revision changes', async () => {
  const f = await fixture();
  await f.seed((state) => { state.engine.records = [node('raw')]; });
  f.fail('atomic');
  await expect(f.withdrawal.withdraw({ projectId: 'p', sessionIds: ['s1'], forget: true })).rejects.toThrow();
  await f.store.update((state) => { state.sessions.s1 = { directory: '/project', checkpoint: null, revision: 4, deleted: true }; });
  await f.withdrawal.retryPending();
  const state = await f.store.read();
  expect(state.engine.records.filter((row) => row.collection === 'hy-withdrawal' && row.value.state === 'pending')).toEqual([]);
  expect(state.engine.records.filter((row) => row.collection === 'node-source')).toEqual([]);
  expect(f.indexes.size).toBe(0);
});

test('a forgotten source hash cannot erase another session with the same hash', async () => {
  const f = await fixture();
  await f.seed((state) => {
    state.entries = [entry('owner')]; state.engine.records = [node('owner'),
      { collection: 'trace', id: 'unrelated', projectId: 'p', value: { source_refs: [{ sessionId: 'other-session', messageId: 'm', sourceHash: 'hash-s1' }], messages: 'unrelated evidence' } }];
    state.jobs = [{ id: 'segment-s1', segment: { id: 'segment-s1', projectId: 'p', sessionId: 's1', directory: '/project', sourceHash: 'hash-s1' }, state: 'done', error: null, attempts: 1 }];
  });
  await f.withdrawal.withdraw({ projectId: 'p', entryIds: ['owner'], forget: true });
  expect((await f.store.read()).engine.records.find((row) => row.id === 'unrelated')?.value.messages).toBe('unrelated evidence');
});

test('a resumed invalidation preserves restored cards and their newer source representations', async () => {
  const f = await fixture();
  await f.seed((state) => {
    state.entries = [entry('owner')]; state.engine.records = [node('owner'), node('key'), edge('e', 'owner', 'key', 'CONTENT_REPRESENTATION')];
    state.sessions.s1 = { directory: '/project', checkpoint: null, revision: 1, reconciling: true };
  });
  f.fail('atomic');
  await expect(f.withdrawal.withdraw({ projectId: 'p', sessionIds: ['s1'] })).rejects.toThrow();
  await f.store.update((state) => {
    state.entries[0] = entry('owner'); state.sessions.s1.revision = 2; state.sessions.s1.reconciling = false;
    for (const row of state.engine.records.filter((row) => row.collection === 'node-source')) row.value.sourceRefs[0].sourceRevision = 2;
  });
  await f.withdrawal.retryPending();
  const state = await f.store.read();
  expect(state.entries[0]).toMatchObject({ status: 'active', cleanupPending: false, body: 'body owner', documentId: 'owner' });
  expect(state.engine.records.filter((row) => row.collection === 'node-source')).toHaveLength(2);
  expect(state.tombstones).toEqual([]);
  expect(f.indexes.size).toBe(3);
});

test('forgetting the last source card erases retained raw support nodes', async () => {
  const f = await fixture();
  await f.seed((state) => {
    state.entries = [entry('owner')]; state.engine.records = [node('owner'), node('raw'), edge('e', 'owner', 'raw', 'DERIVED_FROM')];
    state.jobs = [{ id: 'segment-s1', segment: { id: 'segment-s1', projectId: 'p', sessionId: 's1', directory: '/project', sourceHash: 'hash-s1', messages: [{ text: 'private source' }] }, state: 'done', error: null, attempts: 1 }];
  });
  await f.withdrawal.withdraw({ projectId: 'p', entryIds: ['owner'], forget: true });
  expect((await f.store.read()).engine.records.filter((row) => row.collection === 'node-source')).toEqual([]);
  expect(f.indexes.size).toBe(0);
});

test('overlapping journal retries cannot repeat an already completed deletion', async () => {
  const f = await fixture();
  await f.seed((state) => { state.entries = [entry('owner')]; state.engine.records = [node('owner')]; });
  f.fail('atomic');
  await expect(f.withdrawal.withdraw({ projectId: 'p', entryIds: ['owner'], forget: true })).rejects.toThrow();
  await Promise.all([f.withdrawal.retryPending(), f.withdrawal.retryPending()]);
  expect(f.deletes).toHaveLength(2);
});

test('schema revision withdrawal erases successor representations and preserves ordinary related nodes', async () => {
  const f = await fixture();
  await f.seed((state) => {
    state.entries = [entry('old-schema'), entry('new-schema', 's2'), entry('related', 's2')];
    const revision = edge('revision', 'new-schema', 'old-schema', 'RELATED_TO'); revision.value.properties.relation_type = 'schema_revision';
    state.engine.records = [node('old-schema'), node('new-schema', 's2'), node('behavior', 's2'), node('related', 's2'), revision,
      edge('behavior', 'new-schema', 'behavior', 'SCHEMA_BEHAVIOR'), edge('normal', 'old-schema', 'related', 'RELATED_TO')];
  });
  await f.withdrawal.withdraw({ projectId: 'p', entryIds: ['old-schema'], forget: true });
  const state = await f.store.read();
  expect(state.engine.records.filter((row) => row.collection === 'node-source').map((row) => row.id)).toEqual(['related']);
  expect(state.entries.find((card) => card.id === 'new-schema')).toMatchObject({ status: 'superseded', cleanupPending: false, body: '' });
  expect(state.entries.find((card) => card.id === 'related')).toMatchObject({ status: 'active', body: 'body related' });
});

test('large source withdrawal batches node deletion inside one atomic commit', async () => {
  const f = await fixture();
  await f.seed((state) => { state.engine.records = Array.from({ length: 300 }, (_, index) => node(`raw-${index}`)); });
  await f.withdrawal.withdraw({ projectId: 'p', sessionIds: ['s1'], forget: true });
  expect(f.indexes.size).toBe(0);
  expect(f.deletes.map((input) => input.ids.length)).toEqual([256, 44]);
});
