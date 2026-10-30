import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createConversationMemoryStore, memoryEntrySchema } from '../conversation-memory/store.js';
import { createMethodologyManager, methodologySourcesEligible } from '../conversation-memory/methodology.js';
import { createHyMaintenance } from './maintenance.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const entry = (id, sessionId, extra = {}) => memoryEntrySchema.parse({
  id, sessionId, kind: 'segment', title: 'Export lesson', body: 'Inspect editable exports under the recorded conditions.',
  status: 'active', verification: 'unverified', indexState: 'ready', projectId: 'p', directory: '/p',
  segmentId: `capture-${id}`, sourceHash: (sessionId === 's1' ? 'a' : 'b').repeat(64),
  sourceMessageIds: [`message-${id}`], sourcePartIds: [`part-${id}`],
  sourceReferences: [{ sessionId, messageId: `message-${id}` }], limitations: ['Fixture observation.'], createdAt: 1, updatedAt: 1, ...extra,
});
const seed = async (entries) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hy-maintenance-'));
  cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
  const store = createConversationMemoryStore({ dataDir });
  await store.update((state) => {
    state.enabled = true; state.entries = entries; state.engine = { records: [], projections: [], dirtyProjects: ['p'], continuations: {}, migrated: false };
    for (const item of entries) {
      state.sessions[item.sessionId] = { directory: item.directory, checkpoint: null, revision: 3 };
      state.jobs.push({ id: item.segmentId, state: 'done', error: null, attempts: 1, sourceRevision: 3,
        segment: { id: item.segmentId, sessionId: item.sessionId, projectId: item.projectId, directory: item.directory,
          title: item.title, createdAt: 1, sourceHash: item.sourceHash, outcome: 'unknown', messageIds: item.sourceMessageIds,
          messages: item.sourceMessageIds.map((id, index) => ({ id, partId: item.sourcePartIds[index], role: 'tool', status: 'completed', text: 'Observed fixture output.' })) } });
    }
  });
  return store;
};
const resultFor = (entries, { cards = true, continuation = null } = {}) => ({
  cards: cards ? [{ id: 'method', kind: 'methodology', title: 'Inspect editable exports', body: 'Inspect an export under its recorded conditions.',
    status: 'active', verification: 'observed', supportingEntryIds: entries.map((item) => item.id),
    sourceMessageIds: entries.flatMap((item) => item.sourceMessageIds), sourcePartIds: entries.flatMap((item) => item.sourcePartIds),
    sourceRefs: entries.flatMap((item) => item.sourceRefs), limitations: ['Validate independently.'] }] : [],
  operations: [{ operation: 'records/upsert', collection: 'review', id: 'cluster-1', value: { reviewed: true } }],
  review: { reviewed: ['cluster-1'], toolCalls: [{ operation: 'create_schema' }] }, continuation,
});
const setup = async ({ entries = [entry('a', 's1'), entry('b', 's2', { kind: 'experience', status: 'candidate', indexState: 'pending' })], consolidate, backend, verifySources } = {}) => {
  const store = await seed(entries); const requests = [];
  const maintenance = createHyMaintenance({ store, backend: backend ?? (async () => ({})), canProcess: () => true, now: () => 10,
    verifySources: verifySources ?? (async () => true), organizer: { consolidate: async (request) => {
      requests.push(request); return consolidate ? consolidate(request) : resultFor(request.entries);
    } } });
  return { store, maintenance, requests };
};

test('coalesces dirty sources into one bounded job and preserves candidate supports', async () => {
  const h = await setup();
  await h.maintenance.schedule(); await h.maintenance.schedule();
  let state = await h.store.read();
  expect(state.syntheses).toHaveLength(1); expect(state.syntheses[0].automatic).toBe(true);
  await h.maintenance.process(state.syntheses[0]); state = await h.store.read();
  expect(h.requests).toHaveLength(1);
  expect(h.requests[0].entries[1]).toMatchObject({ status: 'candidate', sourceRefs: [{ sessionId: 's2', messageId: 'message-b', partId: 'part-b', sourceHash: 'b'.repeat(64), sourceRevision: 3 }] });
  const method = state.entries.find((item) => item.id === 'method');
  expect(method).toMatchObject({ status: 'candidate', verification: 'unverified', confirmed: false, indexState: 'pending' });
  expect(methodologySourcesEligible(state, method)).toBe(true);
  expect(state.entries.find((item) => item.id === 'b').status).toBe('candidate');
  expect(state.engine.records.find((record) => record.collection === 'review')?.value).toEqual({ reviewed: true });
  expect(state.syntheses[0].generated.review).toEqual({ reviewed: ['cluster-1'], toolCalls: [{ operation: 'create_schema' }] });
  await h.store.update((next) => { next.entries.find((item) => item.id === 'b').status = 'forgotten'; });
  expect(methodologySourcesEligible(await h.store.read(), method)).toBe(false);
});

test('requires retained current source messages from two sessions and never mixes projects', async () => {
  const entries = Array.from({ length: 12 }, (_, i) => entry(`a${i}`, 's1'));
  entries.push(entry('b', 's2', { kind: 'experience', status: 'candidate' }), entry('other', 's2', { projectId: 'other' }));
  const h = await setup({ entries }); await h.maintenance.schedule();
  const [job] = (await h.store.read()).syntheses;
  expect(job.supports).toHaveLength(10); expect(new Set(job.supports.map((item) => item.sessionId)).size).toBe(2);
  expect(job.supports.some((item) => item.id === 'other')).toBe(false);
  await h.store.update((state) => { state.sessions.s2.revision++; });
  await h.maintenance.process(job);
  expect(h.requests).toHaveLength(0);
  expect((await h.store.read()).entries.some((item) => item.kind === 'methodology')).toBe(false);
});

test('each confirmed method in an automatic batch indexes against candidate source supports', async () => {
  const h = await setup({ consolidate: async ({ entries }) => {
    const result = resultFor(entries); result.cards.push({ ...result.cards[0], id: 'second-method' }); return result;
  } });
  await h.maintenance.schedule(); await h.maintenance.process((await h.store.read()).syntheses[0]);
  await h.store.update((state) => {
    for (const item of state.entries.filter((item) => item.kind === 'methodology')) { item.status = 'active'; item.confirmed = true; }
    state.syntheses[0].state = 'indexing';
  });
  const indexed = [];
  const manager = createMethodologyManager({ store: h.store, resolveProjectId: async () => 'p', canProcess: () => true, now: () => 11,
    knowledgeLibrary: { upsertManagedDocument: async ({ id }) => { indexed.push(id); return { documentId: id, state: 'ready' }; } } });
  await manager.process((await h.store.read()).syntheses[0]); await manager.process((await h.store.read()).syntheses[0]);
  const state = await h.store.read();
  expect(indexed.sort()).toEqual(['method', 'second-method']);
  expect(state.entries.filter((item) => item.kind === 'methodology').every((item) => item.indexState === 'ready')).toBe(true);
  expect(state.syntheses[0].state).toBe('done'); expect(state.entries.find((item) => item.id === 'b').status).toBe('candidate');
});

test('one method indexing failure preserves its error while another confirmed method finishes', async () => {
  const h = await setup({ consolidate: async ({ entries }) => {
    const result = resultFor(entries); result.cards.push({ ...result.cards[0], id: 'second-method' }); return result;
  } });
  await h.maintenance.schedule(); await h.maintenance.process((await h.store.read()).syntheses[0]);
  await h.store.update((state) => {
    for (const item of state.entries.filter((item) => item.kind === 'methodology')) { item.status = 'active'; item.confirmed = true; }
    state.syntheses[0].state = 'indexing';
  });
  const manager = createMethodologyManager({ store: h.store, resolveProjectId: async () => 'p', canProcess: () => true, now: () => 11,
    knowledgeLibrary: { upsertManagedDocument: async ({ id }) => id === 'method' ? { state: 'failed', error: { code: 'index_failed' } } : { documentId: id, state: 'ready' } } });
  await manager.process((await h.store.read()).syntheses[0]); await manager.process((await h.store.read()).syntheses[0]);
  const state = await h.store.read();
  expect(state.entries.find((item) => item.id === 'method')).toMatchObject({ indexState: 'failed', error: 'index_failed' });
  expect(state.entries.find((item) => item.id === 'second-method').indexState).toBe('ready');
  expect(state.syntheses[0]).toMatchObject({ state: 'failed', error: 'index_failed' });
});

test('a failed durable projection reuses its receipt without repeating synthesis', async () => {
  let rejectProjection = true;
  const h = await setup({ consolidate: async ({ entries }) => ({ ...resultFor(entries), operations: [{ operation: 'nodes/delete', ids: ['obsolete'] }] }),
    backend: async () => { if (rejectProjection) throw Object.assign(new Error('Unavailable'), { code: 'backend_unavailable' }); return {}; } });
  await h.maintenance.schedule(); await h.maintenance.process((await h.store.read()).syntheses[0]);
  let state = await h.store.read();
  expect(state.syntheses[0].generated).toBeTruthy(); expect(state.syntheses[0].state).toBe('failed');
  await h.store.update((next) => { next.engine.dirtyProjects.push('p'); }); await h.maintenance.schedule();
  expect((await h.store.read()).syntheses).toHaveLength(1); expect(h.requests).toHaveLength(1);
  rejectProjection = false;
  await h.store.update((next) => { next.syntheses[0].state = 'queued'; });
  await h.maintenance.process((await h.store.read()).syntheses[0]);
  state = await h.store.read();
  expect(h.requests).toHaveLength(1); expect(state.syntheses[0].state).toBe('done'); expect(state.engine.projections[0].state).toBe('done');
});

test('withdraws source authority while synthesis is running before committing cards or operations', async () => {
  let release; let started;
  const waiting = new Promise((resolve) => { release = resolve; }); const entered = new Promise((resolve) => { started = resolve; });
  const h = await setup({ consolidate: async ({ entries }) => { started(); await waiting; return resultFor(entries); } });
  await h.maintenance.schedule(); const running = h.maintenance.process((await h.store.read()).syntheses[0]); await entered;
  await h.store.update((state) => { state.sessions.s2.reconciling = true; state.sessions.s2.revision++; }); release(); await running;
  const state = await h.store.read();
  expect(state.entries.some((item) => item.kind === 'methodology')).toBe(false); expect(state.engine.projections).toHaveLength(0);
  expect(state.syntheses[0].generated).toBeNull(); expect(state.syntheses[0].state).toBe('failed');
});

test('withholds a method whose part citation exceeds its selected support cards', async () => {
  const h = await setup({ consolidate: async ({ entries }) => {
    const result = resultFor(entries); result.cards[0].sourcePartIds.push('unused-part');
    result.cards[0].sourceRefs.push({ sessionId: 's1', messageId: 'message-a', partId: 'unused-part', sourceHash: 'a'.repeat(64), sourceRevision: 3 });
    return result;
  } });
  await h.store.update((state) => { state.jobs[0].segment.messages.push({ id: 'message-a', partId: 'unused-part', role: 'tool', text: 'Another captured part.' }); });
  await h.maintenance.schedule(); await h.maintenance.process((await h.store.read()).syntheses[0]);
  const state = await h.store.read();
  expect(state.entries.some((item) => item.kind === 'methodology')).toBe(false);
  expect(state.engine.projections).toHaveLength(0);
});

test('retains review-only batches and schedules continuation after the current project tick', async () => {
  const h = await setup({ consolidate: async ({ entries }) => resultFor(entries, { cards: false, continuation: { offset: 100, reason: 'unreviewed_clusters' } }) });
  await h.maintenance.schedule(); await h.maintenance.process((await h.store.read()).syntheses[0]);
  let state = await h.store.read(); expect(state.entries.some((item) => item.kind === 'methodology')).toBe(false);
  expect(state.engine.records.find((record) => record.collection === 'review')).toBeTruthy();
  await h.maintenance.schedule({ excludeProjects: ['p'] }); expect((await h.store.read()).syntheses).toHaveLength(1);
  await h.maintenance.schedule(); state = await h.store.read(); expect(state.syntheses).toHaveLength(2);
  await h.store.update((next) => { next.engine.continuations.p.cursor.offset = 999; });
  await h.maintenance.process(state.syntheses[1]); expect(h.requests[1].s2Offset).toBe(100);
});

test('explicit Hy distillation keeps a review-only receipt without inventing a method', async () => {
  const h = await setup({ entries: [entry('a', 's1', { kind: 'experience' }), entry('b', 's2', { kind: 'experience' })], consolidate: async ({ entries }) => resultFor(entries, { cards: false }) });
  await h.store.update((state) => { state.syntheses.push({ id: 'explicit', projectId: 'p', directory: '/p', automatic: false,
    supports: state.entries.map((item) => ({ id: item.id, sessionId: item.sessionId, sourceHash: item.sourceHash, sourceRevision: 3 })),
    state: 'extracting', entryId: null, error: null, attempts: 1 }); });
  const input = { entries: (await h.store.read()).entries, directory: '/p', jobId: 'explicit' };
  await expect(h.maintenance.distill(input)).rejects.toMatchObject({ code: 'methodology_no_schema' });
  await expect(h.maintenance.distill(input)).rejects.toMatchObject({ code: 'methodology_no_schema' });
  const state = await h.store.read(); expect(h.requests).toHaveLength(1);
  expect(state.engine.records.find((record) => record.collection === 'review')).toBeTruthy();
  expect(state.entries.some((item) => item.kind === 'methodology')).toBe(false);
});

test('lost S2 worker aborts its provider signal and never automatically replays an unknown result', async () => {
  for (const code of ['hy_generation_timeout', 'hy_worker_exited', 'hy_protocol_invalid']) {
    let signal;
    const h = await setup({ consolidate: async (input) => { signal = input.signal; throw Object.assign(new Error(code), { code }); } });
    await h.maintenance.schedule(); await h.maintenance.process((await h.store.read()).syntheses[0]);
    expect(signal.aborted).toBe(true);
    expect((await h.store.read()).syntheses[0]).toMatchObject({ state: 'unknown', generated: null, error: code });
    await h.store.update((state) => { state.engine.dirtyProjects.push('p'); });
    await h.maintenance.schedule(); await h.maintenance.process((await h.store.read()).syntheses[0]);
    expect(h.requests).toHaveLength(1); expect((await h.store.read()).syntheses).toHaveLength(1);
  }
});

test('S2 startup capability rejection records a repairable failure without an unknown paid outcome', async () => {
  let signal;
  const h = await setup({ consolidate: async (input) => { signal = input.signal; throw Object.assign(new Error('Capability mismatch'), { code: 'hy_capabilities_invalid' }); } });
  await h.maintenance.schedule(); await h.maintenance.process((await h.store.read()).syntheses[0]);
  expect(signal.aborted).toBe(false);
  expect((await h.store.read()).syntheses[0]).toMatchObject({ state: 'failed', generated: null, error: 'hy_capabilities_invalid' });
  await h.store.update((state) => { state.engine.dirtyProjects.push('p'); }); await h.maintenance.schedule();
  expect(h.requests).toHaveLength(1); expect((await h.store.read()).syntheses).toHaveLength(1);
});

test('an evolved confirmed schema becomes a new candidate and withdraws its previous card vector atomically', async () => {
  const h = await setup(); await h.maintenance.schedule(); await h.maintenance.process((await h.store.read()).syntheses[0]);
  await h.store.update((state) => {
    const method = state.entries.find((item) => item.id === 'method'); method.status = 'active'; method.confirmed = true;
    method.indexState = 'ready'; method.documentId = 'method'; method.knowledgeId = 'method';
    state.syntheses.push({ ...state.syntheses[0], id: 'next-review', state: 'queued', generated: null, entryId: null });
  });
  const deletes = []; let calls = 0; let rejectWithdrawal = true;
  const atomicStore = { atomicIndex: true, read: h.store.read,
    update: (change, { indexOperations = [] } = {}) => h.store.update((state) => {
      change(state);
      if (rejectWithdrawal && indexOperations.length) throw Object.assign(new Error('Atomic vector withdrawal failed'), { code: 'unavailable' });
      deletes.push(...structuredClone(indexOperations));
    }) };
  const maintenance = createHyMaintenance({ store: atomicStore, backend: async () => ({}), canProcess: () => true, now: () => 20,
    verifySources: async () => true, organizer: { consolidate: async ({ entries }) => {
      calls++; const result = resultFor(entries); result.cards[0].body = 'Inspect the rendered export and check the editable text layer.'; return result;
    } } });
  await maintenance.process((await h.store.read()).syntheses.find((job) => job.id === 'next-review'));
  expect((await h.store.read()).entries.find((item) => item.id === 'method')).toMatchObject({ confirmed: true, status: 'active', documentId: 'method' });
  expect(deletes).toHaveLength(0); expect(calls).toBe(1);
  rejectWithdrawal = false;
  await h.store.update((state) => { state.syntheses.find((job) => job.id === 'next-review').state = 'queued'; });
  await maintenance.process((await h.store.read()).syntheses.find((job) => job.id === 'next-review'));
  let state = await h.store.read(); const method = state.entries.find((item) => item.id === 'method');
  expect(method).toMatchObject({ body: 'Inspect the rendered export and check the editable text layer.', status: 'candidate', confirmed: false,
    verification: 'unverified', indexState: 'pending', documentId: null, knowledgeId: null, createdAt: 10, updatedAt: 20, segmentId: 'next-review' });
  expect(deletes).toEqual([{ operation: 'nodes/delete', namespace: expect.stringContaining(':cards'), ids: ['method'] }]);
  await h.store.update((next) => { const proposal = next.entries.find((item) => item.id === 'method'); proposal.status = 'active'; proposal.confirmed = true; next.syntheses.find((job) => job.id === 'next-review').state = 'indexing'; });
  const indexed = [];
  const manager = createMethodologyManager({ store: h.store, resolveProjectId: async () => 'p', canProcess: () => true, now: () => 21,
    knowledgeLibrary: { upsertManagedDocument: async ({ id, markdown }) => { indexed.push({ id, markdown }); return { documentId: id, state: 'ready' }; } } });
  await manager.process((await h.store.read()).syntheses.find((job) => job.id === 'next-review'));
  state = await h.store.read();
  expect(indexed[0].markdown).toContain('check the editable text layer'); expect(calls).toBe(1);
  expect(state.entries.find((item) => item.id === 'method').indexState).toBe('ready');
});

const deferredCard = (state, ids, id = 'cross-domain') => ({
  id, kind: 'methodology', title: 'Compare the source before reusing a method', body: 'Check the source conditions before applying the method.',
  supportingEntryIds: ids, sourceMessageIds: ids.flatMap((support) => state.entries.find((item) => item.id === support).sourceMessageIds),
  sourcePartIds: ids.flatMap((support) => state.entries.find((item) => item.id === support).sourcePartIds), limitations: ['Cross-domain inference.'],
  sourceRefs: ids.flatMap((support) => {
    const item = state.entries.find((candidate) => candidate.id === support);
    return item.sourceMessageIds.map((messageId, index) => ({ sessionId: item.sessionId, messageId, partId: item.sourcePartIds[index], sourceHash: item.sourceHash, sourceRevision: 3 }));
  }),
});

test('automatic maintenance materializes deferred cross-domain cards with verified expanded supports', async () => {
  const seen = [];
  const h = await setup({ entries: [entry('a', 's1'), entry('b', 's2'), entry('c', 's3'), entry('d', 's4')],
    verifySources: async ({ entries }) => { seen.push(entries.map((item) => item.id)); return true; },
    consolidate: async ({ entries }) => ({ ...resultFor(entries), deferredCards: [deferredCard(await h.store.read(), ['c', 'd'])] }) });
  await h.maintenance.schedule();
  await h.store.update((state) => { state.syntheses[0].supports = state.syntheses[0].supports.filter((support) => ['a', 'b'].includes(support.id)); });
  await h.maintenance.process((await h.store.read()).syntheses[0]);
  const state = await h.store.read(); const card = state.entries.find((item) => item.id === 'cross-domain');
  expect(card).toMatchObject({ status: 'candidate', verification: 'unverified', confirmed: false, supportingEntryIds: ['c', 'd'] });
  expect(state.syntheses[0].supports.map((support) => support.id).sort()).toEqual(['a', 'b', 'c', 'd']);
  expect(seen.some((ids) => ids.length === 4)).toBe(true);
  expect(methodologySourcesEligible(state, card)).toBe(true);
  expect(state.engine.projections.every((projection) => projection.state === 'done')).toBe(true);
});

test('an unavailable deferred source keeps its proposal for model-free repair and does not discard the primary card', async () => {
  let unavailable = true;
  const h = await setup({ entries: [entry('a', 's1'), entry('b', 's2'), entry('c', 's3'), entry('d', 's4')],
    verifySources: async ({ entries }) => !unavailable || !entries.some((item) => item.id === 'c'),
    consolidate: async ({ entries }) => ({ ...resultFor(entries), deferredCards: [deferredCard(await h.store.read(), ['c', 'd'])] }) });
  await h.maintenance.schedule();
  await h.store.update((state) => { state.syntheses[0].supports = state.syntheses[0].supports.filter((support) => ['a', 'b'].includes(support.id)); });
  await h.maintenance.process((await h.store.read()).syntheses[0]);
  let state = await h.store.read();
  expect(state.entries.some((item) => item.id === 'method')).toBe(true);
  expect(state.entries.some((item) => item.id === 'cross-domain')).toBe(false);
  expect(state.syntheses[0].generated.deferredCards).toHaveLength(1);
  expect(state.syntheses[0].generated.deferredStatus).toMatchObject({ pending: 1 });
  unavailable = false;
  await h.store.update((next) => { next.engine.dirtyProjects.push('p'); }); await h.maintenance.schedule();
  await h.maintenance.process((await h.store.read()).syntheses[0]); state = await h.store.read();
  expect(h.requests).toHaveLength(1); expect(state.entries.find((item) => item.id === 'cross-domain')).toMatchObject({ status: 'candidate', confirmed: false });
  expect(state.syntheses[0].generated.deferredCards).toEqual([]);
});

test('explicit selection never expands to deferred source cards', async () => {
  const h = await setup({ entries: [entry('a', 's1', { kind: 'experience' }), entry('b', 's2', { kind: 'experience' }), entry('c', 's3'), entry('d', 's4')],
    consolidate: async ({ entries }) => ({ ...resultFor(entries), deferredCards: [deferredCard(await h.store.read(), ['c', 'd'])] }) });
  await h.store.update((state) => { state.syntheses.push({ id: 'selected', projectId: 'p', directory: '/p', automatic: false,
    supports: state.entries.filter((item) => ['a', 'b'].includes(item.id)).map((item) => ({ id: item.id, sessionId: item.sessionId, sourceHash: item.sourceHash, sourceRevision: 3 })),
    state: 'extracting', entryId: null, error: null, attempts: 1 }); });
  const card = await h.maintenance.distill({ entries: (await h.store.read()).entries.filter((item) => ['a', 'b'].includes(item.id)), directory: '/p', jobId: 'selected' });
  expect(card.id).toBe('method');
  expect((await h.store.read()).syntheses[0].supports.map((support) => support.id)).toEqual(['a', 'b']);
  expect((await h.store.read()).entries.some((item) => item.id === 'cross-domain')).toBe(false);
});

test('unknown deferred supports and source-session budget overflow leave primary evidence usable', async () => {
  const extras = Array.from({ length: 39 }, (_, index) => entry(`extra-${index}`, `other-${index}`));
  const h = await setup({ entries: [entry('a', 's1'), entry('b', 's2'), ...extras], consolidate: async ({ entries }) => {
    const state = await h.store.read();
    const missing = deferredCard(state, ['a', 'b'], 'missing-support'); missing.supportingEntryIds.push('unknown');
    return { ...resultFor(entries), deferredCards: [missing, deferredCard(state, extras.map((item) => item.id), 'over-budget')] };
  } });
  await h.maintenance.schedule();
  await h.store.update((state) => { state.syntheses[0].supports = state.entries.filter((item) => ['a', 'b'].includes(item.id))
    .map((item) => ({ id: item.id, sessionId: item.sessionId, sourceHash: item.sourceHash, sourceRevision: 3 })); });
  await h.maintenance.process((await h.store.read()).syntheses[0]);
  const state = await h.store.read();
  expect(state.syntheses[0].state).toBe('done'); expect(state.entries.find((item) => item.id === 'method')).toBeTruthy();
  expect(state.entries.some((item) => ['missing-support', 'over-budget'].includes(item.id))).toBe(false);
  expect(state.syntheses[0].supports).toHaveLength(2);
  expect(state.syntheses[0].generated.deferredCards).toHaveLength(1);
  expect(state.syntheses[0].generated.deferredStatus).toMatchObject({ pending: 1, rejected: 1 });
});

test('deferred receipt repair rechecks exact source revisions before candidate promotion', async () => {
  let available = false;
  const h = await setup({ entries: [entry('a', 's1'), entry('b', 's2'), entry('c', 's3'), entry('d', 's4')],
    verifySources: async ({ entries }) => available || !entries.some((item) => item.id === 'c'),
    consolidate: async ({ entries }) => ({ ...resultFor(entries), deferredCards: [deferredCard(await h.store.read(), ['c', 'd'])] }) });
  await h.maintenance.schedule();
  await h.store.update((state) => { state.syntheses[0].supports = state.syntheses[0].supports.filter((support) => ['a', 'b'].includes(support.id)); });
  await h.maintenance.process((await h.store.read()).syntheses[0]); available = true;
  await h.store.update((state) => { state.sessions.s3.revision++; state.engine.dirtyProjects.push('p'); });
  await h.maintenance.schedule(); await h.maintenance.process((await h.store.read()).syntheses[0]);
  const state = await h.store.read();
  expect(h.requests).toHaveLength(1);
  expect(state.entries.some((item) => item.id === 'cross-domain')).toBe(false);
  expect(state.syntheses[0].generated.deferredCards).toEqual([]);
  expect(state.syntheses[0].generated.deferredStatus).toMatchObject({ pending: 0, rejected: 1 });
});
