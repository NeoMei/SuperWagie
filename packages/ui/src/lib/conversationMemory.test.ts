import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  captureConversationMemory,
  confirmConversationMemoryEntry,
  forgetConversationMemoryEntry,
  listConversationMemoryEntries,
  readConversationMemoryStatus,
  retryConversationMemoryEntry,
  updateConversationMemorySettings,
} from './conversationMemory';
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from './runtime-url';

const previousResolver = getRuntimeUrlResolver();
let fixture: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | null = null;
afterEach(() => { fixture?.mockRestore(); fixture = null; setRuntimeUrlResolver(previousResolver); });
const status = { enabled: false, state: 'off', pending: 0, failed: 0, unknown: 0, entries: 0, lastError: null };
const entry = {
  id: 'entry/1', kind: 'experience', title: 'Observed behavior', body: 'Evidence', status: 'candidate',
  indexState: 'failed', verification: 'unverified', sessionId: 'ses_source', projectId: 'project',
  createdAt: 1, updatedAt: 2, sourceMessageIds: ['msg_source'], limitations: ['Fixture only'],
};

describe('conversation memory HTTP contract', () => {
  test('validates status and never turns an unreadable response into disabled success', async () => {
    fixture = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(status));
    expect(await readConversationMemoryStatus()).toEqual(status);
    fixture.mockResolvedValue(Response.json({ enabled: false }));
    await expect(readConversationMemoryStatus()).rejects.toThrow('bad_response');
    fixture.mockResolvedValue(Response.json({ error: 'memory_unavailable' }, { status: 503 }));
    await expect(readConversationMemoryStatus()).rejects.toThrow('memory_unavailable');
  });

  test('preserves trusted directory, query, abort and mutation payloads on the active runtime', async () => {
    configureRuntimeUrlResolver({ apiBaseUrl: 'https://memory.example' });
    const calls: Array<{ url: URL; method: string; body: string | null; signal: AbortSignal | null }> = [];
    fixture = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      calls.push({ url, method: request.method, body: init?.body ? String(init.body) : null, signal: init?.signal ?? null });
      if (url.pathname.endsWith('/settings')) return Response.json({ ...status, enabled: true, state: 'ready' });
      if (url.pathname.endsWith('/confirm')) return Response.json({ entry: { ...entry, status: 'active' } });
      if (request.method === 'DELETE') return Response.json({ forgotten: true, pendingCleanup: true });
      if (request.method === 'POST') return Response.json({ queued: true });
      return Response.json({ entries: [entry] });
    });
    const controller = new AbortController();
    expect(await listConversationMemoryEntries({ directory: 'C:/my project/', query: 'fix & retry', signal: controller.signal })).toEqual([entry]);
    expect(calls[0]?.url.searchParams.get('directory')).toBe('C:/my project/');
    expect(calls[0]?.url.searchParams.get('query')).toBe('fix & retry');
    expect(calls[0]?.signal).toBe(controller.signal);
    await updateConversationMemorySettings(true);
    await captureConversationMemory({ sessionId: 'ses_current', directory: '/repo' });
    await retryConversationMemoryEntry({ id: entry.id, directory: '/repo' });
    expect(await forgetConversationMemoryEntry({ id: entry.id, directory: '/repo' })).toEqual({ forgotten: true, pendingCleanup: true });
    expect((await confirmConversationMemoryEntry({ id: entry.id, directory: '/repo' })).status).toBe('active');
    expect(calls.map((call) => call.method)).toEqual(['GET', 'PUT', 'POST', 'POST', 'DELETE', 'POST']);
    expect(calls[1]?.body).toBe(JSON.stringify({ enabled: true }));
    expect(calls[2]?.body).toBe(JSON.stringify({ sessionId: 'ses_current', directory: '/repo' }));
    expect(calls[3]?.body).toBe(JSON.stringify({ id: entry.id, directory: '/repo' }));
    expect(calls[4]?.url.pathname).toBe('/api/conversation-memory/entries/entry%2F1');
    expect(calls[4]?.url.searchParams.get('directory')).toBe('/repo');
  });

  test('rejects malformed entries and unsuccessful acknowledgments', async () => {
    fixture = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ entries: [{ ...entry, verification: 'verified' }] }));
    await expect(listConversationMemoryEntries({ directory: '/repo' })).rejects.toThrow('bad_response');
    fixture.mockResolvedValue(Response.json({ forgotten: false, pendingCleanup: false }));
    await expect(forgetConversationMemoryEntry({ id: 'entry', directory: '/repo' })).rejects.toThrow('bad_response');
  });
});

test('drops responses from an aborted request and a previous runtime', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const runtimeWindow = { __OPENCHAMBER_API_BASE_URL__: 'https://old.example', location: { origin: 'https://app.example', href: 'https://app.example/' } };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: runtimeWindow });
  let resolveResponse: ((response: Response) => void) | undefined;
  fixture = spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>((resolve) => { resolveResponse = resolve; }));
  try {
    const oldRead = readConversationMemoryStatus();
    await new Promise((resolve) => setTimeout(resolve, 0));
    runtimeWindow.__OPENCHAMBER_API_BASE_URL__ = 'https://new.example';
    resolveResponse?.(Response.json(status));
    await expect(oldRead).rejects.toThrow('runtime_changed');
    const controller = new AbortController();
    const abortedRead = readConversationMemoryStatus(controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    resolveResponse?.(Response.json(status));
    await expect(abortedRead).rejects.toThrow('The request was aborted');
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('queues an explicit methodology proposal with only the selected project entry IDs', async () => {
  const { consolidateConversationMemory } = await import('./conversationMemory');
  let body = '';
  let path = '';
  fixture = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    path = String(input);
    body = String(init?.body ?? '');
    return Response.json({ queued: true });
  });
  expect(await consolidateConversationMemory({ directory: '/project', entryIds: ['entry_1', 'entry_2'] })).toEqual({ queued: true });
  expect(path).toContain('/api/conversation-memory/consolidate');
  expect(JSON.parse(body)).toEqual({ directory: '/project', entryIds: ['entry_1', 'entry_2'] });
});
