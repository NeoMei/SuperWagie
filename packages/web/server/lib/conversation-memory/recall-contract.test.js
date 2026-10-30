import { expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createConversationMemoryRuntime } from './runtime.js';
import { createConversationMemoryStore } from './store.js';

const fixture = async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'recall-contract-'));
  const store = createConversationMemoryStore({ dataDir });
  await store.update((state) => { state.enabled = true;
    for (let n = 1; n <= 5; n++) state.entries.push({ id: `e${n}`, kind: 'experience', title: `Entry ${n}`, body: `Synthetic ${n}`, status: 'active', verification: 'unverified', indexState: 'ready', projectId: 'p', directory: '/toy', sessionId: `s${n}`, segmentId: `seg${n}`, sourceHash: 'a'.repeat(64), sourceMessageIds: [`m${n}`], sourcePartIds: [], limitations: [], createdAt: n, updatedAt: n, documentId: `d${n}`, knowledgeId: `k${n}`, error: null, confirmed: true });
    state.entries.push({ ...state.entries[0], id: 'candidate', title: 'Exact lesson', status: 'candidate', indexState: 'pending', confirmed: false });
  });
  return { dataDir, store };
};
test('preserves retrieval rank when selecting automatic references', async () => {
  const h = await fixture();
  const runtime = createConversationMemoryRuntime({ dataDir: h.dataDir, resolveProjectId: async () => 'p', knowledgeLibrary: { isReady: () => true, searchManagedDocuments: async () => ({ passages: [5,4,3,2,1].map((n) => ({ documentId: `d${n}` })), documents: [] }) } });
  try { await runtime.start(); const text = await runtime.recall({ directory: '/toy', query: 'needle' }); expect([...text.matchAll(/"title":"Entry (\d)"/g)].map((m) => m[1])).toEqual(['5','4','3','2']); }
  finally { await runtime.stop(); await fs.rm(h.dataDir, { recursive: true, force: true }); }
});
test('exact candidate inspection survives semantic failure without elevating its status', async () => {
  const h = await fixture();
  const runtime = createConversationMemoryRuntime({ dataDir: h.dataDir, resolveProjectId: async () => 'p', knowledgeLibrary: { isReady: () => true, searchManagedDocuments: async () => { throw new Error('offline'); } } });
  try { await runtime.start(); const result = await runtime.retrieve({ directory: '/toy', title: 'Exact lesson', mode: 'inspect' }); expect(result.entries[0]).toMatchObject({ id: 'candidate', status: 'candidate', availability: { state: 'unverified' } }); expect(result.scope.projectId).toBe('p'); }
  finally { await runtime.stop(); await fs.rm(h.dataDir, { recursive: true, force: true }); }
});
