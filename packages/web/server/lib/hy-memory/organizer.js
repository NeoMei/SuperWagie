import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createHyMemoryWorker } from './worker.js';

const hostSchema = z.object({ jobId: z.string().min(1), namespace: z.string().optional() }).passthrough();
const generateSchema = hostSchema.extend({ prompt: z.string().min(1).max(2_000_000), systemPrompt: z.string().max(200_000).optional(), maxTokens: z.number().int().positive().max(32_000).optional() });
const embedSchema = hostSchema.extend({ texts: z.array(z.string().max(1_000_000)).min(1).max(100), input_role: z.enum(['query', 'document']).default('document') });
const storeSchema = hostSchema.extend({ operation: z.enum(['nodes/get', 'nodes/list', 'nodes/search', 'records/get', 'records/list', 'relations/list']) });
const resultSchema = z.object({ cards: z.array(z.json()).default([]), operations: z.array(z.json()).default([]) }).passthrough();
const fail = (code) => Object.assign(new Error(code), { code });
export const memoryNamespace = (projectId) => `superwagie:memory:${createHash('sha256').update(projectId).digest('hex')}`;

const sourceRefSchema = z.object({ sessionId: z.string(), messageId: z.string(), partId: z.string().optional(),
  sourceHash: z.string(), sourceRevision: z.number().int().nonnegative().nullish() });
const nodeSourceSchema = z.object({ sourceRefs: z.array(sourceRefSchema).min(1) });
const sourceJobSchema = z.object({ sourceRevision: z.number().int().nonnegative().default(0), segment: z.object({
  id: z.string(), projectId: z.string(), sessionId: z.string(), sourceHash: z.string(), directory: z.string().optional(),
  messages: z.array(z.object({ id: z.string(), partId: z.string().optional() }).passthrough()).default([]),
}).passthrough() });
const sessionSourceSchema = z.object({ revision: z.number().int().nonnegative().default(0), directory: z.string().optional(),
  deleted: z.boolean().default(false), reconciling: z.boolean().default(false) });
const withdrawalReadSchema = z.object({ state: z.string(), nodeIds: z.array(z.string()).default([]) });
const sourceRecordSchema = z.object({ source_refs: z.array(sourceRefSchema).optional(), sourceRefs: z.array(sourceRefSchema).optional(),
  node_ids: z.array(z.string()).optional(), source_id: z.string().optional(), target_id: z.string().optional() }).passthrough();
const nodeReadResultSchema = z.object({ nodes: z.array(z.object({ id: z.string(), space_id: z.string().optional(), score: z.number().finite().optional() }).passthrough()),
  total: z.number().int().nonnegative().optional() }).passthrough();
const sourceKey = (ref, revision) => JSON.stringify([ref.sessionId, ref.sourceHash, revision, ref.messageId, ref.partId ?? null]);

// A retained vector is never authority to expose its source text. This ledger
// allowlist excludes withdrawn and untracked rows before backend ranking.
const sourceAuthority = (state, projectId) => {
  const tombstones = new Set(state.tombstones ?? []); const validRefs = new Set(); const revisions = new Map();
  for (const raw of state.jobs ?? []) {
    const parsed = sourceJobSchema.safeParse(raw); if (!parsed.success) continue;
    const { segment, sourceRevision } = parsed.data;
    const retainedSibling = state.entries?.some((entry) => entry.segmentId === segment.id && entry.projectId === projectId
      && ['active', 'candidate'].includes(entry.status) && !entry.cleanupPending && !tombstones.has(entry.id));
    if (segment.projectId !== projectId || tombstones.has(`source:${segment.id}:${segment.sourceHash}`) && !retainedSibling) continue;
    const session = sessionSourceSchema.safeParse(state.sessions?.[segment.sessionId]);
    if (!session.success || session.data.deleted || session.data.reconciling || session.data.revision !== sourceRevision
      || session.data.directory && segment.directory !== session.data.directory) continue;
    revisions.set(segment.sessionId, sourceRevision);
    for (const message of segment.messages) {
      const ref = { sessionId: segment.sessionId, sourceHash: segment.sourceHash, messageId: message.id };
      validRefs.add(sourceKey(ref, sourceRevision));
      if (message.partId) validRefs.add(sourceKey({ ...ref, partId: message.partId }, sourceRevision));
    }
  }
  const acceptsRef = (ref) => validRefs.has(sourceKey(ref, ref.sourceRevision ?? revisions.get(ref.sessionId)));
  const denied = new Set(tombstones);
  for (const entry of state.entries ?? []) if (entry.projectId === projectId && (entry.status === 'forgotten' || entry.cleanupPending)) denied.add(entry.id);
  for (const row of state.engine.records) if (row.projectId === projectId && row.collection === 'hy-withdrawal') {
    const parsed = withdrawalReadSchema.safeParse(row.value);
    if (!parsed.success) throw fail('hy_withdrawal_state_invalid');
    if (parsed.data.state === 'pending') for (const id of parsed.data.nodeIds) denied.add(id);
  }
  const nodes = new Map();
  for (const row of state.engine.records) if (row.projectId === projectId && row.collection === 'node-source' && !denied.has(row.id)) {
    const parsed = nodeSourceSchema.safeParse(row.value);
    if (parsed.success && parsed.data.sourceRefs.every(acceptsRef)) nodes.set(row.id, parsed.data.sourceRefs);
  }
  return { nodes, acceptsRef };
};

/** Host dispatch validates each reverse request against its live authorized job. */
export function createHyMemoryOrganizer({ backend, generate, readState, isBlocked = () => false, createWorker = createHyMemoryWorker, runtimeDirectory, command, ensureSpace = null }) {
  const jobs = new Map();
  let stopped = false;
  let waiting = 0;
  let queue = Promise.resolve();
  const authorize = (input) => {
    if (isBlocked()) throw fail('enterprise_mode');
    const request = hostSchema.parse(input); const job = jobs.get(request.jobId);
    if (!job || job.signal?.aborted) throw fail('hy_job_unavailable');
    if (request.namespace && request.namespace !== job.context.namespace) throw fail('hy_scope_mismatch');
    return job;
  };
  const checkReadSources = async (job) => {
    if (!job.readNodeIds.size && !job.readSourceRefs.size) return;
    const authority = sourceAuthority(await readState(), job.context.projectId);
    if ([...job.readNodeIds].some((id) => !authority.nodes.has(id)) || [...job.readSourceRefs.values()].some((ref) => !authority.acceptsRef(ref))) throw fail('hy_source_changed');
  };
  const readNodes = async (parsed, job) => {
    const { operation, jobId: _job, namespace: _namespace, ids: requestedIds, filters: rawFilters, limit: rawLimit, offset: rawOffset, ...options } = parsed;
    const filters = z.record(z.string(), z.json()).parse(rawFilters ?? {});
    const requested = operation === 'nodes/get' ? z.array(z.string()).parse(requestedIds) : filters.node_ids === undefined ? null : z.array(z.string()).parse(filters.node_ids);
    const requestedSet = requested ? new Set(requested) : null;
    const authority = sourceAuthority(await readState(), job.context.projectId);
    const ids = [...authority.nodes.keys()].filter((id) => !requestedSet || requestedSet.has(id)).sort();
    const limit = Math.min(z.number().int().positive().optional().parse(rawLimit) ?? 100, 256);
    const offset = z.number().int().nonnegative().max(512).optional().parse(rawOffset) ?? 0;
    if (!ids.length) return { nodes: [], total: 0 };
    const found = []; let total = 0; let metadata = {};
    for (let index = 0; index < ids.length; index += 256) {
      const chunk = ids.slice(index, index + 256); let pageOffset = 0;
      while (true) {
        const input = { ...options, namespace: job.context.namespace };
        if (operation === 'nodes/get') input.ids = chunk;
        else {
          input.filters = { ...filters, node_ids: chunk };
          input.limit = operation === 'nodes/search' ? limit : 256;
          if (operation === 'nodes/list') input.offset = pageOffset;
        }
        const result = nodeReadResultSchema.parse(await backend(operation, input));
        const rows = result.nodes.filter((node) => chunk.includes(node.id));
        const { nodes: _nodes, total: _total, ...extra } = result; metadata = { ...metadata, ...extra };
        found.push(...rows);
        if (pageOffset === 0) total += result.total ?? rows.length;
        pageOffset += result.nodes.length;
        if (operation !== 'nodes/list' || pageOffset >= (result.total ?? pageOffset) || pageOffset >= offset + limit) break;
        if (!result.nodes.length) throw fail('hy_store_page_incomplete');
      }
    }
    const current = sourceAuthority(await readState(), job.context.projectId);
    if (found.some((node) => !current.nodes.has(node.id) || (authority.nodes.get(node.id) ?? []).some((ref) => !current.acceptsRef(ref)))) throw fail('hy_source_changed');
    const unique = [...new Map(found.map((node) => [JSON.stringify([node.id, node.space_id ?? options.space_id ?? '']), node])).values()];
    unique.sort(operation === 'nodes/search' ? (a, b) => (b.score ?? 0) - (a.score ?? 0) || a.id.localeCompare(b.id) :
      (a, b) => a.id.localeCompare(b.id) || (a.space_id ?? '').localeCompare(b.space_id ?? ''));
    const nodes = operation === 'nodes/get' ? unique : unique.slice(operation === 'nodes/list' ? offset : 0, (operation === 'nodes/list' ? offset : 0) + limit);
    for (const node of nodes) {
      job.readNodeIds.add(node.id);
      for (const ref of authority.nodes.get(node.id) ?? []) job.readSourceRefs.set(JSON.stringify(ref), ref);
    }
    return { ...metadata, nodes, total };
  };
  const worker = createWorker({ runtimeDirectory, command, handlers: {
    'host.generate': async (input) => {
      const parsed = generateSchema.parse(input); const job = authorize(parsed);
      await checkReadSources(job);
      const generated = await generate({ prompt: parsed.prompt, system: parsed.systemPrompt, maxOutputTokens: parsed.maxTokens ?? 6000,
        onOverflow: 'error', directory: job.directory, preferredProviderID: job.providerID, preferredModelID: job.modelID, signal: job.signal });
      if (generated.inputTruncated) throw fail('hy_input_truncated');
      return { content: z.string().parse(generated.text) };
    },
    'host.embed': async (input) => { const parsed = embedSchema.parse(input); const job = authorize(parsed); await checkReadSources(job); const result = await backend('embed', { texts: parsed.texts, input_role: parsed.input_role }); job.spaceId = z.object({ space_id: z.string() }).parse(result).space_id; return result; },
    'host.store': async (input) => {
      const parsed = storeSchema.parse(input); const job = authorize(parsed);
      if (parsed.operation.startsWith('nodes/')) {
        return readNodes(parsed, job);
      }
      const state = await readState();
      const authority = sourceAuthority(state, job.context.projectId);
      const records = state.engine.records.filter((record) => {
        if (record.projectId !== job.context.projectId || !['trace', 'code_history', 'review', 'relation'].includes(record.collection)) return false;
        const parsed = sourceRecordSchema.safeParse(record.value); if (!parsed.success) return false;
        const value = parsed.data;
        if (record.collection === 'relation') return authority.nodes.has(value.source_id) && authority.nodes.has(value.target_id);
        const refs = [...(value.source_refs ?? []), ...(value.sourceRefs ?? [])];
        return refs.length > 0 && refs.every(authority.acceptsRef) && (!value.node_ids?.length || value.node_ids.every((id) => authority.nodes.has(id)));
      });
      const collection = z.string().optional().parse(parsed.collection);
      const id = z.string().optional().parse(parsed.id);
      const collections = z.array(z.string()).optional().parse(parsed.collections);
      const ids = z.array(z.string()).optional().parse(parsed.ids);
      const nodeIds = z.array(z.string()).optional().parse(parsed.node_ids);
      const related = (record) => {
        if (!nodeIds?.length) return true;
        const value = z.object({ node_ids: z.array(z.string()).optional(), source_id: z.string().optional(), target_id: z.string().optional() }).passthrough().safeParse(record.value);
        return value.success && [value.data.source_id, value.data.target_id, ...(value.data.node_ids ?? [])].some((nodeId) => nodeIds.includes(nodeId));
      };
      const selected = records.filter((record) => (!collection || record.collection === collection) && (!collections || collections.includes(record.collection))
        && (!id || record.id === id) && (!ids || ids.includes(record.id)) && (parsed.operation !== 'relations/list' || record.collection === 'relation') && related(record));
      const offset = z.number().int().nonnegative().optional().parse(parsed.offset) ?? 0;
      const limit = Math.min(z.number().int().positive().optional().parse(parsed.limit) ?? 100, 100);
      for (const record of selected.slice(offset, offset + limit)) {
        const value = sourceRecordSchema.parse(record.value);
        for (const id of value.node_ids ?? []) job.readNodeIds.add(id);
        for (const ref of [...(value.source_refs ?? []), ...(value.sourceRefs ?? [])]) job.readSourceRefs.set(JSON.stringify(ref), ref);
      }
      if (parsed.operation === 'relations/list') return { relations: selected.slice(offset, offset + limit).map((record) => record.value), total: selected.length };
      return { records: selected.slice(offset, offset + limit).map((record) => ({ id: record.id, collection: record.collection, value: record.value })), total: selected.length };
    },
  } });
  const invoke = async (method, input, scope) => {
    if (stopped) throw fail('hy_worker_stopped');
    if (isBlocked()) throw fail('enterprise_mode');
    const namespace = `${memoryNamespace(scope.projectId)}:core`;
    const jobId = `${method}:${scope.id}`;
    const ensured = ensureSpace ? await ensureSpace({ projectId: scope.projectId, signal: scope.signal }) : null;
    const savedSpace = (await readState()).engine.records.find((record) => record.projectId === scope.projectId && record.collection === 'model-space');
    const spaceId = ensured ? ensured.spaceId : savedSpace ? z.object({ spaceId: z.string() }).parse(savedSpace.value).spaceId : undefined;
    const context = { jobId, namespace, userId: namespace, agentId: 'superwagie', projectId: scope.projectId, sessionId: scope.sessionId, spaceId,
      sourceRevision: scope.sourceRevision ?? 0, sourceHash: scope.sourceHash ?? '', crossSessionMaintenance: method === 'consolidate' };
    if (scope.eligibleNodeIds) context.recallEligibleNodeIds = z.array(z.string()).parse(scope.eligibleNodeIds);
    if (scope.candidateNodeIds) context.recallCandidateNodeIds = z.array(z.string()).parse(scope.candidateNodeIds);
    if (scope.s2Offset !== undefined) context.s2Offset = scope.s2Offset;
    if (input.entries) context.approvedNodeIds = input.entries.map((entry) => entry.id);
    if (jobs.has(jobId)) throw fail('hy_job_running');
    jobs.set(jobId, { context, spaceId, readNodeIds: new Set(), readSourceRefs: new Map(), directory: scope.directory, providerID: scope.providerID, modelID: scope.modelID, signal: scope.signal });
    try {
      const result = { ...resultSchema.parse(await worker.call(method, { ...input, context }, { signal: scope.signal })), engine: 'hy-memory', namespace, spaceId: jobs.get(jobId).spaceId };
      if (ensured?.configurationId) result.configurationId = ensured.configurationId;
      return result;
    }
    finally { jobs.delete(jobId); }
  };
  const exclusive = (operation) => {
    waiting++;
    const work = queue.then(operation).finally(() => { waiting--; });
    queue = work.catch(() => {});
    return work;
  };
  return {
    organize: ({ segment, signal, sourceRevision }) => exclusive(() => invoke('organize', { segment, patches: segment.patches ?? [] }, { ...segment, signal, sourceRevision })),
    consolidate: ({ entries, directory, signal, ...options }) => exclusive(() => invoke('consolidate', { entries }, { id: createHash('sha256').update(JSON.stringify(entries.map((entry) => [entry.id, entry.sourceHash]))).digest('hex'),
      projectId: entries[0].projectId, sessionId: entries[0].sessionId, directory, signal, ...options })),
    recall: ({ query, directory, projectId, signal, eligibleNodeIds, candidateNodeIds }) => {
      if (waiting) return Promise.reject(fail('hy_engine_busy'));
      return exclusive(() => invoke('recall', { query }, { id: createHash('sha256').update(query).digest('hex'), projectId, sessionId: '', directory, signal, eligibleNodeIds, candidateNodeIds }));
    },
    status: worker.status,
    capabilities: worker.capabilities,
    stop: async () => { stopped = true; await worker.stop(); await queue; },
  };
}
