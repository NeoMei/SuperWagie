import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { planHyTransportRebind } from './transport-rebind.js';
import { memoryNamespace } from './organizer.js';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const engine = (collection, id, value, projectId = 'p') => ({ collection: 'entry', id: `hy:${sha(JSON.stringify([projectId, collection, id]))}`, valueRaw: JSON.stringify({ projectId, collection, id, value, extra: 'retained' }) });
const fixture = () => {
  const ref = { sessionId: 's', messageId: 'm', sourceHash: 'hash', sourceRevision: 2 };
  const manual = { id: 'manual', scope: 'global', type: 'fact', title: 'Title', body: 'Body' };
  const sourceHash = sha(JSON.stringify(['manual', 'global', 'fact', 'Title', 'Body']));
  const records = [
    { collection: 'meta', id: 'control', valueRaw: JSON.stringify({ version: 1, enabled: true, enabledAt: 1, pending: [], tombstones: [], lastError: null }) },
    { collection: 'source', id: 's', valueRaw: JSON.stringify({ directory: '/p', checkpoint: null, revision: 2 }) },
    { collection: 'job', id: 'capture:c', valueRaw: JSON.stringify({ type: 'capture', item: { id: 'c', sourceRevision: 2, state: 'done', error: null, attempts: 1, segment: { id: 'c', projectId: 'p', sessionId: 's', directory: '/p', sourceHash: 'hash', messages: [{ id: 'm' }] } } }) },
    { collection: 'entry', id: 'card', valueRaw: JSON.stringify({ id: 'card', kind: 'segment', title: 'Card', body: 'Canonical', status: 'active', verification: 'observed', indexState: 'ready', projectId: 'p', directory: '/p', sessionId: 's', segmentId: 'c', sourceHash: 'hash', sourceMessageIds: ['m'], sourceReferences: [{ sessionId: 's', messageId: 'm' }], limitations: [], createdAt: 1, updatedAt: 1 }) },
    engine('model-space', 'current', { configurationId: 'old-config', spaceId: 'old', extra: 7 }),
    engine('node-source', 'core', { sourceRefs: [ref] }),
    engine('manual', 'manual', manual, 'global'),
    engine('manual-index', 'manual', { version: 1, configurationId: 'old-config', spaceId: 'old', dimensions: 1024, state: 'ready', sourceHash }, 'global'),
  ];
  const node = (kind, id, content, payload, active = true, projectId = 'p') => ({ namespace: `${memoryNamespace(projectId)}:${kind}`, spaceId: 'old', id, content, payloadRaw: JSON.stringify(payload), active, dimensions: 1024, vectorFloat32LE: Buffer.alloc(4096).toString('base64') });
  return { tenantId: 1, kbId: 'kb', rawLedger: { namespace: 'superwagie:memory', revision: 5, records },
    oldIdentity: { configurationId: 'old-config', spaceId: 'old', dimensions: 1024 }, targetIdentity: { configurationId: 'new-config', spaceId: 'new', dimensions: 1024 },
    scopedNodes: [node('core', 'core', 'Retained', { user_id: `${memoryNamespace('p')}:core`, workspace_id: 'p', custom: { source_refs: [ref] } }, false),
      node('cards', 'card', 'Canonical', { entry_id: 'card', project_id: 'p', title: 'Card', representation: 'card' }),
      node('manual', 'manual', 'Title\n\nBody', { entry_id: 'manual', project_id: 'global', scope: 'global', manual_type: 'fact', title: 'Title', representation: 'manual', source_hash: sourceHash, verification: 'unverified' }, true, 'global')] };
};
const edit = (f, collection, id, change) => { const row = f.rawLedger.records.find((r) => r.collection === collection && r.id === id); const value = JSON.parse(row.valueRaw); change(value); row.valueRaw = JSON.stringify(value); };

test('selects source-authorized inactive core, canonical card and global manual; patches original markers only', () => {
  const f = fixture(); const before = JSON.stringify(f); const plan = planHyTransportRebind(f);
  expect(plan.selectedNodes.map((n) => n.nodeId).sort()).toEqual(['card', 'core', 'manual']);
  expect(plan.ledgerMutations).toHaveLength(2);
  const changed = plan.ledgerMutations.map((row) => JSON.parse(row.valueRaw));
  expect(changed.find((r) => r.collection === 'model-space')).toEqual({ projectId: 'p', collection: 'model-space', id: 'current', extra: 'retained', value: { configurationId: 'new-config', spaceId: 'new', extra: 7 } });
  expect(changed.filter((r) => r.collection === 'model-space' && r.projectId === 'global')).toHaveLength(0);
  expect(plan.beforeAfterCounts.inactive).toBe(1); expect(JSON.stringify(f)).toBe(before);
  expect(plan.selectedNodes.every((row) => !Object.hasOwn(row, 'vectorFloat32LE'))).toBe(true);
});

for (const reason of ['tombstone', 'withdrawal', 'directory', 'revision', 'deleted']) test(`excludes core with ${reason} source authority`, () => {
  const f = fixture();
  if (reason === 'tombstone') edit(f, 'meta', 'control', (v) => { v.tombstones = ['core']; });
  if (reason === 'withdrawal') f.rawLedger.records.push(engine('hy-withdrawal', 'w', { state: 'pending', nodeIds: ['core'] }));
  if (['directory', 'revision', 'deleted'].includes(reason)) edit(f, 'source', 's', (v) => { v[reason] = reason === 'directory' ? '/other' : reason === 'revision' ? 3 : true; });
  expect(planHyTransportRebind(f).selectedNodes.some((row) => row.nodeId === 'core')).toBe(false);
});
for (const change of ['body', 'flagged', 'pending', 'payload', 'hash']) test(`excludes manual with ${change} drift without promoting marker`, () => {
  const f = fixture();
  const row = f.rawLedger.records.find((r) => r.id === engine(change === 'pending' || change === 'hash' ? 'manual-index' : 'manual', 'manual', {}, 'global').id);
  if (change !== 'payload') edit(f, 'entry', row.id, (v) => { v.value[change === 'pending' ? 'state' : change === 'hash' ? 'sourceHash' : change] = change === 'flagged' ? true : 'changed'; });
  else f.scopedNodes[2].payloadRaw = '{}';
  if (change === 'pending') expect(() => planHyTransportRebind(f)).toThrow();
  else { const plan = planHyTransportRebind(f); expect(plan.selectedNodes.some((r) => r.nodeId === 'manual')).toBe(false); expect(plan.ledgerMutations).toHaveLength(1); }
});
test('rejects duplicate/raw identity confusion and migration journal; excludes changed card content', () => {
  const f = fixture(); f.scopedNodes[1].content = 'stale'; expect(planHyTransportRebind(f).selectedNodes).toHaveLength(2);
  f.rawLedger.records.push(f.rawLedger.records[0]); expect(() => planHyTransportRebind(f)).toThrow();
  const g = fixture(); g.rawLedger.records.push(engine('model-space-migration', 'current', {})); expect(() => planHyTransportRebind(g)).toThrow();
  const h = fixture(); h.rawLedger.records[4].id = `hy:${'a'.repeat(64)}`; expect(() => planHyTransportRebind(h)).toThrow();
});
