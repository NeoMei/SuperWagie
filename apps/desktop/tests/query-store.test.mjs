import test from 'node:test';
import assert from 'node:assert/strict';

import { createQueryState, reduceQueryState } from '../src/renderer/query-store.mjs';

test('core restart invalidates the old snapshot and write ability', () => {
  const state = reduceQueryState(
    { ...createQueryState(), status: 'ready', canWrite: true, snapshot: { snapshot_revision: 4 } },
    { message_type: 'subscription.resync_required', reason: 'core_restarted', next_action: 'query.execute' },
  );
  assert.equal(state.status, 'resync_required');
  assert.equal(state.canWrite, false);
  assert.equal(state.snapshot, null);
});

test('an old project response cannot replace the active project snapshot', () => {
  const state = reduceQueryState(
    { ...createQueryState(), activeProjectId: 'project:new', requestGeneration: 3 },
    {
      message_type: 'query.snapshot',
      project_id: 'project:old',
      request_generation: 2,
      snapshot: { snapshot_revision: 99 },
    },
  );
  assert.equal(state.snapshot, null);
  assert.equal(state.activeProjectId, 'project:new');
});

test('only a current snapshot restores write ability', () => {
  const state = reduceQueryState(
    { ...createQueryState(), activeProjectId: 'project:one', requestGeneration: 5 },
    {
      message_type: 'query.snapshot',
      project_id: 'project:one',
      request_generation: 5,
      snapshot: { snapshot_revision: 7 },
    },
  );
  assert.equal(state.status, 'ready');
  assert.equal(state.canWrite, true);
  assert.equal(state.snapshot.snapshot_revision, 7);
});
