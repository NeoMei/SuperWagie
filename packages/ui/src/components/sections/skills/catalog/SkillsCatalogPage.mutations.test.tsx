import { beforeEach, expect, test } from 'bun:test';
import { setup, act, mount, unmount, button, deferred, setResponder, defaultResponse,
  requests, mutations, switchTo, useSkillsCatalogStore, source, item, unexpected } from '../skillMutationTestUtils';
const { SkillsCatalogPage } = await import('@/components/sections/skills/catalog/SkillsCatalogPage');
beforeEach(setup);
const begin = async () => {
  useSkillsCatalogStore.setState({ sources: [source], selectedSourceId: source.id,
    itemsBySource: { fixture: [item('one'), item('two')] }, loadedSourceIds: { fixture: true } });
  await mount(<SkillsCatalogPage mode="external" onModeChange={() => {}} />);
  const selectAll = document.querySelector<HTMLElement>('[role="checkbox"][aria-label="Select all"]');
  if (!selectAll) throw new Error('Missing select-all checkbox');
  await act(async () => selectAll.click());
  await act(async () => button('Delete').click());
  await act(async () => button('Delete', '[role="dialog"] button').click());
};
for (const outcome of ['success', 'failure']) {
  for (const ownerChange of ['runtime', 'runtime-round-trip', 'unmount']) {
    test(`batch stops after first ${outcome} DELETE across ${ownerChange}`, async () => {
      const held = deferred<Response>();
      setResponder(async (entry) => entry.method === 'DELETE' && entry.path.endsWith('/one') ? held.promise : defaultResponse(entry));
      await begin();
      expect(mutations().filter((entry) => entry.method === 'DELETE')).toHaveLength(1);
      if (ownerChange === 'unmount') await unmount();
      else await act(async () => { switchTo('b'); if (ownerChange === 'runtime-round-trip') switchTo('a'); });
      const before = requests.length;
      await act(async () => held.finish(Response.json(outcome === 'failure' ? { error: 'original DELETE failed' } : {}, { status: outcome === 'failure' ? 500 : 200 })));
      const late = requests.slice(before);
      expect(mutations().filter((entry) => entry.method === 'DELETE').map(({ host, path }) => [host, path])).toEqual([
        ['skill-a.invalid', '/api/config/skills/one'],
      ]);
      expect(late.some((entry) => entry.path === '/api/config/skills/catalog/source')).toBe(false);
      expect(unexpected).toEqual([]);
    });
  }
}
test('same-owner batch continues after ordinary failure and retains only failed item for retry', async () => {
  setResponder(async (entry) => entry.method === 'DELETE' && entry.path.endsWith('/one')
    ? Response.json({ error: 'ordinary failure' }, { status: 500 }) : defaultResponse(entry));
  await begin();
  expect(mutations().filter((entry) => entry.method === 'DELETE').map(({ host, path }) => [host, path])).toEqual([
    ['skill-a.invalid', '/api/config/skills/one'], ['skill-a.invalid', '/api/config/skills/two'],
  ]);
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog?.textContent).toContain('one');
  expect(dialog?.textContent).not.toContain('two');
  expect(unexpected).toEqual([]);
});
test('same-owner all-success batch survives its own catalog reload and source echo', async () => {
  let echoed = false;
  setResponder(async (entry) => {
    if (entry.method === 'DELETE' && entry.path.endsWith('/one') && !echoed) {
      echoed = true;
      await useSkillsCatalogStore.getState().loadCatalog({ refresh: true });
      await useSkillsCatalogStore.getState().loadSource('fixture', { refresh: true });
    }
    return defaultResponse(entry);
  });
  await begin();
  expect(mutations().filter((entry) => entry.method === 'DELETE').map((entry) => entry.path)).toEqual(['/api/config/skills/one', '/api/config/skills/two']);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
test('same-owner retry resolves retained failed items against the refreshed source', async () => {
  setResponder(async (entry) => entry.method === 'DELETE' && entry.path.endsWith('/one')
    ? Response.json({ error: 'ordinary failure' }, { status: 500 }) : defaultResponse(entry));
  await begin(); setResponder(defaultResponse);
  await act(async () => button('Delete', '[role="dialog"] button').click());
  expect(mutations().filter((entry) => entry.method === 'DELETE').map((entry) => entry.path)).toEqual(['/api/config/skills/one', '/api/config/skills/two', '/api/config/skills/one']);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
test('external source rebind stops the pending batch before its next deletion', async () => {
  const held = deferred<Response>();
  setResponder(async (entry) => entry.method === 'DELETE' && entry.path.endsWith('/one') ? held.promise : defaultResponse(entry));
  await begin();
  await act(async () => useSkillsCatalogStore.setState({ sources: [{ ...source, source: 'another/repository' }], itemsBySource: { fixture: [item('one'), item('two')] } }));
  await act(async () => held.finish(Response.json({})));
  expect(mutations().filter((entry) => entry.method === 'DELETE')).toHaveLength(1);
});
for (const change of ['source-round-trip', 'selected-source-round-trip', 'next-name', 'next-scope']) {
  test(`pending batch irreversibly retires ${change} before the next request`, async () => {
    const held = deferred<Response>();
    setResponder(async (entry) => entry.method === 'DELETE' && entry.path.endsWith('/one') ? held.promise : defaultResponse(entry));
    await begin();
    await act(async () => {
      if (change === 'source-round-trip') {
        useSkillsCatalogStore.setState({ sources: [{ ...source, source: 'replacement/repository' }] });
        useSkillsCatalogStore.setState({ sources: [source] });
      } else if (change === 'selected-source-round-trip') {
        useSkillsCatalogStore.getState().setSelectedSource('other');
        useSkillsCatalogStore.getState().setSelectedSource('fixture');
      } else {
        const next = item('two');
        useSkillsCatalogStore.setState({ itemsBySource: { fixture: [item('one'), change === 'next-name'
          ? { ...next, skillName: 'replacement' } : { ...next, installed: { isInstalled: true, scope: 'project', source: 'opencode' } }] } });
      }
    });
    await act(async () => held.finish(Response.json({})));
    expect(mutations().filter((entry) => entry.method === 'DELETE').map((entry) => entry.path)).toEqual(['/api/config/skills/one']);
  });
}
test('catalog echo may remove an already deleted row while the next pending target continues', async () => {
  setResponder(async (entry) => {
    if (entry.method === 'DELETE' && entry.path.endsWith('/one')) {
      useSkillsCatalogStore.setState({ sources: [{ ...source }], itemsBySource: { fixture: [item('two')] } });
    }
    return defaultResponse(entry);
  });
  await begin();
  expect(mutations().filter((entry) => entry.method === 'DELETE').map((entry) => entry.path)).toEqual(['/api/config/skills/one', '/api/config/skills/two']);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
