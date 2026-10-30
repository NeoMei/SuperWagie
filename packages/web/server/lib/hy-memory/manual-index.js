import { createHash } from 'node:crypto';
import { z } from 'zod';
import { findThreatPattern } from '../agent-memory/threat-patterns.js';
import { memoryNamespace } from './organizer.js';

const manualSchema = z.object({ id: z.string().min(1), scope: z.enum(['global', 'project']), title: z.string().min(1),
  body: z.string().min(1), type: z.enum(['fact', 'preference', 'reference']), flagged: z.boolean().optional() });
const markerSchema = z.object({ version: z.literal(1), sourceHash: z.string(), spaceId: z.string().min(1), dimensions: z.number().int().positive(),
  configurationId: z.string().nullable(), state: z.enum(['pending', 'ready']) });
const embeddingSchema = z.object({ space_id: z.string().min(1), dimensions: z.number().int().positive(), vectors: z.array(z.array(z.number().finite())) });
const capabilitySchema = z.object({ max_batch: z.number().int().positive().optional(), embedding_configuration_id: z.string().min(1).optional() });
const hitsSchema = z.object({ nodes: z.array(z.object({ id: z.string(), score: z.number().finite().optional() }).passthrough()) });
const inputSchema = z.object({ projectId: z.string().min(1), limit: z.number().int().positive().max(100).optional() });
const fail = (code) => Object.assign(new Error(code), { code });
const namespace = (projectId) => `${memoryNamespace(projectId)}:manual`;
const hash = (entry) => createHash('sha256').update(JSON.stringify([entry.id, entry.scope, entry.type, entry.title, entry.body])).digest('hex');
const eligible = (state, projectId) => new Map(state.engine.records.filter((row) => row.collection === 'manual' && row.projectId === projectId).flatMap((row) => {
  const entry = manualSchema.parse(row.value);
  if (entry.id !== row.id || entry.scope !== (projectId === 'global' ? 'global' : 'project')) throw fail('manual_scope_mismatch');
  return entry.flagged || findThreatPattern(`${entry.title}\n${entry.body}`) ? [] : [[entry.id, { ...entry, sourceHash: hash(entry) }]];
}));
const markers = (state, projectId) => new Map(state.engine.records.filter((row) => row.collection === 'manual-index' && row.projectId === projectId)
  .map((row) => [row.id, markerSchema.parse(row.value)]));
const matches = (marker, entry, configurationId) => marker?.state === 'ready' && marker.sourceHash === entry?.sourceHash
  && (configurationId === null || marker.configurationId === configurationId);
const removeMarker = (state, projectId, id) => {
  state.engine.records = state.engine.records.filter((row) => row.collection !== 'manual-index' || row.projectId !== projectId || row.id !== id);
};
const saveMarker = (state, projectId, id, value) => {
  removeMarker(state, projectId, id); state.engine.records.push({ collection: 'manual-index', id, projectId, value });
};
const reason = (cause) => /^[a-z][a-z0-9_:-]{0,79}$/.test(cause?.code ?? '') ? cause.code : 'semantic_unavailable';
const embedded = (raw, count) => {
  const result = embeddingSchema.parse(raw);
  if (result.vectors.length !== count || result.vectors.some((vector) => vector.length !== result.dimensions)) throw fail('embedding_dimension_mismatch');
  return result;
};

/**
 * Owns semantic projection of explicit manual records into the shared backend.
 * Canonical records decide eligibility before top K and again after retrieval.
 * Per-scope namespaces preserve global/project identity. Ledger markers bind a
 * content hash, read-only model configuration identity and actual vector space.
 * Atomic stores publish vectors and ready markers together. Other stores retain
 * pending markers for failed-write cleanup. Flagged rows never enter indexing.
 * Sync bounds each paid batch and leaves S2's dirty-project marks untouched.
 * Search returns IDs and availability; its caller owns the lexical fallback.
 */
export function createManualMemoryIndex({ store, backend }) {
  let queue = Promise.resolve();
  const capabilities = async () => {
    const result = capabilitySchema.parse(await backend('capabilities', {}));
    return { configurationId: result.embedding_configuration_id ?? null, batch: Math.min(result.max_batch ?? 100, 100) };
  };
  const synchronize = async (input) => {
    const { projectId, limit = 32 } = inputSchema.parse(input);
    const before = await store.read(); const records = eligible(before, projectId); const previous = markers(before, projectId);
    if (!records.size && !previous.size) return { indexed: 0, deleted: 0, pending: 0 };
    const { configurationId, batch } = await capabilities();
    const work = [...new Set([...previous.keys(), ...records.keys()])].filter((id) => !records.has(id) || !matches(previous.get(id), records.get(id), configurationId));
    const selected = work.slice(0, Math.min(limit, batch));
    if (!selected.length) return { indexed: 0, deleted: 0, pending: 0 };
    const documents = selected.filter((id) => records.has(id));
    const vectors = documents.length ? embedded(await backend('embed', { texts: documents.map((id) => `${records.get(id).title}\n\n${records.get(id).body}`), input_role: 'document' }), documents.length) : null;
    const current = eligible(await store.read(), projectId);
    const accepted = selected.filter((id) => current.get(id)?.sourceHash === records.get(id)?.sourceHash);
    const operations = accepted.length ? [{ operation: 'nodes/delete', namespace: namespace(projectId), ids: accepted }] : [];
    const indexed = accepted.filter((id) => records.has(id));
    const next = new Map(indexed.map((id) => [id, { version: 1, sourceHash: records.get(id).sourceHash,
      spaceId: vectors.space_id, dimensions: vectors.dimensions, configurationId, state: 'ready' }]));
    if (indexed.length) operations.push({ operation: 'nodes/upsert', namespace: namespace(projectId), space_id: vectors.space_id,
      nodes: indexed.map((id) => { const entry = records.get(id); return { id, content: `${entry.title}\n\n${entry.body}`, vector: vectors.vectors[documents.indexOf(id)], active: true,
        payload: { entry_id: id, project_id: projectId, scope: entry.scope, manual_type: entry.type, title: entry.title,
          representation: 'manual', source_hash: entry.sourceHash, verification: 'unverified' } }; }) });
    const validate = (state) => {
      const latest = eligible(state, projectId);
      if (accepted.some((id) => latest.get(id)?.sourceHash !== records.get(id)?.sourceHash)) throw fail('manual_source_changed');
    };
    const commit = (state, pending = false) => {
      validate(state);
      for (const id of accepted) {
        if (next.has(id)) saveMarker(state, projectId, id, { ...next.get(id), state: pending ? 'pending' : 'ready' });
        else if (pending && previous.has(id)) saveMarker(state, projectId, id, { ...previous.get(id), state: 'pending' });
        else removeMarker(state, projectId, id);
      }
    };
    if (accepted.length) {
      if (store.atomicIndex) await store.update(commit, { indexOperations: operations });
      else {
        // A pending marker keeps orphan cleanup resumable if an index write or
        // the final ledger commit fails. Pending rows never enter retrieval.
        await store.update((state) => commit(state, true));
        for (const { operation, ...params } of operations) await backend(operation, params);
        await store.update(commit);
      }
    }
    const after = await store.read(); const remaining = eligible(after, projectId); const saved = markers(after, projectId);
    const pending = [...new Set([...remaining.keys(), ...saved.keys()])].filter((id) => !remaining.has(id) || !matches(saved.get(id), remaining.get(id), configurationId)).length;
    return { indexed: indexed.length, deleted: accepted.length - indexed.length, pending };
  };
  return {
    sync(input) {
      const work = queue.then(() => synchronize(input)); queue = work.catch(() => {}); return work;
    },
    async search({ projectId, query, limit = 10, includeGlobal = true }) {
      inputSchema.parse({ projectId, limit }); z.string().trim().min(1).max(16000).parse(query);
      const scopes = [...new Set([projectId, ...(includeGlobal ? ['global'] : [])])];
      try {
        const { configurationId, batch } = await capabilities(); const state = await store.read();
        const groups = scopes.map((scopeProject) => {
          const records = eligible(state, scopeProject); const saved = markers(state, scopeProject);
          return { projectId: scopeProject, records, saved, ids: [...records.keys()].filter((id) => matches(saved.get(id), records.get(id), configurationId)) };
        });
        const total = groups.reduce((sum, group) => sum + group.records.size, 0);
        if (!groups.some((group) => group.ids.length)) return { hits: [], availability: total ? { state: 'degraded', reason: 'manual_index_pending' } : { state: 'ready', reason: null } };
        const vector = embedded(await backend('embed', { texts: [query], input_role: 'query' }), 1);
        const candidates = [];
        for (const group of groups) {
          const allowed = group.ids.filter((id) => group.saved.get(id).spaceId === vector.space_id && group.saved.get(id).dimensions === vector.dimensions);
          // Every partition applies the canonical allowlist before backend top K.
          for (let offset = 0; offset < allowed.length; offset += batch) {
            const ids = allowed.slice(offset, offset + batch);
            const response = hitsSchema.parse(await backend('nodes/search', { namespace: namespace(group.projectId), space_id: vector.space_id,
              vector: vector.vectors[0], filters: { node_ids: ids }, limit: Math.min(limit, batch), min_score: 0.35 }));
            for (const hit of response.nodes) if (ids.includes(hit.id)) candidates.push({ id: hit.id, projectId: group.projectId,
              scope: group.projectId === 'global' ? 'global' : 'project', score: hit.score ?? 0, sourceHash: group.records.get(hit.id).sourceHash });
          }
        }
        const fresh = await store.read(); const current = new Map(scopes.map((scopeProject) => [scopeProject, eligible(fresh, scopeProject)]));
        const hits = candidates.filter((hit) => current.get(hit.projectId).get(hit.id)?.sourceHash === hit.sourceHash)
          .sort((left, right) => right.score - left.score || Number(left.scope === 'global') - Number(right.scope === 'global') || left.id.localeCompare(right.id))
          .slice(0, limit).map(({ sourceHash: _hash, ...hit }) => hit);
        const complete = groups.every((group) => group.ids.length === group.records.size && group.ids.every((id) => group.saved.get(id).spaceId === vector.space_id));
        return { hits, availability: complete ? { state: 'ready', reason: null } : { state: 'degraded', reason: 'manual_index_pending' } };
      } catch (cause) { return { hits: [], availability: { state: 'degraded', reason: reason(cause) } }; }
    },
  };
}
