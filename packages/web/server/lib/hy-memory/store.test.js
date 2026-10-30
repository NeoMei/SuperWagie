import { describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createConversationMemoryStore } from '../conversation-memory/store.js';
import { createSharedMemoryStore } from './store.js';

describe('shared memory state', () => {
  test('imports legacy consent and preserves it on a failed atomic backend commit', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-memory-'));
    try {
      const legacy = createConversationMemoryStore({ dataDir: root });
      await legacy.update((state) => { state.enabled = true; state.enabledAt = 42; });
      let revision = 0; let records = []; let fail = false;
      const backend = async (action, input) => {
        if (action === 'state/read') return { revision, records: structuredClone(records) };
        if (fail) throw Object.assign(new Error('backend unavailable'), { code: 'unavailable' });
        expect(input.expected_revision).toBe(revision);
        for (const m of input.mutations) {
          records = records.filter((r) => r.collection !== m.collection || r.id !== m.id);
          if (!m.delete) records.push({ collection: m.collection, id: m.id, value: m.value });
        }
        return { revision: ++revision };
      };
      const store = createSharedMemoryStore({ dataDir: root, backend });
      expect((await store.read()).enabledAt).toBe(42);
      fail = true;
      await expect(store.update((state) => { state.enabled = false; })).rejects.toThrow();
      expect((await legacy.read()).enabled).toBe(true);
      fail = false;
      expect((await store.read()).enabled).toBe(true);
      expect(records.find((r) => r.collection === 'meta').value.enabled).toBe(true);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
