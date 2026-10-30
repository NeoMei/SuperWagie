import { z } from 'zod';
import { sanitizeMemoryText } from '../conversation-memory/reader.js';

const responseSchema = z.object({
  nodes: z.array(z.object({ id: z.string() }).passthrough()).max(100),
  history: z.object({ records: z.array(z.object({
    id: z.string(), project_id: z.string(), session_id: z.string(), message_id: z.string(),
    part_id: z.string().nullish(), source_hash: z.string(), node_ids: z.array(z.string()),
    file: z.string().optional(), symbol: z.string().optional(), patch: z.string(),
  }).passthrough()).max(100) }).optional(),
}).passthrough();

/** Core hits supply rank and history only for cards already eligible in the ledger. */
export async function readHyRecall({ organizer, directory, projectId, query, entries, state = null, timeoutMs = 1500 }) {
  const controller = new AbortController();
  let timer;
  try {
    const eligibleNodeIds = entries.map((entry) => entry.id);
    const candidates = new Set(eligibleNodeIds);
    const edgeSchema = z.object({ source_id: z.string(), target_id: z.string(), relation_type: z.string(),
      properties: z.object({ relation_type: z.string().optional() }).passthrough().optional() }).passthrough();
    const edges = (state?.engine.records ?? []).filter((row) => row.projectId === projectId && row.collection === 'relation').map((row) => edgeSchema.parse(row.value));
    let expanded = true;
    while (expanded) {
      const size = candidates.size;
      for (const edge of edges) {
        if (['EXPERIENCE_KEY', 'SCHEMA_BEHAVIOR'].includes(edge.relation_type) && candidates.has(edge.source_id)) candidates.add(edge.target_id);
        if (edge.relation_type === 'DERIVED_FROM' && candidates.has(edge.source_id)) candidates.add(edge.target_id);
        if ((edge.relation_type === 'FACT_SUPERSEDES' || edge.relation_type === 'RELATED_TO' && edge.properties?.relation_type === 'schema_revision')
          && (candidates.has(edge.source_id) || candidates.has(edge.target_id))) { candidates.add(edge.source_id); candidates.add(edge.target_id); }
      }
      expanded = candidates.size !== size;
    }
    const response = responseSchema.parse(await Promise.race([
      organizer.recall({ directory, projectId, query, signal: controller.signal, eligibleNodeIds, candidateNodeIds: [...candidates] }),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error('Hy recall timed out'), { code: 'hy_recall_timeout' })); }, timeoutMs); timer.unref?.(); }),
    ]));
    const allowed = new Map(entries.map((entry) => [entry.id, entry]));
    const ids = [...new Set(response.nodes.map((node) => node.id).filter((id) => allowed.has(id)))];
    const history = new Map();
    for (const id of ids) {
      const entry = allowed.get(id);
      const records = (response.history?.records ?? []).filter((row) => row.project_id === projectId && row.node_ids.includes(id)
        && row.source_hash === entry.sourceHash && entry.sourceReferences.some((ref) => ref.sessionId === row.session_id && ref.messageId === row.message_id)
        && (!row.part_id || entry.sourcePartIds.includes(row.part_id))).slice(0, 4);
      if (records.length) history.set(id, records.map((row) => {
        const reference = { id: row.id, file: row.file ?? '', symbol: row.symbol ?? '',
          patch: sanitizeMemoryText(row.patch).slice(0, 4000), sessionId: row.session_id, messageId: row.message_id, sourceHash: row.source_hash,
          limitation: 'Historical patch. Verify the current file and version before applying it.' };
        if (row.part_id) reference.partId = row.part_id;
        return reference;
      }));
    }
    return { ids, history, availability: { state: 'ready', reason: null } };
  } catch (error) {
    return { ids: [], history: new Map(), availability: { state: 'degraded', reason: /^[a-z][a-z0-9_:-]{0,79}$/.test(error?.code ?? '') ? error.code : 'hy_recall_unavailable' } };
  } finally { clearTimeout(timer); }
}
