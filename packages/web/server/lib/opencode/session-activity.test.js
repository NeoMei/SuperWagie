import { describe, expect, it } from 'vitest';
import { createSessionActivityProbe } from './session-activity.js';

const createProbe = (sessions, { failureId, timeoutMs = 10_000, delayMs = 0 } = {}) => {
  const reads = [];
  const signals = new Set();
  const probe = createSessionActivityProbe({
    buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
    getOpenCodeAuthHeaders: () => ({}),
    timeoutMs,
    fetchImpl: async (url, init) => {
      const id = decodeURIComponent(new URL(url).pathname.split('/').at(-1));
      reads.push(id);
      signals.add(init.signal);
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (id === failureId) return new Response(null, { status: 503 });
      return Response.json({ data: sessions[id] ?? null });
    },
  });
  return { probe, reads, signals };
};

describe('queue descendant activity', () => {
  const running = { type: 'running' };

  it('detects a live grandchild through an idle intermediate session', async () => {
    const { probe, reads } = createProbe({ child: { id: 'child', parentID: 'root' }, grandchild: { id: 'grandchild', parentID: 'child' } });
    expect(await probe.hasWorkingDescendants('root', { grandchild: running })).toBe(true);
    expect(reads).toEqual(['grandchild', 'child']);
    expect(await probe.hasWorkingDescendants('root', {})).toBe(false);
    expect(reads).toHaveLength(2);
  });

  it('does not block on an unrelated active tree or count the parent itself', async () => {
    const { probe, reads } = createProbe({ other: { id: 'other' }, child: { id: 'child', parentID: 'other' } });
    expect(await probe.hasWorkingDescendants('root', { root: running, child: running })).toBe(false);
    expect(reads).toEqual(['child', 'other']);
  });

  it('reads shared ancestry once within a probe and refreshes it on the next probe', async () => {
    const sessions = { other: { id: 'other' } };
    const statuses = {};
    for (let index = 0; index < 100; index += 1) {
      const id = `child_${index}`;
      sessions[id] = { id, parentID: 'other' };
      statuses[id] = running;
    }
    const { probe, reads, signals } = createProbe(sessions);
    expect(await probe.hasWorkingDescendants('root', statuses)).toBe(false);
    expect(reads).toHaveLength(101);
    expect(signals.size).toBe(1);
    sessions.other.parentID = 'root';
    expect(await probe.hasWorkingDescendants('root', { child_0: running })).toBe(true);
    expect(reads).toHaveLength(103);
  });

  it('keeps unreadable lineage unknown and allows a later successful read', async () => {
    const sessions = { grandchild: { id: 'grandchild', parentID: 'child' }, child: { id: 'child', parentID: 'root' } };
    const { probe } = createProbe(sessions, { failureId: 'child' });
    expect(await probe.hasWorkingDescendants('root', { grandchild: running })).toBeNull();
    expect(await createProbe(sessions).probe.hasWorkingDescendants('root', { grandchild: running })).toBe(true);
  });

  it('rejects missing, malformed and mismatched session records', async () => {
    for (const record of [null, {}, { id: 'other' }, { id: 'child', parentID: 123 }, { id: 'child', parentID: '' }]) {
      const { probe } = createProbe({ child: record });
      expect(await probe.hasWorkingDescendants('root', { child: running })).toBeNull();
    }
  });

  it('still reports a proven descendant when another active lineage fails', async () => {
    const { probe } = createProbe({ child: { id: 'child', parentID: 'root' } });
    expect(await probe.hasWorkingDescendants('root', { missing: running, child: running })).toBe(true);
  });

  it('bounds cyclic lineage and preserves the unknown result', async () => {
    const { probe, reads } = createProbe({ a: { id: 'a', parentID: 'b' }, b: { id: 'b', parentID: 'a' } });
    expect(await probe.hasWorkingDescendants('root', { a: running })).toBeNull();
    expect(reads).toEqual(['a', 'b']);
  });

  it('accepts an eighth-level descendant and treats a deeper chain as unrelated', async () => {
    const sessions = {};
    for (let depth = 1; depth <= 9; depth += 1) sessions[`child_${depth}`] = { id: `child_${depth}`, parentID: depth === 1 ? 'root' : `child_${depth - 1}` };
    const { probe, reads } = createProbe(sessions);
    expect(await probe.hasWorkingDescendants('root', { child_8: running })).toBe(true);
    expect(reads).toHaveLength(8);
    expect(await probe.hasWorkingDescendants('root', { child_9: running })).toBe(false);
    expect(reads).toHaveLength(16);
  });

  it('uses one deadline for the entire lineage walk', async () => {
    const { probe, reads } = createProbe({ child: { id: 'child', parentID: 'parent' } }, { timeoutMs: 1, delayMs: 10 });
    expect(await probe.hasWorkingDescendants('root', { child: running })).toBeNull();
    expect(reads).toEqual(['child']);
  });
});

describe('running background jobs', () => {
  const makeJobProbe = (answer, source = 'host') => {
    const requests = [];
    const probe = createSessionActivityProbe({
      buildOpenCodeUrl: (route) => `http://${source}.test${route}`,
      getOpenCodeAuthHeaders: () => ({}),
      fetchImpl: async (url, init) => {
        requests.push({ url: new URL(url), headers: new Headers(init.headers) });
        return answer(init);
      },
    });
    return { probe, requests };
  };

  it('reads the session tree globally with its owner IDs and no directory startup', async () => {
    const { probe, requests } = makeJobProbe(() => Response.json({ data: [
      { kind: 'image', sessionID: 'grandchild', status: 'running', time: { started: 1 } },
      { kind: 'shell', sessionID: 'root', status: 'running', command: 'bun test', time: { started: 2 } },
      { kind: 'subagent', sessionID: 'root', status: 'completed', time: { started: 3 } },
    ] }));
    expect(await probe.fetchRunningBackgroundJobs('root')).toEqual([
      { kind: 'image', sessionID: 'grandchild', command: undefined, startedAt: 1 },
      { kind: 'shell', sessionID: 'root', command: 'bun test', startedAt: 2 },
    ]);
    expect(requests[0].url.pathname).toBe('/api/experimental/job');
    expect(Object.fromEntries(requests[0].url.searchParams)).toEqual({ sessionID: 'root', descendants: 'true', status: 'running' });
    expect(requests[0].headers.has('x-opencode-directory')).toBe(false);
  });

  it('distinguishes authoritative empty jobs from an explicitly absent route', async () => {
    expect(await makeJobProbe(() => Response.json({ data: [] })).probe.fetchRunningBackgroundJobs('root')).toEqual([]);
    expect(await makeJobProbe(() => new Response(null, { status: 404 })).probe.fetchRunningBackgroundJobs('root')).toBeUndefined();
  });

  it.each(['completed', 'error', 'cancelled'])('excludes a valid %s job from running work', async (status) => {
    expect(await makeJobProbe(() => Response.json({ data: [
      { kind: 'image', sessionID: 'root', status, time: { started: 1 } },
    ] })).probe.fetchRunningBackgroundJobs('root')).toEqual([]);
  });

  it('keeps a session-only adapter on its explicit legacy capability without probing another runtime', async () => {
    let reads = 0;
    const probe = createSessionActivityProbe({
      buildOpenCodeUrl: () => 'http://space.test', getOpenCodeAuthHeaders: () => ({}),
      supportsBackgroundJobs: false,
      fetchImpl: async () => { reads += 1; throw new Error('job route is outside this adapter'); },
    });
    expect(await probe.fetchRunningBackgroundJobs('root')).toBeUndefined();
    expect(reads).toBe(0);
  });

  it.each([
    () => Response.json({ _tag: 'SessionNotFoundError', message: 'missing session' }, { status: 404 }),
    () => Response.json({ error: 'ambiguous 404' }, { status: 404 }),
    () => new Response('broken json', { status: 404 }),
    () => new Response(null, { status: 503 }),
    () => Response.json({ data: {} }),
    () => Response.json({ data: [{ kind: 'image', sessionID: '', status: 'running', time: { started: 1 } }] }),
    () => Response.json({ data: [{ kind: 'image', sessionID: 'root', status: 'not-a-job-status', time: { started: 1 } }] }),
    () => { throw new DOMException('Timed out', 'TimeoutError'); },
  ])('keeps failed, malformed or missing-session job reads unknown', async (answer) => {
    expect(await makeJobProbe(answer).probe.fetchRunningBackgroundJobs('root')).toBeNull();
  });

  it('keeps independent runtime results for the same session ID and refreshes every read', async () => {
    let jobs = [{ kind: 'image', sessionID: 'root', status: 'running', time: { started: 1 } }];
    const a = makeJobProbe(() => Response.json({ data: jobs }), 'instance-a');
    const b = makeJobProbe(() => Response.json({ data: [] }), 'instance-b');
    expect(await a.probe.fetchRunningBackgroundJobs('root')).toHaveLength(1);
    expect(await b.probe.fetchRunningBackgroundJobs('root')).toEqual([]);
    jobs = [];
    expect(await a.probe.fetchRunningBackgroundJobs('root')).toEqual([]);
    expect(a.requests.map((request) => request.url.hostname)).toEqual(['instance-a.test', 'instance-a.test']);
    expect(b.requests[0].url.hostname).toBe('instance-b.test');
  });

  it('does not carry an old runtime capability result through an instance switch', async () => {
    let origin = 'http://instance-a.test';
    let legacy = true;
    const probe = createSessionActivityProbe({
      buildOpenCodeUrl: (route) => `${origin}${route}`, getOpenCodeAuthHeaders: () => ({}),
      fetchImpl: async (url) => {
        if (new URL(url).hostname === 'instance-a.test') return legacy ? new Response(null, { status: 404 }) : Response.json({ data: [] });
        return Response.json({ data: [{ kind: 'image', sessionID: 'root', status: 'running', time: { started: 1 } }] });
      },
    });
    expect(await probe.fetchRunningBackgroundJobs('root')).toBeUndefined();
    origin = 'http://instance-b.test';
    expect(await probe.fetchRunningBackgroundJobs('root')).toHaveLength(1);
    origin = 'http://instance-a.test';
    legacy = false;
    expect(await probe.fetchRunningBackgroundJobs('root')).toEqual([]);
  });

  it('keeps an expired job request unknown', async () => {
    const probe = createSessionActivityProbe({
      buildOpenCodeUrl: (route) => `http://instance.test${route}`, getOpenCodeAuthHeaders: () => ({}), timeoutMs: 1,
      fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    });
    expect(await probe.fetchRunningBackgroundJobs('root')).toBeNull();
  });
});
