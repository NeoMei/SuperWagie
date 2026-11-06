import { beforeEach, expect, test } from 'bun:test';
import {
  setup, act, mount, unmount, button, change, deferred, setResponder, defaultResponse,
  requests, mutations, switchTo, useAgentsStore, useUIStore, success, error, envelope,
} from './agentMutationTestUtils';
const { AgentsSidebar } = await import('./AgentsSidebar');
beforeEach(setup);
const menu = async (label: string) => {
  const trigger = document.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]');
  if (!trigger) throw new Error('Missing agent menu');
  await act(async () => trigger.click());
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((node) => node.textContent?.trim() === label);
  if (!item) throw new Error(`Missing ${label} menu item`);
  await act(async () => item.click());
};
const rename = async () => {
  await menu('Rename');
  const input = document.querySelector<HTMLInputElement>('[role="dialog"] input');
  if (!input) throw new Error('Missing rename input');
  await change(input, 'renamed');
  await act(async () => button('Rename', '[role="dialog"] button').click());
};
const retire = async (kind: string) => {
  await act(async () => {
    if (kind === 'runtime') { switchTo('b'); switchTo('a'); }
    else if (kind === 'directory') { useUIStore.setState({ settingsProjectPath: '/other' }); useUIStore.setState({ settingsProjectPath: '/fixture' }); }
    else { useAgentsStore.getState().setSelectedAgent('other'); useAgentsStore.getState().setSelectedAgent('lab'); }
  });
  if (kind === 'unmount') await unmount();
};
for (const stage of ['config', 'POST', 'DELETE']) {
  for (const kind of ['runtime', 'directory', 'selection', 'unmount']) {
    test(`rename retires at ${stage} across ${kind}`, async () => {
      const held = deferred<Response>();
      setResponder(async (entry) => entry.path.includes('/config/agents/') && (stage === 'config' ? entry.path.endsWith('/config') : entry.method === stage) ? held.promise : defaultResponse(entry));
      await mount(<AgentsSidebar />); await rename();
      const before = mutations().length;
      await retire(kind);
      success.mockClear(); error.mockClear();
      await act(async () => held.finish(Response.json(stage === 'config' ? envelope() : {})));
      expect(mutations()).toHaveLength(before);
      expect(useAgentsStore.getState().selectedAgentName).toBe('lab');
      expect(success).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
    });
  }
}
for (const kind of ['runtime', 'directory', 'selection', 'unmount']) {
  test(`duplicate read cannot replace draft after ${kind}`, async () => {
    const held = deferred<Response>();
    setResponder(async (entry) => entry.path.endsWith('/lab/config') ? held.promise : defaultResponse(entry));
    await mount(<AgentsSidebar />); await menu('Duplicate');
    await retire(kind);
    const newer = { name: 'newer', scope: 'user' as const };
    await act(async () => useAgentsStore.setState({ agentDraft: newer }));
    success.mockClear(); error.mockClear();
    await act(async () => held.finish(Response.json(envelope())));
    expect(useAgentsStore.getState().agentDraft).toBe(newer);
    expect(error).not.toHaveBeenCalled();
  });
}
for (const action of ['Delete', 'Disable']) {
  test(`${action} completion cannot clear newer selection`, async () => {
    const held = deferred<Response>();
    setResponder(async (entry) => entry.method === (action === 'Delete' ? 'DELETE' : 'PATCH') ? held.promise : defaultResponse(entry));
    await mount(<AgentsSidebar />); await menu(action);
    if (action === 'Delete') await act(async () => button('Delete', '[role="dialog"] button').click());
    await retire('selection');
    success.mockClear(); error.mockClear();
    await act(async () => held.finish(Response.json({})));
    expect(useAgentsStore.getState().selectedAgentName).toBe('lab');
    expect(success).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
  });
}
test('current rename copies stored config then deletes the original and selects the new name', async () => {
  await mount(<AgentsSidebar />); await rename();
  expect(mutations().map(({ host, method, path }) => [host, method, path])).toEqual([
    ['agent-a.invalid', 'POST', '/api/config/agents/renamed'], ['agent-a.invalid', 'DELETE', '/api/config/agents/lab'],
  ]);
  expect(JSON.parse(mutations()[0].body ?? '{}')).toMatchObject({ system: 'initial', permissions: envelope().config.permissions, scope: 'project' });
  expect(useAgentsStore.getState().selectedAgentName).toBe('renamed');
  expect(success).toHaveBeenCalledTimes(1);
});
test('current delete clears its selection and reports success', async () => {
  await mount(<AgentsSidebar />); await menu('Delete');
  await act(async () => button('Delete', '[role="dialog"] button').click());
  expect(useAgentsStore.getState().selectedAgentName).toBeNull(); expect(success).toHaveBeenCalledTimes(1);
});
test('current duplicate retains stored permissions in its draft', async () => {
  await mount(<AgentsSidebar />); await menu('Duplicate');
  expect(useAgentsStore.getState().agentDraft).toMatchObject({ name: 'lab-copy', system: 'initial', permissions: envelope().config.permissions });
  expect(requests.some((entry) => entry.path.endsWith('/lab/config'))).toBe(true);
});

for (const action of ['Delete', 'Disable']) {
  test(`${action} rejection cannot report failure for a newer visit`, async () => {
    const held = deferred<Response>();
    setResponder(async (entry) => entry.method === (action === 'Delete' ? 'DELETE' : 'PATCH') ? held.promise : defaultResponse(entry));
    await mount(<AgentsSidebar />); await menu(action);
    if (action === 'Delete') await act(async () => button('Delete', '[role="dialog"] button').click());
    await retire('selection');
    error.mockClear(); success.mockClear();
    await act(async () => held.finish(Response.json({ error: 'old failure' }, { status: 500 })));
    expect(useAgentsStore.getState().selectedAgentName).toBe('lab');
    expect(error).not.toHaveBeenCalled(); expect(success).not.toHaveBeenCalled();
  });
}
test('old delete finalizer preserves a newer pending confirmation', async () => {
  const first = deferred<Response>(); const second = deferred<Response>(); let writes = 0;
  setResponder(async (entry) => entry.method === 'DELETE' ? (++writes === 1 ? first.promise : second.promise) : defaultResponse(entry));
  await mount(<AgentsSidebar />); await menu('Delete');
  await act(async () => button('Delete', '[role="dialog"] button').click());
  await retire('selection');
  await menu('Delete');
  await act(async () => button('Delete', '[role="dialog"] button').click());
  try {
    await act(async () => first.finish(Response.json({})));
    expect(button('Delete', '[role="dialog"] button').disabled).toBe(true);
    expect(success).not.toHaveBeenCalled();
    await act(async () => second.finish(Response.json({})));
    expect(success).toHaveBeenCalledTimes(1);
  } finally { first.finish(Response.json({})); second.finish(Response.json({})); }
});
