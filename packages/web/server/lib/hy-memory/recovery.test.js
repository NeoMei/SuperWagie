import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createConversationMemoryStore, memoryEntrySchema } from '../conversation-memory/store.js';
import { createConversationMemoryRuntime } from '../conversation-memory/runtime.js';
import { createHyRecovery, storedJobCanIndex } from './recovery.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const segment = {
  id: 'capture', sessionId: 'session', projectId: 'project', directory: '/project', title: 'An export lesson',
  sourceHash: 'a'.repeat(64), createdAt: 1, messageIds: ['message'], outcome: 'unknown',
  messages: [{ id: 'message', role: 'tool', text: 'Export inspected.', partId: 'part', status: 'completed' }],
};
const card = (extra = {}) => memoryEntrySchema.parse({
  id: 'card', kind: 'experience', title: 'Check the export', body: 'Inspect the exported file.',
  status: 'active', verification: 'unverified', confirmed: true, indexState: 'failed',
  projectId: 'project', directory: '/project', sessionId: 'session', segmentId: 'capture',
  sourceHash: segment.sourceHash, sourceMessageIds: ['message'], sourcePartIds: ['part'], limitations: ['Fixture.'],
  sourceReferences: [{ sessionId: 'session', messageId: 'message' }], createdAt: 1, updatedAt: 2,
  documentId: 'legacy-file', knowledgeId: 'legacy-knowledge', error: 'managed_derivation_scope_unavailable', ...extra,
});
const setup = async (entries = [card()]) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hy-recovery-'));
  cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
  const store = createConversationMemoryStore({ dataDir });
  await store.update((state) => {
    state.enabled = true; state.entries = entries;
    state.sessions.session = { directory: '/project', checkpoint: null, revision: 3, historyAllowed: true };
    state.jobs = [{ id: 'capture', segment, state: 'failed', sourceRevision: 3, error: 'managed_derivation_scope_unavailable', attempts: 1 }];
  });
  return store;
};

const recoveryHarness = async ({ entries, job }) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hy-recovery-runtime-'));
  cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
  const store = createConversationMemoryStore({ dataDir });
  let generated = 0;
  let clock = 100;
  const runtime = createConversationMemoryRuntime({ dataDir, store, indexPollMs: 0, now: () => clock,
    organizer: { organize: async () => { generated++; throw new Error('Recovery must not call the model'); },
      consolidate: async () => { throw new Error('Recovery must not call the model'); },
      status: () => ({ state: 'ready' }), stop: async () => {}, recall: async () => ({ cards: [], operations: [], memories: [] }) },
    memoryBackend: async () => ({ nodes: [] }),
    knowledgeLibrary: {
      isReady: () => true,
      upsertManagedDocument: async ({ id }) => ({ documentId: id, knowledgeId: id, state: 'ready' }),
      ensureManagedDocumentIndexed: async ({ id }) => ({ documentId: id, knowledgeId: id, state: 'ready' }),
      removeManagedDocument: async () => ({ removed: true }),
      removeLegacyManagedDocument: async () => ({ removed: true }),
      searchManagedDocuments: async () => ({ documents: [], passages: [] }),
    },
    resolveProjectId: async (directory) => directory === '/project' ? 'project' : 'elsewhere',
    createClient: () => ({}), readSegments: async () => { throw new Error('Recovery must not read history'); },
    distill: async () => { throw new Error('Recovery must not call the legacy extractor'); },
    renderMarkdown: () => '',
  });
  await store.update((state) => {
    state.engine.migrated = true;
    state.enabled = true;
    state.entries = entries;
    state.sessions.session = { directory: '/project', checkpoint: null, revision: 3, historyAllowed: true };
    state.jobs = [{ id: 'capture', segment, state: 'failed', sourceRevision: 3,
      error: 'hy_chat_extraction_failed', attempts: 1, extractorVersion: 'hy-memory-2.0.8:sw1', ...job }];
  });
  cleanups.unshift(() => runtime.stop());
  return { runtime, store, generated: () => generated, advance: (ms) => { clock += ms; } };
};

test('migrates stored cards once without changing source, confirmation or extractor attribution', async () => {
  const store = await setup([card(), card({ id: 'candidate', status: 'candidate', confirmed: false })]);
  const recovery = createHyRecovery({ store, now: () => 50 });
  expect(await recovery.migrate()).toMatchObject({ migrated: 2 });
  let state = await store.read();
  expect(state.entries[0]).toMatchObject({ title: 'Check the export', confirmed: true, status: 'active', extractorVersion: 'conversation-memory-v1',
    sourceHash: segment.sourceHash, documentId: null, knowledgeId: null, indexState: 'pending', createdAt: 1, updatedAt: 2 });
  expect(state.entries[1]).toMatchObject({ status: 'candidate', confirmed: false });
  expect(state.jobs[0]).toMatchObject({ state: 'indexing', attempts: 1, extractorVersion: 'conversation-memory-v1' });
  expect(state.engine.records.find((row) => row.collection === 'legacy-projection' && row.id === 'card').value)
    .toMatchObject({ documentId: 'legacy-file', knowledgeId: 'legacy-knowledge', retired: false });
  expect(storedJobCanIndex(state, state.jobs[0])).toBe(true);
  expect(await recovery.migrate()).toMatchObject({ migrated: 0 });
  state = await store.read(); expect(state.engine.records.filter((row) => row.collection === 'legacy-projection')).toHaveLength(2);
});

test('does not authorize generation, malformed source, changed source, tombstones or deleted source', async () => {
  const store = await setup(); const recovery = createHyRecovery({ store }); await recovery.migrate();
  const state = await store.read(); const job = state.jobs[0];
  expect(storedJobCanIndex(state, { ...job, state: 'queued' })).toBe(false);
  expect(storedJobCanIndex(state, { ...job, extractorVersion: 'conversation-memory-v0' })).toBe(false);
  expect(storedJobCanIndex(state, { ...job, segment: { ...segment, messages: [] } })).toBe(false);
  state.sessions.session.revision++;
  expect(storedJobCanIndex(state, job)).toBe(false);
  state.sessions.session.revision--; state.tombstones.push('card');
  expect(storedJobCanIndex(state, job)).toBe(false);
  state.tombstones = []; state.sessions.session.deleted = true;
  expect(storedJobCanIndex(state, job)).toBe(false);
});

test('a single-card source tombstone preserves stored sibling indexing without authorizing generation', async () => {
  const store = await setup([card(), card({ id: 'forgotten', status: 'forgotten' })]);
  await store.update((state) => { state.tombstones.push('forgotten', `source:${segment.id}:${segment.sourceHash}`); });
  const recovery = createHyRecovery({ store }); await recovery.migrate();
  const state = await store.read();
  expect(storedJobCanIndex(state, state.jobs[0])).toBe(true);
  expect(state.entries[1].status).toBe('forgotten');
});

test('an unsuccessful migration commit leaves source state and marker unchanged', async () => {
  const store = await setup(); const original = await store.read();
  const recovery = createHyRecovery({ store: { read: store.read, update: async () => { throw new Error('commit failed'); } } });
  await expect(recovery.migrate()).rejects.toThrow('commit failed');
  expect(await store.read()).toEqual(original);
});

test('retries known indexing failures with durable exponential backoff and a fixed attempt limit', async () => {
  const store = await setup([card({ extractorVersion: 'hy-memory-2.0.8:sw1' })]);
  let time = 100;
  await store.update((state) => { state.engine.migrated = true; state.jobs[0].error = 'backend_unavailable'; });
  const recovery = createHyRecovery({ store, now: () => time, baseDelayMs: 10, maxAttempts: 2 });
  expect(await recovery.schedule()).toEqual({ scheduled: 0, nextRetryAt: 110 });
  time = 110; expect(await recovery.schedule()).toEqual({ scheduled: 1, nextRetryAt: null });
  expect((await store.read()).jobs[0]).toMatchObject({ state: 'indexing', attempts: 1 });
  await store.update((state) => { state.jobs[0].state = 'failed'; state.jobs[0].error = 'backend_unavailable'; });
  expect(await recovery.schedule()).toEqual({ scheduled: 0, nextRetryAt: 130 });
  time = 130; expect(await recovery.schedule()).toEqual({ scheduled: 1, nextRetryAt: null });
  await store.update((state) => { state.jobs[0].state = 'failed'; state.jobs[0].error = 'backend_unavailable'; });
  time = 1000; expect(await recovery.schedule()).toEqual({ scheduled: 0, nextRetryAt: null });
  expect((await store.read()).jobs[0].state).toBe('failed');
});

test('uses persisted generation receipts but never retries unknown generation or source and model-policy errors', async () => {
  const store = await setup([]); let time = 1;
  await store.update((state) => {
    state.engine.migrated = true;
    state.jobs[0].error = 'hy_commit_failed'; state.jobs[0].generated = { cards: [], operations: [] };
    state.jobs.push(...['unknown', 'source_changed', 'enterprise_mode', 'hy_source_invalid', 'provider_auth_invalid'].map((error) => ({
      ...state.jobs[0], id: error, state: error === 'unknown' ? 'unknown' : 'failed', error, generated: error === 'unknown' ? null : { cards: [] },
    })));
  });
  const recovery = createHyRecovery({ store, now: () => time, baseDelayMs: 1 });
  await recovery.schedule(); time++;
  expect((await recovery.schedule()).scheduled).toBe(1);
  const state = await store.read();
  expect(state.jobs[0]).toMatchObject({ state: 'queued', generated: { cards: [], operations: [] }, attempts: 1 });
  expect(state.jobs.slice(1).every((job) => ['unknown', 'failed'].includes(job.state))).toBe(true);
});

test('retries a chat generation failure without a receipt but keeps an unknown outcome terminal', async () => {
  const store = await setup([]); let time = 1;
  await store.update((state) => {
    state.engine.migrated = true;
    state.jobs[0].error = 'hy_chat_llm_unavailable';
    state.jobs[0].state = 'failed';
    state.jobs.push({ ...state.jobs[0], id: 'unknown-outcome', error: 'generation_outcome_unknown' });
  });
  const recovery = createHyRecovery({ store, now: () => time, baseDelayMs: 1 });
  expect(await recovery.schedule()).toMatchObject({ scheduled: 0 });
  time += 2;
  expect(await recovery.schedule()).toMatchObject({ scheduled: 1 });
  const state = await store.read();
  expect(state.jobs[0]).toMatchObject({ state: 'queued', error: null });
  expect(state.jobs[1]).toMatchObject({ state: 'failed', error: 'generation_outcome_unknown' });
});

test('retries a shared memory index outage through the stored card path', async () => {
  const store = await setup([card({ extractorVersion: 'hy-memory-2.0.8:sw1' })]);
  let time = 1;
  await store.update((state) => {
    state.engine.migrated = true;
    state.jobs[0].error = 'memory_index_unavailable';
    state.jobs[0].state = 'failed';
  });
  const recovery = createHyRecovery({ store, now: () => time, baseDelayMs: 1 });
  await recovery.schedule(); time += 2;
  expect(await recovery.schedule()).toMatchObject({ scheduled: 1 });
  const state = await store.read();
  expect(state.jobs[0]).toMatchObject({ state: 'indexing', error: null });
  expect(state.entries[0].indexState).toBe('pending');
});

test('recovers a legacy extraction failure only from its durable result', async () => {
  const receipt = { cards: [], operations: [] };
  const plain = await setup([]);
  await plain.update((state) => { state.engine.migrated = true; state.jobs[0].error = 'hy_chat_extraction_failed'; });
  const recovery = createHyRecovery({ store: plain, now: () => 1, baseDelayMs: 1 });
  expect(await recovery.schedule()).toMatchObject({ scheduled: 0, nextRetryAt: null });
  expect((await plain.read()).jobs[0]).toMatchObject({ state: 'failed', error: 'hy_chat_extraction_failed' });

  const withReceipt = await setup([]);
  await withReceipt.update((state) => {
    state.engine.migrated = true;
    Object.assign(state.jobs[0], { error: 'hy_chat_extraction_failed', generated: receipt });
  });
  let time = 1;
  const receiptRecovery = createHyRecovery({ store: withReceipt, now: () => time, baseDelayMs: 1 });
  expect(await receiptRecovery.schedule()).toMatchObject({ scheduled: 0, nextRetryAt: 2 });
  time = 2;
  expect(await receiptRecovery.schedule()).toMatchObject({ scheduled: 1 });
  expect((await withReceipt.read()).jobs[0]).toMatchObject({ state: 'queued', error: null, generated: receipt });

  const withCard = await setup([card({ extractorVersion: 'hy-memory-2.0.8:sw1' })]);
  await withCard.update((state) => { state.engine.migrated = true; state.jobs[0].error = 'hy_chat_extraction_failed'; });
  time = 1;
  const cardRecovery = createHyRecovery({ store: withCard, now: () => time, baseDelayMs: 1 });
  await cardRecovery.schedule(); time = 2;
  expect(await cardRecovery.schedule()).toMatchObject({ scheduled: 1 });
  expect((await withCard.read()).jobs[0]).toMatchObject({ state: 'indexing', error: null });
  expect((await withCard.read()).entries[0]).toMatchObject({ indexState: 'pending', error: null });

  const terminal = await setup([]);
  await terminal.update((state) => {
    state.engine.migrated = true;
    state.jobs[0].error = 'hy_chat_extraction_failed';
    state.jobs.push(...['hy_chat_empty_response', 'hy_chat_json_parse_failed', 'hy_chat_agent_no_result', 'hy_chat_agent_failed'].map((error) => ({
      ...state.jobs[0], id: error, error, generated: { cards: [], operations: [] },
    })));
  });
  const terminalRecovery = createHyRecovery({ store: terminal, now: () => 1, baseDelayMs: 1 });
  expect(await terminalRecovery.schedule()).toMatchObject({ scheduled: 0, nextRetryAt: null });
  expect((await terminal.read()).jobs.every((job) => job.state === 'failed')).toBe(true);
});

test('legacy extraction recovery finishes only from durable results without another model call', async () => {
  for (const variant of [
    { entries: [], job: { generated: { cards: [], operations: [] } }, finalState: 'done', finalError: null },
    { entries: [card({ extractorVersion: 'hy-memory-2.0.8:sw1' })], job: {}, finalState: 'done', finalError: null },
    { entries: [], job: {}, finalState: 'failed', finalError: 'hy_chat_extraction_failed' },
  ]) {
    const h = await recoveryHarness(variant);
    await h.runtime.start();
    await h.runtime.idle();
    h.advance(10000);
    await h.runtime.setEnabled(true);
    await h.runtime.idle();
    expect(h.generated()).toBe(0);
    expect((await h.store.read()).jobs[0]).toMatchObject({ state: variant.finalState, error: variant.finalError, attempts: 1 });
  }
});

test('explicit retry resets the durable limit without changing the saved generation', async () => {
  const store = await setup(); await store.update((state) => {
    state.engine.records.push({ collection: 'hy-retry', id: 'capture:capture', projectId: 'project', value: { attempts: 3, nextRetryAt: null, error: 'unavailable' } });
  });
  const recovery = createHyRecovery({ store }); await recovery.reset({ id: 'capture' });
  expect((await store.read()).engine.records.some((row) => row.collection === 'hy-retry')).toBe(false);
});

test('keeps legacy cleanup retryable and only removes old references after a new ready projection', async () => {
  const store = await setup(); let rejectCleanup = true; const removed = [];
  const recovery = createHyRecovery({ store, removeLegacy: async (input) => {
    removed.push(input); if (rejectCleanup) throw Object.assign(new Error('private response'), { code: 'backend_unavailable' });
  } });
  await recovery.migrate(); expect((await recovery.retireLegacy()).retired).toBe(0); expect(removed).toHaveLength(0);
  await store.update((state) => { state.entries[0].indexState = 'ready'; state.entries[0].documentId = 'card'; });
  expect(await recovery.retireLegacy()).toEqual({ retired: 0, pending: 1 });
  let record = (await store.read()).engine.records.find((row) => row.collection === 'legacy-projection');
  expect(record.value).toMatchObject({ retired: false, error: 'backend_unavailable' });
  rejectCleanup = false; expect(await recovery.retireLegacy()).toEqual({ retired: 1, pending: 0 });
  record = (await store.read()).engine.records.find((row) => row.collection === 'legacy-projection');
  expect(record.value).toMatchObject({ retired: true, documentId: null, knowledgeId: null, error: null });
  expect((await store.read()).entries[0].documentId).toBe('card');
});
