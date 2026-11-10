import { z } from 'zod';
import { memoryNamespace } from './organizer.js';
import { averageVectors, embedSegments, truncateUtf8 } from './embed-limit.js';

const embeddedSchema = z.object({ vectors: z.array(z.array(z.number().finite())), space_id: z.string().min(1), dimensions: z.number().int().positive() });
const nodeSchema = z.object({ id: z.string(), content: z.string(), payload: z.object({ title: z.string().optional(), entry_id: z.string().optional() }).passthrough(), score: z.number().optional() }).passthrough();
const hitsSchema = z.object({ nodes: z.array(nodeSchema) });
const fail = (code) => Object.assign(new Error(code), { code });

/** Typed memory nodes bypass document parsing and document-wide Wiki derivation. */
export function createMemoryProjection({ backend, legacyLibrary = null, ensureSpace = null }) {
  const namespace = (projectId) => `${memoryNamespace(projectId)}:cards`;
  const index = async ({ projectId, id, title, markdown }) => {
    await ensureSpace?.({ projectId });
    const texts = [];
    const whole = truncateUtf8(markdown);
    for (const segment of embedSegments(whole)) {
      const cut = truncateUtf8(segment);
      if (cut) texts.push(cut);
    }
    if (!texts.length) throw fail('embedding_input_empty');
    const vectors = [];
    let spaceId; let dimensions;
    // The account gateway accepts one text per request. Send eight segments
    // in parallel: measured stable against the local backend, and keeps a
    // multi-kilobyte card from taking minutes to index.
    for (let offset = 0; offset < texts.length; offset += 8) {
      const slice = texts.slice(offset, offset + 8);
      const results = await Promise.all(slice.map((segment) => backend('embed', { texts: [segment] }).then((value) => embeddedSchema.parse(value))));
      for (const result of results) {
        if (result.vectors.length !== 1) throw fail('embedding_dimension_mismatch');
        if (spaceId && spaceId !== result.space_id) throw fail('embedding_space_changed');
        spaceId = result.space_id; dimensions = result.dimensions;
        vectors.push(...result.vectors);
      }
    }
    const vector = averageVectors(vectors);
    if (vector.length !== dimensions) throw fail('embedding_dimension_mismatch');
    await backend('nodes/upsert', { namespace: namespace(projectId), space_id: spaceId,
      nodes: [{ id, content: markdown, vector, payload: { entry_id: id, project_id: projectId, title, representation: 'card' }, active: true }] });
    return { documentId: id, knowledgeId: id, state: 'ready' };
  };
  return {
    isReady: () => legacyLibrary?.isReady?.() ?? true,
    upsertManagedDocument: index,
    removeLegacyManagedDocument: (input) => legacyLibrary?.removeManagedDocument(input) ?? Promise.resolve({ removed: true }),
    async ensureManagedDocumentIndexed({ projectId, id }) {
      await ensureSpace?.({ projectId });
      const response = hitsSchema.parse(await backend('nodes/list', { namespace: namespace(projectId), filters: { node_ids: [id] }, limit: 1 }));
      if (!response.nodes.length) throw fail('memory_projection_missing');
      return { documentId: id, knowledgeId: id, state: 'ready' };
    },
    async removeManagedDocument({ projectId, id }) {
      await backend('nodes/delete', { namespace: namespace(projectId), ids: [id] });
      // Existing document-backed entries are removed through their original owner.
      if (legacyLibrary) await legacyLibrary.removeManagedDocument({ projectId, id });
      return { removed: true };
    },
    async searchManagedDocuments({ projectId, query, limit = 10, documentIds }) {
      const allowed = new Set(documentIds ?? []);
      if (!allowed.size) return { documents: [], passages: [] };
      let semantic = []; let availability = { state: 'ready', reason: null };
      const degrade = (cause) => {
        availability = { state: 'degraded', reason: /^[a-z][a-z0-9_:-]{0,79}$/.test(cause?.code ?? '') ? cause.code : 'semantic_unavailable' };
      };
      const ids = [...allowed];
      const readPartitions = async (options) => {
        const nodes = [];
        for (let offset = 0; offset < ids.length; offset += 256) {
          try {
            const response = hitsSchema.parse(await backend('nodes/search', { ...options, namespace: namespace(projectId),
              filters: { node_ids: ids.slice(offset, offset + 256) }, limit }));
            nodes.push(...response.nodes.filter((node) => allowed.has(node.id)));
          } catch (cause) { degrade(cause); }
        }
        const best = new Map();
        for (const node of nodes) if (!best.has(node.id) || (best.get(node.id).score ?? 0) < (node.score ?? 0)) best.set(node.id, node);
        return [...best.values()]
          .sort((left, right) => (right.score ?? 0) - (left.score ?? 0) || left.id.localeCompare(right.id)).slice(0, limit);
      };
      const lexical = await readPartitions({ query });
      try {
        await ensureSpace?.({ projectId });
        const embedded = embeddedSchema.parse(await backend('embed', { texts: [query], input_role: 'query' }));
        semantic = await readPartitions({ space_id: embedded.space_id, vector: embedded.vectors[0], min_score: 0.35 });
      } catch (cause) { degrade(cause); }
      const ordered = [...new Map([...lexical, ...semantic].map((node) => [node.id, node])).values()].slice(0, limit);
      return { documents: [], passages: ordered.map((node) => ({ documentId: node.id, title: node.payload.title ?? '', content: node.content, score: node.score ?? 1 })), availability };
    },
  };
}
