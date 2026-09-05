import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createDocumentSwitchCoordinator, createDraftSaveQueue, persistPendingBeforeSwitch,
} from '../src/renderer/editor/document-switch.mjs';

test('a conflicted draft prevents tab replacement', async () => {
  let opened = false;
  const result = await persistPendingBeforeSwitch({
    hasPendingChanges: () => true,
    persistPending: async () => ({ ok: false, code: 'SW_WORKSPACE_REVISION_CONFLICT' }),
    loadTarget: async () => { opened = true; },
  });
  assert.equal(result.opened, false);
  assert.equal(opened, false);
});

test('a stale document load cannot replace the newer requested tab', async () => {
  const resolvers = new Map();
  const applied = [];
  const switchTo = createDocumentSwitchCoordinator({
    hasPendingChanges: () => false,
    persistPending: async () => ({ ok: true }),
    getChangeGeneration: () => 0,
    loadTarget: (target) => new Promise((resolve) => resolvers.set(target, resolve)),
    applyTarget: async (target) => applied.push(target),
  });
  const first = switchTo('one');
  const second = switchTo('two');
  resolvers.get('two')({ source: 'two' });
  assert.equal(await second, true);
  resolvers.get('one')({ source: 'one' });
  assert.equal(await first, false);
  assert.deepEqual(applied, ['two']);
});

test('typing during an in-flight save schedules the next generation', async () => {
  let source = 'one';
  let release;
  const persisted = [];
  const queue = createDraftSaveQueue({
    captureDraft: () => source,
    persistDraft: (draft) => new Promise((resolve) => {
      persisted.push(draft);
      if (persisted.length === 1) release = () => resolve({ ok: true });
      else resolve({ ok: true });
    }),
  });
  queue.markChanged();
  const saving = queue.save();
  await Promise.resolve();
  source = 'two';
  queue.markChanged();
  release();
  await saving;
  assert.deepEqual(persisted, ['one', 'two']);
  assert.equal(queue.isDirty(), false);
});
