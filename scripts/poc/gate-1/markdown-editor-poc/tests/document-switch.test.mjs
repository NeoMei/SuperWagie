import assert from 'node:assert/strict';
import test from 'node:test';

test('persists a pending draft before loading another document', async () => {
  const documentSwitch = await import('../src/document-switch.mjs').catch(() => null);
  assert.ok(documentSwitch, 'document switch guard must exist');

  const events = [];
  const result = await documentSwitch.persistPendingBeforeSwitch({
    hasPendingChanges: () => true,
    persistPending: async () => {
      events.push('save');
      return { ok: true, revision: 'saved-revision' };
    },
    loadTarget: async () => {
      events.push('load');
      return { content: '# next', revision: 'next-revision' };
    },
  });

  assert.deepEqual(events, ['save', 'load']);
  assert.equal(result.opened, true);
  assert.equal(result.loaded.revision, 'next-revision');
});

test('keeps the current draft open when saving detects a conflict', async () => {
  const { persistPendingBeforeSwitch } = await import('../src/document-switch.mjs');
  let targetLoaded = false;
  const conflict = { ok: false, code: 'SW_WORKSPACE_REVISION_CONFLICT' };

  const result = await persistPendingBeforeSwitch({
    hasPendingChanges: () => true,
    persistPending: async () => conflict,
    loadTarget: async () => {
      targetLoaded = true;
      return { content: '# must not load' };
    },
  });

  assert.equal(targetLoaded, false);
  assert.deepEqual(result, { opened: false, saveResult: conflict });
});

test('keeps the current draft open when saving fails', async () => {
  const { persistPendingBeforeSwitch } = await import('../src/document-switch.mjs');
  let targetLoaded = false;

  await assert.rejects(
    persistPendingBeforeSwitch({
      hasPendingChanges: () => true,
      persistPending: async () => { throw new Error('disk unavailable'); },
      loadTarget: async () => {
        targetLoaded = true;
        return { content: '# must not load' };
      },
    }),
    /disk unavailable/,
  );
  assert.equal(targetLoaded, false);
});

test('drains an edit made during an in-flight save before switching documents', async () => {
  const documentSwitch = await import('../src/document-switch.mjs');
  assert.equal(typeof documentSwitch.createDraftSaveQueue, 'function', 'save generation queue must exist');

  let content = 'first draft';
  let releaseFirstSave;
  const firstSaveGate = new Promise((resolve) => { releaseFirstSave = resolve; });
  const events = [];
  const queue = documentSwitch.createDraftSaveQueue({
    captureDraft: () => content,
    persistDraft: async (draft) => {
      events.push(`save:${draft}`);
      if (draft === 'first draft') await firstSaveGate;
      return { ok: true, revision: `revision-${events.length}` };
    },
  });

  queue.markChanged();
  const inFlightSave = queue.save();
  content = 'second draft';
  queue.markChanged();
  const switchResultPromise = documentSwitch.persistPendingBeforeSwitch({
    hasPendingChanges: queue.isDirty,
    persistPending: queue.save,
    loadTarget: async () => {
      events.push('load:next document');
      return { content: 'next document', revision: 'next-revision' };
    },
  });

  assert.deepEqual(events, ['save:first draft']);
  releaseFirstSave();
  const [, switchResult] = await Promise.all([inFlightSave, switchResultPromise]);

  assert.equal(switchResult.opened, true);
  assert.equal(queue.isDirty(), false);
  assert.deepEqual(events, ['save:first draft', 'save:second draft', 'load:next document']);
});

test('preserves an edit made while the target document is loading', async () => {
  const { createDocumentSwitchCoordinator, createDraftSaveQueue } = await import('../src/document-switch.mjs');
  let content = 'original';
  let releaseFirstLoad;
  const firstLoad = new Promise((resolve) => { releaseFirstLoad = resolve; });
  const events = [];
  let loadCount = 0;
  const queue = createDraftSaveQueue({
    captureDraft: () => ({ content }),
    persistDraft: async (draft) => {
      events.push(`save:${draft.content}`);
      return { ok: true, revision: 'saved' };
    },
  });
  const open = createDocumentSwitchCoordinator({
    hasPendingChanges: queue.isDirty,
    persistPending: queue.save,
    getChangeGeneration: queue.generation,
    loadTarget: async () => {
      events.push('load');
      loadCount += 1;
      return loadCount === 1 ? firstLoad : { content: 'next', revision: 'next' };
    },
    applyTarget: async (_target, loaded) => events.push(`apply:${loaded.content}`),
  });

  const switching = open('next.md');
  content = 'edited while loading';
  queue.markChanged();
  releaseFirstLoad({ content: 'stale next', revision: 'stale' });

  assert.equal(await switching, true);
  assert.deepEqual(events, ['load', 'save:edited while loading', 'load', 'apply:next']);
});

test('discards an older document load that finishes after the latest selection', async () => {
  const { createDocumentSwitchCoordinator } = await import('../src/document-switch.mjs');
  const releases = new Map();
  const applied = [];
  const open = createDocumentSwitchCoordinator({
    hasPendingChanges: () => false,
    persistPending: async () => ({ ok: true }),
    getChangeGeneration: () => 0,
    loadTarget: (target) => new Promise((resolve) => releases.set(target, resolve)),
    applyTarget: async (target) => applied.push(target),
  });

  const first = open('first.md');
  const second = open('second.md');
  releases.get('second.md')({ content: 'second', revision: 'second' });
  assert.equal(await second, true);
  releases.get('first.md')({ content: 'first', revision: 'first' });
  assert.equal(await first, false);
  assert.deepEqual(applied, ['second.md']);
});
