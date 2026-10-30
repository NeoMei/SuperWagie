import { expect, test } from 'bun:test';
import { createHySpaceMaintenance } from './spaces.js';
import { memoryNamespace } from './organizer.js';

test('model-space migration never re-embeds a node with pending canonical withdrawal', async () => {
  const ref = { sessionId: 's', messageId: 'm', sourceHash: 'hash', sourceRevision: 1 };
  let state = { sessions: { s: { revision: 1, deleted: false, reconciling: false } }, tombstones: ['forgotten-card'], entries: [],
    jobs: [{ id: 'capture', sourceRevision: 1, segment: { id: 'capture', projectId: 'p', sessionId: 's', sourceHash: 'hash', messages: [{ id: 'm' }] } }],
    engine: { records: [
      { collection: 'model-space', projectId: 'p', id: 'current', value: { spaceId: 'old', configurationId: 'old-config', dimensions: 2 } },
      { collection: 'node-source', projectId: 'p', id: 'dependent-core', value: { sourceRefs: [ref] } },
      { collection: 'hy-withdrawal', projectId: 'p', id: 'pending-cleanup', value: { state: 'pending', nodeIds: ['dependent-core'] } },
    ] } };
  const coreNamespace = `${memoryNamespace('p')}:core`;
  const node = { id: 'dependent-core', content: 'Private text already withdrawn by the user', active: true, space_id: 'old',
    payload: { user_id: coreNamespace, workspace_id: 'p', custom: { source_refs: [ref] } } };
  const calls = [];
  const store = { atomicIndex: true, read: async () => structuredClone(state), update: async (change) => {
    const next = structuredClone(state); change(next); state = next; return structuredClone(state);
  } };
  const spaces = createHySpaceMaintenance({ store, backend: async (action, input) => {
    calls.push({ action, input });
    if (action === 'capabilities') return { embedding_configuration_id: 'new-config' };
    if (action === 'nodes/list') return { nodes: input.namespace === coreNamespace ? [node] : [], total: input.namespace === coreNamespace ? 1 : 0 };
    if (action === 'embed') return { vectors: [[0, 1]], dimensions: 2, space_id: 'new' };
    throw new Error(action);
  } });
  await spaces.ensure({ projectId: 'p' });
  expect(calls.filter((call) => call.action === 'embed')).toEqual([]);
});

test('model-space migration preserves the actual coding experience retrieval representation', async () => {
  const ref = { sessionId: 's', messageId: 'm', sourceHash: 'hash', sourceRevision: 1 };
  let state = { sessions: { s: { revision: 1, deleted: false, reconciling: false } }, tombstones: [], entries: [],
    jobs: [{ id: 'capture', sourceRevision: 1, segment: { id: 'capture', projectId: 'p', sessionId: 's', sourceHash: 'hash', messages: [{ id: 'm' }] } }],
    engine: { records: [
      { collection: 'model-space', projectId: 'p', id: 'current', value: { spaceId: 'old', configurationId: 'old-config', dimensions: 2 } },
      { collection: 'node-source', projectId: 'p', id: 'experience', value: { sourceRefs: [ref] } },
    ] } };
  const coreNamespace = `${memoryNamespace('p')}:core`;
  const node = { id: 'experience', content: 'Rebuild importer\nUse transaction staging for every write.', active: true, space_id: 'old',
    payload: { user_id: coreNamespace, workspace_id: 'p', custom: { source_refs: [ref], hy_kind: 'experience',
      record: { task: 'Rebuild importer', solution: 'Use transaction staging for every write.' } } } };
  const texts = [];
  const store = { atomicIndex: true, read: async () => structuredClone(state), update: async (change) => {
    const next = structuredClone(state); change(next); state = next; return structuredClone(state);
  } };
  const spaces = createHySpaceMaintenance({ store, backend: async (action, input) => {
    if (action === 'capabilities') return { embedding_configuration_id: 'new-config' };
    if (action === 'nodes/list') return { nodes: input.namespace === coreNamespace ? [node] : [], total: input.namespace === coreNamespace ? 1 : 0 };
    if (action === 'embed') { texts.push(...input.texts); return { vectors: [[0, 1]], dimensions: 2, space_id: 'new' }; }
    throw new Error(action);
  } });
  await spaces.ensure({ projectId: 'p' });
  expect(texts).toEqual(['Rebuild importer']);
});
