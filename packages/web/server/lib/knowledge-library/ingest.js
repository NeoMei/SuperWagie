/**
 * Ingest: turn a queued document into a parsed knowledge record, and keep the
 * record in step with the file.
 *
 * The backend indexes a file where it lives (reference ingest), so registering
 * a document sends only its path — no bytes, no copy. A content change reparses
 * the same record: the knowledge id survives, citations stay valid, and nothing
 * is deleted first.
 *
 * One pass does at most `concurrency` registrations and one poll per document
 * that is already parsing; the runtime decides how often to call it. Every
 * transition is written to the ledger before the next side effect, so a crash
 * leaves a state the next pass can reason about instead of a silent gap.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';

import { z } from 'zod';

import { MAX_FILE_BYTES } from './scan.js';

const baseName = (relPath) => relPath.slice(relPath.lastIndexOf('/') + 1);

const directoryOf = (relPath) => {
  const slash = relPath.lastIndexOf('/');
  return slash === -1 ? '' : relPath.slice(0, slash);
};

const isParseComplete = (knowledge) =>
  knowledge?.parse_status === 'completed' && !knowledge?.pending_subtasks_count;

const errorCode = z.string();
const errorMessage = z.string();

const errorOf = (error) => {
  const code = errorCode.safeParse(error?.code);
  const message = errorMessage.safeParse(error?.message);
  return {
    code: code.success ? code.data : 'ingest_failed',
    message: message.success ? message.data.slice(0, 500) : undefined,
  };
};

const hashFile = (absPath) =>
  new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(absPath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });

export function createIngestQueue({
  client,
  store,
  getLibraries,
  onDocumentChange = () => {},
  fsPromises = fsp,
  concurrency = 2,
  now = () => Date.now(),
  maxParseMs = 15 * 60 * 1000,
  autoPollUploads = true,
} = {}) {
  let running = null;

  const libraryOf = (document, libraries) => libraries.find((library) => library.id === document.libraryId) ?? null;

  const commit = async (documents, document) => {
    document.updatedAt = now();
    await store.writeDocuments(documents);
    try {
      onDocumentChange(document);
    } catch {
      /* a listener must not fail an ingest */
    }
  };

  const markFailed = async (documents, document, error) => {
    document.state = 'failed';
    document.lastError = errorOf(error);
    document.attempts = (document.attempts ?? 0) + 1;
    await commit(documents, document);
  };

  const poll = async (documents, document) => {
    if (!document.knowledgeId) {
      await markFailed(documents, document, { code: 'knowledge_missing', message: 'No knowledge record to poll' });
      return 'failed';
    }

    let knowledge;
    try {
      knowledge = await client.getKnowledge(document.knowledgeId);
    } catch (error) {
      if (error?.code === 'not_found') {
        document.knowledgeId = null;
        document.state = 'queued';
        await commit(documents, document);
        return 'requeued';
      }
      await markFailed(documents, document, error);
      return 'failed';
    }

    if (isParseComplete(knowledge)) {
      document.state = 'ready';
      document.parseStatus = 'completed';
      document.lastError = undefined;
      await commit(documents, document);
      return 'ready';
    }

    if (knowledge?.parse_status === 'failed') {
      document.state = 'failed';
      document.parseStatus = 'failed';
      const parseMessage = z.string().safeParse(knowledge.error_message);
      document.lastError = {
        code: 'parse_failed',
        message: parseMessage.success && parseMessage.data ? parseMessage.data.slice(0, 500) : undefined,
      };
      await commit(documents, document);
      return 'failed';
    }

    document.parseStatus = 'processing';
    if (document.uploadedAt && now() - document.uploadedAt > maxParseMs) {
      document.state = 'failed';
      document.lastError = { code: 'parse_timeout' };
      await commit(documents, document);
      return 'failed';
    }

    await commit(documents, document);
    return 'parsing';
  };

  const register = async (documents, document, libraries) => {
    if ((document.size ?? 0) > MAX_FILE_BYTES) {
      document.state = 'skipped';
      document.lastError = { code: 'too_large' };
      await commit(documents, document);
      return 'skipped';
    }

    const library = libraryOf(document, libraries);
    if (!library) {
      await markFailed(documents, document, { code: 'library_missing', message: 'The library is no longer registered' });
      return 'failed';
    }

    let sha256;
    try {
      sha256 = await hashFile(document.absPath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        document.state = 'missing';
        await commit(documents, document);
        return 'missing';
      }
      await markFailed(documents, document, error);
      return 'failed';
    }

    if (document.knowledgeId && document.sha256 === sha256) {
      document.state = 'ready';
      document.lastError = undefined;
      await commit(documents, document);
      return 'unchanged';
    }

    const folder = [library.slug, directoryOf(document.relPath)].filter(Boolean).join('/');

    const callBackend = async () => {
      if (document.knowledgeId) {
        // Changed content: reparse in place, keeping the knowledge id.
        await client.reparseKnowledge(document.knowledgeId);
        return;
      }
      const created = await client.registerReference({
        knowledgeBaseId: library.knowledgeBaseId,
        path: document.absPath,
        title: baseName(document.relPath),
        folderPath: folder,
        metadata: {
          sw_document_id: document.id,
          sw_library_id: document.libraryId,
          sw_rel_path: document.relPath,
          sw_sha256: sha256,
        },
      });
      if (!created?.id) {
        throw Object.assign(new Error('The backend created no knowledge record'), { code: 'register_no_id' });
      }
      document.knowledgeId = created.id;
    };

    try {
      await callBackend();
    } catch (error) {
      // The backend no longer has the record (deleted elsewhere, or a rebuilt
      // knowledge base). Register it again instead of failing forever.
      if (document.knowledgeId && error?.code === 'not_found') {
        document.knowledgeId = null;
        try {
          await callBackend();
        } catch (retryError) {
          await markFailed(documents, document, retryError);
          return 'failed';
        }
      } else {
        await markFailed(documents, document, error);
        return 'failed';
      }
    }

    document.sha256 = sha256;
    document.state = 'parsing';
    document.parseStatus = 'pending';
    document.uploadedAt = now();
    document.lastError = undefined;
    await commit(documents, document);

    return autoPollUploads ? poll(documents, document) : 'parsing';
  };

  const runPass = async () => {
    const documents = await store.readDocuments();
    const libraries = (await getLibraries()) ?? [];
    const result = { registered: 0, completed: 0, failed: 0, skipped: 0 };

    const registrable = Object.values(documents).filter((document) => document.state === 'queued');
    const polling = Object.values(documents).filter((document) => document.state === 'parsing');

    for (let index = 0; index < registrable.length; index += concurrency) {
      const batch = registrable.slice(index, index + concurrency);
      const outcomes = await Promise.all(batch.map((document) => register(documents, document, libraries)));
      for (const outcome of outcomes) {
        if (outcome === 'failed') result.failed += 1;
        if (outcome === 'skipped' || outcome === 'missing') result.skipped += 1;
        if (outcome === 'ready') result.completed += 1;
        if (outcome === 'parsing' || outcome === 'unchanged') result.registered += 1;
      }
    }

    for (const document of polling) {
      const outcome = await poll(documents, document);
      if (outcome === 'ready') result.completed += 1;
      if (outcome === 'failed') result.failed += 1;
      if (outcome === 'requeued') result.registered += 1;
    }

    return result;
  };

  return {
    processOnce() {
      if (running) return running;
      running = runPass().finally(() => {
        running = null;
      });
      return running;
    },

    async getStats() {
      const documents = Object.values(await store.readDocuments());
      const stats = { queued: 0, parsing: 0, ready: 0, failed: 0, skipped: 0, missing: 0 };
      for (const document of documents) {
        if (document.state in stats) stats[document.state] += 1;
      }
      return stats;
    },
  };
}
