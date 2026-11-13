import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { opencodeClient } from '@/lib/opencode/client';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { patchSessionMetadata } from './session-actions';

const source: Session = { id: 'metadata', directory: '/old', projectID: 'project', title: 'old', cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1, idle: 10, viewed: 5 }, metadata: {} };
const metadata = { openchamber: { manualUnread: true } };
const originalFetch = globalThis.fetch;
let read = spyOn(opencodeClient, 'getSession');
let release: (response: Response) => void = () => {};
let writes = 0;
const begin = () => patchSessionMetadata(source.id, source.directory, () => metadata);
const waitForWrite = async () => { for (let i = 0; i < 10 && writes === 0; i++) await Promise.resolve(); expect(writes).toBe(1); };

beforeEach(() => {
  writes = 0;
  read = spyOn(opencodeClient, 'getSession').mockResolvedValue(source);
  globalThis.fetch = Object.assign((input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.includes('/metadata')) return Promise.resolve(Response.json({}));
    writes += 1;
    return new Promise<Response>(resolve => { release = resolve; });
  }, originalFetch);
  useGlobalSessionsStore.getState().applySnapshot([source], [], 'ready');
});
afterEach(() => {
  read.mockRestore();
  globalThis.fetch = originalFetch;
  useGlobalSessionsStore.getState().resetForRuntimeSwitch();
});

test('a metadata response preserves same-head viewed, idle, location, title and usage changes', async () => {
  const operation = begin();
  await waitForWrite();
  const newer = { ...source, title: 'new', directory: '/new', cost: 4, time: { ...source.time, viewed: 20, idle: 20, archived: 25 } };
  useGlobalSessionsStore.getState().upsertSession(newer);
  release(Response.json({ metadata }));
  const result = await operation;
  expect(result).toMatchObject({ ...newer, metadata });
  expect(useGlobalSessionsStore.getState().entityById.get(source.id)).toMatchObject({ ...newer, metadata });
});

test('a deletion while the metadata read is pending prevents the write', async () => {
  let finish: (session: Session) => void = () => {};
  read.mockImplementation(() => new Promise<Session>(resolve => { finish = resolve; }));
  const operation = begin();
  useGlobalSessionsStore.getState().removeSessions([source.id]);
  finish(source);
  await expect(operation).rejects.toThrow('removed');
  expect(writes).toBe(0);
  expect(useGlobalSessionsStore.getState().entityById.has(source.id)).toBe(false);
});

test('a deletion while the write is pending cannot resurrect the session', async () => {
  const operation = begin();
  await waitForWrite();
  useGlobalSessionsStore.getState().removeSessions([source.id]);
  release(Response.json({ metadata }));
  await operation;
  expect(useGlobalSessionsStore.getState().entityById.has(source.id)).toBe(false);
});

test('a runtime round trip retires an unguarded metadata response', async () => {
  switchRuntimeEndpoint({ apiBaseUrl: 'http://a.test', runtimeKey: 'a' });
  const operation = begin();
  await waitForWrite();
  switchRuntimeEndpoint({ apiBaseUrl: 'http://b.test', runtimeKey: 'b' });
  switchRuntimeEndpoint({ apiBaseUrl: 'http://a.test', runtimeKey: 'a' });
  release(Response.json({ metadata }));
  await expect(operation).rejects.toThrow('runtime changed');
  expect(useGlobalSessionsStore.getState().entityById.get(source.id)?.metadata).toEqual({});
});
