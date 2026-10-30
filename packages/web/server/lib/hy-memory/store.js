import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createConversationMemoryStore, conversationMemoryStateSchema } from '../conversation-memory/store.js';

const rowSchema = z.object({ collection: z.string(), id: z.string(), value: z.json() });
const snapshotSchema = z.object({ revision: z.number().int().nonnegative(), records: z.array(rowSchema) });
const revisionSchema = z.object({ revision: z.number().int().nonnegative() });
const key = (row) => `${row.collection}:${row.id}`;
const encode = (state) => {
  const { sessions, entries, jobs, syntheses, engine, ...meta } = state;
  return [
    { collection: 'meta', id: 'control', value: meta },
    { collection: 'meta', id: 'engine', value: { ...engine, records: [], projections: [] } },
    ...Object.entries(sessions).map(([id, value]) => ({ collection: 'source', id, value })),
    ...entries.map((value) => ({ collection: 'entry', id: value.id, value })),
    ...jobs.map((value) => ({ collection: 'job', id: `capture:${value.id}`, value: { type: 'capture', item: value } })),
    ...syntheses.map((value) => ({ collection: 'job', id: `synthesis:${value.id}`, value: { type: 'synthesis', item: value } })),
    ...engine.records.map((value) => ({ collection: 'entry', id: `hy:${createHash('sha256').update(JSON.stringify([value.projectId, value.collection, value.id])).digest('hex')}`, value })),
    ...engine.projections.map((value) => ({ collection: 'receipt', id: value.id, value })),
  ];
};
const decode = (rows) => {
  const control = rows.find((row) => row.collection === 'meta' && row.id === 'control');
  if (!control) return null;
  const engine = rows.find((row) => row.collection === 'meta' && row.id === 'engine')?.value;
  const value = z.object({ version: z.literal(1) }).passthrough().parse(control.value);
  return conversationMemoryStateSchema.parse({ ...value,
    sessions: Object.fromEntries(rows.filter((row) => row.collection === 'source').map((row) => [row.id, row.value])),
    entries: rows.filter((row) => row.collection === 'entry' && !row.id.startsWith('hy:')).map((row) => row.value),
    jobs: rows.filter((row) => row.collection === 'job' && row.id.startsWith('capture:')).map((row) => z.object({ item: z.json() }).parse(row.value).item),
    syntheses: rows.filter((row) => row.collection === 'job' && row.id.startsWith('synthesis:')).map((row) => z.object({ item: z.json() }).parse(row.value).item),
    engine: { ...z.object({}).passthrough().parse(engine ?? {}),
      records: rows.filter((row) => row.collection === 'entry' && row.id.startsWith('hy:')).map((row) => row.value),
      projections: rows.filter((row) => row.collection === 'receipt').map((row) => row.value) },
  });
};

/** SQLite owns commits after a one-time, consent-preserving import. Legacy JSON is retained. */
export function createSharedMemoryStore({ dataDir, backend, namespace = 'superwagie:memory' }) {
  const legacy = createConversationMemoryStore({ dataDir });
  let queue = Promise.resolve();
  const commit = async (snapshot, state, indexOperations = []) => {
    const next = encode(conversationMemoryStateSchema.parse(state));
    const before = new Map(snapshot.records.map((row) => [key(row), row]));
    const after = new Map(next.map((row) => [key(row), row]));
    const mutations = next.filter((row) => JSON.stringify(before.get(key(row))?.value) !== JSON.stringify(row.value));
    for (const row of snapshot.records) if (!after.has(key(row))) mutations.push({ collection: row.collection, id: row.id, delete: true });
    if (!mutations.length && !indexOperations.length) return;
    const identity = createHash('sha256').update(JSON.stringify([namespace, snapshot.revision, mutations, indexOperations])).digest('hex');
    revisionSchema.parse(await backend('state/commit', { namespace, expected_revision: snapshot.revision, idempotency_key: identity, mutations, index_operations: indexOperations }));
  };
  const load = async () => {
    const snapshot = snapshotSchema.parse(await backend('state/read', { namespace }));
    const current = decode(snapshot.records);
    if (current) return { snapshot, current };
    const imported = conversationMemoryStateSchema.parse(await legacy.read());
    await commit(snapshot, imported);
    return { snapshot: snapshotSchema.parse(await backend('state/read', { namespace })), current: imported };
  };
  return {
    atomicIndex: true,
    read() {
      const work = queue.then(async () => structuredClone((await load()).current));
      queue = work.catch(() => {});
      return work;
    },
    update(change, { indexOperations = [] } = {}) {
      const work = queue.then(async () => {
        const { snapshot, current } = await load();
        const draft = structuredClone(current);
        change(draft);
        const next = conversationMemoryStateSchema.parse(draft);
        await commit(snapshot, next, indexOperations);
        return structuredClone(next);
      });
      queue = work.catch(() => {});
      return work;
    },
  };
}
