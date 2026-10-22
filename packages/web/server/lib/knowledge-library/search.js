/**
 * Search: one query in, two answers out.
 *
 * The file-name side runs over the ledger, not the backend: it is instant, it
 * works while the backend is down, and the backend's own keyword filter only
 * matches titles of documents it has finished indexing. The passage side is the
 * backend's hybrid search, scoped to a library by the knowledge ids the ledger
 * already knows.
 *
 * Only documents in the `ready` state are ever returned: a record that is still
 * parsing has no reliable passages, and showing it invites citations the user
 * cannot open.
 */

import { z } from 'zod';

const MAX_PASSAGE_CHARS = 1200;
const MAX_DOCUMENTS = 20;

const hitSchema = z.object({
  knowledge_id: z.string().optional(),
  content: z.string().optional(),
  score: z.number().optional(),
  chunk_index: z.number().optional(),
  start_at: z.number().optional(),
  end_at: z.number().optional(),
});

const baseName = (relPath) => relPath.slice(relPath.lastIndexOf('/') + 1);

const normalize = (value) => value.toLowerCase();

const rankName = (relPath, query) => {
  const name = normalize(baseName(relPath));
  const needle = normalize(query);
  if (name === needle) return 0;
  if (name.startsWith(needle)) return 1;
  if (name.includes(needle)) return 2;
  if (normalize(relPath).includes(needle)) return 3;
  return -1;
};

const trimPassage = (content) =>
  content.length > MAX_PASSAGE_CHARS ? `${content.slice(0, MAX_PASSAGE_CHARS)}…` : content;

export function createSearch({ client, store, getKnowledgeBaseId, maxDocuments = MAX_DOCUMENTS }) {
  if (!client || !store) throw new Error('search requires a client and a store');

  const toDocument = (document, matched) => ({
    documentId: document.id,
    title: baseName(document.relPath),
    path: document.absPath,
    relPath: document.relPath,
    libraryId: document.libraryId,
    fileType: baseName(document.relPath).split('.').pop()?.toLowerCase() ?? '',
    size: document.size ?? 0,
    parseStatus: document.parseStatus ?? 'completed',
    matched,
  });

  return {
    async search({ query, libraryId, limit = 8 } = {}) {
      const parsedQuery = z.string().safeParse(query);
      const trimmed = parsedQuery.success ? parsedQuery.data.trim() : '';
      if (!trimmed) return { query: '', documents: [], passages: [] };

      const documents = Object.values(await store.readDocuments());
      const ready = documents.filter((document) => document.state === 'ready' && document.knowledgeId);
      const scoped = libraryId ? ready.filter((document) => document.libraryId === libraryId) : ready;

      const nameMatches = documents
        .filter((document) => document.state === 'ready')
        .filter((document) => !libraryId || document.libraryId === libraryId)
        .map((document) => ({ document, rank: rankName(document.relPath, trimmed) }))
        .filter((entry) => entry.rank >= 0)
        .sort(
          (left, right) =>
            left.rank - right.rank ||
            left.document.relPath.length - right.document.relPath.length ||
            left.document.relPath.localeCompare(right.document.relPath),
        )
        .slice(0, maxDocuments)
        .map((entry) => toDocument(entry.document, 'name'));

      if (scoped.length === 0) return { query: trimmed, documents: nameMatches, passages: [] };

      const hits = await client.hybridSearch({
        knowledgeBaseId: getKnowledgeBaseId(),
        queryText: trimmed,
        matchCount: limit,
        knowledgeIds: libraryId ? scoped.map((document) => document.knowledgeId) : undefined,
      });

      const byKnowledgeId = new Map(ready.map((document) => [document.knowledgeId, document]));
      const passages = [];
      for (const hit of hits) {
        const parsedHit = hitSchema.safeParse(hit);
        if (!parsedHit.success) continue;
        const data = parsedHit.data;
        const document = byKnowledgeId.get(data.knowledge_id);
        if (!document) continue;
        passages.push({
          documentId: document.id,
          title: baseName(document.relPath),
          path: document.absPath,
          relPath: document.relPath,
          libraryId: document.libraryId,
          content: trimPassage(data.content ?? ''),
          score: data.score ?? 0,
          chunkIndex: data.chunk_index ?? 0,
          startAt: data.start_at ?? 0,
          endAt: data.end_at ?? 0,
        });
        if (passages.length >= limit) break;
      }

      return { query: trimmed, documents: nameMatches, passages };
    },
  };
}
