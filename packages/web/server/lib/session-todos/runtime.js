/**
 * The agent's todo list of each session, from OpenCode's experimental
 * `todowrite` tool. OpenCode keeps no state for it: the list is the input of
 * the session's newest completed `todowrite` call before its revert boundary.
 * This server keeps that list per session from the event stream and finds it
 * in the history once, when a session is first asked for. See DOCUMENTATION.md.
 */
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { unwrapOpenCodeResponse } from '../opencode/response-envelope.js';

const FILE_NAME = 'session-todos.json';
const FILE_VERSION = 1;
const TOOL_NAME = 'todowrite';
const FLAG_KEY = 'todo';
const PAGE_SIZE = 50;
/** Sessions kept on disk; the least recently changed go first. */
const MAX_SESSIONS = 2000;
/** Calls between their start and their end; a call whose end never came is dropped first. */
const MAX_OPEN_CALLS = 500;
const MAX_TODOS = 200;
const MAX_TODO_LENGTH = 2000;
const PERSIST_DELAY_MS = 1000;
const REQUEST_TIMEOUT_MS = 15_000;

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{4,128}$/;

export const sessionIdSchema = z.string().regex(SESSION_ID_PATTERN);

const todoSchema = z.object({
  content: z.string().min(1).transform((content) => content.slice(0, MAX_TODO_LENGTH)),
  status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']).catch('pending'),
});

export class SessionTodosDataError extends Error {
  constructor(code) {
    super(code === 'todo-list-too-large' ? `The todo list exceeds ${MAX_TODOS} items` : 'The todo list is invalid');
    this.code = code;
  }
}

/** A completed call grants authority only for a complete valid list. */
const parseTodos = (value) => {
  const list = z.array(z.unknown()).safeParse(value);
  if (!list.success) throw new SessionTodosDataError('todo-list-invalid');
  if (list.data.length > MAX_TODOS) throw new SessionTodosDataError('todo-list-too-large');
  const parsed = z.array(todoSchema).safeParse(list.data);
  if (!parsed.success) throw new SessionTodosDataError('todo-list-invalid');
  return parsed.data;
};
const todoInputSchema = z.object({ todos: z.unknown() });

const storedRecordSchema = z.object({
  directory: z.string(),
  todos: z.array(z.unknown()),
  checkedThrough: z.number().finite().nullable(),
  updatedAt: z.number().finite(),
});
const storedFileSchema = z.object({
  version: z.literal(FILE_VERSION),
  sessions: z.record(z.string(), z.unknown()),
});

const experimentalSchema = z.object({ todo: z.boolean().optional(), all_flags: z.unknown().optional() }).passthrough();
const configEntrySchema = z.object({
  type: z.string(),
  info: z.object({ experimental: experimentalSchema.nullish().catch(undefined) }).passthrough().nullish(),
}).passthrough();
const configEntriesSchema = z.array(z.unknown());
const infoSchema = z.object({ version: z.string() });
const sessionSchema = z.object({
  revert: z.object({ messageID: z.string() }).nullish(),
  location: z.object({ directory: z.string() }).optional(),
}).passthrough();
class UnsupportedSessionTodosError extends Error {}
const createdSchema = z.object({ time: z.object({ created: z.number() }) });
const messageTimeSchema = z.object({ time: z.object({ created: z.number(), completed: z.number().optional().catch(undefined) }) });
const pageSchema = z.object({
  data: z.array(z.unknown()),
  cursor: z.object({ next: z.string().nullish() }).nullish(),
});

// The wire event and the message parts this module reads; anything else passes.
const wireEventSchema = z.object({
  type: z.string(),
  created: z.number().finite().optional().catch(undefined),
  data: z.object({
    sessionID: z.string().trim().optional().catch(undefined),
    id: z.string().optional().catch(undefined),
    name: z.string().optional().catch(undefined),
    input: z.object({ todos: z.unknown() }).partial().optional().catch(undefined),
    metadata: z.object({ todos: z.unknown() }).partial().optional().catch(undefined),
  }).passthrough().catch({}),
  location: z.object({ directory: z.string().trim() }).partial().nullish().catch(undefined),
}).passthrough();
const todoCallSchema = z.object({
  type: z.literal('tool'),
  name: z.literal(TOOL_NAME),
  state: z.object({ status: z.literal('completed'), input: z.unknown().optional() }),
});
const messageContentSchema = z.object({ content: z.array(z.unknown()).catch([]) });

// Every event of the stream reaches this module, text deltas included; only
// these are parsed. A call's own events are parsed only for a followed call.
const SESSION_EVENT_TYPES = new Set([
  'session.tool.input.started',
  'session.revert.staged',
  'session.revert.cleared',
  'session.revert.committed',
  'session.deleted',
  'config.updated',
]);
const CALL_EVENT_TYPES = new Set(['session.tool.called', 'session.tool.success', 'session.tool.failed']);

/**
 * `OPENCODE_FLAGS` as OpenCode reads it: `todo` or `-todo` decides, `all`
 * turns it on unless the list opts it out. Undefined when the list says nothing.
 */
export const flagFromOverrides = (overrides) => {
  const entries = new Map((overrides ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => (item.startsWith('-') ? [item.slice(1), false] : [item, true])));
  if (entries.has(FLAG_KEY)) return entries.get(FLAG_KEY);
  return entries.get('all') === true ? true : undefined;
};

/**
 * The flag as OpenCode resolves it from the location's config documents
 * (lowest priority first): `experimental.todo` from the highest document that
 * sets `experimental`, else `experimental.all_flags: true` from the highest
 * document that sets `all_flags`. Undefined when the config says nothing.
 */
export const flagFromConfig = (entries) => {
  const documents = entries
    .map((entry) => configEntrySchema.safeParse(entry))
    .filter((parsed) => parsed.success && parsed.data.type === 'document')
    .map((parsed) => parsed.data.info?.experimental);
  const experimental = documents.findLast((value) => value !== undefined && value !== null);
  if (experimental?.todo !== undefined) return experimental.todo;
  const allFlags = documents.findLast((value) => value?.all_flags !== undefined);
  return allFlags?.all_flags === true ? true : undefined;
};

/** Flags default to on in OpenCode's local and `dev` channel builds, off in releases. */
export const flagOnByDefault = (version) => version === 'local' || version.startsWith('0.0.0-dev-');

/** The newest completed `todowrite` call in one assistant message, or null. */
const todosInMessage = (message) => {
  const parsed = messageContentSchema.safeParse(message);
  const content = parsed.success ? parsed.data.content : [];
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const call = todoCallSchema.safeParse(content[index]);
    if (!call.success) continue;
    const input = todoInputSchema.safeParse(call.data.state.input);
    if (!input.success) throw new SessionTodosDataError('todo-list-invalid');
    return parseTodos(input.data.todos);
  }
  return null;
};

/**
 * @param {object} options
 * @param {string} options.dataDir
 * @param {(path: string, directory: string) => string} options.buildOpenCodeUrl
 * @param {() => Record<string, string>} options.getOpenCodeAuthHeaders
 * @param {{ subscribeEvent: Function, subscribeStatus: Function, isConnected?: () => boolean }} options.globalEventHub
 * @param {() => string | undefined} options.getFlagOverrides `OPENCODE_FLAGS` of the OpenCode this server talks to.
 * @param {(directory: string) => boolean} options.isSpaceDirectory
 * @param {(event: object) => void} [options.broadcast] Sends an event to every connected client.
 */
export const createSessionTodosRuntime = ({
  dataDir,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  globalEventHub,
  getFlagOverrides,
  isSpaceDirectory,
  broadcast = () => {},
  fetchImpl = fetch,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  logger = console,
}) => {
  const filePath = path.join(dataDir, FILE_NAME);

  // Starts from the clock so an answer after a restart still reads as newer.
  let revision = now();
  /**
   * sessionId → { directory, todos, checkedThrough, updatedAt, verified, generation }.
   * `checkedThrough` is a time by which every finished agent message is
   * accounted for: a later look at the history stops at the first message
   * that finished by then. A message still streaming at that time is looked
   * at again, since a call in it may have ended unseen. `verified` (memory
   * only) means the event stream has been followed without a gap since the
   * list was right; `generation` changes with every write, so a history read
   * that an event overtook does not commit.
   */
  const records = new Map();
  /** callId → { sessionId, directory, todos } for `todowrite` calls that started and have not ended. */
  const openCalls = new Map();
  /** directory → Promise<boolean>: whether the tool is on there. */
  const flags = new Map();
  /** Directories where a `todowrite` call was seen since their config last changed. */
  const observed = new Set();
  let versionRead = null;
  /** sessionId → owner of the running history read, retired by invalidation. */
  const reads = new Map();
  // One history read at a time, so opening several old sessions does not load OpenCode.
  let lane = Promise.resolve();
  let generation = 0;
  let persistTimer = null;
  let writeChain = Promise.resolve();
  let stopped = false;
  let configGeneration = 0;
  const unsubscribers = [];

  const headers = (directory) => {
    const result = { Accept: 'application/json', ...getOpenCodeAuthHeaders() };
    // v2 scopes by header and rejects non-ASCII header values.
    if (directory) result['x-opencode-directory'] = encodeURIComponent(directory);
    return result;
  };

  const readJson = async (route, { directory = '', query } = {}) => {
    const url = buildOpenCodeUrl(route, '');
    const response = await fetchImpl(query ? `${url}?${new URLSearchParams(query)}` : url, {
      method: 'GET',
      headers: headers(directory),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`${route} answered ${response.status}`);
    return unwrapOpenCodeResponse(await response.json());
  };

  // ----- Persistence -----

  const writeFile = () => {
    const sessions = {};
    for (const [sessionId, record] of records) {
      sessions[sessionId] = {
        directory: record.directory,
        todos: record.todos,
        checkedThrough: record.checkedThrough,
        updatedAt: record.updatedAt,
      };
    }
    const payload = JSON.stringify({ version: FILE_VERSION, sessions });
    writeChain = writeChain
      .then(async () => {
        await fs.promises.mkdir(dataDir, { recursive: true });
        const tmpPath = `${filePath}.${process.pid}.tmp`;
        await fs.promises.writeFile(tmpPath, payload, 'utf8');
        await fs.promises.rename(tmpPath, filePath);
      })
      .catch((error) => logger.warn?.('[session-todos] failed to save:', error?.message ?? error));
    return writeChain;
  };

  const schedulePersist = () => {
    if (persistTimer || stopped) return;
    persistTimer = setTimer(() => {
      persistTimer = null;
      void writeFile();
    }, PERSIST_DELAY_MS);
  };

  const load = async () => {
    let raw;
    try {
      raw = await fs.promises.readFile(filePath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') logger.warn?.('[session-todos] failed to read:', error?.message ?? error);
      return;
    }
    let parsed;
    try {
      parsed = storedFileSchema.safeParse(JSON.parse(raw));
    } catch {
      parsed = { success: false };
    }
    // Derived data: a file this version cannot read is rebuilt from the history.
    if (!parsed.success) return;
    for (const [sessionId, value] of Object.entries(parsed.data.sessions)) {
      const record = storedRecordSchema.safeParse(value);
      if (!sessionIdSchema.safeParse(sessionId).success || !record.success || records.has(sessionId)) continue;
      // Invalid derived data is rebuilt; it never becomes an empty success.
      try {
        const todos = parseTodos(record.data.todos);
        records.set(sessionId, { ...record.data, todos, verified: false, generation: ++generation });
      } catch { /* History remains authoritative. */ }
    }
  };

  // ----- State changes -----

  const announce = (sessionId, directory, todos) => {
    revision += 1;
    broadcast({ type: 'openchamber:session-todos', properties: { revision, sessionId, directory, todos } });
  };

  const trim = () => {
    if (records.size <= MAX_SESSIONS) return;
    const oldest = [...records].sort(([, a], [, b]) => a.updatedAt - b.updatedAt);
    for (const [sessionId] of oldest.slice(0, records.size - MAX_SESSIONS)) records.delete(sessionId);
  };

  const writeRecord = (sessionId, directory, todos, checkedThrough) => {
    const previous = records.get(sessionId);
    records.set(sessionId, {
      directory: directory || previous?.directory || '',
      todos,
      checkedThrough: Math.max(checkedThrough ?? 0, previous?.checkedThrough ?? 0) || null,
      updatedAt: now(),
      verified: true,
      generation: ++generation,
    });
    trim();
    schedulePersist();
    announce(sessionId, records.get(sessionId).directory, todos);
  };

  /** The history behind the list changed: it is looked up again from the start on the next read. */
  const invalidate = (sessionId) => {
    const read = reads.get(sessionId);
    if (read) read.current = false;
    for (const [id, call] of openCalls) if (call.sessionId === sessionId) openCalls.delete(id);
    const record = records.get(sessionId);
    if (!record) return;
    const { error: _error, ...previous } = record;
    records.set(sessionId, { ...previous, checkedThrough: null, verified: false, generation: ++generation });
    schedulePersist();
    announce(sessionId, record.directory, null);
  };

  const markUnavailable = (sessionId, directory, error) => {
    const read = reads.get(sessionId);
    if (read) read.current = false;
    const previous = records.get(sessionId);
    records.set(sessionId, {
      directory: directory || previous?.directory || '', todos: previous?.todos ?? [],
      checkedThrough: null, updatedAt: now(), verified: false, generation: ++generation, error,
    });
    trim();
    schedulePersist();
    announce(sessionId, records.get(sessionId).directory, null);
  };

  // ----- Events -----

  const processPayload = (payload) => {
    const kind = payload?.type;
    if (!SESSION_EVENT_TYPES.has(kind) && !(CALL_EVENT_TYPES.has(kind) && openCalls.has(payload.data?.id))) return;
    const event = wireEventSchema.safeParse(payload);
    if (stopped || !event.success) return;
    const { type, data } = event.data;
    const sessionId = data.sessionID ?? '';
    const directory = event.data.location?.directory ?? '';

    switch (type) {
      case 'session.tool.input.started': {
        if (data.name !== TOOL_NAME || !sessionId || !data.id || isSpaceDirectory(directory)) return;
        if (openCalls.size >= MAX_OPEN_CALLS) openCalls.delete(openCalls.keys().next().value);
        openCalls.set(data.id, { sessionId, directory, todos: null });
        if (directory) observed.add(directory);
        return;
      }
      case 'session.tool.called': {
        const call = openCalls.get(data.id);
        if (call) call.todos = data.input?.todos;
        return;
      }
      case 'session.tool.success': {
        const call = openCalls.get(data.id);
        if (!call) return;
        openCalls.delete(data.id);
        // The tool hands its list back as metadata, the same as its input.
        try {
          const value = Object.hasOwn(data.metadata ?? {}, 'todos') ? data.metadata.todos : call.todos;
          const todos = parseTodos(value);
          const at = event.data.created ?? now();
          writeRecord(call.sessionId, call.directory || directory, todos, at);
        } catch (error) {
          markUnavailable(call.sessionId, call.directory || directory, error);
        }
        return;
      }
      case 'session.tool.failed':
        openCalls.delete(data.id);
        return;
      case 'session.revert.staged':
      case 'session.revert.cleared':
      case 'session.revert.committed':
        if (sessionId) invalidate(sessionId);
        return;
      case 'session.deleted':
        invalidate(sessionId);
        if (records.delete(sessionId)) schedulePersist();
        return;
      case 'config.updated':
        configGeneration += 1;
        for (const read of reads.values()) if (!directory || read.directory === directory) read.current = false;
        if (!directory) {
          flags.clear();
          observed.clear();
        } else {
          flags.delete(directory);
          observed.delete(directory);
        }
        revision += 1;
        broadcast({ type: 'openchamber:session-todos', properties: { revision, sessionId: null, directory: directory || null, todos: null } });
        return;
      default:
    }
  };

  /**
   * A gap in OpenCode's stream may hide calls and config changes: everything
   * is checked again when asked, and clients are told to ask, since their own
   * connection to this server may not have dropped.
   */
  const onConnected = () => {
    if (stopped) return;
    configGeneration += 1;
    for (const read of reads.values()) read.current = false;
    openCalls.clear();
    flags.clear();
    // The flag may have been turned off unseen.
    observed.clear();
    versionRead = null;
    for (const [sessionId, record] of records) {
      if (record.verified || record.error) {
        const { error: _error, ...previous } = record;
        records.set(sessionId, { ...previous, verified: false, generation: ++generation });
      }
    }
    revision += 1;
    broadcast({ type: 'openchamber:session-todos', properties: { revision, sessionId: null, directory: null, todos: null } });
  };

  // ----- Whether the tool is on -----

  const readVersion = () => {
    versionRead ??= readJson('/api/info').then((info) => infoSchema.parse(info).version);
    versionRead.catch(() => { versionRead = null; });
    return versionRead;
  };

  const readFlag = async (directory) => {
    const override = flagFromOverrides(getFlagOverrides());
    if (override !== undefined) return override;
    const configured = flagFromConfig(configEntriesSchema.parse(await readJson('/api/config', { directory })));
    if (configured !== undefined) return configured;
    return flagOnByDefault(await readVersion());
  };

  /** Throws when it cannot be told; the caller keeps what it shows. */
  const isEnabled = async (directory) => {
    if (observed.has(directory)) return true;
    let pending = flags.get(directory);
    if (!pending) {
      pending = readFlag(directory);
      flags.set(directory, pending);
      pending.catch(() => {
        if (flags.get(directory) === pending) flags.delete(directory);
      });
    }
    return pending;
  };

  // ----- The history -----

  const readPage = async (sessionId, cursor) => {
    // The type filter travels with every page; the order rides in the cursor.
    const query = cursor
      ? { limit: String(PAGE_SIZE), cursor, type: 'assistant' }
      : { limit: String(PAGE_SIZE), order: 'desc', type: 'assistant' };
    return pageSchema.parse(await readJson(`/api/session/${encodeURIComponent(sessionId)}/message`, { query }));
  };

  /** Creation time of the session's revert boundary, null without one. */
  const readBoundary = async (sessionId) => {
    const session = sessionSchema.parse(await readJson(`/api/session/${encodeURIComponent(sessionId)}`));
    if (session.location && isSpaceDirectory(session.location.directory)) throw new UnsupportedSessionTodosError();
    const messageId = session.revert?.messageID;
    if (!messageId) return null;
    const message = await readJson(`/api/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`);
    return createdSchema.parse(message).time.created;
  };

  /**
   * Walks the session's agent messages newest first until the newest
   * completed `todowrite` call before the revert boundary, or until a message
   * that finished by the time the stored list accounts for. A walk that
   * reaches the start of the history without a call settles on "no list".
   * `newest` is the latest finish time the walk saw, the next `checkedThrough`.
   */
  const findInHistory = async (sessionId, checkedThrough) => {
    const boundary = await readBoundary(sessionId);
    // A revert this server did not see may have hidden the stored list's call.
    const stopAt = boundary !== null && checkedThrough !== null && checkedThrough >= boundary ? null : checkedThrough;
    let newest = null;
    let cursor;
    const seen = new Set();
    for (;;) {
      const page = await readPage(sessionId, cursor);
      for (const value of page.data) {
        const time = messageTimeSchema.safeParse(value);
        if (!time.success) continue;
        const { created, completed } = time.data.time;
        if (boundary !== null && created >= boundary) continue;
        if (stopAt !== null && completed !== undefined && completed <= stopAt) return { todos: null, newest };
        if (completed !== undefined) newest = Math.max(newest ?? 0, completed);
        const todos = todosInMessage(value);
        if (todos) return { todos, newest };
      }
      const next = page.cursor?.next;
      if (next && (page.data.length === 0 || seen.has(next))) throw new Error('Invalid session history cursor');
      if (!next) return { todos: [], newest };
      seen.add(next);
      cursor = next;
    }
  };

  const refreshFromHistory = (sessionId, directory) => {
    const running = reads.get(sessionId);
    if (running) return running.promise;
    const before = records.get(sessionId);
    const startedAt = before?.generation ?? null;
    const owner = { current: true, directory, promise: Promise.resolve() };
    const run = lane.then(async () => {
      if (stopped) throw new Error('Session todos runtime stopped');
      if (!owner.current) throw new Error('Session todos changed while reading');
      const found = await findInHistory(sessionId, before?.checkedThrough ?? null);
      if (stopped) throw new Error('Session todos runtime stopped');
      if (!owner.current) throw new Error('Session todos changed while reading');
      // An event wrote a newer list meanwhile.
      if ((records.get(sessionId)?.generation ?? null) !== startedAt) return;
      const todos = found.todos ?? before?.todos ?? [];
      const unchanged = before && found.todos === null;
      if (unchanged) {
        records.set(sessionId, { ...before, checkedThrough: Math.max(found.newest ?? 0, before.checkedThrough ?? 0) || null, verified: true, generation: ++generation });
        schedulePersist();
        return;
      }
      writeRecord(sessionId, directory, todos, found.newest ?? now());
    });
    lane = run.catch(() => {});
    const tracked = run.finally(() => {
      if (reads.get(sessionId) === owner) reads.delete(sessionId);
    });
    owner.promise = tracked;
    reads.set(sessionId, owner);
    return tracked;
  };

  /**
   * What the Work Status section shows for a session: `off` while the tool is
   * off in the session's directory (and for an isolated space, whose history
   * this server cannot read), else the list. Throws when it cannot be told.
   */
  const read = async (sessionId, directory) => {
    if (stopped) throw new Error('Session todos runtime stopped');
    if (isSpaceDirectory(directory)) return { revision, state: 'unsupported' };
    const startedAt = configGeneration;
    const enabled = await isEnabled(directory);
    if (stopped) throw new Error('Session todos runtime stopped');
    if (startedAt !== configGeneration) throw new Error('Session todos configuration changed while reading');
    if (!enabled) return { revision, state: 'off' };
    try {
      if (records.get(sessionId)?.error) throw records.get(sessionId).error;
      if (!records.get(sessionId)?.verified) await refreshFromHistory(sessionId, directory);
    } catch (error) {
      if (error instanceof UnsupportedSessionTodosError) return { revision, state: 'unsupported' };
      throw error;
    }
    if (stopped) throw new Error('Session todos runtime stopped');
    return { revision, state: 'ready', todos: records.get(sessionId)?.todos ?? [] };
  };

  const start = async () => {
    await load();
    if (stopped) return;
    unsubscribers.push(globalEventHub.subscribeEvent((event) => processPayload(event?.payload)));
    unsubscribers.push(globalEventHub.subscribeStatus((status) => {
      if (status?.type === 'connect') onConnected();
    }));
  };

  const stop = async () => {
    stopped = true;
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe?.();
    if (persistTimer) {
      clearTimer(persistTimer);
      persistTimer = null;
      await writeFile();
    }
    await writeChain;
  };

  return { start, stop, read, processPayload, onConnected };
};
