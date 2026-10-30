import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createConversationMemoryStore, memoryEntrySchema } from '../conversation-memory/store.js';
import { createConversationMemoryRuntime } from '../conversation-memory/runtime.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const segment = {
  id: 'capture', sessionId: 'session', projectId: 'project', directory: '/project', title: 'Inspect exported slides',
  sourceHash: 'a'.repeat(64), createdAt: 1, messageIds: ['message'], outcome: 'unknown',
  messages: [{ id: 'message', role: 'tool', text: 'The exported slide was inspected.', partId: 'part', status: 'completed' }],
};
const card = (extra = {}) => memoryEntrySchema.parse({
  id: 'card', kind: 'experience', title: 'Inspect exported slides', body: 'Inspect the rendered export after changing a slide.',
  status: 'active', verification: 'unverified', confirmed: true, indexState: 'failed',
  projectId: 'project', directory: '/project', sessionId: 'session', segmentId: 'capture',
  sourceHash: segment.sourceHash, sourceMessageIds: ['message'], sourcePartIds: ['part'], limitations: ['Fixture only.'],
  sourceReferences: [{ sessionId: 'session', messageId: 'message' }], createdAt: 1, updatedAt: 2,
  documentId: 'legacy-document', knowledgeId: 'legacy-knowledge', error: 'managed_derivation_scope_unavailable', ...extra,
});
const harness = async ({ readSessionSource = null, organize = null } = {}) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hy-runtime-integration-'));
  cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
  const store = createConversationMemoryStore({ dataDir });
  const indexed = new Map(); const retired = [];
  let generated = 0; let indexCalls = 0; let searchCalls = 0; let rejectIndex = false; let time = 100; let blocked = false;
  const organizer = {
    organize: async (input) => { generated++; if (organize) return organize(input); throw new Error('Recovery must reuse stored results'); },
    consolidate: async () => { throw new Error('One session cannot authorize S2'); },
    status: () => ({ state: 'ready' }), stop: async () => {}, recall: async () => ({ cards: [], operations: [], memories: [] }),
  };
  const knowledgeLibrary = {
    isReady: () => true,
    upsertManagedDocument: async ({ id, title, body }) => {
      indexCalls++;
      if (rejectIndex) throw Object.assign(new Error('Fixture backend unavailable'), { code: 'unavailable' });
      indexed.set(id, { title, body }); return { documentId: id, knowledgeId: id, state: 'ready' };
    },
    ensureManagedDocumentIndexed: async ({ id }) => ({ documentId: id, knowledgeId: id, state: 'ready' }),
    removeManagedDocument: async ({ id }) => { indexed.delete(id); return { removed: true }; },
    removeLegacyManagedDocument: async (input) => { retired.push(input); return { removed: true }; },
    searchManagedDocuments: async ({ documentIds }) => { searchCalls++; return { documents: [], passages: documentIds.filter((id) => indexed.has(id)).map((id) => ({ documentId: id })) }; },
  };
  const createRuntime = () => {
    const runtime = createConversationMemoryRuntime({ dataDir, store, organizer,
      memoryBackend: async () => ({ nodes: [] }), now: () => time, indexPollMs: 0,
      resolveProjectId: async (directory) => directory === '/project' ? 'project' : 'elsewhere',
      createClient: () => ({}), readSegments: async () => { throw new Error('Index recovery must not capture history'); },
      distill: async () => { throw new Error('Index recovery must not call legacy distillation'); },
      renderMarkdown: () => { throw new Error('Typed projection does not need document conversion'); }, knowledgeLibrary,
      isBlocked: () => blocked, readSessionSource,
    });
    cleanups.unshift(() => runtime.stop());
    return runtime;
  };
  const seed = async ({ entries = [card()], job = {} } = {}) => store.update((state) => {
    state.enabled = true; state.entries = entries;
    state.sessions.session = { directory: '/project', checkpoint: { version: 1, sessionId: 'session', projectId: 'project', directory: '/project',
      revertId: null, cursor: 'cursor', anchorId: 'message', anchorHash: segment.sourceHash, pending: null }, revision: 3, historyAllowed: true };
    state.jobs = [{ id: 'capture', segment, state: 'failed', sourceRevision: 3, error: 'managed_derivation_scope_unavailable', attempts: 1, ...job }];
  });
  return { store, seed, createRuntime, indexed, retired, generated: () => generated, indexCalls: () => indexCalls,
    searchCalls: () => searchCalls, rejectIndex: (value) => { rejectIndex = value; }, time: (value) => { time = value; }, blocked: (value) => { blocked = value; } };
};

test('a real runtime migrates old indexing failures without extraction and preserves candidate confirmation', async () => {
  const h = await harness();
  await h.seed({ entries: [card(), card({ id: 'candidate', status: 'candidate', confirmed: false })] });
  const runtime = h.createRuntime(); await runtime.start(); await runtime.idle();
  expect(h.generated()).toBe(0); expect(h.indexCalls()).toBe(1);
  const state = await h.store.read();
  expect(state.entries[0]).toMatchObject({ id: 'card', indexState: 'ready', documentId: 'card', confirmed: true,
    extractorVersion: 'conversation-memory-v1', sourceHash: segment.sourceHash });
  expect(state.entries[1]).toMatchObject({ id: 'candidate', status: 'candidate', confirmed: false, indexState: 'pending' });
  expect(h.indexed.has('candidate')).toBe(false);
  expect(h.retired).toEqual([{ projectId: 'project', id: 'card' }, { projectId: 'project', id: 'candidate' }]);
  await runtime.confirm({ id: 'candidate', directory: '/project' }); await runtime.idle();
  expect(h.generated()).toBe(0); expect(h.indexCalls()).toBe(2);
  expect((await h.store.read()).entries[1]).toMatchObject({ confirmed: true, indexState: 'ready' });
  expect(await runtime.recall({ directory: '/other', query: 'slides' })).toBe('');
});

test('a persisted Hy result survives indexing failure and restart without another generation', async () => {
  const h = await harness();
  await h.seed({ entries: [], job: { state: 'extracting', error: null, extractorVersion: 'hy-memory-2.0.8:sw1', generated: {
    cards: [{ id: 'hy-card', kind: 'segment', title: 'Inspect exported slides', body: 'Inspect the rendered export.',
      sourceMessageIds: ['message'], sourcePartIds: ['part'], limitations: ['Fixture only.'] }], operations: [],
  } } });
  h.rejectIndex(true);
  const first = h.createRuntime(); await first.start(); await first.idle();
  expect(h.generated()).toBe(0); expect(h.indexCalls()).toBe(1);
  let state = await h.store.read();
  expect(state.jobs[0]).toMatchObject({ state: 'failed', error: 'unavailable' });
  expect(state.jobs[0].generated).toBeTruthy();
  expect(state.engine.records.find((row) => row.collection === 'hy-retry').value.nextRetryAt).toBe(2100);
  await first.stop(); h.time(2100); h.rejectIndex(false);
  const second = h.createRuntime(); await second.start(); await second.idle();
  state = await h.store.read();
  expect(h.generated()).toBe(0); expect(h.indexCalls()).toBe(2);
  expect(state.jobs[0].state).toBe('done');
  expect(state.entries[0]).toMatchObject({ id: 'hy-card', indexState: 'ready', documentId: 'hy-card' });
});

test('off and enterprise mode defer legacy embedding until an allowed enable', async () => {
  for (const initiallyBlocked of [false, true]) {
    const h = await harness(); await h.seed();
    if (initiallyBlocked) h.blocked(true);
    else await h.store.update((state) => { state.enabled = false; });
    const runtime = h.createRuntime(); await runtime.start(); await runtime.idle();
    expect(h.indexCalls()).toBe(0); expect(h.generated()).toBe(0);
    if (initiallyBlocked) await expect(runtime.setEnabled(true)).rejects.toThrow('enterprise_mode');
    h.blocked(false); await runtime.setEnabled(true); await runtime.idle();
    expect(h.indexCalls()).toBe(1); expect(h.generated()).toBe(0);
  }
});

test('disabled and enterprise title inspection stays local and reports the retrieval limit', async () => {
  const h = await harness(); await h.seed(); const runtime = h.createRuntime(); await runtime.start(); await runtime.idle();
  await runtime.setEnabled(false);
  let result = await runtime.listEntries({ directory: '/project', query: 'Inspect exported slides' });
  expect(result.entries.map((entry) => entry.id)).toEqual(['card']);
  expect(result.availability?.reason).toBe('disabled'); expect(h.searchCalls()).toBe(0);
  h.blocked(true);
  result = await runtime.listEntries({ directory: '/project', query: 'Inspect exported slides' });
  expect(result.entries.map((entry) => entry.id)).toEqual(['card']);
  expect(result.availability?.reason).toBe('enterprise_mode'); expect(h.searchCalls()).toBe(0);
});

test('agent retrieval rechecks forgotten content and enablement after source validation', async () => {
  for (const mutation of ['forget', 'disable']) {
    let enter; let release;
    const started = new Promise((resolve) => { enter = resolve; });
    const paused = new Promise((resolve) => { release = resolve; });
    const h = await harness({ readSessionSource: async () => { enter(); await paused; return { directory: '/project', revertId: null, anchorMatches: true }; } });
    await h.seed(); const runtime = h.createRuntime(); await runtime.start(); await runtime.idle();
    const retrieval = runtime.retrieve({ directory: '/project', query: 'Inspect exported slides' });
    await started;
    if (mutation === 'forget') await runtime.forget({ directory: '/project', id: 'card' });
    else await runtime.setEnabled(false);
    release();
    expect((await retrieval).entries).toEqual([]);
  }
});

test('lost worker extraction aborts its provider signal, remains unknown and does not replay after restart', async () => {
  for (const code of ['hy_generation_timeout', 'hy_worker_exited', 'hy_protocol_invalid']) {
    let signal;
    const h = await harness({ organize: async (input) => { signal = input.signal; throw Object.assign(new Error(code), { code }); } });
    await h.seed({ entries: [], job: { extractorVersion: 'hy-memory-2.0.8:sw1', state: 'queued', error: null } });
    const first = h.createRuntime(); await first.start(); await first.idle();
    expect(signal.aborted).toBe(true);
    expect((await h.store.read()).jobs[0]).toMatchObject({ state: 'unknown', error: code, generated: null });
    await first.stop(); h.time(900000);
    const second = h.createRuntime(); await second.start(); await second.idle();
    expect(h.generated()).toBe(1); expect((await second.status()).unknown).toBe(1);
  }
});

test('a startup capability rejection stays an ordinary failed job with no automatic model replay', async () => {
  let signal;
  const h = await harness({ organize: async (input) => { signal = input.signal; throw Object.assign(new Error('Capability mismatch'), { code: 'hy_capabilities_invalid' }); } });
  await h.seed({ entries: [], job: { extractorVersion: 'hy-memory-2.0.8:sw1', state: 'queued', error: null } });
  const runtime = h.createRuntime(); await runtime.start(); await runtime.idle();
  expect(signal.aborted).toBe(false);
  expect((await h.store.read()).jobs[0]).toMatchObject({ state: 'failed', error: 'hy_capabilities_invalid', generated: null });
  h.time(900000); await runtime.setEnabled(true); await runtime.idle(); expect(h.generated()).toBe(1);
});

test('confirming only the second automatic method indexes that card without repeating synthesis', async () => {
  const h = await harness();
  const secondSegment = { ...segment, id: 'capture-two', sessionId: 'session-two', sourceHash: 'b'.repeat(64), messageIds: ['message-two'],
    messages: [{ ...segment.messages[0], id: 'message-two', partId: 'part-two' }] };
  const firstSupport = card({ id: 'support-first', status: 'candidate', confirmed: false, indexState: 'pending', documentId: null,
    knowledgeId: null, error: null, extractorVersion: 'hy-memory-2.0.8:sw1' });
  const secondSupport = card({ ...firstSupport, id: 'support-second', sessionId: secondSegment.sessionId, segmentId: secondSegment.id,
    sourceHash: secondSegment.sourceHash, sourceMessageIds: ['message-two'], sourcePartIds: ['part-two'],
    sourceReferences: [{ sessionId: secondSegment.sessionId, messageId: 'message-two' }] });
  const method = (id, title) => card({ id, title, kind: 'methodology', status: 'candidate', confirmed: false, indexState: 'pending',
    documentId: null, knowledgeId: null, error: null, extractorVersion: 'hy-memory-2.0.8:sw1:s2', segmentId: 'automatic-methods',
    sourceHash: 'c'.repeat(64), supportingEntryIds: [firstSupport.id, secondSupport.id],
    sourceMessageIds: ['message', 'message-two'], sourcePartIds: ['part', 'part-two'],
    sourceReferences: [...firstSupport.sourceReferences, ...secondSupport.sourceReferences] });
  await h.seed({ entries: [firstSupport, secondSupport, method('method-first', 'First proposal'), method('method-second', 'Second proposal')],
    job: { extractorVersion: 'hy-memory-2.0.8:sw1', state: 'done', error: null } });
  await h.store.update((state) => {
    state.engine.migrated = true;
    state.sessions[secondSegment.sessionId] = { ...state.sessions.session };
    state.jobs.push({ ...state.jobs[0], id: secondSegment.id, segment: secondSegment });
    state.syntheses.push({ id: 'automatic-methods', projectId: 'project', directory: '/project', automatic: true,
      supports: [firstSupport, secondSupport].map((support) => ({ id: support.id, sessionId: support.sessionId,
        sourceHash: support.sourceHash, sourceRevision: 3 })),
      state: 'done', entryId: 'method-first', error: null, attempts: 1, generated: null });
  });
  const runtime = h.createRuntime(); await runtime.start(); await runtime.idle();
  expect(h.indexCalls()).toBe(0);
  await runtime.confirm({ id: 'method-second', directory: '/project' }); await runtime.idle();
  const state = await h.store.read();
  expect(h.generated()).toBe(0); expect(h.indexCalls()).toBe(1);
  expect([...h.indexed.keys()]).toEqual(['method-second']);
  expect(state.entries.find((entry) => entry.id === 'method-first')).toMatchObject({ status: 'candidate', confirmed: false, indexState: 'pending', documentId: null });
  expect(state.entries.find((entry) => entry.id === 'method-second')).toMatchObject({ status: 'active', confirmed: true, indexState: 'ready', documentId: 'method-second' });
  expect(state.syntheses[0]).toMatchObject({ state: 'done', error: null, attempts: 1, generated: null });
});
