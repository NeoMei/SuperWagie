import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createIngestQueue } from './ingest.js';
import { MAX_FILE_BYTES } from './scan.js';

const tempDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'sw-ingest-'));

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

const createMemoryStore = (documents) => {
  const state = { documents: structuredClone(documents) };
  return {
    readDocuments: async () => structuredClone(state.documents),
    writeDocuments: async (next) => {
      state.documents = structuredClone(next);
    },
    document: (id) => state.documents[id],
    all: () => state.documents,
  };
};

const createClient = ({ knowledge } = {}) => {
  let counter = 0;
  const registers = [];
  const reparses = [];
  const deletes = [];
  return {
    registers,
    reparses,
    deletes,
    registerReference: async (input) => {
      registers.push(input);
      counter += 1;
      return { id: `k${counter}`, parse_status: 'pending' };
    },
    reparseKnowledge: async (id) => {
      reparses.push(id);
      return { success: true };
    },
    deleteKnowledge: async (id) => {
      deletes.push(id);
      return { success: true };
    },
    getKnowledge: async (id) => knowledge ?? { id, parse_status: 'completed', pending_subtasks_count: 0 },
  };
};

const setup = async ({ content = 'first', knowledge, size, relPath = 'sub/a.md' } = {}) => {
  const root = await tempDir();
  const absPath = path.join(root, ...relPath.split('/'));
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, content);
  const documents = {
    d1: {
      id: 'd1',
      libraryId: 'l1',
      relPath,
      absPath,
      size: size ?? (await fs.stat(absPath)).size,
      state: 'queued',
      attempts: 0,
    },
  };
  const store = createMemoryStore(documents);
  const client = createClient({ knowledge });
  const queue = createIngestQueue({
    client,
    store,
    getLibraries: () => [{ id: 'l1', slug: 'lib', knowledgeBaseId: 'kb1' }],
  });
  return { root, absPath, store, client, queue };
};

describe('ingest queue (reference mode)', () => {
  it('registers the absolute path and folder without sending bytes', async () => {
    const { absPath, store, client, queue } = await setup();

    const result = await queue.processOnce();

    expect(result.completed).toBe(1);
    expect(client.registers).toHaveLength(1);
    const call = client.registers[0];
    expect(call).toMatchObject({
      knowledgeBaseId: 'kb1',
      path: absPath,
      title: 'a.md',
      folderPath: 'lib/sub',
    });
    expect(call.path.startsWith('/')).toBe(true);
    expect(call).not.toHaveProperty('bytes');
    expect(call.metadata).toMatchObject({ sw_document_id: 'd1', sw_library_id: 'l1', sw_rel_path: 'sub/a.md' });
    expect(call.metadata.sw_sha256).toBe(sha256('first'));
    expect(store.document('d1')).toMatchObject({ state: 'ready', knowledgeId: 'k1', parseStatus: 'completed' });
  });

  it('reparses the same knowledge record when the content changes', async () => {
    const { absPath, store, client, queue } = await setup();
    await queue.processOnce();
    expect(store.document('d1').knowledgeId).toBe('k1');

    await fs.writeFile(absPath, 'second');
    const documents = store.all();
    documents.d1.state = 'queued';
    await store.writeDocuments(documents);

    await queue.processOnce();

    expect(client.reparses).toEqual(['k1']);
    expect(client.registers).toHaveLength(1);
    expect(client.deletes).toEqual([]);
    expect(store.document('d1')).toMatchObject({ state: 'ready', knowledgeId: 'k1' });
  });

  it('registers again when the backend no longer has the record', async () => {
    const { absPath, store, client, queue } = await setup();
    await queue.processOnce();
    client.reparseKnowledge = async () => {
      throw Object.assign(new Error('not found'), { code: 'not_found' });
    };

    await fs.writeFile(absPath, 'second');
    const documents = store.all();
    documents.d1.state = 'queued';
    await store.writeDocuments(documents);

    const result = await queue.processOnce();

    expect(result.failed).toBe(0);
    expect(client.registers).toHaveLength(2);
    expect(store.document('d1')).toMatchObject({ state: 'ready', knowledgeId: 'k2' });
  });

  it('makes no backend call when the content is unchanged', async () => {
    const { store, client, queue } = await setup();
    await queue.processOnce();
    const documents = store.all();
    documents.d1.state = 'queued';
    await store.writeDocuments(documents);

    await queue.processOnce();

    expect(client.registers).toHaveLength(1);
    expect(client.reparses).toEqual([]);
    expect(store.document('d1').state).toBe('ready');
  });

  it('records a parse failure with the backend message', async () => {
    const { store, queue } = await setup({
      knowledge: { id: 'k1', parse_status: 'failed', error_message: 'unsupported encoding' },
    });

    const result = await queue.processOnce();

    expect(result.failed).toBe(1);
    expect(store.document('d1')).toMatchObject({
      state: 'failed',
      parseStatus: 'failed',
      lastError: { code: 'parse_failed', message: 'unsupported encoding' },
    });
  });

  it('marks a vanished file as missing without calling the backend', async () => {
    const { absPath, store, client, queue } = await setup();
    await fs.rm(absPath);

    await queue.processOnce();

    expect(client.registers).toEqual([]);
    expect(store.document('d1')).toMatchObject({ state: 'missing' });
  });

  it('skips an oversized file without registering it', async () => {
    const { store, client, queue } = await setup({ size: MAX_FILE_BYTES + 1 });

    await queue.processOnce();

    expect(client.registers).toEqual([]);
    expect(store.document('d1')).toMatchObject({ state: 'skipped', lastError: { code: 'too_large' } });
  });

  it('fails a parse that never finishes', async () => {
    const documents = {
      d1: {
        id: 'd1',
        libraryId: 'l1',
        relPath: 'a.md',
        absPath: '/nowhere/a.md',
        state: 'parsing',
        knowledgeId: 'k1',
        uploadedAt: Date.now() - 16 * 60 * 1000,
      },
    };
    const store = createMemoryStore(documents);
    const queue = createIngestQueue({
      client: createClient({ knowledge: { id: 'k1', parse_status: 'processing', pending_subtasks_count: 0 } }),
      store,
      getLibraries: () => [{ id: 'l1', slug: 'lib', knowledgeBaseId: 'kb1' }],
    });

    await queue.processOnce();

    expect(store.document('d1')).toMatchObject({ state: 'failed', lastError: { code: 'parse_timeout' } });
  });

  it('reports per-state counts without an uploading bucket', async () => {
    const { queue } = await setup();
    await queue.processOnce();
    const stats = await queue.getStats();
    expect(stats).toMatchObject({ ready: 1, queued: 0, failed: 0 });
    expect(stats).not.toHaveProperty('uploading');
  });
});
