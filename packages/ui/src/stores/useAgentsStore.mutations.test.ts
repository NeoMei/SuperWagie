import { beforeEach, expect, spyOn, test } from 'bun:test';
import {
  setup, deferred, setResponder, defaultResponse, requests, switchTo, useAgentsStore,
  agent, selectAgentsForDirectory, useProjectsStore, until,
} from '@/components/sections/agents/agentMutationTestUtils';
import { subscribeToConfigChanges } from '@/lib/configSync';

beforeEach(setup);
const begin = (method: string, directory = '/fixture') => method === 'POST'
  ? useAgentsStore.getState().createAgent({ name: 'lab', system: 'changed', scope: 'project' }, directory)
  : method === 'PATCH' ? useAgentsStore.getState().updateAgent('lab', { system: 'changed' }, directory)
    : useAgentsStore.getState().deleteAgent('lab', 'project', directory);
for (const method of ['POST', 'PATCH', 'DELETE']) {
  for (const roundTrip of [false, true]) {
    for (const outcome of ['success', 'manual', 'http', 'throw']) {
      test(`${method} rejects retired ${outcome} completion after ${roundTrip ? 'ABA' : 'AB'}`, async () => {
        const held = deferred<Response>();
        const errors = spyOn(console, 'error').mockImplementation(() => undefined);
        let events = 0; const unsubscribe = subscribeToConfigChanges(() => { events += 1; });
        setResponder(async (entry) => entry.method === method && entry.path.includes('/config/agents/') ? held.promise : defaultResponse(entry));
        const settled = begin(method).then((result) => result, (reason: Error) => ({ reason }));
        try {
          await until(() => requests.some((entry) => entry.path.includes('/config/agents/') && entry.method === method));
          switchTo('b'); if (roundTrip) switchTo('a');
          const newer = { name: 'newer', scope: 'user' as const };
          useAgentsStore.setState({ agents: [agent('newer')], agentsByDirectory: { '/fixture': [agent('newer')] }, selectedAgentName: 'lab', agentDraft: newer });
          const before = requests.length;
          if (outcome === 'throw') held.fail(new Error('old network'));
          else held.finish(Response.json(outcome === 'manual' ? { requiresManualRestart: true } : outcome === 'http' ? { error: 'old error' } : {}, { status: outcome === 'http' ? 500 : 200 }));
          expect(await settled).toEqual({ ok: false });
          expect(requests.slice(before).filter((entry) => entry.path.startsWith('/api/'))).toEqual([]);
          expect(selectAgentsForDirectory(useAgentsStore.getState(), '/fixture').map((entry) => entry.name)).toEqual(['newer']);
          expect(useAgentsStore.getState().agents.map((entry) => entry.name)).toEqual(['newer']);
          expect(useAgentsStore.getState().selectedAgentName).toBe('lab');
          expect(useAgentsStore.getState().agentDraft).toBe(newer);
          expect(events).toBe(0); expect(errors).not.toHaveBeenCalled();
        } finally { held.finish(Response.json({})); await settled; errors.mockRestore(); unsubscribe(); }
      });
    }
  }
  test(`${method} manual completion updates requested catalog and preserves ambient`, async () => {
    useAgentsStore.setState({ agents: [agent('ambient')], agentsByDirectory: { '/fixture': [agent('ambient')], '/other': [agent()] } });
    setResponder(async (entry) => entry.method === method ? Response.json({ requiresManualRestart: true }) : defaultResponse(entry));
    const result = await begin(method, '/other');
    expect(result).toEqual({ ok: true, requiresManualRestart: true });
    expect(useAgentsStore.getState().agents.map((entry) => entry.name)).toEqual(['ambient']);
    const entries = selectAgentsForDirectory(useAgentsStore.getState(), '/other');
    if (method === 'DELETE') expect(entries).toEqual([]);
    else expect(entries.find((entry) => entry.name === 'lab')?.system).toBe('changed');
  });
  test(`${method} manual completion preserves unknown catalog authority`, async () => {
    setResponder(async (entry) => entry.method === method ? Response.json({ requiresManualRestart: true }) : defaultResponse(entry));
    expect((await begin(method, '/unknown')).ok).toBe(true);
    expect(Object.hasOwn(useAgentsStore.getState().agentsByDirectory, '/unknown')).toBe(false);
  });
  test(`${method} returns retired failure after list refresh`, async () => {
    const list = deferred<Response>();
    setResponder(async (entry) => entry.path.endsWith('/agent') ? list.promise : defaultResponse(entry));
    const pending = begin(method);
    try {
      const { until } = await import('@/components/sections/agents/agentMutationTestUtils');
      await until(() => requests.some((entry) => entry.path.endsWith('/agent')));
      switchTo('b'); switchTo('a');
      list.finish(Response.json({ data: [] }));
      expect(await pending).toEqual({ ok: false });
    } finally { list.finish(Response.json({ data: [] })); await pending; }
  });
}
for (const resource of ['config', 'permissions', 'disabled']) {
  test(`${resource} read rejects retired authority and reset clears disabled inventory`, async () => {
    const held = deferred<Response>();
    setResponder(async (entry) => entry.path.endsWith(resource === 'disabled' ? '/disabled-agents' : `/${resource}`) ? held.promise : defaultResponse(entry));
    useAgentsStore.setState({ disabledAgentsByDirectory: { '/fixture': [{ name: 'old', scope: 'project', path: '/fixture/old.md' }] } });
    const pending = resource === 'config' ? useAgentsStore.getState().fetchAgentEntity('lab', '/fixture')
      : resource === 'permissions' ? useAgentsStore.getState().fetchAgentPermissions('lab', '/fixture')
        : useAgentsStore.getState().loadDisabledAgents('/fixture');
    switchTo('b'); switchTo('a');
    held.finish(Response.json(resource === 'disabled' ? { agents: [{ name: 'old', scope: 'project', path: '/fixture/old.md' }] } : {}));
    expect(await pending).toBe(resource === 'disabled' ? false : null);
    expect(useAgentsStore.getState().disabledAgentsByDirectory).toEqual({});
  });
}
test('manual completion tests ambient directory at commit time', async () => {
  const held = deferred<Response>();
  setResponder(async (entry) => entry.method === 'PATCH' ? held.promise : defaultResponse(entry));
  const pending = begin('PATCH');
  useProjectsStore.setState({ activeProjectId: 'other' });
  useAgentsStore.setState({ agents: [agent('new-ambient')] });
  held.finish(Response.json({ requiresManualRestart: true }));
  expect((await pending).ok).toBe(true);
  expect(useAgentsStore.getState().agents.map((entry) => entry.name)).toEqual(['new-ambient']);
  expect(selectAgentsForDirectory(useAgentsStore.getState(), '/fixture')[0].system).toBe('changed');
});

for (const method of ['POST', 'PATCH', 'DELETE']) {
  test(`${method} rejects a runtime switch while JSON decoding is pending`, async () => {
    const body = deferred<string>(); const started = deferred<void>();
    setResponder(async (entry) => {
      if (entry.method !== method || !entry.path.includes('/config/agents/')) return defaultResponse(entry);
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        started.finish();
        void body.promise.then((value) => { controller.enqueue(new TextEncoder().encode(value)); controller.close(); });
      } }));
    });
    const pending = begin(method);
    await started.promise;
    switchTo('b'); switchTo('a');
    body.finish('{}');
    expect(await pending).toEqual({ ok: false });
  });
}
test('newer disabled inventory wins over a read started before mutation invalidation', async () => {
  const older = deferred<string>(); let reads = 0;
  setResponder(async (entry) => {
    if (entry.path.endsWith('/disabled-agents')) {
      reads += 1;
      if (reads !== 1) return Response.json({ agents: [] });
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        void older.promise.then((value) => { controller.enqueue(new TextEncoder().encode(value)); controller.close(); });
      } }));
    }
    return defaultResponse(entry);
  });
  const oldRead = useAgentsStore.getState().loadDisabledAgents('/fixture');
  await until(() => reads === 1);
  try {
    expect((await useAgentsStore.getState().updateAgent('lab', { disabled: false }, '/fixture')).ok).toBe(true);
    older.finish(JSON.stringify({ agents: [{ name: 'lab', scope: 'project', path: '/fixture/lab.md' }] }));
    expect(await oldRead).toBe(false);
    expect(useAgentsStore.getState().disabledAgentsByDirectory['/fixture']).toEqual([]);
  } finally { older.finish('{"agents":[]}'); await oldRead; }
});
