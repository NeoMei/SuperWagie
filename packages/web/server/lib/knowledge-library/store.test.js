import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createKnowledgeLibraryStore } from './store.js';

const tempDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'sw-lib-store-'));

describe('knowledge library store', () => {
  it('round-trips libraries and documents', async () => {
    const store = createKnowledgeLibraryStore({ dataDir: await tempDir() });
    await store.writeLibraries([{ id: 'l1', root: '/tmp/x', slug: 'x' }]);
    await store.writeDocuments({ d1: { id: 'd1', relPath: 'a.md', state: 'ready' } });

    expect(await store.readLibraries()).toEqual([{ id: 'l1', root: '/tmp/x', slug: 'x' }]);
    expect(await store.readDocuments()).toEqual({ d1: { id: 'd1', relPath: 'a.md', state: 'ready' } });
  });

  it('reads a corrupt file as empty instead of throwing', async () => {
    const dataDir = await tempDir();
    const store = createKnowledgeLibraryStore({ dataDir, log: { warn: () => {} } });
    await fs.mkdir(path.join(dataDir, 'knowledge-library'), { recursive: true });
    await fs.writeFile(path.join(dataDir, 'knowledge-library', 'libraries.json'), '{oops');

    expect(await store.readLibraries()).toEqual([]);
    expect(await store.readDocuments()).toEqual({});
  });

  it('serializes concurrent writes so the last one wins intact', async () => {
    const store = createKnowledgeLibraryStore({ dataDir: await tempDir() });
    await Promise.all([
      store.writeLibraries([{ id: 'a' }]),
      store.writeLibraries([{ id: 'b' }]),
      store.writeLibraries([{ id: 'c' }]),
    ]);
    expect(await store.readLibraries()).toEqual([{ id: 'c' }]);
  });
});
