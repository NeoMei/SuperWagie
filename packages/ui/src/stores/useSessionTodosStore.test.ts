import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { useSessionTodosStore } from './useSessionTodosStore';

const originalFetch = globalThis.fetch;
const todos = [{ content: 'Current step', status: 'in_progress' as const }];
let requests = 0;
let respond: () => Promise<Response>;
beforeEach(() => {
  useSessionTodosStore.getState().reset();
  requests = 0;
  respond = async () => Response.json({ revision: 1, state: 'ready', todos });
  globalThis.fetch = Object.assign(async () => { requests += 1; return respond(); }, originalFetch);
});
afterEach(() => { globalThis.fetch = originalFetch; useSessionTodosStore.getState().reset(); });

describe('session todo state', () => {
  test('retains the last successful list and exposes a failed read separately', async () => {
    await useSessionTodosStore.getState().load('ses_a', '/repo');
    respond = async () => new Response('unavailable', { status: 502 });
    await expect(useSessionTodosStore.getState().load('ses_a', '/repo')).rejects.toThrow();
    expect(useSessionTodosStore.getState().entries.ses_a).toMatchObject({ state: 'ready', todos, failures: 1 });
  });

  test('a response started before reset cannot restore the retired runtime', async () => {
    let finish: (response: Response) => void = () => {};
    let begin: () => void = () => {};
    const started = new Promise<void>((resolve) => { begin = resolve; });
    respond = () => new Promise((resolve) => { finish = resolve; begin(); });
    const pending = useSessionTodosStore.getState().load('ses_a', '/repo');
    await started;
    useSessionTodosStore.getState().reset();
    finish(Response.json({ revision: 50, state: 'ready', todos }));
    await pending;
    expect(useSessionTodosStore.getState().entries).toEqual({});
  });

  test('an older fetch cannot replace a newer successful event', async () => {
    await useSessionTodosStore.getState().load('ses_a', '/repo');
    useSessionTodosStore.getState().applyEvent({ revision: 3, sessionId: 'ses_a', directory: '/repo', todos: [] }, () => true);
    await useSessionTodosStore.getState().load('ses_a', '/repo');
    expect(useSessionTodosStore.getState().entries.ses_a).toMatchObject({ revision: 3, todos: [] });
  });

  test('config and gap events do not load history for inactive sessions', async () => {
    await useSessionTodosStore.getState().load('ses_a', '/repo');
    useSessionTodosStore.getState().applyEvent({ revision: 2, sessionId: null, directory: null, todos: null }, () => true);
    await Promise.resolve();
    expect(requests).toBe(1);
    expect(useSessionTodosStore.getState().entries.ses_a?.stale).toBe(true);
  });

  test('a mounted session refreshes after a gap and stops requesting after release', async () => {
    const release = useSessionTodosStore.getState().watch('ses_a', '/repo', () => true);
    await useSessionTodosStore.getState().load('ses_a', '/repo');
    respond = async () => Response.json({ revision: 2, state: 'ready', todos: [] });
    useSessionTodosStore.getState().applyEvent({ revision: 2, sessionId: null, directory: null, todos: null }, () => true);
    await useSessionTodosStore.getState().load('ses_a', '/repo');
    expect(useSessionTodosStore.getState().entries.ses_a).toMatchObject({ revision: 2, todos: [], stale: false });
    expect(requests).toBe(2);
    release();
    useSessionTodosStore.getState().applyEvent({ revision: 3, sessionId: null, directory: null, todos: null }, () => true);
    await Promise.resolve();
    expect(requests).toBe(2);
  });

  test('off, confirmed empty and unsupported remain distinct', async () => {
    respond = async () => Response.json({ revision: 1, state: 'off' });
    await useSessionTodosStore.getState().load('ses_off', '/repo');
    respond = async () => Response.json({ revision: 1, state: 'unsupported' });
    await useSessionTodosStore.getState().load('ses_space', '/space');
    respond = async () => Response.json({ revision: 1, state: 'ready', todos: [] });
    await useSessionTodosStore.getState().load('ses_empty', '/repo');
    expect(useSessionTodosStore.getState().entries.ses_off?.state).toBe('off');
    expect(useSessionTodosStore.getState().entries.ses_space?.state).toBe('unsupported');
    expect(useSessionTodosStore.getState().entries.ses_empty).toMatchObject({ state: 'ready', todos: [] });
  });
});
