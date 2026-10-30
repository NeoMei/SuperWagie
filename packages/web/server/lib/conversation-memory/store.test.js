import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createConversationMemoryStore } from './store.js';

const roots = [];
const createStore = async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'conversation-memory-'));
  roots.push(dataDir);
  return { dataDir, store: createConversationMemoryStore({ dataDir }) };
};
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

describe('durable conversation learning state', () => {
  test('defaults to disabled and preserves independent queued updates after restart', async () => {
    const { dataDir, store } = await createStore();
    expect((await store.read()).enabled).toBe(false);
    await Promise.all([
      store.update((state) => { state.enabled = true; state.enabledAt = 100; }),
      store.update((state) => { state.pending.push({ sessionId: 's1', directory: '/work/a', includeHistory: false }); }),
    ]);
    const restored = await createConversationMemoryStore({ dataDir }).read();
    expect(restored.enabled).toBe(true);
    expect(restored.pending).toEqual([{ sessionId: 's1', directory: '/work/a', includeHistory: false }]);
    expect((await fs.stat(path.join(dataDir, 'conversation-memory', 'state.json'))).mode & 0o777).toBe(0o600);
  });

  test('an unreadable state never becomes an authoritative empty store', async () => {
    const { dataDir, store } = await createStore();
    await store.update((state) => { state.enabled = true; });
    await fs.writeFile(path.join(dataDir, 'conversation-memory', 'state.json'), '{broken');
    await expect(createConversationMemoryStore({ dataDir }).read()).rejects.toThrow();
  });

  test('a rejected mutation leaves the last valid state intact', async () => {
    const { store } = await createStore();
    await expect(store.update((state) => { state.enabled = 'invalid'; })).rejects.toThrow();
    expect((await store.read()).enabled).toBe(false);
    await store.update((state) => { state.enabled = true; });
    expect((await store.read()).enabled).toBe(true);
  });
});
