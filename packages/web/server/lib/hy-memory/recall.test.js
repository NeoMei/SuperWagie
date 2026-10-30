import { expect, test } from 'bun:test';
import { readHyRecall } from './recall.js';

test('core ranking and historical patches require a current eligible card and exact captured source', async () => {
  const entry = { id: 'approved', sourceHash: 'hash', sourcePartIds: ['part'], sourceReferences: [{ sessionId: 's', messageId: 'm' }] };
  const row = { id: 'patch', project_id: 'p', session_id: 's', message_id: 'm', part_id: 'part', source_hash: 'hash', node_ids: ['approved'], patch: '+ fixed', file: 'a.js' };
  const result = await readHyRecall({ projectId: 'p', query: 'fix', entries: [entry], organizer: { recall: async () => ({
    nodes: [{ id: 'candidate' }, { id: 'approved' }, { id: 'approved' }],
    history: { records: [row, { ...row, id: 'other', source_hash: 'wrong' }, { ...row, id: 'other-project', project_id: 'other' }] },
  }) } });
  expect(result.ids).toEqual(['approved']);
  expect(result.history.get('approved')).toHaveLength(1);
  expect(result.history.get('approved')[0]).toMatchObject({ patch: '+ fixed', sourceHash: 'hash', file: 'a.js' });
});

test('Reader candidates retain eligible aliases and revision anchors without promoting unrelated candidates', async () => {
  let request;
  const relation = (source_id, target_id, relation_type, properties = {}) => ({ projectId: 'p', collection: 'relation', id: `${source_id}:${target_id}`,
    value: { source_id, target_id, relation_type, properties } });
  await readHyRecall({ projectId: 'p', directory: '/p', query: 'q', entries: [{ id: 'new', sourceReferences: [], sourcePartIds: [] }],
    state: { engine: { records: [relation('new', 'key', 'EXPERIENCE_KEY'), relation('old', 'new', 'FACT_SUPERSEDES'), relation('other', 'unconfirmed', 'EXPERIENCE_KEY')] } },
    organizer: { recall: async (input) => { request = input; return { nodes: [], history: { records: [] } }; } } });
  expect(request.eligibleNodeIds).toEqual(['new']);
  expect(request.candidateNodeIds.sort()).toEqual(['key', 'new', 'old']);
});

test('busy or timed-out core retrieval degrades without discarding other retrieval', async () => {
  const result = await readHyRecall({ projectId: 'p', query: 'q', entries: [], timeoutMs: 5,
    organizer: { recall: () => new Promise(() => {}) } });
  expect(result.ids).toEqual([]);
  expect(result.availability).toEqual({ state: 'degraded', reason: 'hy_recall_timeout' });
});
