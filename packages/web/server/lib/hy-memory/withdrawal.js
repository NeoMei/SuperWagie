import { createHash } from 'node:crypto';
import { z } from 'zod';
import { memoryNamespace } from './organizer.js';

const requestSchema = z.object({ projectId: z.string().min(1), sessionIds: z.array(z.string().min(1)).default([]), entryIds: z.array(z.string().min(1)).default([]), forget: z.boolean().default(false) });
const refSchema = z.object({ sessionId: z.string(), sourceHash: z.string().optional() }).passthrough();
const infoSchema = z.object({
  node_ids: z.array(z.string()).optional(), source_refs: z.array(refSchema).optional(), sourceRefs: z.array(refSchema).optional(),
  session_id: z.string().optional(), sessionId: z.string().optional(), source_hash: z.string().optional(), sourceHash: z.string().optional(),
  experience_id: z.string().optional(), entry_id: z.string().optional(), owner_node_id: z.string().optional(),
}).passthrough();
const relationSchema = z.object({ source_id: z.string(), target_id: z.string(), relation_type: z.string(), properties: z.object({ relation_type: z.string().optional() }).passthrough().optional() }).passthrough();
const nodeSchema = z.object({ id: z.string(), payload: z.object({ custom: infoSchema }).passthrough() }).passthrough();
const operationSchema = z.object({ operation: z.string(), collection: z.string().optional(), id: z.string().optional(), value: z.json().optional(), nodes: z.array(nodeSchema).optional(), ids: z.array(z.string()).optional() }).passthrough();
const sourceScopeSchema = z.object({ sessionId: z.string(), sourceHash: z.string() });
const nodeSnapshotSchema = z.object({ id: z.string(), signature: z.string() });
const withdrawalSchema = z.object({ sessionIds: z.array(z.string()), entryIds: z.array(z.string()), nodeIds: z.array(z.string()), cardIds: z.array(z.string()), sourceIds: z.array(z.string()), sourceScopes: z.array(sourceScopeSchema).default([]), nodeSnapshots: z.array(nodeSnapshotSchema).default([]), forget: z.boolean(), state: z.enum(['pending', 'done']), error: z.string().nullable() });
const ordered = (values) => [...new Set(values)].sort();
const signature = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sourceKey = (segment) => `source:${segment.id}:${segment.sourceHash}`;
const references = (info) => [...(info.sourceRefs ?? []), ...(info.source_refs ?? [])];
const failureCode = (error) => /^[a-z][a-z0-9_:-]{0,79}$/.test(error?.code ?? '') ? error.code : 'hy_cleanup_failed';
const recordInfo = (value) => { const parsed = infoSchema.safeParse(value); return parsed.success ? parsed.data : null; };
const sessionMatches = (info, sessions) => info && (sessions.has(info.session_id ?? info.sessionId) || references(info).some((ref) => sessions.has(ref.sessionId)));
const scopeMatches = (info, scopes) => references(info).some((ref) => scopes.some((scope) => scope.sessionId === ref.sessionId && scope.sourceHash === ref.sourceHash))
  || scopes.some((scope) => scope.sessionId === (info.session_id ?? info.sessionId) && scope.sourceHash === (info.source_hash ?? info.sourceHash));
const relationDepends = (edge, nodes) => {
  if (edge.relation_type === 'DERIVED_FROM' && nodes.has(edge.target_id)) return edge.source_id;
  if (['CROSS_ABSTRACTS_TO', 'EXPERIENCE_KEY', 'SCHEMA_BEHAVIOR', 'CONTENT_REPRESENTATION'].includes(edge.relation_type) && nodes.has(edge.source_id)) return edge.target_id;
  if (edge.relation_type === 'FACT_SUPERSEDES' || edge.relation_type === 'RELATED_TO' && edge.properties?.relation_type === 'schema_revision') {
    if (nodes.has(edge.source_id)) return edge.target_id;
    if (nodes.has(edge.target_id)) return edge.source_id;
  }
  return null;
};

const collectPlan = (state, input, saved) => {
  const sessions = new Set(input.sessionIds);
  const cards = state.entries.filter((entry) => entry.projectId === input.projectId);
  const records = state.engine.records.filter((record) => record.projectId === input.projectId);
  const projected = state.engine.projections.filter((projection) => projection.projectId === input.projectId);
  const generated = [
    ...state.jobs.filter((job) => job.segment?.projectId === input.projectId).map((job) => job.generated),
    ...state.syntheses.filter((job) => job.projectId === input.projectId).map((job) => job.generated),
  ];
  const generatedSchema = z.object({ operations: z.array(operationSchema).optional() }).passthrough();
  const operations = [...projected.flatMap((projection) => projection.operations.map((op) => operationSchema.parse(op))),
    ...generated.flatMap((receipt) => { const parsed = generatedSchema.safeParse(receipt); return parsed.success ? parsed.data.operations ?? [] : []; })];
  const nodes = new Set(saved?.nodeIds ?? []);
  const known = new Set([...cards.map((card) => card.id), ...records.filter((record) => record.collection === 'node-source').map((record) => record.id), ...operations.flatMap((op) => op.nodes?.map((node) => node.id) ?? [])]);
  for (const id of input.entryIds) if (known.has(id)) nodes.add(id);
  for (const entry of cards) if (sessions.has(entry.sessionId) || entry.sourceReferences.some((ref) => sessions.has(ref.sessionId))) nodes.add(entry.id);
  for (const record of records.filter((record) => record.collection === 'node-source')) {
    if (sessionMatches(infoSchema.parse(record.value), sessions)) nodes.add(record.id);
  }
  for (const op of operations) for (const node of op.nodes ?? []) if (sessionMatches(node.payload.custom, sessions)) nodes.add(node.id);
  const relations = [
    ...records.filter((record) => record.collection === 'relation').map((record) => relationSchema.parse(record.value)),
    ...operations.filter((op) => op.operation === 'relations/upsert').map((op) => relationSchema.parse(op.value)),
  ];
  const sources = new Set(saved?.sourceIds ?? []);
  const scopes = new Map((saved?.sourceScopes ?? []).map((scope) => [JSON.stringify(scope), scope]));
  let changed = true;
  while (changed) {
    const size = nodes.size;
    for (const edge of relations) { const related = relationDepends(edge, nodes); if (related) nodes.add(related); }
    for (const card of cards) if (card.supportingEntryIds.some((id) => nodes.has(id))) nodes.add(card.id);
    for (const op of operations) for (const node of op.nodes ?? []) if (nodes.has(node.payload.custom.owner_node_id)) nodes.add(node.id);
    for (const job of state.jobs.filter((job) => job.segment?.projectId === input.projectId)) {
      const related = cards.filter((card) => card.segmentId === job.id && card.sourceHash === job.segment.sourceHash);
      if (sessions.has(job.segment.sessionId) || related.length && related.every((card) => nodes.has(card.id) || card.status === 'forgotten' && !card.cleanupPending)) {
        sources.add(sourceKey(job.segment));
        const scope = { sessionId: job.segment.sessionId, sourceHash: job.segment.sourceHash }; scopes.set(JSON.stringify(scope), scope);
      }
    }
    const sourceScopes = [...scopes.values()];
    for (const record of records.filter((record) => record.collection === 'node-source')) if (scopeMatches(infoSchema.parse(record.value), sourceScopes)) nodes.add(record.id);
    for (const op of operations) for (const node of op.nodes ?? []) if (scopeMatches(node.payload.custom, sourceScopes)) nodes.add(node.id);
    changed = nodes.size !== size;
  }
  const cardIds = new Set([...(saved?.cardIds ?? []), ...cards.filter((card) => nodes.has(card.id)).map((card) => card.id)]);
  const snapshots = new Map((saved?.nodeSnapshots ?? []).map((snapshot) => [snapshot.id, snapshot]));
  for (const record of records.filter((record) => record.collection === 'node-source' && nodes.has(record.id))) {
    if (!snapshots.has(record.id)) snapshots.set(record.id, { id: record.id, signature: signature(record.value) });
  }
  return { ...input, nodeIds: ordered(nodes), cardIds: ordered(cardIds), sourceIds: ordered(sources), sourceScopes: [...scopes.values()], nodeSnapshots: [...snapshots.values()], state: 'pending', error: null };
};

const resumeInvalidation = (state, input, saved) => {
  const records = state.engine.records.filter((record) => record.projectId === input.projectId);
  const restored = state.entries.filter((card) => card.projectId === input.projectId && saved.cardIds.includes(card.id)
    && ['active', 'candidate'].includes(card.status) && !card.cleanupPending);
  const preserved = new Set(restored.map((card) => card.id));
  for (const snapshot of saved.nodeSnapshots) {
    const current = records.find((record) => record.collection === 'node-source' && record.id === snapshot.id);
    if (current && signature(current.value) !== snapshot.signature) preserved.add(current.id);
  }
  let changed = true;
  while (changed) {
    const size = preserved.size;
    for (const row of records.filter((record) => record.collection === 'relation')) {
      const edge = relationSchema.parse(row.value);
      if (['EXPERIENCE_KEY', 'SCHEMA_BEHAVIOR', 'CONTENT_REPRESENTATION'].includes(edge.relation_type) && preserved.has(edge.source_id)) preserved.add(edge.target_id);
    }
    changed = preserved.size !== size;
  }
  const restoredScope = (scope) => restored.some((card) => card.sessionId === scope.sessionId && card.sourceHash === scope.sourceHash);
  const retainedSources = state.jobs.filter((job) => job.segment?.projectId === input.projectId && restoredScope(job.segment)).map((job) => sourceKey(job.segment));
  return { ...input, ...saved,
    nodeIds: saved.nodeIds.filter((id) => !preserved.has(id)), cardIds: saved.cardIds.filter((id) => !preserved.has(id)),
    sessionIds: saved.sessionIds.filter((id) => !restored.some((card) => card.sessionId === id)),
    sourceScopes: saved.sourceScopes.filter((scope) => !restoredScope(scope)), sourceIds: saved.sourceIds.filter((id) => !retainedSources.includes(id)), state: 'pending', error: null };
};

const withdrawnRecord = (record, plan) => {
  const nodes = new Set(plan.nodeIds); const sessions = new Set(plan.sessionIds);
  if (record.collection === 'node-source') return nodes.has(record.id) ? null : record;
  if (record.collection === 'relation') {
    const edge = relationSchema.parse(record.value);
    return nodes.has(edge.source_id) || nodes.has(edge.target_id) ? null : record;
  }
  if (!['trace', 'code_history', 'review'].includes(record.collection)) return record;
  const info = recordInfo(record.value);
  if (!info) return record;
  if (sessionMatches(info, sessions) || scopeMatches(info, plan.sourceScopes) || nodes.has(info.experience_id) || nodes.has(info.entry_id) || nodes.has(info.owner_node_id)) return null;
  if (!info.node_ids?.some((id) => nodes.has(id))) return record;
  const remaining = info.node_ids.filter((id) => !nodes.has(id));
  if (!remaining.length || record.collection === 'review') return null;
  return { ...record, value: { ...info, node_ids: remaining } };
};

const pruneProjection = (projection, plan) => {
  if (projection.state === 'done') return;
  const sessions = new Set(plan.sessionIds); const nodes = new Set(plan.nodeIds);
  if (projection.sourceSessionIds.some((id) => sessions.has(id))) {
    projection.operations = []; projection.state = 'done'; projection.error = 'source_withdrawn'; return;
  }
  projection.operations = projection.operations.flatMap((raw) => {
    const op = operationSchema.parse(raw);
    if (op.operation === 'nodes/upsert') { const remaining = (op.nodes ?? []).filter((node) => !nodes.has(node.id)); return remaining.length ? [{ ...op, nodes: remaining }] : []; }
    if (op.operation === 'nodes/delete') { const remaining = (op.ids ?? []).filter((id) => !nodes.has(id)); return remaining.length ? [{ ...op, ids: remaining }] : []; }
    if (op.operation.endsWith('/delete')) return nodes.has(op.id) ? [] : [op];
    const collection = op.operation.startsWith('relations/') ? 'relation' : op.collection;
    if (!collection || !op.id) return [op];
    const retained = withdrawnRecord({ collection, id: op.id, projectId: projection.projectId, value: op.value ?? null }, plan);
    return retained ? [{ ...op, value: retained.value }] : [];
  });
  if (!projection.operations.length) { projection.state = 'done'; projection.error = 'source_withdrawn'; }
};

const eraseReceipts = (state, plan) => {
  const cards = new Set(plan.cardIds); const sessions = new Set(plan.sessionIds);
  for (const job of state.jobs.filter((job) => job.segment?.projectId === plan.projectId)) {
    const related = state.entries.filter((card) => card.projectId === plan.projectId && card.segmentId === job.id);
    if (sessions.has(job.segment.sessionId) || related.some((card) => cards.has(card.id))) job.generated = null;
    if (!plan.sourceIds.includes(sourceKey(job.segment))) continue;
    const { id, sessionId, projectId, directory, sourceHash } = job.segment;
    job.segment = { id, sessionId, projectId, directory, sourceHash }; job.generated = null; job.state = 'done'; job.error = null;
  }
  for (const job of state.syntheses.filter((job) => job.projectId === plan.projectId)) {
    if (!cards.has(job.entryId) && !job.supports.some((support) => cards.has(support.id) || sessions.has(support.sessionId))) continue;
    job.generated = null; job.continuation = null; job.state = 'done'; job.error = null;
  }
};

/** Withdrawal persists an ineligible closure before backend removal and erases prose after confirmed deletion. */
export function createHyWithdrawal({ store, backend }) {
  let queue = Promise.resolve();
  const run = async (raw, savedIdentity = null) => {
    const input = requestSchema.parse(raw);
    input.sessionIds = ordered(input.sessionIds); input.entryIds = ordered(input.entryIds);
    let plan; let identity; let alreadyComplete = false;
    await store.update((state) => {
      const revision = input.sessionIds.map((id) => [id, state.sessions[id]?.revision ?? 0]);
      identity = savedIdentity ?? createHash('sha256').update(JSON.stringify([input, revision])).digest('hex');
      const previous = state.engine.records.find((record) => record.projectId === input.projectId && record.collection === 'hy-withdrawal' && record.id === identity);
      const saved = previous && withdrawalSchema.parse(previous.value);
      if (savedIdentity && saved?.state === 'done') { plan = { ...input, ...saved }; alreadyComplete = true; return; }
      plan = saved?.state === 'pending' && !input.forget ? resumeInvalidation(state, input, saved) : collectPlan(state, input, saved);
      if (previous) previous.value = plan;
      else state.engine.records.push({ projectId: input.projectId, collection: 'hy-withdrawal', id: identity, value: plan });
      for (const card of state.entries.filter((card) => card.projectId === input.projectId && plan.cardIds.includes(card.id))) {
        const direct = plan.entryIds.includes(card.id) || plan.sessionIds.includes(card.sessionId);
        if (card.status !== 'forgotten') card.status = input.forget && direct ? 'forgotten' : 'superseded';
        card.cleanupPending = true; card.indexState = 'pending'; card.error = null;
      }
      if (input.forget) for (const key of [...plan.nodeIds, ...plan.sourceIds]) if (!state.tombstones.includes(key)) state.tombstones.push(key);
      for (const projection of state.engine.projections.filter((projection) => projection.projectId === input.projectId)) pruneProjection(projection, plan);
      for (const job of state.jobs.filter((job) => job.segment?.projectId === input.projectId && plan.sourceIds.includes(sourceKey(job.segment)))) { job.state = 'done'; job.error = null; }
      for (const job of state.syntheses.filter((job) => job.projectId === input.projectId && (plan.cardIds.includes(job.entryId) || job.supports.some((support) => plan.cardIds.includes(support.id) || plan.sessionIds.includes(support.sessionId))))) { job.state = 'done'; job.error = null; }
      if (plan.nodeIds.length || plan.sessionIds.length) delete state.engine.continuations[input.projectId];
    });
    if (alreadyComplete) return { entryIds: plan.cardIds, nodeIds: plan.nodeIds, sourceIds: plan.sourceIds, cleanupPending: false };
    const indexOperations = [];
    for (const [kind, ids] of [['core', plan.nodeIds], ['cards', plan.cardIds]]) {
      for (let offset = 0; offset < ids.length; offset += 256) indexOperations.push({ operation: 'nodes/delete', namespace: `${memoryNamespace(input.projectId)}:${kind}`, ids: ids.slice(offset, offset + 256) });
    }
    try {
      const complete = (state) => {
        state.engine.records = state.engine.records.flatMap((record) => {
          if (record.projectId !== input.projectId) return [record];
          const retained = withdrawnRecord(record, plan); return retained ? [retained] : [];
        });
        for (const card of state.entries.filter((card) => card.projectId === input.projectId && plan.cardIds.includes(card.id))) {
          card.cleanupPending = false; card.error = null; card.documentId = null; card.knowledgeId = null;
          card.indexState = card.status === 'forgotten' ? 'ready' : 'pending';
          if (input.forget || card.status === 'forgotten') { card.title = ''; card.body = ''; card.limitations = []; }
        }
        eraseReceipts(state, plan);
        const receipt = state.engine.records.find((record) => record.projectId === input.projectId && record.collection === 'hy-withdrawal' && record.id === identity);
        if (receipt) receipt.value = { ...plan, state: 'done', error: null };
      };
      if (store.atomicIndex) await store.update(complete, { indexOperations });
      else { for (const { operation, ...payload } of indexOperations) await backend(operation, payload); await store.update(complete); }
      return { entryIds: plan.cardIds, nodeIds: plan.nodeIds, sourceIds: plan.sourceIds, cleanupPending: false };
    } catch (error) {
      await store.update((state) => {
        for (const card of state.entries.filter((card) => card.projectId === input.projectId && plan.cardIds.includes(card.id))) { card.cleanupPending = true; card.indexState = 'failed'; card.error = failureCode(error); }
        const receipt = state.engine.records.find((record) => record.projectId === input.projectId && record.collection === 'hy-withdrawal' && record.id === identity);
        if (receipt) receipt.value = { ...plan, error: failureCode(error) };
      });
      throw error;
    }
  };
  const enqueue = (input, identity = null) => { const work = queue.then(() => run(input, identity)); queue = work.catch(() => {}); return work; };
  return {
    withdraw: (input) => enqueue(input),
    async retryPending() {
      const state = await store.read();
      const pending = state.engine.records.filter((record) => record.collection === 'hy-withdrawal').map((record) => ({ projectId: record.projectId, id: record.id, ...withdrawalSchema.parse(record.value) })).filter((record) => record.state === 'pending');
      const results = [];
      for (const record of pending) {
        try { results.push(await enqueue(record, record.id)); }
        catch (error) { results.push({ projectId: record.projectId, cleanupPending: true, error: failureCode(error) }); }
      }
      return results;
    },
  };
}
