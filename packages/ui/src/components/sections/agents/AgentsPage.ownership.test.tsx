import { beforeEach, expect, test } from 'bun:test';
import {
  setup, act, mount, unmount, button, change, deferred, setResponder, defaultResponse,
  mutations, switchTo, useAgentsStore, useUIStore, success, error, agent, envelope,
} from './agentMutationTestUtils';
const { AgentsPage } = await import('./AgentsPage');
beforeEach(setup);
const retire = async (kind: string) => {
  await act(async () => {
    if (kind === 'runtime') { switchTo('b'); switchTo('a'); }
    else if (kind === 'directory') { useUIStore.setState({ settingsProjectPath: '/other' }); useUIStore.setState({ settingsProjectPath: '/fixture' }); }
    else { useAgentsStore.getState().setSelectedAgent('other'); useAgentsStore.getState().setSelectedAgent('lab'); }
  });
  if (kind === 'unmount') await unmount();
};
for (const kind of ['runtime', 'directory', 'selection', 'unmount']) {
  for (const failure of [false, true]) {
    test(`create preserves replacement draft after ${kind} and ${failure ? 'failure' : 'success'}`, async () => {
      const held = deferred<Response>();
      setResponder(async (entry) => entry.method === 'POST' ? held.promise : defaultResponse(entry));
      useAgentsStore.setState({ selectedAgentName: 'new', agentDraft: { name: 'new', scope: 'user' } });
      await mount(<AgentsPage />); await act(async () => button('Create').click());
      expect(mutations()).toHaveLength(1);
      await retire(kind);
      const newer = { name: 'newer', scope: 'user' as const };
      await act(async () => useAgentsStore.setState({ selectedAgentName: 'newer', agentDraft: newer }));
      success.mockClear(); error.mockClear();
      await act(async () => held.finish(Response.json(failure ? { error: 'old error' } : {}, { status: failure ? 500 : 200 })));
      expect(useAgentsStore.getState().agentDraft).toBe(newer);
      expect(useAgentsStore.getState().selectedAgentName).toBe('newer');
      expect(success).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
    });
  }
}
for (const kind of ['runtime', 'directory', 'selection', 'unmount']) {
  test(`permissions save cannot chain page PATCH after ${kind}`, async () => {
    const held = deferred<Response>();
    setResponder(async (entry) => entry.method === 'PATCH' ? held.promise : defaultResponse(entry));
    await mount(<AgentsPage />);
    const system = [...document.querySelectorAll<HTMLTextAreaElement>('textarea')].find((node) => node.value === 'initial');
    if (!system) throw new Error('Missing hydrated system');
    await change(system, 'edited');
    // The global permission chip triggers the page save with both a dirty
    // permission model and dirty system text. No blur starts an earlier write.
    const deny = [...document.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === 'Deny');
    if (!deny) throw new Error('Missing permission Deny chip');
    await act(async () => deny.click());
    expect(mutations()).toHaveLength(1);
    expect(JSON.parse(mutations()[0].body ?? '{}')).toHaveProperty('permissions');
    await retire(kind);
    error.mockClear();
    await act(async () => held.finish(Response.json({})));
    expect(mutations()).toHaveLength(1);
    expect(error).not.toHaveBeenCalled();
  });
}
test('current create clears its own draft', async () => {
  useAgentsStore.setState({ selectedAgentName: 'new', agentDraft: { name: 'new', scope: 'user' } });
  await mount(<AgentsPage />); await act(async () => button('Create').click());
  expect(useAgentsStore.getState().agentDraft).toBeNull(); expect(success).toHaveBeenCalledTimes(1);
});
test('same-owner save preserves a newer form edit during its PATCH', async () => {
  const held = deferred<Response>();
  setResponder(async (entry) => entry.method === 'PATCH' ? held.promise : defaultResponse(entry));
  await mount(<AgentsPage />);
  const field = [...document.querySelectorAll<HTMLTextAreaElement>('textarea')].find((node) => node.value === 'initial');
  if (!field) throw new Error('Missing system');
  await change(field, 'written');
  await act(async () => field.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
  await change(field, 'newer');
  await act(async () => held.finish(Response.json({})));
  expect(field.value).toBe('newer');
  expect(mutations()).toHaveLength(1);
});
test('hydration from a retired directory cannot replace another entity', async () => {
  const held = deferred<Response>();
  setResponder(async (entry) => entry.path.endsWith('/lab/config') ? held.promise : entry.path.endsWith('/other/config') ? Response.json(envelope('other-system')) : defaultResponse(entry));
  await mount(<AgentsPage />);
  await act(async () => useAgentsStore.setState({ selectedAgentName: 'other', agentsByDirectory: { '/fixture': [agent('other')] } }));
  await act(async () => held.finish(Response.json(envelope('old-system'))));
  expect([...document.querySelectorAll<HTMLTextAreaElement>('textarea')].some((node) => node.value === 'other-system')).toBe(true);
});

for (const kind of ['runtime', 'directory', 'selection', 'unmount']) {
  for (const failure of [false, true]) {
    test(`page PATCH ignores ${failure ? 'failure' : 'success'} after ${kind}`, async () => {
      const held = deferred<Response>();
      setResponder(async (entry) => entry.method === 'PATCH' ? held.promise : defaultResponse(entry));
      await mount(<AgentsPage />);
      const field = [...document.querySelectorAll<HTMLTextAreaElement>('textarea')].find((node) => node.value === 'initial');
      if (!field) throw new Error('Missing hydrated system');
      await change(field, 'edited');
      await act(async () => field.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
      expect(mutations()).toHaveLength(1);
      await retire(kind);
      error.mockClear(); success.mockClear();
      await act(async () => held.finish(Response.json(failure ? { error: 'old failure' } : {}, { status: failure ? 500 : 200 })));
      expect(mutations()).toHaveLength(1);
      expect(error).not.toHaveBeenCalled(); expect(success).not.toHaveBeenCalled();
    });
  }
}

for (const kind of ['runtime', 'directory']) {
  test(`old rendered create cannot dispatch after synchronous ${kind} change`, async () => {
    useAgentsStore.setState({ selectedAgentName: 'new', agentDraft: { name: 'new', scope: 'user' } });
    await mount(<AgentsPage />);
    const create = button('Create');
    await act(async () => {
      if (kind === 'runtime') switchTo('b');
      else useUIStore.setState({ settingsProjectPath: '/other' });
      create.click();
    });
    expect(mutations()).toEqual([]);
  });
}

for (const readState of ['pending', 'failed']) {
  test(`new agent save cannot inherit dirty permission rules while its read is ${readState}`, async () => {
    const oldWrite = deferred<Response>();
    const nextPermissions = deferred<Response>();
    setResponder(async (entry) => {
      // Keep both agents mounted through the old mutation's list refresh.
      if (entry.path.endsWith('/agent')) return Response.json({ data: [agent(), agent('other')] });
      if (entry.method === 'PATCH' && entry.path.endsWith('/lab')) return oldWrite.promise;
      if (entry.path.endsWith('/other/permissions')) return nextPermissions.promise;
      if (entry.path.endsWith('/other/config')) return Response.json(envelope('other system'));
      return defaultResponse(entry);
    });
    try {
      await mount(<AgentsPage />);
      const deny = [...document.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === 'Deny');
      if (!deny) throw new Error('Missing permission Deny chip');
      await act(async () => deny.click());
      expect(mutations()).toHaveLength(1);
      await act(async () => useAgentsStore.setState({ selectedAgentName: 'other', agentsByDirectory: { '/fixture': [agent(), agent('other')] } }));
      if (readState === 'failed') {
        await act(async () => nextPermissions.finish(Response.json({ error: 'Permission read failed' }, { status: 503 })));
      }
      const field = [...document.querySelectorAll<HTMLTextAreaElement>('textarea')].find((node) => node.value === 'other system');
      if (!field) throw new Error('Missing new agent config hydration');
      await change(field, 'new other system');
      await act(async () => field.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
      await act(async () => oldWrite.finish(Response.json({})));
      const newWrites = mutations().filter((entry) => entry.path.endsWith('/other'));
      expect(newWrites.some((entry) => Object.hasOwn(JSON.parse(entry.body ?? '{}'), 'permissions'))).toBe(false);
      expect(newWrites.map((entry) => JSON.parse(entry.body ?? '{}').system)).toEqual(['new other system']);
    } finally {
      await act(async () => {
        oldWrite.finish(Response.json({}));
        nextPermissions.finish(Response.json({ global: [], agent: [], effective: [], source: 'json', path: '/fixture/config.json' }));
      });
    }
  });
}

test('current permission save preserves edits made during its pending write', async () => {
  const held = deferred<Response>(); let writes = 0;
  setResponder(async (entry) => entry.method === 'PATCH' && ++writes === 1 ? held.promise : defaultResponse(entry));
  await mount(<AgentsPage />);
  const chip = (label: string) => {
    const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === label);
    if (!found) throw new Error(`Missing permission ${label} chip`);
    return found;
  };
  try {
    await act(async () => chip('Deny').click());
    await act(async () => chip('Allow').click());
    expect(mutations()).toHaveLength(1);
    await act(async () => held.finish(Response.json({})));
    expect(mutations().map((entry) => JSON.parse(entry.body ?? '{}').permissions)).toEqual([
      [{ action: '*', resource: '*', effect: 'deny' }],
      [{ action: '*', resource: '*', effect: 'allow' }],
    ]);
  } finally { await act(async () => held.finish(Response.json({}))); }
});

test('current permission failure leaves its hydrated dirty rules available for retry', async () => {
  let writes = 0;
  setResponder(async (entry) => entry.method === 'PATCH' && ++writes === 1
    ? Response.json({ error: 'Write refused' }, { status: 403 }) : defaultResponse(entry));
  await mount(<AgentsPage />);
  const deny = [...document.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === 'Deny');
  if (!deny) throw new Error('Missing permission Deny chip');
  await act(async () => deny.click());
  expect(error).toHaveBeenCalledTimes(1);
  const field = document.querySelector<HTMLTextAreaElement>('textarea');
  if (!field) throw new Error('Missing page text field');
  await act(async () => field.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
  expect(mutations().map((entry) => JSON.parse(entry.body ?? '{}').permissions)).toEqual([
    [{ action: '*', resource: '*', effect: 'deny' }],
    [{ action: '*', resource: '*', effect: 'deny' }],
  ]);
});
