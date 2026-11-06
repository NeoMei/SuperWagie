import { beforeEach, expect, test } from 'bun:test';
import { setup, act, mount, unmount, button, deferred, setResponder, defaultResponse, mutations,
  switchTo, useSkillsStore, useUIStore, skill, success, error, unexpected } from '@/components/sections/skills/skillMutationTestUtils';
const { useDirectoryStore } = await import('@/stores/useDirectoryStore');
const { IntegrationsCatalogView } = await import('./IntegrationsCatalogView');
beforeEach(setup);
const names = ['notion-knowledge-capture', 'notion-research-documentation', 'notion-meeting-intelligence', 'notion-spec-to-implementation'];
const installed = names.map((name) => ({ ...skill(name), scope: 'user' as const, path: `/fixture/.config/opencode/skills/${name}/SKILL.md` }));
for (const ownerChange of ['runtime', 'unmount']) {
  test(`uninstall stops its following skill after ${ownerChange} even when first deletion fails`, async () => {
    const held = deferred<Response>();
    useDirectoryStore.setState({ currentDirectory: '/fixture' }); useUIStore.setState({ isIntegrationsCatalogOpen: true });
    useSkillsStore.setState({ skills: installed, skillsByDirectory: { '/fixture': installed } });
    setResponder(async (entry) => {
      if (entry.path === '/api/config/skills') return Response.json({ skills: installed });
      if (entry.path === `/api/config/skills/${names[0]}` && entry.method === 'DELETE') return held.promise;
      if (entry.path === '/api/config/mcp') return Response.json([{ name: 'notion', type: 'remote', url: 'https://fixture.invalid/mcp', scope: 'user' }]);
      if (entry.path === '/api/config/mcp/notion') return Response.json({});
      if (entry.path === '/api/plugin') return Response.json({ location: { directory: '/fixture' }, data: [] });
      if (entry.path === '/api/mcp') return Response.json({ location: { directory: '/fixture' }, data: [] });
      if (entry.path === '/api/config/plugins') return Response.json({ entries: [], files: [] });
      if (entry.path === '/api/config/plugins/runtime') return Response.json({ plugins: [] });
      if (entry.path === '/api/guests') return Response.json({ guests: [] });
      return defaultResponse(entry);
    });
    await mount(<IntegrationsCatalogView />);
    const notion = [...document.querySelectorAll<HTMLButtonElement>('aside button')].find((node) => node.textContent?.trim() === 'Notion');
    if (!notion) throw new Error('Missing installed Notion entry');
    await act(async () => notion.click());
    const menu = document.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]');
    if (!menu) throw new Error('Missing integration menu'); await act(async () => menu.click());
    const uninstall = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((node) => node.textContent?.includes('Uninstall'));
    if (!uninstall) throw new Error('Missing Uninstall action'); await act(async () => uninstall.click());
    await act(async () => button('Remove', '[role="dialog"] button').click());
    expect(mutations().filter((entry) => entry.method === 'DELETE')).toHaveLength(1);
    if (ownerChange === 'unmount') await unmount(); else await act(async () => switchTo('b'));
    success.mockClear(); error.mockClear(); await act(async () => held.finish(Response.json({ error: 'A failed' }, { status: 500 })));
    expect(mutations().filter((entry) => entry.method === 'DELETE')).toHaveLength(1);
    expect(mutations()[0]?.query).toBe('?directory=%2Ffixture&scope=user&source=opencode');
    expect(success).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled(); expect(unexpected).toEqual([]);
  });
}
