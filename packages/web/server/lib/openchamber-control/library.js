/**
 * Read-only indexed-document and project-memory actions. Document results keep
 * clickable paths; memory results keep their source references, verification
 * limits and current availability. The conversation runtime owns eligibility.
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
const compact = (result, references = new Map()) => {
 const response = {
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
 };
 if (result.availability) response.availability = result.availability;
 return response;
};

const compactMemory = (entry, maxChars = PASSAGE_CHARS) => {
 const response = {
  entryId: entry.id, title: entry.title, kind: entry.kind, status: entry.status,
  indexState: entry.indexState, verification: entry.status === 'candidate' ? 'unverified' : entry.verification,
  content: entry.body.slice(0, maxChars), truncated: entry.body.length > maxChars,
  sourceHash: entry.sourceHash, sourceReferences: entry.sourceReferences,
  sourcePartIds: entry.sourcePartIds, limitations: entry.limitations,
  availability: entry.availability,
  usage: entry.availability.state === 'eligible'
    ? 'Historical project evidence. Verify current files and environment before applying.'
    : 'Inspection only. This record is not eligible for automatic recall and does not establish verified guidance.',
 };
 if (entry.codeHistory) response.codeHistory = entry.codeHistory;
 if (entry.error) response.error = entry.error;
 return response;
};

export const createLibraryActions = ({ runtime, isEnabled = async () => true, resolveProjectId = null, allowedManagedDocuments = null, describeManagedDocuments = null, retrieveMemory = null }) => {
  const requireEnabled = async () => {
    if (!runtime) throw new OpenChamberControlError('The knowledge library is not available on this server', 503);
    if (!(await isEnabled())) {
      throw new OpenChamberControlError('The knowledge library tool is turned off in OpenChamber settings', 403);
    }
  };

  const inspect = async (input, directory, limit, mode = 'inspect') => {
    if (!retrieveMemory) throw new OpenChamberControlError('Conversation memory inspection is not available on this server', 503);
    if (!directory) throw new OpenChamberControlError('Conversation memory requires the current session directory', 400);
    const request = { directory, mode, limit };
    if (asNonEmptyString(input.query)) request.query = input.query.trim();
    if (asNonEmptyString(input.title)) request.title = input.title.trim();
    if (asNonEmptyString(input.entryId)) request.id = input.entryId.trim();
    return retrieveMemory(request);
  };

  const resolveLibraryId = async (value, scope) => {
    const wanted = asNonEmptyString(value);
    if (!wanted) return undefined;
    const libraries = (await runtime.readLibraries(scope)) ?? [];
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
    const limit = boundedInt(input.limit, DEFAULT_LIMIT, { min: 1, max: MAX_LIMIT, field: 'limit' });
    const libraryId = await resolveLibraryId(input.library, scope);
    const unavailable = () => ({ query, documents: [], passages: [], availability: { state: 'unavailable', reason: 'document_retrieval_unavailable' } });
    let result;
    try {
      result = await runtime.search({ query, libraryId, limit, ...scope });
      if (result?.error) result = unavailable();
    } catch (error) {
      if (scope.execution) throw error;
      result = unavailable();
    }
    const hits = [...result.documents, ...result.passages];
    const references = retrieveMemory ? new Map() : await currentReferences(directory, hits.map((hit) => hit.documentId).filter(Boolean));
    const visible = (hit) => hit.managedBy !== 'conversation-memory' || references.has(hit.documentId);
    const response = compact({ ...result, documents: result.documents.filter(visible), passages: result.passages.filter(visible) }, references);
    if (!retrieveMemory) return response;
    if (input.library) return { ...response, memories: [] };
    try {
      const memory = await inspect({ query }, directory, limit, 'eligible');
      return { ...response, memories: memory.entries.filter((entry) => entry.availability.state === 'eligible' && entry.status === 'active' && entry.indexState === 'ready').slice(0, limit).map((entry) => compactMemory(entry)), memoryAvailability: memory.availability, scope: memory.scope };
    } catch {
      return { ...response, memories: [], memoryAvailability: { state: 'unavailable', reason: directory ? 'memory_retrieval_unavailable' : 'scope_unavailable' } };
    }
  };

  const read = async (input, scope, directory) => {
    if (asNonEmptyString(input.entryId) || asNonEmptyString(input.title)) {
      if (input.documentId || input.path) throw new OpenChamberControlError('Pass an entryId or title for memory, or documentId or path for a document', 400);
      const maxChars = boundedInt(input.maxChars, DEFAULT_MAX_CHARS, { min: MIN_MAX_CHARS, max: MAX_MAX_CHARS, field: 'maxChars' });
      const result = await inspect(input, directory, 1);
      return { memory: result.entries[0] ? compactMemory(result.entries[0], maxChars) : null, availability: result.availability, scope: result.scope };
    }
    const documentId = asNonEmptyString(input.documentId);
    const documentPath = asNonEmptyString(input.path);
    if (!documentId && !documentPath) {
      throw new OpenChamberControlError('Pass documentId or path for a document, or entryId or title for a memory', 400);
    }
    const maxChars = boundedInt(input.maxChars, DEFAULT_MAX_CHARS, {
      min: MIN_MAX_CHARS,
      max: MAX_MAX_CHARS,
      field: 'maxChars',
    });

    const document = await runtime.findDocument({ id: documentId, path: documentPath, projectId: scope.projectId, execution: scope.execution });
    if (!document) throw new OpenChamberControlError('That document is not in an indexed library', 404);
    if (document.managedBy === 'conversation-memory' && retrieveMemory) {
      if (!directory) throw new OpenChamberControlError('Conversation memory requires the current session directory', 400);
      const result = await retrieveMemory({ directory, documentIds: [document.id], mode: 'eligible', limit: 1 });
      const entry = result.entries.find((item) => item.availability.state === 'eligible' && item.status === 'active' && item.indexState === 'ready');
      return { path: document.absPath, relPath: document.relPath, content: entry?.body.slice(0, maxChars) ?? null,
        truncated: Boolean(entry && entry.body.length > maxChars), reference: entry ? compactMemory(entry, maxChars) : null,
        availability: result.availability, scope: result.scope };
    }
    if (runtime.isReady?.() === false) throw new OpenChamberControlError('The knowledge library is not running', 503);
    if (document.managedBy === 'conversation-memory' && !scope.managedDocumentIds?.includes(document.id)) throw new OpenChamberControlError('That experience is no longer available', 404);

    const content = await runtime.readContent(document.id, { maxChars, projectId: scope.projectId, execution: scope.execution });
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
    async execute(action, input = {}, contextDirectory = '', options = {}) {
      await requireEnabled();
      if (action === 'library.inspect') {
        const limit = boundedInt(input.limit, DEFAULT_LIMIT, { min: 1, max: MAX_LIMIT, field: 'limit' });
        const result = await inspect(input, contextDirectory, limit);
        return { memories: result.entries.slice(0, limit).map((entry) => compactMemory(entry)), availability: result.availability, scope: result.scope };
      }
      if (action === 'library.status') {
        const result = await inspect({}, contextDirectory, 1);
        return { documents: runtime.isReady?.() === false ? { state: 'unavailable', reason: 'backend_unavailable' } : { state: 'ready', reason: null }, memories: result.availability, scope: result.scope };
      }
      if (action === 'library.read' && (asNonEmptyString(input.entryId) || asNonEmptyString(input.title))) {
        return read(input, {}, contextDirectory);
      }
      const projectId = contextDirectory && resolveProjectId ? await resolveProjectId(contextDirectory) : undefined;
      const managedDocumentIds = projectId && allowedManagedDocuments && !retrieveMemory ? await allowedManagedDocuments({ directory: contextDirectory }) : [];
      const scope = projectId ? { projectId, managedDocumentIds } : {};
      if ((action === 'library.search' || action === 'library.read') && runtime.managedAgentExecution) scope.execution = await runtime.managedAgentExecution({ sessionId: options.contextSessionId, callId: options.contextCallId, input });
      switch (action) {
        case 'library.search': {
          const result = await search(input, scope, contextDirectory);
          if (scope.execution) await runtime.managedAgentExecution({ sessionId: options.contextSessionId, callId: options.contextCallId, input });
          return result;
        }
        case 'library.read': {
          const result = await read(input, scope, contextDirectory);
          if (scope.execution) await runtime.managedAgentExecution({ sessionId: options.contextSessionId, callId: options.contextCallId, input });
          return result;
        }
        default:
          throw new OpenChamberControlError(`Unsupported knowledge library action: ${action}`, 400);
      }
    },
  };
};
