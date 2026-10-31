import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createConversationMemoryRuntime } from './runtime.js';
import { createConversationMemoryStore } from './store.js';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
const segment = { id: 'seg1', sessionId: 'ses1', projectId: 'project-a', directory: '/work/a', title: 'Build fix', createdAt: 100,
  sourceHash: 'a'.repeat(64), messageIds: ['u1', 'a1'], outcome: 'succeeded', messages: [{ id: 'u1', role: 'user', text: 'Fix the build' }, { id: 'a1', role: 'assistant', text: 'Build passed' }] };
const card = { id: 'card1', kind: 'experience', title: 'Build fix', body: 'Build passed in the recorded environment.', status: 'active', verification: 'observed', sourceMessageIds: ['u1', 'a1'], sourcePartIds: [], limitations: ['Installation was not tested.'] };
const harness = async (overrides = {}) => {
  const { knowledgeLibrary: knowledgeOverrides, ...runtimeOverrides } = overrides;
  const dataDir = overrides.dataDir ?? await fs.mkdtemp(path.join(os.tmpdir(), 'conversation-runtime-'));
  if (!overrides.dataDir) roots.push(dataDir);
  let generated = 0;
  let failIndex = false;
  let failDelete = false;
  const indexed = new Map();
  const knowledgeLibrary = {
    isReady: () => true,
    upsertManagedDocument: async ({ projectId, id, markdown }) => {
      if (failIndex) throw new Error('embedding_failed');
      indexed.set(id, { projectId, markdown });
      return { documentId: `doc-${id}`, knowledgeId: `kb-${id}`, state: 'ready' };
    },
    ensureManagedDocumentIndexed: async ({ id }) => ({ documentId: `doc-${id}`, knowledgeId: `kb-${id}`, state: 'ready' }),
    removeManagedDocument: async ({ id }) => { if (failDelete) throw new Error('delete_failed'); indexed.delete(id); return { removed: true }; },
    searchManagedDocuments: async ({ projectId, documentIds }) => ({ query: 'build', documents: [], passages: [...indexed].filter(([id, value]) => value.projectId === projectId && documentIds.includes(`doc-${id}`)).map(([id]) => ({ documentId: `doc-${id}`, content: 'Build fix' })) }),
    ...knowledgeOverrides,
  };
  const runtime = createConversationMemoryRuntime({ dataDir, now: () => 100, indexPollMs: 0,
    resolveProjectId: async (directory) => directory === '/work/b' ? 'project-b' : 'project-a',
    createClient: () => ({}), readSegments: async () => ({ segments: [segment], checkpoint: { version: 1 }, reset: false, complete: true, sourceMessageIds: ['u1', 'a1'] }),
    distill: async () => { generated++; return [card]; }, renderMarkdown: ({ card: entry }) => entry.body,
    knowledgeLibrary, isBlocked: () => false, ...runtimeOverrides,
  });
  await runtime.start();
  return { dataDir, runtime, indexed, generated: () => generated, failIndex: (value) => { failIndex = value; }, failDelete: (value) => { failDelete = value; } };
};
const capture = async (runtime) => { await runtime.capture({ sessionId: 'ses1', directory: '/work/a' }); await runtime.idle(); };
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

describe('conversation learning pipeline', () => {
  test('is opt-in, deduplicates source delivery and recalls only the owning project', async () => {
    const h = await harness();
    await expect(capture(h.runtime)).rejects.toThrow();
    await h.runtime.setEnabled(true);
    await capture(h.runtime);
    await capture(h.runtime);
    expect(h.generated()).toBe(1);
    expect((await h.runtime.listEntries({ directory: '/work/a' })).entries[0]).toMatchObject({ id: 'card1', indexState: 'ready', verification: 'observed' });
    expect((await h.runtime.listEntries({ directory: '/work/b' })).entries).toEqual([]);
    expect(await h.runtime.recall({ directory: '/work/a', query: 'build' })).toContain('Installation was not tested.');
    expect(await h.runtime.recall({ directory: '/work/b', query: 'build' })).toBe('');
    await h.runtime.stop();
  });

  test('embedding retry uses stored cards without repeating model generation', async () => {
    const h = await harness();
    h.failIndex(true);
    await h.runtime.setEnabled(true);
    await capture(h.runtime);
    expect((await h.runtime.listEntries({ directory: '/work/a' })).entries[0].indexState).toBe('failed');
    h.failIndex(false);
    await h.runtime.retry({ id: 'card1', directory: '/work/a' });
    await h.runtime.idle();
    expect(h.generated()).toBe(1);
    expect((await h.runtime.listEntries({ directory: '/work/a' })).entries[0].indexState).toBe('ready');
    await h.runtime.stop();
  });

  test('forget suppresses recall before cleanup and persists refusal across restart', async () => {
    const h = await harness();
    await h.runtime.setEnabled(true);
    await capture(h.runtime);
    h.failDelete(true);
    expect(await h.runtime.forget({ id: 'card1', directory: '/work/a' })).toEqual({ forgotten: true, pendingCleanup: true });
    expect(await h.runtime.recall({ directory: '/work/a', query: 'build' })).toBe('');
    expect((await h.runtime.listEntries({ directory: '/work/a' })).entries[0]).toMatchObject({ status: 'forgotten', cleanupPending: true });
    await h.runtime.stop();
    const restored = await harness({ dataDir: h.dataDir });
    await capture(restored.runtime);
    expect(restored.generated()).toBe(0);
    expect((await restored.runtime.listEntries({ directory: '/work/a' })).entries).toEqual([]);
    await restored.runtime.stop();
  });

  test('candidate experience requires confirmation and keeps its verification limits', async () => {
    const h = await harness({ distill: async () => [{ ...card, status: 'candidate', verification: 'unverified' }] });
    await h.runtime.setEnabled(true);
    await capture(h.runtime);
    expect(h.indexed.size).toBe(0);
    await h.runtime.confirm({ id: 'card1', directory: '/work/a' });
    await h.runtime.idle();
    expect(h.indexed.size).toBe(1);
    expect((await h.runtime.listEntries({ directory: '/work/a' })).entries[0].verification).toBe('unverified');
    await h.runtime.stop();
  });

  test('an uncertain in-flight model job is not replayed after a crash', async () => {
    const h = await harness();
    await h.runtime.stop();
    await createConversationMemoryStore({ dataDir: h.dataDir }).update((state) => {
      state.enabled = true;
      state.jobs.push({ id: 'seg1', segment, state: 'extracting', error: null, attempts: 1 });
    });
    const restarted = await harness({ dataDir: h.dataDir });
    await restarted.runtime.idle();
    expect(restarted.generated()).toBe(0);
    expect((await restarted.runtime.status()).unknown).toBe(1);
    await restarted.runtime.stop();
  });

  test('keeps backend failure codes and treats absent candidate cleanup as complete', async () => {
    const h = await harness({ knowledgeLibrary: { upsertManagedDocument: async () => ({ documentId: 'doc-card1', state: 'failed', error: { code: 'parse_failed' } }), removeManagedDocument: async () => ({ removed: false }) } });
    await h.runtime.setEnabled(true);
    await capture(h.runtime);
    expect((await h.runtime.listEntries({ directory: '/work/a' })).entries[0].error).toBe('parse_failed');
    expect(await h.runtime.forget({ id: 'card1', directory: '/work/a' })).toEqual({ forgotten: true, pendingCleanup: false });
    await h.runtime.stop();
  });

  test('rechecks recall after an overlapping forget or disable', async () => {
    for (const mutation of ['forget', 'disable']) {
      const entered = deferred(); const release = deferred();
      const h = await harness({ knowledgeLibrary: { searchManagedDocuments: async () => { entered.resolve(); await release.promise; return { documents: [], passages: [{ documentId: 'doc-card1' }] }; } } });
      await h.runtime.setEnabled(true); await capture(h.runtime);
      const recall = h.runtime.recall({ directory: '/work/a', query: 'build' });
      await entered.promise;
      if (mutation === 'forget') await h.runtime.forget({ id: 'card1', directory: '/work/a' });
      else await h.runtime.setEnabled(false);
      release.resolve();
      expect(await recall).toBe('');
      await h.runtime.stop();
    }
  });

  test('cancels queued source jobs before generation and prevents deleted-session recapture after restart', async () => {
    const h = await harness();
    await h.runtime.setEnabled(true);
    await h.runtime.stop();
    await createConversationMemoryStore({ dataDir: h.dataDir }).update((state) => {
      state.jobs.push({ id: segment.id, segment, state: 'queued', attempts: 0, error: null });
    });
    await h.runtime.invalidateSession('ses1', true);
    const restarted = await harness({ dataDir: h.dataDir });
    await restarted.runtime.idle();
    expect(restarted.generated()).toBe(0);
    await expect(capture(restarted.runtime)).rejects.toThrow('source_deleted');
    await restarted.runtime.stop();
  });

  test('rejects malformed persisted source jobs before model invocation', async () => {
    const h = await harness(); await h.runtime.stop();
    await createConversationMemoryStore({ dataDir: h.dataDir }).update((state) => {
      state.enabled = true;
      state.jobs.push({ id: 'bad', segment: { id: 'bad', sessionId: 'ses1', projectId: 'project-a', directory: '/work/a' }, state: 'queued', error: null, attempts: 0 });
    });
    const restarted = await harness({ dataDir: h.dataDir }); await restarted.runtime.idle();
    expect(restarted.generated()).toBe(0);
    expect((await restarted.runtime.status()).failed).toBe(1);
    await restarted.runtime.stop();
  });

  test('queues a candidate confirmed while disabled for indexing on the next enable', async () => {
    const h = await harness({ distill: async () => [{ ...card, status: 'candidate', verification: 'unverified' }] });
    await h.runtime.setEnabled(true); await capture(h.runtime); await h.runtime.setEnabled(false);
    await h.runtime.confirm({ id: 'card1', directory: '/work/a' });
    expect(h.indexed.size).toBe(0);
    await h.runtime.setEnabled(true); await h.runtime.idle();
    expect(h.indexed.size).toBe(1);
    await h.runtime.stop();
  });

  test('rechecks eligibility before starting each entry indexing operation', async () => {
    const entered = deferred(); const release = deferred(); const indexed = [];
    const h = await harness({ distill: async () => [card, { ...card, id: 'card2' }], knowledgeLibrary: { upsertManagedDocument: async ({ id }) => { indexed.push(id); entered.resolve(); await release.promise; return { documentId: `doc-${id}`, state: 'ready' }; } } });
    await h.runtime.setEnabled(true); await h.runtime.capture({ sessionId: 'ses1', directory: '/work/a' });
    await entered.promise; await h.runtime.setEnabled(false); release.resolve(); await h.runtime.idle();
    expect(indexed).toEqual(['card1']);
    await h.runtime.setEnabled(true); await h.runtime.idle();
    expect(indexed).toEqual(['card1', 'card2']);
    await h.runtime.stop();
  });

  test('keeps an in-flight generation invalid after its source is reverted', async () => {
    const entered = deferred(); const release = deferred();
    const h = await harness({ distill: async () => { entered.resolve(); await release.promise; return [card]; } });
    await h.runtime.setEnabled(true); await h.runtime.capture({ sessionId: 'ses1', directory: '/work/a' });
    await entered.promise; await h.runtime.invalidateSession('ses1'); release.resolve(); await h.runtime.idle();
    expect(h.indexed.size).toBe(0);
    expect((await h.runtime.listEntries({ directory: '/work/a' })).entries).toEqual([]);
    await h.runtime.stop();
  });

  test('uses the authoritative session directory and retains explicit history permission across reset', async () => {
    const requests = [];
    const h = await harness({
      resolveSessionDirectory: async () => '/work/b',
      readSegments: async (request) => { requests.push(request); return { segments: [{ ...segment, projectId: 'project-b', directory: '/work/b' }], checkpoint: { version: 1 }, reset: requests.length > 1, complete: true }; },
    });
    await h.runtime.setEnabled(true); await capture(h.runtime);
    expect(requests[0]).toMatchObject({ directory: '/work/b', projectId: 'project-b', includeHistory: true });
    expect((await h.runtime.listEntries({ directory: '/work/a' })).entries).toEqual([]);
    await h.runtime.invalidateSession('ses1');
    // Automatic delivery carries no separate request to process old history.
    const state = await createConversationMemoryStore({ dataDir: h.dataDir }).read();
    expect(state.sessions.ses1.historyAllowed).toBe(true);
    await h.runtime.stop();
  });

  test('observes raw v2 revert events before delayed authoritative recapture', async () => {
    let listener;
    const h = await harness({ debounceMs: 60_000, globalEventHub: { subscribeEvent: (callback) => { listener = callback; return () => {}; } } });
    await h.runtime.setEnabled(true); await capture(h.runtime);
    for (const type of ['session.revert.staged', 'session.revert.cleared', 'session.revert.committed']) {
      listener({ directory: '/work/a', payload: { type, data: { sessionID: 'ses1' }, location: { directory: '/work/a' } }, translated: () => [] });
      expect(await h.runtime.allowedDocumentIds({ directory: '/work/a' })).toEqual([]);
    }
    await h.runtime.stop();
  });

  test('cannot confirm an entry after a concurrent forget queued its tombstone', async () => {
    const h = await harness({ distill: async () => [{ ...card, status: 'candidate', verification: 'unverified' }] });
    await h.runtime.setEnabled(true); await capture(h.runtime);
    const outcomes = await Promise.allSettled([
      h.runtime.forget({ id: 'card1', directory: '/work/a' }),
      h.runtime.confirm({ id: 'card1', directory: '/work/a' }),
    ]);
    expect(outcomes[1].status).toBe('rejected');
    expect(await h.runtime.allowedDocumentIds({ directory: '/work/a' })).toEqual([]);
    await h.runtime.stop();
  });

  test('erases forgotten prose and unused captured excerpts after cleanup', async () => {
    const h = await harness(); await h.runtime.setEnabled(true); await capture(h.runtime);
    await h.runtime.forget({ id: 'card1', directory: '/work/a' });
    const persisted = await fs.readFile(path.join(h.dataDir, 'conversation-memory', 'state.json'), 'utf8');
    expect(persisted).not.toContain(card.body);
    expect(persisted).not.toContain('Fix the build');
    expect(persisted).not.toContain('Build passed');
    expect((await createConversationMemoryStore({ dataDir: h.dataDir }).read()).tombstones).toContain('card1');
    await h.runtime.stop();
  });

  test('keeps existing sibling cards eligible after one card is forgotten', async () => {
    const h = await harness({ distill: async () => [card, { ...card, id: 'card2', title: 'Build followup' }] });
    await h.runtime.setEnabled(true); await capture(h.runtime);
    await h.runtime.forget({ id: 'card1', directory: '/work/a' });
    expect(await h.runtime.allowedDocumentIds({ directory: '/work/a' })).toEqual(['doc-card2']);
    expect(await h.runtime.recall({ directory: '/work/a', query: 'Build followup' })).toContain('Build followup');
    await h.runtime.stop();
  });

  test('reconciles consented historical cards after a raw source reset', async () => {
    let listener; let reads = 0; const reread = deferred();
    const h = await harness({ debounceMs: 1,
      globalEventHub: { subscribeEvent: (callback) => { listener = callback; return () => {}; } },
      readSegments: async (request) => {
        reads++;
        if (reads > 1) reread.resolve();
        return { segments: request.includeHistory ? [segment] : [], checkpoint: { version: 1 }, reset: reads > 1, complete: true };
      },
    });
    await h.runtime.setEnabled(true); await capture(h.runtime);
    listener({ directory: '/work/a', payload: { type: 'session.revert.cleared', data: { sessionID: 'ses1' } }, translated: () => [] });
    await reread.promise; await h.runtime.idle();
    expect(await h.runtime.allowedDocumentIds({ directory: '/work/a' })).toEqual(['doc-card1']);
    expect(h.generated()).toBe(1);
    await h.runtime.stop();
  });
});

test('restores retained sibling cards after a forgotten source is reconciled', async () => {
  const h = await harness({ distill: async () => [card, { ...card, id: 'card2', title: 'Retained sibling' }] });
  try {
    await h.runtime.setEnabled(true); await capture(h.runtime);
    await h.runtime.forget({ id: 'card1', directory: '/work/a' });
    await h.runtime.invalidateSession('ses1');
    await capture(h.runtime);
    expect(await h.runtime.allowedDocumentIds({ directory: '/work/a' })).toEqual(['doc-card2']);
    expect(await h.runtime.recall({ directory: '/work/a', query: 'Retained sibling' })).toContain('Retained sibling');
  } finally { await h.runtime.stop(); }
});

test('forgetting one card keeps an active sibling indexing job pending', async () => {
  const h = await harness({ distill: async () => [card, { ...card, id: 'card2', title: 'Retained sibling' }],
    knowledgeLibrary: { upsertManagedDocument: async ({ id }) => ({ documentId: `doc-${id}`, state: 'pending' }) },
  });
  try {
    await h.runtime.setEnabled(true); await capture(h.runtime);
    await h.runtime.forget({ id: 'card1', directory: '/work/a' });
    expect((await h.runtime.status()).pending).toBe(1);
    await h.runtime.retry({ id: 'card2', directory: '/work/a' }); await h.runtime.idle();
    expect(await h.runtime.allowedDocumentIds({ directory: '/work/a' })).toEqual(['doc-card2']);
    expect((await h.runtime.status()).pending).toBe(0);
  } finally { await h.runtime.stop(); }
});

test('quarantines jobs from a previous extractor until explicit history capture', async () => {
  const h = await harness(); await h.runtime.stop();
  await createConversationMemoryStore({ dataDir: h.dataDir }).update((state) => {
    state.enabled = true;
    state.jobs.push({ id: segment.id, segment, state: 'queued', error: null, attempts: 0, sourceRevision: 0, extractorVersion: 'conversation-memory-v0' });
  });
  const restarted = await harness({ dataDir: h.dataDir });
  try {
    await restarted.runtime.idle();
    expect(restarted.generated()).toBe(0);
    expect((await restarted.runtime.status()).unknown).toBe(1);
    await capture(restarted.runtime);
    expect(restarted.generated()).toBe(1);
    expect((await restarted.runtime.status()).unknown).toBe(0);
  } finally { await restarted.runtime.stop(); }
});

test('explicit extraction-version refresh supersedes and cleans old cards before recall', async () => {
  const h = await harness(); await h.runtime.setEnabled(true); await capture(h.runtime); await h.runtime.stop();
  await createConversationMemoryStore({ dataDir: h.dataDir }).update((state) => {
    state.jobs[0].extractorVersion = 'conversation-memory-v0';
    state.entries[0].extractorVersion = 'conversation-memory-v0';
  });
  let generated = 0; const removed = [];
  const restarted = await harness({ dataDir: h.dataDir,
    distill: async () => { generated++; return [{ ...card, id: 'card-current-version' }]; },
    knowledgeLibrary: { removeManagedDocument: async ({ id }) => { removed.push(id); return { removed: true }; } },
  });
  try {
    await restarted.runtime.idle(); expect(generated).toBe(0);
    await capture(restarted.runtime);
    expect(generated).toBe(1);
    expect(removed).toContain('card1');
    expect(await restarted.runtime.allowedDocumentIds({ directory: '/work/a' })).toEqual(['doc-card-current-version']);
    const state = await createConversationMemoryStore({ dataDir: h.dataDir }).read();
    expect(state.entries.find((entry) => entry.id === 'card1').status).toBe('superseded');
    expect(state.entries.find((entry) => entry.id === 'card1').cleanupPending).toBe(false);
    expect(state.entries.find((entry) => entry.id === 'card-current-version').extractorVersion).toBe(state.jobs[0].extractorVersion);
  } finally { await restarted.runtime.stop(); }
});

test('reindexes a reconciled sibling whose previous managed document was cleaned', async () => {
  let present = true; let writes = 0;
  const h = await harness({
    readSegments: async () => ({ segments: present ? [segment] : [], checkpoint: { version: 1 }, reset: false, complete: true }),
    knowledgeLibrary: { upsertManagedDocument: async ({ id }) => { writes++; return { documentId: `doc-${id}`, state: 'ready' }; } },
  });
  try {
    await h.runtime.setEnabled(true); await capture(h.runtime);
    await h.runtime.invalidateSession('ses1'); present = false; await capture(h.runtime);
    expect(await h.runtime.allowedDocumentIds({ directory: '/work/a' })).toEqual([]);
    await h.runtime.invalidateSession('ses1'); present = true; await capture(h.runtime);
    expect(writes).toBe(2);
    expect(await h.runtime.allowedDocumentIds({ directory: '/work/a' })).toEqual(['doc-card1']);
  } finally { await h.runtime.stop(); }
});

const checkpointFor = (source) => ({ version: 1, sessionId: source.sessionId, projectId: source.projectId, directory: source.directory,
  revertId: null, cursor: null, anchorId: null, anchorHash: null, pending: null });

test('withholds sources deleted or reverted while disabled or stopped without receiving events', async () => {
  for (const lifecycle of ['disabled', 'restarted']) for (const change of ['deleted', 'reverted', 'moved']) {
    let source = { directory: '/work/a', revertId: null }; const reads = [];
    const options = {
      readSegments: async () => ({ segments: [segment], checkpoint: checkpointFor(segment), reset: false, complete: true }),
      readSessionSource: async (request) => { reads.push(request); return source; },
    };
    const h = await harness(options); let current = h;
    try {
      await h.runtime.setEnabled(true); await capture(h.runtime);
      if (lifecycle === 'disabled') await h.runtime.setEnabled(false); else await h.runtime.stop();
      source = change === 'deleted' ? null : { directory: change === 'moved' ? '/work/b' : '/work/a', revertId: change === 'reverted' ? 'u1' : null };
      if (lifecycle === 'disabled') await h.runtime.setEnabled(true);
      else current = await harness({ ...options, dataDir: h.dataDir });
      await current.runtime.listEntries({ directory: '/work/a' });
      expect(reads.length).toBe(0);
      expect(await current.runtime.recall({ directory: '/work/a', query: 'Build fix' })).toBe('');
      expect(reads.map((request) => request.directoryHint)).toEqual(['/work/a']);
      const state = await createConversationMemoryStore({ dataDir: h.dataDir }).read();
      expect(state.sessions.ses1.deleted).toBe(change === 'deleted');
      expect(state.entries[0].status).toBe(change === 'deleted' ? 'forgotten' : 'superseded');
    } finally { await current.runtime.stop(); }
  }
});

test('one unavailable source cannot suppress unrelated recalled entries or mark its source deleted', async () => {
  const second = { ...segment, id: 'seg2', sessionId: 'ses2' };
  const reads = [];
  const h = await harness({
    readSegments: async ({ sessionId }) => { const source = sessionId === 'ses1' ? segment : second;
      return { segments: [source], checkpoint: checkpointFor(source), reset: false, complete: true }; },
    distill: async ({ segment: source }) => [{ ...card, id: source.sessionId === 'ses1' ? 'card1' : 'card2', title: source.sessionId === 'ses1' ? 'Unavailable experience' : 'Retained experience' }],
    readSessionSource: async ({ sessionId, directoryHint }) => { reads.push({ sessionId, directoryHint });
      if (sessionId === 'ses1') throw new Error('temporary network failure'); return { directory: '/work/a', revertId: null }; },
  });
  try {
    await h.runtime.setEnabled(true); await capture(h.runtime);
    await h.runtime.capture({ sessionId: 'ses2', directory: '/work/a' }); await h.runtime.idle();
    const recalled = await h.runtime.recall({ directory: '/work/a', query: 'experience' });
    expect(recalled).toContain('Retained experience'); expect(recalled).not.toContain('Unavailable experience');
    expect(reads.length).toBe(2);
    const metadata = await h.runtime.describeDocuments({ directory: '/work/a', documentIds: ['doc-card1', 'doc-card2'] });
    expect(metadata.map((entry) => entry.id)).toEqual(['card2']);
    expect(reads.length).toBe(4);
    const state = await createConversationMemoryStore({ dataDir: h.dataDir }).read();
    expect(state.sessions.ses1.deleted).toBe(false);
    expect(state.entries.find((entry) => entry.id === 'card1').status).toBe('active');
  } finally { await h.runtime.stop(); }
});

test('source verification shares the retrieval deadline and cannot block sending', async () => {
  const h = await harness({ recallTimeoutMs: 20,
    readSegments: async () => ({ segments: [segment], checkpoint: checkpointFor(segment), reset: false, complete: true }),
    readSessionSource: async () => new Promise(() => {}),
  });
  try {
    await h.runtime.setEnabled(true); await capture(h.runtime);
    expect(await h.runtime.recall({ directory: '/work/a', query: 'build' })).toBe('');
    expect(await h.runtime.describeDocuments({ directory: '/work/a', documentIds: ['doc-card1'] })).toEqual([]);
  } finally { await h.runtime.stop(); }
});

test('withholds an offline committed revert whose null revert marker hides a changed source anchor', async () => {
  let observedCheckpoint;
  const h = await harness({
    readSegments: async () => ({ segments: [segment], checkpoint: checkpointFor(segment), reset: false, complete: true }),
    readSessionSource: async ({ checkpoint }) => { observedCheckpoint = checkpoint; return { directory: '/work/a', revertId: null, anchorMatches: false }; },
  });
  try {
    await h.runtime.setEnabled(true); await capture(h.runtime);
    expect(await h.runtime.recall({ directory: '/work/a', query: 'build' })).toBe('');
    expect(observedCheckpoint).toEqual(checkpointFor(segment));
    expect((await h.runtime.listEntries({ directory: '/work/a' })).entries).toEqual([]);
  } finally { await h.runtime.stop(); }
});

test('source checks deduplicate siblings and recheck a concurrent forget before metadata returns', async () => {
  const started = deferred(); const release = deferred(); let reads = 0;
  const h = await harness({
    readSegments: async () => ({ segments: [segment], checkpoint: checkpointFor(segment), reset: false, complete: true }),
    distill: async () => [card, { ...card, id: 'card2', title: 'Retained sibling' }],
    readSessionSource: async () => { reads++; started.resolve(); await release.promise; return { directory: '/work/a', revertId: null }; },
  });
  try {
    await h.runtime.setEnabled(true); await capture(h.runtime);
    const metadata = h.runtime.describeDocuments({ directory: '/work/a', documentIds: ['doc-card1', 'doc-card2'] });
    await started.promise;
    await h.runtime.forget({ id: 'card1', directory: '/work/a' }); release.resolve();
    expect((await metadata).map((entry) => entry.id)).toEqual(['card2']);
    expect(reads).toBe(1);
  } finally { release.resolve(); await h.runtime.stop(); }
});

test('source location changes withhold memory without activating the moved directory', async () => {
  let captures = 0;
  const h = await harness({ debounceMs: 1,
    readSegments: async () => { captures++; return { segments: [segment], checkpoint: checkpointFor(segment), reset: false, complete: true }; },
    readSessionSource: async () => ({ directory: '/work/b', revertId: null }),
  });
  try {
    await h.runtime.setEnabled(true); await capture(h.runtime);
    expect(await h.runtime.recall({ directory: '/work/a', query: 'build' })).toBe('');
    await new Promise((resolve) => setTimeout(resolve, 10));
    await h.runtime.idle();
    expect(captures).toBe(1);
  } finally { await h.runtime.stop(); }
});

test('bounds source verification at 40 sessions and withholds entries with unchecked references', async () => {
  const many = Array.from({ length: 42 }, (_, index) => `source_${index}`);
  const reads = [];
  const h = await harness({ readSessionSource: async ({ sessionId }) => { reads.push(sessionId); return { directory: '/work/a', revertId: null }; } });
  await h.runtime.stop();
  await createConversationMemoryStore({ dataDir: h.dataDir }).update((state) => {
    state.enabled = true;
    for (const sessionId of many) state.sessions[sessionId] = { directory: '/work/a', checkpoint: checkpointFor({ ...segment, sessionId }) };
    state.entries.push({ ...card, id: 'too-many-sources', indexState: 'ready', projectId: 'project-a', directory: '/work/a', sessionId: many[0], segmentId: 'none', sourceHash: segment.sourceHash, createdAt: 1, updatedAt: 1,
      documentId: 'doc-many', sourceReferences: many.map((sessionId) => ({ sessionId, messageId: 'a1' })) });
  });
  const restored = await harness({ dataDir: h.dataDir,
    readSessionSource: async ({ sessionId }) => { reads.push(sessionId); return { directory: '/work/a', revertId: null }; },
  });
  try {
    expect(await restored.runtime.describeDocuments({ directory: '/work/a', documentIds: ['doc-many'] })).toEqual([]);
    expect(reads.length).toBe(40);
  } finally { await restored.runtime.stop(); }
});

test('an old worktree source never starts capture while validating its parent project', async () => {
  const worktree = { ...segment, directory: '/work/a-worktree' }; let sourceChanged = false;
  const captures = []; const generations = [];
  const h = await harness({ debounceMs: 1,
    readSegments: async ({ directory }) => { captures.push(directory); return { segments: [worktree], checkpoint: checkpointFor(worktree), reset: false, complete: true }; },
    distill: async ({ segment: source }) => { generations.push(source.directory); return [card]; },
    readSessionSource: async ({ directoryHint }) => {
      expect(directoryHint).toBe('/work/a');
      return { directory: worktree.directory, revertId: sourceChanged ? 'u1' : null };
    },
  });
  try {
    await h.runtime.setEnabled(true);
    await h.runtime.capture({ sessionId: 'ses1', directory: worktree.directory }); await h.runtime.idle();
    sourceChanged = true;
    expect(await h.runtime.recall({ directory: '/work/a', query: 'build' })).toBe('');
    await new Promise((resolve) => setTimeout(resolve, 10)); await h.runtime.idle();
    expect(captures).toEqual([worktree.directory]);
    expect(generations).toEqual([worktree.directory]);
  } finally { await h.runtime.stop(); }
});
