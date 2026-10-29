/**
 * The `openchamber_library` actions over the indexed local folders.
 *
 * Read-only by design: registration and change detection belong to the folder
 * sync, never to an agent. Results are compacted for a model — every entry
 * keeps its absolute path, because that is what makes the chat's file
 * references clickable, while passage text is trimmed before it reaches the
 * context window.
 */

import { asNonEmptyString } from '../shared/guards.js';
import { OpenChamberControlError } from './error.js';

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
const MAX_DOCUMENTS = 10;
const MAX_PASSAGES = 5;
const PASSAGE_CHARS = 600;
const DEFAULT_MAX_CHARS = 20_000;
const MIN_MAX_CHARS = 1_000;
const MAX_MAX_CHARS = 200_000;

const boundedInt = (value, fallback, { min, max, field }) => {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new OpenChamberControlError(`${field} must be an integer from ${min} to ${max}`, 400);
  }
  return number;
};

const withReference = (value, documentId, references) => {
  if (references.has(documentId)) value.reference = references.get(documentId);
  return value;
};
const compact = (result, references = new Map()) => ({
  query: result.query,
  documents: result.documents.slice(0, MAX_DOCUMENTS).map((document) => withReference({
    path: document.path,
    title: document.title,
    relPath: document.relPath,
    libraryId: document.libraryId,
  }, document.documentId, references)),
  passages: result.passages.slice(0, MAX_PASSAGES).map((passage) => withReference({
    path: passage.path,
    title: passage.title,
    content: passage.content.length > PASSAGE_CHARS ? `${passage.content.slice(0, PASSAGE_CHARS)}…` : passage.content,
    startAt: passage.startAt,
    endAt: passage.endAt,
  }, passage.documentId, references)),
});

export const createLibraryActions = ({ runtime, isEnabled = async () => true, resolveProjectId = null, allowedManagedDocuments = null, describeManagedDocuments = null }) => {
  const requireReady = async () => {
    if (!runtime) throw new OpenChamberControlError('The knowledge library is not available on this server', 503);
    if (!(await isEnabled())) {
      throw new OpenChamberControlError('The knowledge library tool is turned off in OpenChamber settings', 403);
    }
    if (runtime.isReady?.() === false) {
      throw new OpenChamberControlError('The knowledge library is not running', 503);
    }
  };

  const resolveLibraryId = async (value, projectId) => {
    const wanted = asNonEmptyString(value);
    if (!wanted) return undefined;
    const libraries = (await runtime.readLibraries({ projectId })) ?? [];
    const match =
      libraries.find((library) => library.id === wanted) ??
      libraries.find((library) => library.name === wanted) ??
      libraries.find((library) => library.slug === wanted);
    if (!match) throw new OpenChamberControlError(`Library not found: ${wanted}`, 404);
    return match.id;
  };

  const currentReferences = async (directory, documentIds) => {
    if (!directory || !describeManagedDocuments) return new Map();
    const entries = await describeManagedDocuments({ directory, documentIds });
    return new Map(entries.map((entry) => [entry.documentId, {
      documentId: entry.documentId, kind: entry.kind, verification: entry.verification,
      sourceHash: entry.sourceHash, sourceReferences: entry.sourceReferences,
      sourcePartIds: entry.sourcePartIds, limitations: entry.limitations,
      usage: 'Historical project evidence. Verify current files and environment before applying.',
    }]));
  };
  const search = async (input, scope, directory) => {
    const query = asNonEmptyString(input.query);
    if (!query) throw new OpenChamberControlError('query must be a non-empty string', 400);
    const result = await runtime.search({
      query,
      libraryId: await resolveLibraryId(input.library, scope.projectId),
      limit: boundedInt(input.limit, DEFAULT_LIMIT, { min: 1, max: MAX_LIMIT, field: 'limit' }),
      ...scope,
    });
    if (result?.error) throw new OpenChamberControlError('The knowledge library is not available', 503);
    const hits = [...result.documents, ...result.passages];
    const references = await currentReferences(directory, hits.map((hit) => hit.documentId).filter(Boolean));
    const visible = (hit) => hit.managedBy !== 'conversation-memory' || references.has(hit.documentId);
    return compact({ ...result, documents: result.documents.filter(visible), passages: result.passages.filter(visible) }, references);
  };

  const read = async (input, scope, directory) => {
    const documentId = asNonEmptyString(input.documentId);
    const documentPath = asNonEmptyString(input.path);
    if (!documentId && !documentPath) {
      throw new OpenChamberControlError('Pass documentId or path from a search result', 400);
    }
    const maxChars = boundedInt(input.maxChars, DEFAULT_MAX_CHARS, {
      min: MIN_MAX_CHARS,
      max: MAX_MAX_CHARS,
      field: 'maxChars',
    });

    const document = await runtime.findDocument({ id: documentId, path: documentPath, projectId: scope.projectId });
    if (!document) throw new OpenChamberControlError('That document is not in an indexed library', 404);
    if (document.managedBy === 'conversation-memory' && !scope.managedDocumentIds?.includes(document.id)) throw new OpenChamberControlError('That experience is no longer available', 404);

    const content = await runtime.readContent(document.id, { maxChars, projectId: scope.projectId });
    if (content?.error === 'not_indexed') {
      throw new OpenChamberControlError('That document has not finished indexing', 409);
    }
    if (content?.error) throw new OpenChamberControlError('The knowledge library is not available', 503);

    const references = document.managedBy === 'conversation-memory' ? await currentReferences(directory, [document.id]) : new Map();
    if (document.managedBy === 'conversation-memory' && !references.has(document.id)) throw new OpenChamberControlError('That experience is no longer available', 404);
    return withReference({
      path: document.absPath,
      relPath: document.relPath,
      content: content.content,
      truncated: content.truncated,
    }, document.id, references);
  };

  return {
    async execute(action, input = {}, contextDirectory = '') {
      await requireReady();
      const projectId = contextDirectory && resolveProjectId ? await resolveProjectId(contextDirectory) : undefined;
      const managedDocumentIds = projectId && allowedManagedDocuments ? await allowedManagedDocuments({ directory: contextDirectory }) : [];
      const scope = projectId ? { projectId, managedDocumentIds } : {};
      switch (action) {
        case 'library.search':
          return search(input, scope, contextDirectory);
        case 'library.read':
          return read(input, scope, contextDirectory);
        default:
          throw new OpenChamberControlError(`Unsupported knowledge library action: ${action}`, 400);
      }
    },
  };
};
