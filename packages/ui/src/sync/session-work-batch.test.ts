import { expect, spyOn, test } from 'bun:test';
import { z } from 'zod';
import type { Session } from '@/lib/opencode/model';
import { opencodeClient } from '@/lib/opencode/client';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { markSessionsWorkDone } from './session-work-batch';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';

const session = (id: string): Session => ({
  id, directory: '/repo', projectID: 'project', title: id, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 }, metadata: { openchamber: { work: { state: 'open' } } },
});

test('an instance round trip stops the remaining batch without writing to the new owner', async () => {
  const rows = ['a', 'b', 'c'].map(session);
  const originalFetch = globalThis.fetch;
  let writes = 0;
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    if (String(input).includes('/metadata')) writes += 1;
    return Response.json({ metadata: {} });
  }, originalFetch);
  switchRuntimeEndpoint({ apiBaseUrl: 'http://a.test', runtimeKey: 'a' });
  const read = spyOn(opencodeClient, 'getSession').mockImplementation(async id => {
    switchRuntimeEndpoint({ apiBaseUrl: 'http://b.test', runtimeKey: 'b' });
    switchRuntimeEndpoint({ apiBaseUrl: 'http://a.test', runtimeKey: 'a' });
    return rows.find(row => row.id === id)!;
  });
  useGlobalSessionsStore.getState().applySnapshot(rows, [], 'ready');
  try {
    expect(await markSessionsWorkDone(['a', 'b', 'c'])).toEqual({ doneIds: [], failedIds: ['a', 'b', 'c'] });
    expect(read.mock.calls).toHaveLength(1);
    expect(writes).toBe(0);
  } finally {
    read.mockRestore();
    globalThis.fetch = originalFetch;
    useGlobalSessionsStore.getState().resetForRuntimeSwitch();
  }
});

test('a failed middle write keeps only that session for retry', async () => {
  const rows = ['a', 'b', 'c'].map(session);
  const originalFetch = globalThis.fetch;
  const read = spyOn(opencodeClient, 'getSession').mockImplementation(async (id) => rows.find(row => row.id === id)!);
  let fail = true;
  const writes: string[] = [];
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = input instanceof Request ? input.url : String(input);
    const id = path.match(/sessions\/([^/]+)\/metadata/)?.[1] ?? '';
    writes.push(id);
    if (id === 'b' && fail) return Response.json({ error: 'offline' }, { status: 503 });
    const body = z.object({ patch: z.record(z.string(), z.json()) }).parse(JSON.parse(String(init?.body)));
    return Response.json({ metadata: body.patch });
  }, originalFetch);
  useGlobalSessionsStore.getState().applySnapshot(rows, [], 'ready');
  try {
    const first = await markSessionsWorkDone(['a', 'b', 'c']);
    expect(first).toEqual({ doneIds: ['a', 'c'], failedIds: ['b'] });
    expect(writes).toEqual(['a', 'b', 'c']);
    fail = false;
    expect(await markSessionsWorkDone(first.failedIds)).toEqual({ doneIds: ['b'], failedIds: [] });
    expect(writes).toEqual(['a', 'b', 'c', 'b']);
    expect(useGlobalSessionsStore.getState().entityById.get('a')?.time.archived).toBeUndefined();
  } finally {
    read.mockRestore();
    globalThis.fetch = originalFetch;
    useGlobalSessionsStore.getState().resetForRuntimeSwitch();
  }
});
