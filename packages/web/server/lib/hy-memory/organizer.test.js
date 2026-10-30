import { describe, expect, test } from 'bun:test';
import { createHyMemoryOrganizer } from './organizer.js';

describe('Hy host governance', () => {
  test('recall yields while organization runs and cannot cancel the writer', async () => {
    let release;
    const barrier = new Promise((resolve) => { release = resolve; });
    const methods = [];
    const organizer = createHyMemoryOrganizer({ backend: async () => ({}), generate: async () => ({}), readState: async () => ({ engine: { records: [] } }),
      createWorker: () => ({ call: async (method) => { methods.push(method); await barrier; return {}; }, stop: async () => {}, status: () => ({ state: 'ready' }) }) });
    const writing = organizer.organize({ segment: { id: 'one', projectId: 'p', sessionId: 's', directory: '/p' } });
    await expect(organizer.recall({ query: 'query', projectId: 'p', directory: '/p' })).rejects.toThrow('hy_engine_busy');
    release(); await writing;
    expect(methods).toEqual(['organize']);
    await organizer.stop();
    await expect(organizer.organize({ segment: { id: 'two', projectId: 'p', sessionId: 's', directory: '/p' } })).rejects.toThrow('hy_worker_stopped');
  });
  test('uses trusted scope and model preferences for reverse requests', async () => {
    let callbacks; const calls = [];
    const organizer = createHyMemoryOrganizer({ backend: async (action, input) => { calls.push({ action, input }); return { nodes: [] }; },
      generate: async (input) => { calls.push(input); return { text: '{}' }; }, readState: async () => ({ engine: { records: [] } }),
      createWorker: ({ handlers }) => { callbacks = handlers; return { call: async (_method, params) => {
        await expect(callbacks['host.store']({ jobId: params.context.jobId, namespace: 'another-project', operation: 'nodes/list' })).rejects.toThrow();
        await callbacks['host.generate']({ jobId: params.context.jobId, prompt: 'fixture', preferredProviderID: 'spoof' });
        return { cards: [], operations: [] };
      }, stop: async () => {}, status: () => ({ state: 'ready' }) }; } });
    await organizer.organize({ segment: { id: 'one', projectId: 'trusted', directory: '/trusted', sessionId: 's', sourceHash: 'a', providerID: 'real-provider', modelID: 'real-model' } });
    expect(calls[0]).toMatchObject({ directory: '/trusted', preferredProviderID: 'real-provider', preferredModelID: 'real-model', onOverflow: 'error' });
  });
});

const guardedState = (count = 1) => {
  const sessions = { s: { directory: '/p', revision: 1, deleted: false, reconciling: false } };
  const segment = { id: 'source', projectId: 'p', directory: '/p', sessionId: 's', sourceHash: 'hash', messages: [{ id: 'm', partId: 'part', role: 'user', text: 'source' }] };
  const ref = { sessionId: 's', messageId: 'm', partId: 'part', sourceHash: 'hash', sourceRevision: 1 };
  return { sessions, jobs: [{ id: 'source', sourceRevision: 1, segment }], entries: [], tombstones: [], engine: {
    records: Array.from({ length: count }, (_, i) => ({ collection: 'node-source', projectId: 'p', id: `n${String(i).padStart(3, '0')}`, value: { sourceRefs: [ref] } })),
  } };
};
const hostHarness = (state, callback) => {
  const calls = []; let handlers;
  const organizer = createHyMemoryOrganizer({ readState: async () => structuredClone(state),
    backend: async (action, input) => {
      calls.push({ action, input: structuredClone(input) });
      const ids = input.ids ?? input.filters.node_ids;
      const rows = ids.map((id) => ({ id, content: `private ${id}`, payload: {}, score: Number(id.slice(1)) / 1000 }));
      return { nodes: action === 'nodes/search' ? rows.sort((a, b) => b.score - a.score).slice(0, input.limit) : rows.slice(input.offset ?? 0, (input.offset ?? 0) + (input.limit ?? 256)), total: rows.length };
    }, generate: async () => { calls.push({ action: 'generate' }); return { text: '{}' }; },
    createWorker: (options) => { handlers = options.handlers; return { call: async (_method, params) => {
      await callback(handlers, params.context, calls); return {};
    }, stop: async () => {}, status: () => ({ state: 'ready' }) }; },
  });
  return { calls, run: () => organizer.organize({ segment: { id: 'new-source', projectId: 'p', directory: '/p', sessionId: 's', sourceHash: 'next' }, sourceRevision: 1 }) };
};

test('host node reads intersect canonical sources before backend top K and exclude pending withdrawal', async () => {
  const state = guardedState(7);
  state.tombstones.push('n001');
  state.engine.records[2].value.sourceRefs[0] = { ...state.engine.records[2].value.sourceRefs[0], messageId: 'missing' };
  state.engine.records[3].value.sourceRefs[0] = { ...state.engine.records[3].value.sourceRefs[0], sourceRevision: 0 };
  state.engine.records[4].projectId = 'other';
  state.engine.records.push({ collection: 'hy-withdrawal', projectId: 'p', id: 'cleanup', value: { state: 'pending', nodeIds: ['n005'] } });
  const h = hostHarness(state, async (handlers, ctx) => {
    const result = await handlers['host.store']({ jobId: ctx.jobId, operation: 'nodes/search', vector: [1, 0], filters: { node_ids: ['n000', 'n001', 'n002', 'n003', 'n004', 'n005', 'n006', 'untracked'] }, limit: 5 });
    expect(result.nodes.map((row) => row.id)).toEqual(['n006', 'n000']);
  });
  await h.run();
  expect(h.calls[0].input.filters.node_ids).toEqual(['n000', 'n006']);
});

test('host list pagination and semantic ranking remain complete across allowlist chunks', async () => {
  const state = guardedState(300);
  const h = hostHarness(state, async (handlers, ctx) => {
    const listed = await handlers['host.store']({ jobId: ctx.jobId, operation: 'nodes/list', limit: 20, offset: 250 });
    expect(listed.total).toBe(300);
    expect(listed.nodes.map((row) => row.id)).toEqual(Array.from({ length: 20 }, (_, i) => `n${250 + i}`));
    const searched = await handlers['host.store']({ jobId: ctx.jobId, operation: 'nodes/search', limit: 2, vector: [1, 0] });
    expect(searched.nodes.map((row) => row.id)).toEqual(['n299', 'n298']);
  });
  await h.run();
  expect(h.calls.every((call) => (call.input.filters?.node_ids ?? []).length <= 256)).toBe(true);
});

test('deleted source and source tombstone skip the backend entirely', async () => {
  const state = guardedState(1); state.sessions.s.deleted = true;
  const h = hostHarness(state, async (handlers, ctx) => {
    const request = { jobId: ctx.jobId, operation: 'nodes/get', ids: ['n000'] };
    expect(await handlers['host.store'](request)).toMatchObject({ nodes: [] });
    state.sessions.s.deleted = false; state.tombstones.push('source:source:hash');
    expect(await handlers['host.store'](request)).toMatchObject({ nodes: [] });
  });
  await h.run(); expect(h.calls).toEqual([]);
});

test('withdrawal after a node read prevents subsequent model and embedding calls', async () => {
  const state = guardedState(1);
  const h = hostHarness(state, async (handlers, ctx) => {
    await handlers['host.store']({ jobId: ctx.jobId, operation: 'nodes/get', ids: ['n000'] });
    state.sessions.s.reconciling = true;
    await expect(handlers['host.generate']({ jobId: ctx.jobId, prompt: 'private n000' })).rejects.toMatchObject({ code: 'hy_source_changed' });
    await expect(handlers['host.embed']({ jobId: ctx.jobId, texts: ['private n000'] })).rejects.toMatchObject({ code: 'hy_source_changed' });
  });
  await h.run(); expect(h.calls.map((call) => call.action)).toEqual(['nodes/get']);
});

test('retained trace and relation records require live canonical provenance', async () => {
  const state = guardedState(2); const refs = state.engine.records[0].value.sourceRefs;
  state.engine.records.push(
    { collection: 'trace', projectId: 'p', id: 'live', value: { source_refs: refs, node_ids: ['n000'], messages: [{ role: 'user', content: 'live' }] } },
    { collection: 'trace', projectId: 'p', id: 'stale', value: { source_refs: [{ ...refs[0], sourceHash: 'old' }], messages: [{ role: 'user', content: 'private old text' }] } },
    { collection: 'trace', projectId: 'p', id: 'untracked', value: { messages: [{ role: 'user', content: 'no provenance' }] } },
    { collection: 'relation', projectId: 'p', id: 'edge', value: { source_id: 'n000', target_id: 'n001', relation_type: 'RELATED_TO' } },
    { collection: 'relation', projectId: 'p', id: 'old-edge', value: { source_id: 'n000', target_id: 'untracked', relation_type: 'RELATED_TO' } },
  );
  const h = hostHarness(state, async (handlers, ctx) => {
    const records = await handlers['host.store']({ jobId: ctx.jobId, operation: 'records/get', collection: 'trace', ids: ['live', 'stale', 'untracked'] });
    expect(records.records.map((row) => row.id)).toEqual(['live']);
    const relations = await handlers['host.store']({ jobId: ctx.jobId, operation: 'relations/list', node_ids: ['n000'] });
    expect(relations.relations.map((row) => row.target_id)).toEqual(['n001']);
    state.sessions.s.revision = 2;
    await expect(handlers['host.generate']({ jobId: ctx.jobId, prompt: 'live trace' })).rejects.toMatchObject({ code: 'hy_source_changed' });
  });
  await h.run(); expect(h.calls).toEqual([]);
});

test('a source change while the backend reads cannot expose the returned prose', async () => {
  const state = guardedState(1); let handlers;
  const organizer = createHyMemoryOrganizer({ readState: async () => structuredClone(state),
    backend: async () => { state.sessions.s.deleted = true; return { nodes: [{ id: 'n000', content: 'private body' }] }; },
    generate: async () => { throw new Error('No model call authorized'); },
    createWorker: (options) => { handlers = options.handlers; return { call: async (_method, params) => {
      await expect(handlers['host.store']({ jobId: params.context.jobId, operation: 'nodes/get', ids: ['n000'] })).rejects.toMatchObject({ code: 'hy_source_changed' });
      return {};
    }, stop: async () => {}, status: () => ({ state: 'ready' }) }; },
  });
  await organizer.organize({ segment: { id: 'new', projectId: 'p', directory: '/p', sessionId: 's' } });
});
