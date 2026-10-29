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

  const toDocument = (document, matched) => {
    const result = {
    documentId: document.id,
    title: document.title ?? baseName(document.relPath),
    path: document.absPath,
    relPath: document.relPath,
    libraryId: document.libraryId,
    fileType: baseName(document.relPath).split('.').pop()?.toLowerCase() ?? '',
    size: document.size ?? 0,
    parseStatus: document.parseStatus ?? 'completed',
    matched,
    };
    if (document.managedBy) result.managedBy = document.managedBy;
    return result;
  };

  return {
    async search({ query, libraryId, projectId, documentIds, managedDocumentIds, managedOnly = false, limit = 8 } = {}) {
      const parsedQuery = z.string().safeParse(query);
      const trimmed = parsedQuery.success ? parsedQuery.data.trim() : '';
      if (!trimmed) return { query: '', documents: [], passages: [] };

      const documents = Object.values(await store.readDocuments());
      const libraries = await store.readLibraries?.() ?? [];
      const byLibraryId = new Map(libraries.map((library) => [library.id, library]));
      const selectedIds = documentIds ? new Set(documentIds) : null;
      const activeManagedIds = managedDocumentIds ? new Set(managedDocumentIds) : null;
      const inScope = (document) => {
        const library = byLibraryId.get(document.libraryId);
        const managed = library?.managedBy === 'conversation-memory' || document.managedBy === 'conversation-memory';
        if (managed && (!projectId || (library?.projectId ?? document.projectId) !== projectId)) return false;
        if (managed && activeManagedIds && !activeManagedIds.has(document.id)) return false;
        if (managedOnly && !managed) return false;
        return (!libraryId || document.libraryId === libraryId) && (!selectedIds || selectedIds.has(document.id));
      };
      const scopedDocuments = documents.filter(inScope);
      const scoped = scopedDocuments.filter((document) => document.state === 'ready' && document.knowledgeId);

      const nameMatches = scopedDocuments
        .filter((document) => document.state === 'ready')
        .map((document) => ({ document, rank: rankName(document.title ?? document.relPath, trimmed) }))
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
        knowledgeIds: libraryId || projectId || documentIds || managedDocumentIds || managedOnly || libraries.some((library) => library.managedBy === 'conversation-memory') || documents.some((document) => document.managedBy === 'conversation-memory')
          ? scoped.map((document) => document.knowledgeId) : undefined,
      });

      const byKnowledgeId = new Map(scoped.map((document) => [document.knowledgeId, document]));
      const passages = [];
      for (const hit of hits) {
        const parsedHit = hitSchema.safeParse(hit);
        if (!parsedHit.success) continue;
        const data = parsedHit.data;
        const document = byKnowledgeId.get(data.knowledge_id);
        if (!document) continue;
        const passage = {
          documentId: document.id,
          title: document.title ?? baseName(document.relPath),
          path: document.absPath,
          relPath: document.relPath,
          libraryId: document.libraryId,
          content: trimPassage(data.content ?? ''),
          score: data.score ?? 0,
          chunkIndex: data.chunk_index ?? 0,
          startAt: data.start_at ?? 0,
          endAt: data.end_at ?? 0,
        };
        if (document.managedBy) passage.managedBy = document.managedBy;
        passages.push(passage);
        if (passages.length >= limit) break;
      }

      return { query: trimmed, documents: nameMatches, passages };
    },
  };
}
