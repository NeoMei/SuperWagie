import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionTodosRuntime, flagFromConfig, flagFromOverrides, flagOnByDefault } from './runtime.js';

const SESSION = 'ses_todo_1';
const DIRECTORY = '/repo';
const ON = [{ type: 'document', info: { experimental: { todo: true } } }];

const tempDirs = [];
const runtimes = [];
const makeDataDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-session-todos-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const list = (...items) => items.map(([content, status]) => ({ content, status }));
const todoCall = (todos) => ({ type: 'tool', id: 'call', name: 'todowrite', state: { status: 'completed', input: { todos } } });
// Finished 10 ms after it began unless `completed` says otherwise (null: still streaming).
const message = (created, content = [], completed = created + 10) => ({ id: `msg_${created}`, type: 'assistant', time: completed === null ? { created } : { created, completed }, content });

/**
 * A fake OpenCode. `pages` are the session's agent messages newest first, in
 * pages of any size; `config` the location's config documents.
 */
const makeRuntime = ({ dataDir = makeDataDir(), config = ON, pages = [[]], version = '2.2.7', overrides, revert = null } = {}) => {
  const events = [];
  const opencode = { config, pages, version, revert };
  const fetchImpl = vi.fn(async (url) => {
    const { pathname, searchParams } = new URL(String(url));
    if (pathname === '/api/config') return Response.json(opencode.config);
    if (pathname === '/api/info') return Response.json({ version: opencode.version });
    if (pathname === `/api/session/${SESSION}`) return Response.json({ data: { id: SESSION, revert: opencode.revert && { messageID: opencode.revert.id } } });
    if (opencode.revert && pathname === `/api/session/${SESSION}/message/${opencode.revert.id}`) return Response.json({ data: { time: { created: opencode.revert.created } } });
    if (pathname === `/api/session/${SESSION}/message`) {
      const index = Number(searchParams.get('cursor') ?? 0);
      const next = index + 1 < opencode.pages.length ? String(index + 1) : undefined;
      return Response.json({ data: opencode.pages[index], cursor: { next } });
    }
    return new Response('not found', { status: 404 });
  });
  const runtime = createSessionTodosRuntime({
    dataDir,
    buildOpenCodeUrl: (route) => `http://127.0.0.1:1${route}`,
    getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic x' }),
    globalEventHub: { subscribeEvent: () => () => {}, subscribeStatus: () => () => {} },
    getFlagOverrides: () => overrides,
    isSpaceDirectory: (directory) => directory.startsWith('/space'),
    broadcast: (event) => events.push(event),
    fetchImpl,
  });
  runtimes.push(runtime);
  const messageReads = () => fetchImpl.mock.calls.filter(([url]) => new URL(String(url)).pathname.endsWith('/message')).length;
  return { runtime, fetchImpl, events, opencode, messageReads, dataDir };
};

const wire = (type, data, created = 1000) => ({ type, created, data, location: { directory: DIRECTORY } });
const callTodos = (runtime, todos, { id = 'call_1', created = 1000 } = {}) => {
  runtime.processPayload(wire('session.tool.input.started', { sessionID: SESSION, assistantMessageID: 'msg', id, name: 'todowrite' }, created));
  runtime.processPayload(wire('session.tool.called', { sessionID: SESSION, assistantMessageID: 'msg', id, input: { todos }, executed: true }, created));
  runtime.processPayload(wire('session.tool.success', { sessionID: SESSION, assistantMessageID: 'msg', id, content: [{ type: 'text', text: 'ok' }], metadata: { todos }, executed: true }, created));
};

describe('whether the tool is on', () => {
  it('accepts the explicit todo flag without all_flags', () => {
    expect(flagFromConfig(ON)).toBe(true);
  });
  it('reads OPENCODE_FLAGS the way OpenCode does', () => {
    expect(flagFromOverrides('todo')).toBe(true);
    expect(flagFromOverrides('all,-todo')).toBe(false);
    expect(flagFromOverrides('all')).toBe(true);
    expect(flagFromOverrides('schedules')).toBeUndefined();
    expect(flagFromOverrides(undefined)).toBeUndefined();
  });

  it('takes experimental from the highest document that sets it, whole', () => {
    expect(flagFromConfig([
      { type: 'document', info: { experimental: { todo: true } } },
      { type: 'document', info: { experimental: { subagent_depth: 2 } } },
    ])).toBeUndefined();
    expect(flagFromConfig([
      { type: 'document', info: { experimental: { all_flags: true } } },
      { type: 'document', info: { experimental: { subagent_depth: 2 } } },
    ])).toBe(true);
    expect(flagFromConfig([{ type: 'document', info: { experimental: { todo: false, all_flags: true } } }])).toBe(false);
    expect(flagFromConfig([{ type: 'directory', path: '/x' }])).toBeUndefined();
  });

  it('defaults on only for local and dev builds', () => {
    expect(flagOnByDefault('local')).toBe(true);
    expect(flagOnByDefault('0.0.0-dev-202611100000')).toBe(true);
    expect(flagOnByDefault('0.0.0-feature-x-12')).toBe(false);
    expect(flagOnByDefault('2.2.7')).toBe(false);
  });
});

describe('session todos', () => {
  it.each([
    ['oversized', [...Array.from({ length: 200 }, (_, index) => ({ content: `Done ${index}`, status: 'completed' })), { content: 'Still pending', status: 'pending' }]],
    ['malformed', [{ content: 'Done', status: 'completed' }, { status: 'pending' }]],
    ['missing', undefined],
  ])('rejects the newest %s completed list without falling back to older calls', async (_kind, input) => {
    const previous = list(['Older list', 'completed']);
    const { runtime } = makeRuntime({ pages: [[message(300, [todoCall(previous), todoCall(input)]), message(200, [todoCall(previous)])]] });
    await expect(runtime.read(SESSION, DIRECTORY)).rejects.toThrow(/todo list/i);
  });

  it('an oversized successful live call preserves the previous list and reports unavailability until a valid success', async () => {
    const previous = list(['Original pending', 'pending']);
    const { runtime, events, messageReads } = makeRuntime();
    callTodos(runtime, previous);
    const oversized = [...Array.from({ length: 200 }, (_, index) => ({ content: `Done ${index}`, status: 'completed' })), { content: 'Still pending', status: 'pending' }];
    runtime.processPayload(wire('session.tool.input.started', { sessionID: SESSION, id: 'oversized', name: 'todowrite' }));
    runtime.processPayload(wire('session.tool.called', { id: 'oversized', input: { todos: list(['Input differs', 'completed']) } }));
    runtime.processPayload(wire('session.tool.success', { id: 'oversized', metadata: { todos: oversized } }));
    expect(events.at(-1).properties.todos).toBeNull();
    expect(events.filter((event) => Array.isArray(event.properties.todos)).at(-1).properties.todos).toEqual(previous);
    await expect(runtime.read(SESSION, DIRECTORY)).rejects.toThrow(/todo list.*200/i);
    expect(messageReads()).toBe(0);
    callTodos(runtime, list(['Recovered', 'pending']), { id: 'valid', created: 2000 });
    expect(await runtime.read(SESSION, DIRECTORY)).toMatchObject({ state: 'ready', todos: list(['Recovered', 'pending']) });
  });

  it('a malformed successful live call cannot fall back to valid input or erase the previous list', async () => {
    const previous = list(['Previous', 'pending']);
    const { runtime, events } = makeRuntime();
    callTodos(runtime, previous);
    runtime.processPayload(wire('session.tool.input.started', { sessionID: SESSION, id: 'invalid', name: 'todowrite' }));
    runtime.processPayload(wire('session.tool.called', { id: 'invalid', input: { todos: list(['Different', 'completed']) } }));
    runtime.processPayload(wire('session.tool.success', { id: 'invalid', metadata: { todos: { invalid: true } } }));
    expect(events.at(-1).properties.todos).toBeNull();
    await expect(runtime.read(SESSION, DIRECTORY)).rejects.toThrow(/todo list/i);
  });

  it('an invalid live success overtaking a history read cannot return the previous list as ready', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { runtime, fetchImpl } = makeRuntime({ pages: [[message(100, [todoCall(list(['Old', 'completed']))])]] });
    const original = fetchImpl.getMockImplementation();
    fetchImpl.mockImplementation(async (url) => {
      if (new URL(String(url)).pathname.endsWith('/message')) await gate;
      return original(url);
    });
    const reading = runtime.read(SESSION, DIRECTORY);
    await vi.waitFor(() => expect(fetchImpl.mock.calls.some(([url]) => new URL(String(url)).pathname.endsWith('/message'))).toBe(true));
    callTodos(runtime, { invalid: true });
    release();
    await expect(reading).rejects.toThrow();
  });

  it.each([
    ['malformed', [{ status: 'pending' }]],
    ['oversized', Array.from({ length: 201 }, (_, index) => ({ content: `Done ${index}`, status: 'completed' }))],
  ])('rebuilds a %s persisted list without using its checked-through cutoff', async (_kind, todos) => {
    const dataDir = makeDataDir();
    fs.writeFileSync(path.join(dataDir, 'session-todos.json'), JSON.stringify({ version: 1, sessions: {
      [SESSION]: { directory: DIRECTORY, todos, checkedThrough: 1000, updatedAt: 1000 },
    } }));
    const fresh = list(['Native pending', 'pending']);
    const { runtime } = makeRuntime({ dataDir, pages: [[message(100, [todoCall(fresh)])]] });
    await runtime.start();
    expect(await runtime.read(SESSION, DIRECTORY)).toMatchObject({ state: 'ready', todos: fresh });
  });

  it('a failed call cannot replace the last successful list', async () => {
    const { runtime } = makeRuntime();
    const previous = list(['Keep me', 'completed']);
    callTodos(runtime, previous);
    runtime.processPayload(wire('session.tool.input.started', { sessionID: SESSION, id: 'failed', name: 'todowrite' }));
    runtime.processPayload(wire('session.tool.called', { id: 'failed', input: { todos: list(['Failed', 'pending']) } }));
    runtime.processPayload(wire('session.tool.failed', { id: 'failed' }));
    expect(await runtime.read(SESSION, DIRECTORY)).toMatchObject({ todos: previous });
  });

  it('rejects incomplete pagination instead of claiming the list is empty', async () => {
    const { runtime, fetchImpl } = makeRuntime({ pages: [[message(100)]] });
    const original = fetchImpl.getMockImplementation();
    fetchImpl.mockImplementation((url) => new URL(String(url)).pathname.endsWith('/message')
      ? Response.json({ data: [message(100)], cursor: { next: 'repeated' } })
      : original(url));
    await expect(runtime.read(SESSION, DIRECTORY)).rejects.toThrow('cursor');
  });

  it('cannot publish a history response after the runtime has stopped', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { runtime, fetchImpl, events } = makeRuntime({ pages: [[message(100, [todoCall(list(['Late', 'pending']))])]] });
    const original = fetchImpl.getMockImplementation();
    fetchImpl.mockImplementation(async (url) => {
      if (new URL(String(url)).pathname.endsWith('/message')) await gate;
      return original(url);
    });
    const reading = runtime.read(SESSION, DIRECTORY);
    await vi.waitFor(() => expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith('/message?limit=50&order=desc&type=assistant'))).toBe(true));
    await runtime.stop();
    release();
    await expect(reading).rejects.toThrow('stopped');
    expect(events).toEqual([]);
  });

  it('does not accept a call that completed after its session was reverted', async () => {
    const { runtime } = makeRuntime({ pages: [[]] });
    runtime.processPayload(wire('session.tool.input.started', { sessionID: SESSION, id: 'stale', name: 'todowrite' }));
    runtime.processPayload(wire('session.revert.staged', { sessionID: SESSION }));
    runtime.processPayload(wire('session.tool.success', { id: 'stale', metadata: { todos: list(['Reverted', 'pending']) } }));
    expect(await runtime.read(SESSION, DIRECTORY)).toMatchObject({ todos: [] });
  });
  it('stays off and reads no history while the tool is off', async () => {
    const { runtime, messageReads } = makeRuntime({ config: [] });
    expect(await runtime.read(SESSION, DIRECTORY)).toMatchObject({ state: 'off' });
    expect(messageReads()).toBe(0);
  });

  it('reports an isolated space unsupported without asking OpenCode', async () => {
    const { runtime, fetchImpl } = makeRuntime();
    expect(await runtime.read(SESSION, '/space/a')).toMatchObject({ state: 'unsupported' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('finds the newest list in the history, a page at a time, and reads it once', async () => {
    const newer = list(['Ship it', 'in_progress']);
    const { runtime, messageReads } = makeRuntime({
      pages: [[message(300)], [message(200, [todoCall(newer)]), message(100, [todoCall(list(['Old', 'pending']))])]],
    });
    expect(await runtime.read(SESSION, DIRECTORY)).toMatchObject({ state: 'ready', todos: newer });
    expect(messageReads()).toBe(2);
    await runtime.read(SESSION, DIRECTORY);
    expect(messageReads()).toBe(2);
  });

  it('remembers that a session has no list', async () => {
    const { runtime, messageReads } = makeRuntime({ pages: [[message(200)], [message(100)]] });
    expect(await runtime.read(SESSION, DIRECTORY)).toMatchObject({ state: 'ready', todos: [] });
    await runtime.read(SESSION, DIRECTORY);
    expect(messageReads()).toBe(2);
  });

  it('takes a completed call from the event stream without reading history', async () => {
    const { runtime, events, messageReads } = makeRuntime();
    const todos = list(['Write tests', 'pending']);
    callTodos(runtime, todos);
    expect(events.at(-1)).toMatchObject({ type: 'openchamber:session-todos', properties: { sessionId: SESSION, directory: DIRECTORY, todos } });
    expect(await runtime.read(SESSION, DIRECTORY)).toMatchObject({ state: 'ready', todos });
    expect(messageReads()).toBe(0);
  });

  it('counts the tool as on where a call was seen, whatever the config says', async () => {
    const { runtime } = makeRuntime({ config: [] });
    callTodos(runtime, list(['A', 'pending']));
    expect(await runtime.read(SESSION, DIRECTORY)).toMatchObject({ state: 'ready' });
  });

  it('after a gap, reads only the history newer than the stored list', async () => {
    const stored = list(['Stored', 'pending']);
    const { runtime, opencode, messageReads } = makeRuntime({ pages: [[message(5000)], [message(900, [todoCall(list(['Older', 'pending']))])]] });
    callTodos(runtime, stored, { created: 1000 });
    runtime.onConnected();
    expect(await runtime.read(SESSION, DIRECTORY)).toMatchObject({ todos: stored });
    // The walk stopped at the first message the stored list accounts for.
    expect(messageReads()).toBe(2);

    const missed = list(['Missed during the gap', 'in_progress']);
    opencode.pages = [[message(7000, [todoCall(missed)])]];
    runtime.onConnected();
    expect(await runtime.read(SESSION, DIRECTORY)).toMatchObject({ todos: missed });
  });

  it('after a gap, looks again at a message that was still streaming', async () => {
    const { runtime, opencode } = makeRuntime({ pages: [[]] });
    callTodos(runtime, list(['First', 'in_progress']), { created: 1000 });
    // The same message went on to call the tool again while the stream was down.
    const second = list(['First', 'completed'], ['Second', 'in_progress']);
    opencode.pages = [[message(900, [todoCall(list(['First', 'in_progress'])), todoCall(second)], 1500)]];
    runtime.onConnected();
    expect(await runtime.read(SESSION, DIRECTORY)).toMatchObject({ todos: second });
  });

  it('tells clients to read again when OpenCode\'s stream reconnects', () => {
    const { runtime, events } = makeRuntime();
    runtime.onConnected();
    expect(events.at(-1)).toMatchObject({ type: 'openchamber:session-todos', properties: { sessionId: null, directory: null, todos: null } });
  });

  it('looks the list up again before the revert boundary', async () => {
    const before = list(['Before', 'completed']);
    const after = list(['After', 'pending']);
    const { runtime, opencode, events } = makeRuntime({ pages: [[message(300, [todoCall(after)]), message(100, [todoCall(before)])]] });
    expect(await runtime.read(SESSION, DIRECTORY)).toMatchObject({ todos: after });

    opencode.revert = { id: 'msg_user_200', created: 200 };
    runtime.processPayload(wire('session.revert.staged', { sessionID: SESSION, revert: { messageID: 'msg_user_200' } }));
    expect(events.at(-1)).toMatchObject({ properties: { sessionId: SESSION, todos: null } });
    expect(await runtime.read(SESSION, DIRECTORY)).toMatchObject({ todos: before });
  });

  it('keeps a list an event wrote while the history was being read', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { runtime, fetchImpl } = makeRuntime({ pages: [[message(100, [todoCall(list(['From history', 'pending']))])]] });
    const original = fetchImpl.getMockImplementation();
    fetchImpl.mockImplementation(async (url) => {
      if (new URL(String(url)).pathname.endsWith('/message')) await gate;
      return original(url);
    });
    const reading = runtime.read(SESSION, DIRECTORY);
    await vi.waitFor(() => expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('/message'))).toBe(true));
    const live = list(['From the stream', 'in_progress']);
    callTodos(runtime, live, { created: 500 });
    release();
    expect(await reading).toMatchObject({ todos: live });
  });

  it('turns off for a directory whose config changed, and keeps the list across a restart', async () => {
    const dataDir = makeDataDir();
    const { runtime, opencode } = makeRuntime({ dataDir });
    const todos = list(['Persist me', 'pending']);
    callTodos(runtime, todos);
    opencode.config = [];
    runtime.processPayload({ type: 'config.updated', created: 2000, data: {}, location: { directory: DIRECTORY } });
    expect(await runtime.read(SESSION, DIRECTORY)).toMatchObject({ state: 'off' });
    await runtime.stop();

    const restarted = makeRuntime({ dataDir, pages: [[message(500)]] });
    await restarted.runtime.start();
    expect(await restarted.runtime.read(SESSION, DIRECTORY)).toMatchObject({ state: 'ready', todos });
  });

  it('forgets a deleted session', async () => {
    const { runtime, messageReads } = makeRuntime({ pages: [[]] });
    callTodos(runtime, list(['A', 'pending']));
    runtime.processPayload(wire('session.deleted', { sessionID: SESSION }));
    expect(await runtime.read(SESSION, DIRECTORY)).toMatchObject({ todos: [] });
    expect(messageReads()).toBe(1);
  });
});
