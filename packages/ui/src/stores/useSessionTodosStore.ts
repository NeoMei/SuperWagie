import { create } from 'zustand';
import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { isSpaceDirectory } from '@/lib/spaces/space-route';

const sessionTodoSchema = z.object({
  content: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']).catch('pending'),
});
export type SessionTodo = z.infer<typeof sessionTodoSchema>;
const answerSchema = z.discriminatedUnion('state', [
  z.object({ revision: z.number(), state: z.literal('off') }),
  z.object({ revision: z.number(), state: z.literal('unsupported') }),
  z.object({ revision: z.number(), state: z.literal('ready'), todos: z.array(sessionTodoSchema) }),
]);
export const sessionTodosEventSchema = z.object({
  revision: z.number(),
  sessionId: z.string().min(1).nullable(),
  directory: z.string().min(1).nullable(),
  todos: z.array(sessionTodoSchema).nullable(),
});
export type SessionTodosEvent = z.infer<typeof sessionTodosEventSchema>;
type SessionTodosEntry = {
  directory: string;
  state: 'loading' | 'off' | 'unsupported' | 'ready';
  todos: SessionTodo[];
  revision: number | null;
  failures: number;
  stale: boolean;
};

type SessionTodosState = {
  entries: Record<string, SessionTodosEntry>;
  epoch: number;
  load: (sessionId: string, directory: string, isCurrent?: () => boolean) => Promise<void>;
  watch: (sessionId: string, directory: string, isCurrent: () => boolean) => () => void;
  applyEvent: (event: SessionTodosEvent, isCurrent: () => boolean) => void;
  refreshActive: (isCurrent: () => boolean) => void;
  reset: () => void;
};
const EMPTY: SessionTodo[] = [];
const inFlight = new Map<string, { promise: Promise<void>; again: boolean; directory: string }>();
const watchers = new Map<string, { count: number; directory: string }>();
let generation = 0;

/** Derived per-session lists. Only mounted sessions request history after invalidation. */
export const useSessionTodosStore = create<SessionTodosState>()((set, get) => {
  const commit = (sessionId: string, entry: SessionTodosEntry) => {
    const current = get().entries[sessionId];
    if (current?.revision != null && entry.revision != null && entry.revision < current.revision) return;
    set({ entries: { ...get().entries, [sessionId]: entry } });
  };
  const reload = (sessionId: string, directory: string, isCurrent: () => boolean) => {
    const pending = inFlight.get(sessionId);
    if (pending) pending.again = true;
    void get().load(sessionId, directory, isCurrent).catch(() => { /* The entry retains the failure. */ });
  };
  const invalidate = (sessionId: string, entry: SessionTodosEntry, isCurrent: () => boolean, revision = entry.revision) => {
    if (revision !== null && entry.revision !== null && revision < entry.revision) return;
    commit(sessionId, { ...entry, stale: true, revision });
    if (watchers.get(sessionId)?.directory === entry.directory) reload(sessionId, entry.directory, isCurrent);
  };
  return {
    entries: {},
    epoch: 0,
    load: (sessionId, directory, isCurrent = () => true) => {
      if (isSpaceDirectory(directory)) {
        commit(sessionId, { directory, state: 'unsupported', todos: EMPTY, revision: null, failures: 0, stale: false });
        return Promise.resolve();
      }
      const running = inFlight.get(sessionId);
      if (running?.directory === directory) return running.promise;
      const owner = generation;
      const valid = () => owner === generation && isCurrent() && inFlight.get(sessionId) === slot;
      const existing = get().entries[sessionId];
      if (!existing || existing.directory !== directory) {
        set({ entries: { ...get().entries, [sessionId]: { directory, state: 'loading', todos: EMPTY, revision: null, failures: 0, stale: true } } });
      }
      const slot = { promise: Promise.resolve(), again: false, directory };
      inFlight.set(sessionId, slot);
      slot.promise = (async () => {
        try {
          do {
            slot.again = false;
            const response = await runtimeFetch(`/api/session-todos/${encodeURIComponent(sessionId)}`, { query: { directory }, headers: { Accept: 'application/json' } });
            if (!response.ok) throw new Error(`Session todos request failed with ${response.status}`);
            const answer = answerSchema.parse(await response.json());
            if (!valid()) return;
            commit(sessionId, {
              directory, state: answer.state, todos: answer.state === 'ready' ? answer.todos : EMPTY,
              revision: answer.revision, failures: 0, stale: false,
            });
          } while (slot.again && valid());
        } catch (error) {
          const entry = get().entries[sessionId];
          if (entry && valid()) set({ entries: { ...get().entries, [sessionId]: { ...entry, failures: entry.failures + 1, stale: true } } });
          throw error;
        } finally {
          if (inFlight.get(sessionId) === slot) inFlight.delete(sessionId);
        }
      })();
      return slot.promise;
    },
    watch: (sessionId, directory, isCurrent) => {
      const previous = watchers.get(sessionId);
      const owner = previous?.directory === directory ? previous : { count: 0, directory };
      owner.count += 1;
      watchers.set(sessionId, owner);
      const entry = get().entries[sessionId];
      if (!entry || entry.directory !== directory || entry.stale) reload(sessionId, directory, isCurrent);
      return () => {
        if (watchers.get(sessionId) !== owner) return;
        owner.count -= 1;
        if (owner.count === 0) watchers.delete(sessionId);
      };
    },
    applyEvent: (event, isCurrent) => {
      if (!isCurrent()) return;
      const { entries } = get();
      if (event.sessionId === null) {
        for (const [sessionId, entry] of Object.entries(entries)) {
          if (event.directory === null || entry.directory === event.directory) invalidate(sessionId, entry, isCurrent, event.revision);
        }
        return;
      }
      const entry = entries[event.sessionId];
      if (!entry || (event.directory !== null && event.directory !== entry.directory) || (entry.revision !== null && event.revision < entry.revision)) return;
      if (event.todos === null) invalidate(event.sessionId, entry, isCurrent, event.revision);
      else commit(event.sessionId, { ...entry, state: 'ready', todos: event.todos, revision: event.revision, failures: 0, stale: false });
    },
    refreshActive: (isCurrent) => {
      if (!isCurrent()) return;
      for (const [sessionId, entry] of Object.entries(get().entries)) invalidate(sessionId, entry, isCurrent);
    },
    reset: () => {
      generation += 1;
      inFlight.clear();
      watchers.clear();
      set({ entries: {}, epoch: generation });
    },
  };
});
