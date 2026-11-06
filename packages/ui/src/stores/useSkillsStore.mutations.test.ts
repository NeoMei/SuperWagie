import { beforeEach, expect, test } from 'bun:test';
import { setup, deferred, setResponder, defaultResponse, mutations, requests, switchTo, useSkillsStore, skill, until, unexpected } from '@/components/sections/skills/skillMutationTestUtils';
import { getConfigUpdateSnapshot, startConfigUpdate } from '@/lib/configUpdate';
import { refreshSkillsAfterOpenCodeRestart, type DiscoveredSkill } from './useSkillsStore';
beforeEach(setup);
const disabled = () => useSkillsStore.setState({ policiesByDirectory: { '/fixture': [{ resource: 'skill:lab', effect: 'deny', path: '/fixture/opencode.json' }] } });
for (const returnToA of [false, true]) {
  test(`retired disabled rename stops after its PATCH for ${returnToA ? 'A-B-A' : 'A-B'}`, async () => {
    disabled(); const held = deferred<Response>();
    setResponder(async (entry) => entry.method === 'PATCH' ? held.promise : defaultResponse(entry));
    const pending = useSkillsStore.getState().renameSkill('lab', 'renamed', '/fixture');
    await until(() => mutations().length === 1);
    switchTo('b'); if (returnToA) switchTo('a');
    const newer = skill('newer');
    useSkillsStore.setState({ skills: [newer], skillsByDirectory: { '/fixture': [newer] }, selectedSkillName: 'newer' });
    held.finish(Response.json({})); const result = await pending;
    expect(mutations().map(({ host, method, path, body }) => [host, method, path, body])).toEqual([
      ['skill-a.invalid', 'PATCH', '/api/config/skills/lab', '{"renameTo":"renamed"}'],
    ]);
    expect(result).toBe(false);
    expect(useSkillsStore.getState().skills).toEqual([newer]);
    expect(unexpected).toEqual([]);
  });
}
test('rename retires before old deny cleanup when its new deny response completes on B', async () => {
  disabled(); const held = deferred<Response>();
  setResponder(async (entry) => entry.path === '/api/config/skill-switch' && entry.body?.includes('"enabled":false') ? held.promise : defaultResponse(entry));
  const pending = useSkillsStore.getState().renameSkill('lab', 'renamed', '/fixture');
  await until(() => mutations().length === 2);
  switchTo('b'); held.finish(Response.json({ changed: ['/fixture/opencode.json'] }));
  const result = await pending;
  expect(mutations().map(({ host, method, path, body }) => [host, method, path, body])).toEqual([
    ['skill-a.invalid', 'PATCH', '/api/config/skills/lab', '{"renameTo":"renamed"}'],
    ['skill-a.invalid', 'PUT', '/api/config/skill-switch', '{"id":"renamed","enabled":false,"scope":"project"}'],
  ]);
  expect(result).toBe(false); expect(unexpected).toEqual([]);
});
test('current disabled rename preserves both policy migration writes', async () => {
  disabled(); const result = await useSkillsStore.getState().renameSkill('lab', 'renamed', '/fixture');
  expect(result).toBe(true);
  expect(mutations().map(({ host, method, path, body }) => [host, method, path, body])).toEqual([
    ['skill-a.invalid', 'PATCH', '/api/config/skills/lab', '{"renameTo":"renamed"}'],
    ['skill-a.invalid', 'PUT', '/api/config/skill-switch', '{"id":"renamed","enabled":false,"scope":"project"}'],
    ['skill-a.invalid', 'PUT', '/api/config/skill-switch', '{"id":"lab","enabled":true,"scope":"project"}'],
  ]);
  expect(unexpected).toEqual([]);
});

for (const action of ['create', 'update', 'delete']) {
  for (const outcome of ['plain', 'manual', 'reload']) {
    test(`${action} retires ${outcome} response before local publication or another read`, async () => {
      const held = deferred<Response>();
      setResponder(async (entry) => entry.method !== 'GET' && entry.path.startsWith('/api/config/skills/') ? held.promise : defaultResponse(entry));
      const store = useSkillsStore.getState();
      const pending = action === 'create' ? store.createSkill({ name: 'lab', description: 'A' }, '/fixture')
        : action === 'update' ? store.updateSkill('lab', { description: 'A' }, '/fixture') : store.deleteSkill('lab', '/fixture');
      await until(() => mutations().length === 1); switchTo('b');
      const newer = skill(); useSkillsStore.setState({ skills: [newer], skillsByDirectory: { '/fixture': [newer] }, selectedSkillName: 'lab' });
      const before = requests.length;
      held.finish(Response.json(outcome === 'manual' ? { requiresManualRestart: true } : outcome === 'reload' ? { requiresReload: true } : {}));
      expect(await pending).toBe(false);
      expect(requests.slice(before).filter((entry) => entry.path !== '/auth/url-token')).toEqual([]);
      expect(useSkillsStore.getState().skills).toEqual([newer]); expect(useSkillsStore.getState().selectedSkillName).toBe('lab');
    });
  }
}
test('manual-restart deletion updates only its requested directory inventory', async () => {
  const ambient = skill('ambient'); const target = skill('target');
  useSkillsStore.setState({ skills: [ambient], skillsByDirectory: { '/fixture': [ambient], '/other': [target] } });
  setResponder(async (entry) => entry.method === 'DELETE' ? Response.json({ requiresManualRestart: true }) : defaultResponse(entry));
  expect(await useSkillsStore.getState().deleteSkill('target', '/other', { scope: 'project', source: 'opencode' })).toBe(true);
  expect(useSkillsStore.getState().skillsByDirectory['/other']).toEqual([]); expect(useSkillsStore.getState().skills).toEqual([ambient]);
  expect(mutations()[0]?.query).toBe('?directory=%2Fother&scope=project&source=opencode');
});
test('response body delivery cannot revive an old create', async () => {
  let deliver: (value: Uint8Array) => void = () => { throw new Error('stream not started'); };
  const stream = new ReadableStream<Uint8Array>({ start(controller) { deliver = (bytes) => { controller.enqueue(bytes); controller.close(); }; } });
  setResponder(async (entry) => entry.method === 'POST' && entry.path.endsWith('/skills/lab') ? new Response(stream) : defaultResponse(entry));
  const pending = useSkillsStore.getState().createSkill({ name: 'lab', description: 'A' }, '/fixture');
  await until(() => mutations().length === 1); switchTo('b');
  deliver(new TextEncoder().encode('{"requiresManualRestart":true}'));
  expect(await pending).toBe(false); expect(useSkillsStore.getState().skillsByDirectory).toEqual({});
});
test('disabled rename stops policy migration after its pending catalog read retires', async () => {
  disabled(); const held = deferred<Response>();
  setResponder(async (entry) => entry.path === '/api/config/skills' ? held.promise : defaultResponse(entry));
  const pending = useSkillsStore.getState().renameSkill('lab', 'renamed', '/fixture');
  await until(() => requests.some((entry) => entry.path === '/api/config/skills'));
  switchTo('b'); held.finish(Response.json({ skills: [skill('renamed')] }));
  expect(await pending).toBe(false); expect(mutations()).toHaveLength(1);
});
for (const failure of [false, true]) {
  test(`restart polling stops after a retired ${failure ? 'rejected' : 'unhealthy'} health probe`, async () => {
    const held = deferred<Response>(); const banner = getConfigUpdateSnapshot();
    setResponder(async (entry) => entry.method === 'POST' && entry.path.endsWith('/skills/lab') ? Response.json({ requiresReload: true })
      : entry.path === '/api/opencode/health' ? held.promise : defaultResponse(entry));
    const pending = useSkillsStore.getState().createSkill({ name: 'lab', description: 'A' }, '/fixture');
    await until(() => requests.some((entry) => entry.path === '/api/opencode/health'));
    switchTo('b'); if (failure) held.fail(new Error('A went away')); else held.finish(Response.json({ healthy: false }));
    expect(await pending).toBe(false);
    expect(requests.filter((entry) => entry.host === 'skill-b.invalid' && entry.path !== '/auth/url-token')).toEqual([]);
    expect(getConfigUpdateSnapshot()).toEqual(banner);
  });
}
test('retirement before restart refresh entry releases its existing update count', async () => {
  const banner = getConfigUpdateSnapshot(); startConfigUpdate('Owned skill write');
  expect(await refreshSkillsAfterOpenCodeRestart({ isCurrentRuntime: () => false, directory: '/fixture' })).toBe(false);
  expect(getConfigUpdateSnapshot()).toEqual(banner);
});
test('scoped deletion retains the shared deny while all-copies deletion removes it', async () => {
  disabled(); await useSkillsStore.getState().deleteSkill('lab', '/fixture', { scope: 'project', source: 'opencode' });
  expect(mutations()).toHaveLength(1); expect(mutations()[0]?.query).toBe('?directory=%2Ffixture&scope=project&source=opencode');
  disabled(); await useSkillsStore.getState().deleteSkill('lab', '/fixture');
  expect(mutations().at(-1)?.body).toBe('{"id":"lab","enabled":true,"scope":"project"}');
});
for (const action of ['create', 'update']) {
  for (const inventory of ['unknown-ambient', 'unknown-other', 'loaded-empty', 'other-ambient']) {
    test(`manual-restart ${action} preserves ${inventory} inventory authority`, async () => {
      const ambient = skill('ambient');
      const target = inventory === 'unknown-other' ? '/unloaded' : inventory === 'other-ambient' ? '/other' : '/fixture';
      const maps: Record<string, DiscoveredSkill[]> = inventory === 'unknown-ambient' ? {} : inventory === 'loaded-empty' ? { '/fixture': [] }
        : inventory === 'other-ambient' ? { '/fixture': [ambient], '/other': [] } : { '/fixture': [ambient] };
      const flat = inventory === 'loaded-empty' ? [] : [ambient];
      useSkillsStore.setState({ skills: flat, skillsByDirectory: maps });
      setResponder(async (entry) => entry.method === (action === 'create' ? 'POST' : 'PATCH') && entry.path.endsWith('/skills/new')
        ? Response.json({ requiresManualRestart: true }) : defaultResponse(entry));
      const result = action === 'create'
        ? await useSkillsStore.getState().createSkill({ name: 'new', description: 'updated', scope: 'project' }, target)
        : await useSkillsStore.getState().updateSkill('new', { description: 'updated', scope: 'project' }, target);
      expect(result).toBe(true);
      const state = useSkillsStore.getState();
      if (inventory.startsWith('unknown')) {
        expect(state.skillsByDirectory[target]).toBeUndefined(); expect(state.skills).toEqual(flat);
      } else {
        expect(state.skillsByDirectory[target]?.map((entry) => [entry.name, entry.description])).toEqual([['new', 'updated']]);
        if (inventory === 'other-ambient') expect(state.skills).toEqual([ambient]);
        else expect(state.skills.map((entry) => entry.name)).toEqual(['new']);
      }
    });
  }
}
