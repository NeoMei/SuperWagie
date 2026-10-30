import { createHash } from 'node:crypto';
import { z } from 'zod';
import { memoryNamespace } from './organizer.js';
import { methodologySourcesEligible } from '../conversation-memory/methodology.js';

const fail = (code) => Object.assign(new Error(code), { code });
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const refSchema = z.object({ sessionId: z.string(), messageId: z.string(), partId: z.string().nullish(), sourceHash: z.string(), sourceRevision: z.number().int().nonnegative().nullish() });
const nodeSchema = z.object({ id: z.string(), content: z.string(), active: z.boolean(), payload: z.object({}).passthrough(), space_id: z.string().optional() }).passthrough();
const pageSchema = z.object({ nodes: z.array(nodeSchema), total: z.number().int().nonnegative() });
const bindingSchema = z.object({ spaceId: z.string().optional(), configurationId: z.string().optional(), dimensions: z.number().int().positive().optional() });
const journalSchema = z.object({ configurationId: z.string(), snapshot: z.string(), bindingSignature: z.string(), targetSpaceId: z.string().nullable(), dimensions: z.number().int().positive().nullable(),
  sections: z.array(z.object({ kind: z.enum(['core', 'cards']), spaceId: z.string(), total: z.number().int().nonnegative(), offset: z.number().int().nonnegative() })) });
const embeddedSchema = z.object({ space_id: z.string().min(1), dimensions: z.number().int().positive(), vectors: z.array(z.array(z.number().finite())) });
const rows = (state, projectId, collection) => state.engine.records.filter((row) => row.projectId === projectId && row.collection === collection);
const record = (state, projectId, collection) => rows(state, projectId, collection).find((row) => row.id === 'current');
const removeRecord = (state, projectId, collection) => { state.engine.records = state.engine.records.filter((row) => row.projectId !== projectId || row.collection !== collection || row.id !== 'current'); };
const saveRecord = (state, projectId, collection, value) => { removeRecord(state, projectId, collection); state.engine.records.push({ projectId, collection, id: 'current', value }); };
const bindingOf = (state, projectId) => bindingSchema.parse(record(state, projectId, 'model-space')?.value ?? {});
const refKeys = (refs) => refs.map((ref) => JSON.stringify([ref.sessionId, ref.messageId, ref.partId ?? null, ref.sourceHash, ref.sourceRevision ?? null])).sort();
const namespace = (projectId, kind) => `${memoryNamespace(projectId)}:${kind}`;
const withdrawalSchema = z.object({ state: z.string(), nodeIds: z.array(z.string()).default([]), cardIds: z.array(z.string()).default([]) });
const deniedIds = (state, projectId) => {
  const denied = new Set(state.tombstones);
  for (const entry of state.entries) if (entry.projectId === projectId && (entry.status === 'forgotten' || entry.cleanupPending)) denied.add(entry.id);
  for (const row of rows(state, projectId, 'hy-withdrawal')) {
    const plan = withdrawalSchema.parse(row.value);
    if (plan.state === 'pending') for (const id of [...plan.nodeIds, ...plan.cardIds]) denied.add(id);
  }
  return denied;
};
const representationSchema = z.object({ custom: z.object({ embedding_text: z.string().min(1).optional(),
  hy_kind: z.string().optional(), retrieval_text: z.string().optional(), record: z.object({
    task: z.string().optional(), subject: z.string().optional(), statement: z.string().optional(),
  }).passthrough().optional(),
}).passthrough().optional() }).passthrough();
const embeddingText = (node, kind) => {
  if (kind !== 'core') return node.content;
  const custom = representationSchema.parse(node.payload).custom;
  if (custom?.embedding_text) return custom.embedding_text;
  if (custom?.hy_kind === 'experience' && custom.record?.task) return custom.record.task;
  if (custom?.hy_kind === 'fact' && custom.record?.statement) return custom.record.subject
    ? `${custom.record.subject}: ${custom.record.statement}` : custom.record.statement;
  return custom?.retrieval_text || node.content;
};
const fingerprint = (state, projectId) => {
  const sources = rows(state, projectId, 'node-source').sort((a, b) => a.id.localeCompare(b.id));
  const jobs = state.jobs.filter((job) => job.segment?.projectId === projectId).map((job) => [job.id, job.sourceRevision, job.segment.sourceHash,
    job.segment.messages?.map((message) => [message.id, message.partId ?? null])]).sort((a, b) => a[0].localeCompare(b[0]));
  const entries = state.entries.filter((entry) => entry.projectId === projectId).sort((a, b) => a.id.localeCompare(b.id));
  const sessionIds = new Set([...entries.map((entry) => entry.sessionId), ...sources.flatMap((row) => z.object({ sourceRefs: z.array(refSchema) }).parse(row.value).sourceRefs.map((ref) => ref.sessionId))]);
  const identities = new Set([...entries.map((entry) => entry.id), ...sources.map((row) => row.id), ...jobs.map(([id, , hash]) => `source:${id}:${hash}`)]);
  return digest([sources, jobs, entries, rows(state, projectId, 'hy-withdrawal'), [...sessionIds].sort().map((id) => [id, state.sessions[id]]), state.tombstones.filter((id) => identities.has(id))]);
};
const referencesCurrent = (state, projectId, refs) => refs.every((ref) => {
  const source = state.sessions[ref.sessionId];
  return source && !source.deleted && !source.reconciling && (ref.sourceRevision == null || ref.sourceRevision === (source.revision ?? 0))
    && state.jobs.some((job) => job.segment?.projectId === projectId && job.segment?.sessionId === ref.sessionId
      && job.segment?.sourceHash === ref.sourceHash && job.sourceRevision === (source.revision ?? 0)
      && job.segment.messages?.some((message) => message.id === ref.messageId && (!ref.partId || message.partId === ref.partId)));
});
const copyEligible = (state, projectId, kind, node) => {
  if (deniedIds(state, projectId).has(node.id)) return false;
  if (kind === 'cards') {
    const entry = state.entries.find((item) => item.projectId === projectId && item.id === node.id);
    if (!entry || entry.status !== 'active' || entry.indexState !== 'ready' || entry.cleanupPending || !methodologySourcesEligible(state, entry)) return false;
    return entry.sourceReferences.length > 0 && entry.sourceReferences.every((ref) => {
      const source = state.sessions[ref.sessionId];
      return source && !source.deleted && !source.reconciling && state.jobs.some((job) => job.segment?.projectId === projectId
        && job.segment?.sessionId === ref.sessionId && job.sourceRevision === (source.revision ?? 0)
        && (entry.kind === 'methodology' || job.segment.sourceHash === entry.sourceHash)
        && job.segment.messages?.some((message) => message.id === ref.messageId));
    });
  }
  const source = rows(state, projectId, 'node-source').find((row) => row.id === node.id);
  if (!source) throw fail('hy_space_source_invalid');
  const recorded = z.object({ sourceRefs: z.array(refSchema).min(1) }).parse(source.value).sourceRefs;
  const payload = z.object({ user_id: z.literal(namespace(projectId, 'core')), workspace_id: z.literal(projectId),
    custom: z.object({ source_refs: z.array(refSchema).min(1) }).passthrough() }).passthrough().parse(node.payload);
  if (digest(refKeys(recorded)) !== digest(refKeys(payload.custom.source_refs))) throw fail('hy_space_source_invalid');
  return referencesCurrent(state, projectId, recorded);
};

/** Copies bounded batches while the complete old space remains available until its final atomic swap. */
export function createHySpaceMaintenance({ store, backend, canProcess = () => true, batchSize = 32, maxBatches = 32 }) {
  let queue = Promise.resolve();
  const allowed = (signal) => {
    if (signal?.aborted) throw fail('hy_cancelled');
    if (!canProcess()) throw fail('hy_space_migration_blocked');
  };
  const capabilities = async (signal) => {
    allowed(signal);
    return z.object({ embedding_configuration_id: z.string().min(1) }).parse(await backend('capabilities', {})).embedding_configuration_id;
  };
  const ensure = async ({ projectId, signal }) => {
    z.string().min(1).parse(projectId); allowed(signal);
    if (!store.atomicIndex) throw fail('hy_atomic_projection_required');
    const configurationId = await capabilities(signal);
    let state = await store.read();
    let binding = bindingOf(state, projectId);
    let saved = record(state, projectId, 'model-space-migration');
    let journal = saved ? journalSchema.parse(saved.value) : null;
    const snapshot = fingerprint(state, projectId);
    if (journal && (journal.configurationId !== configurationId || journal.snapshot !== snapshot || journal.bindingSignature !== digest(binding))) {
      const deletes = journal.targetSpaceId && journal.targetSpaceId !== binding.spaceId
        ? ['core', 'cards'].map((kind) => ({ operation: 'nodes/delete', namespace: namespace(projectId, kind), space_id: journal.targetSpaceId })) : [];
      await store.update((next) => {
        allowed(signal); if (digest(bindingOf(next, projectId)) !== digest(binding)) throw fail('hy_space_binding_changed');
        removeRecord(next, projectId, 'model-space-migration');
      }, { indexOperations: deletes });
      state = await store.read(); journal = null;
    }
    if (!journal && binding.configurationId === configurationId) return { spaceId: binding.spaceId, configurationId };
    if (!journal) {
      const sections = [];
      for (const kind of ['core', 'cards']) {
        allowed(signal);
        const firstInput = { namespace: namespace(projectId, kind), limit: 1, offset: 0 };
        if (binding.spaceId) firstInput.space_id = binding.spaceId;
        let first = pageSchema.parse(await backend('nodes/list', firstInput));
        if (!first.nodes.length && kind === 'cards' && binding.spaceId) first = pageSchema.parse(await backend('nodes/list', { namespace: namespace(projectId, kind), limit: 1, offset: 0 }));
        if (!first.nodes.length) continue;
        const oldSpace = first.nodes[0].space_id ?? binding.spaceId;
        if (!oldSpace) throw fail('hy_space_binding_unavailable');
        const exact = pageSchema.parse(await backend('nodes/list', { namespace: namespace(projectId, kind), space_id: oldSpace, limit: 1, offset: 0 }));
        sections.push({ kind, spaceId: oldSpace, total: exact.total, offset: 0 });
      }
      if (!sections.length) {
        if (binding.spaceId) await store.update((next) => { allowed(signal); removeRecord(next, projectId, 'model-space'); });
        return { spaceId: undefined, configurationId };
      }
      journal = { configurationId, snapshot: fingerprint(state, projectId), bindingSignature: digest(binding), targetSpaceId: null, dimensions: null, sections };
      await store.update((next) => { allowed(signal); if (fingerprint(next, projectId) !== journal.snapshot) throw fail('source_changed'); saveRecord(next, projectId, 'model-space-migration', journal); });
    }
    for (let batch = 0; batch < maxBatches; batch++) {
      const section = journal.sections.find((item) => item.offset < item.total);
      if (!section) break;
      allowed(signal); state = await store.read();
      if (fingerprint(state, projectId) !== journal.snapshot || digest(bindingOf(state, projectId)) !== journal.bindingSignature) throw fail('source_changed');
      const page = pageSchema.parse(await backend('nodes/list', { namespace: namespace(projectId, section.kind), space_id: section.spaceId,
        offset: section.offset, limit: Math.min(batchSize, 100), include_vectors: false }));
      if (page.total !== section.total || !page.nodes.length) throw fail('hy_space_index_changed');
      const selected = page.nodes.filter((node) => copyEligible(state, projectId, section.kind, node));
      let embedded = null;
      if (selected.length) {
        allowed(signal);
        embedded = embeddedSchema.parse(await backend('embed', { texts: selected.map((node) => embeddingText(node, section.kind)), input_role: 'document' }));
        if (embedded.vectors.length !== selected.length || embedded.vectors.some((vector) => vector.length !== embedded.dimensions)) throw fail('embedding_dimension_mismatch');
        if (journal.targetSpaceId && (journal.targetSpaceId !== embedded.space_id || journal.dimensions !== embedded.dimensions)) throw fail('hy_embedding_space_changed');
      }
      const nextJournal = structuredClone(journal);
      nextJournal.sections.find((item) => item.kind === section.kind).offset += page.nodes.length;
      if (embedded) { nextJournal.targetSpaceId = embedded.space_id; nextJournal.dimensions = embedded.dimensions; }
      const operations = selected.length ? [{ operation: 'nodes/upsert', namespace: namespace(projectId, section.kind), space_id: embedded.space_id,
        nodes: selected.map((node, index) => ({ id: node.id, content: node.content, payload: node.payload, active: node.active, vector: embedded.vectors[index] })) }] : [];
      await store.update((next) => {
        allowed(signal);
        if (fingerprint(next, projectId) !== journal.snapshot || digest(bindingOf(next, projectId)) !== journal.bindingSignature
          || digest(record(next, projectId, 'model-space-migration')?.value) !== digest(journal)) throw fail('source_changed');
        for (const node of selected) if (!copyEligible(next, projectId, section.kind, node)) throw fail('source_changed');
        saveRecord(next, projectId, 'model-space-migration', nextJournal);
      }, { indexOperations: operations });
      journal = nextJournal;
    }
    if (journal.sections.some((section) => section.offset < section.total)) throw fail('hy_space_migration_pending');
    if (await capabilities(signal) !== configurationId) throw fail('hy_embedding_space_changed');
    const deletes = journal.sections.filter((section) => section.spaceId !== journal.targetSpaceId).map((section) => ({ operation: 'nodes/delete', namespace: namespace(projectId, section.kind), space_id: section.spaceId }));
    await store.update((next) => {
      allowed(signal);
      if (fingerprint(next, projectId) !== journal.snapshot || digest(bindingOf(next, projectId)) !== journal.bindingSignature
        || digest(record(next, projectId, 'model-space-migration')?.value) !== digest(journal)) throw fail('source_changed');
      if (journal.targetSpaceId) saveRecord(next, projectId, 'model-space', { spaceId: journal.targetSpaceId, configurationId, dimensions: journal.dimensions });
      else removeRecord(next, projectId, 'model-space');
      removeRecord(next, projectId, 'model-space-migration');
    }, { indexOperations: deletes });
    binding = { spaceId: journal.targetSpaceId ?? undefined, configurationId };
    return binding;
  };
  return { ensure(input) { const work = queue.then(() => ensure(input)); queue = work.catch(() => {}); return work; } };
}
