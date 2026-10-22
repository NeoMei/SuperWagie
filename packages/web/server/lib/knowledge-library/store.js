/**
 * Persistence for libraries and the document ledger.
 *
 * The server is the only writer. Both files are replaced atomically and writes
 * are serialized, so a UI mutation and an ingest transition never interleave
 * into a half-written file. A corrupt or missing file reads as empty: the
 * feature can rebuild from the filesystem, and a single bad write must not take
 * the routes down.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

import { isRecord } from '../shared/guards.js';

const FILE_VERSION = 1;

export function createKnowledgeLibraryStore({ dataDir, fsPromises = fsp, log = console } = {}) {
  if (!dataDir) throw new Error('knowledge library store requires a data directory');

  const dir = path.join(dataDir, 'knowledge-library');
  const librariesFile = path.join(dir, 'libraries.json');
  const documentsFile = path.join(dir, 'documents.json');

  const readJson = async (file, fallback) => {
    try {
      const parsed = JSON.parse(await fsPromises.readFile(file, 'utf8'));
      return isRecord(parsed) ? parsed : fallback;
    } catch (error) {
      if (error instanceof SyntaxError) {
        log.warn?.(`[KnowledgeLibrary] ignoring unreadable ${path.basename(file)}`);
        return fallback;
      }
      if (error?.code === 'ENOENT') return fallback;
      throw error;
    }
  };

  const writeJson = async (file, value) => {
    await fsPromises.mkdir(dir, { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await fsPromises.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    await fsPromises.rename(temporary, file);
  };

  let queue = Promise.resolve();
  const serialize = (work) => {
    const next = queue.then(work, work);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  return {
    directory: dir,

    async readLibraries() {
      const data = await readJson(librariesFile, { version: FILE_VERSION, libraries: [] });
      return Array.isArray(data.libraries) ? data.libraries : [];
    },

    writeLibraries(libraries) {
      return serialize(() => writeJson(librariesFile, { version: FILE_VERSION, libraries }));
    },

    async readDocuments() {
      const data = await readJson(documentsFile, { version: FILE_VERSION, documents: {} });
      return isRecord(data.documents) ? data.documents : {};
    },

    writeDocuments(documents) {
      return serialize(() => writeJson(documentsFile, { version: FILE_VERSION, documents }));
    },
  };
}
