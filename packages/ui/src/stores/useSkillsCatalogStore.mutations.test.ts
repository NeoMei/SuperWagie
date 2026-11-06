import { beforeEach, expect, test } from 'bun:test';
import { setup, deferred, setResponder, defaultResponse, requests, switchTo, useSkillsCatalogStore, until, item } from '@/components/sections/skills/skillMutationTestUtils';
beforeEach(setup);
const request = { source: 'fixture/skills', scope: 'user', selections: [{ skillDir: 'lab' }], conflictPolicy: 'prompt' } satisfies import('@/lib/api/types').SkillsInstallRequest;
for (const outcome of ['plain', 'manual', 'reload', 'conflicts']) {
  test(`install retires ${outcome} before refresh, error or success publication`, async () => {
    const held = deferred<Response>();
    setResponder(async (entry) => entry.path.endsWith('/skills/install') ? held.promise : defaultResponse(entry));
    const pending = useSkillsCatalogStore.getState().installSkills(request, { directory: '/fixture' });
    await until(() => requests.some((entry) => entry.path.endsWith('/skills/install'))); switchTo('b');
    const error = { kind: 'unknown', message: 'B error' } satisfies import('@/lib/api/types').SkillsInstallError;
    useSkillsCatalogStore.setState({ lastInstallError: error }); const before = requests.length;
    held.finish(Response.json(outcome === 'conflicts' ? { ok: false, error: { kind: 'conflicts', message: 'A conflicts', conflicts: [{ skillName: 'lab', scope: 'user' }] } }
      : { ok: true, ...(outcome === 'manual' ? { requiresManualRestart: true } : outcome === 'reload' ? { requiresReload: true } : {}) }));
    expect(await pending).toEqual({ ok: false }); expect(requests.slice(before).filter((entry) => entry.path !== '/auth/url-token')).toEqual([]);
    expect(useSkillsCatalogStore.getState().lastInstallError).toBe(error);
  });
}
test('current install preserves conflict details and retry policy', async () => {
  const payload = { ok: false, error: { kind: 'conflicts', message: 'Conflict', conflicts: [{ skillName: 'lab', scope: 'user' }] } };
  setResponder(async (entry) => entry.path.endsWith('/skills/install') ? Response.json(payload) : defaultResponse(entry));
  expect(await useSkillsCatalogStore.getState().installSkills(request)).toEqual(payload);
  expect(JSON.parse(requests.find((entry) => entry.path.endsWith('/skills/install'))?.body ?? '{}').conflictPolicy).toBe('prompt');
});
for (const kind of ['catalog', 'source', 'source-fallback']) {
  test(`${kind} read cannot replace B catalog or start a B fallback`, async () => {
    const held = deferred<Response>();
    const path = kind === 'catalog' ? '/api/config/skills/catalog' : '/api/config/skills/catalog/source';
    setResponder(async (entry) => entry.path === path ? held.promise : defaultResponse(entry));
    const pending = kind === 'catalog' ? useSkillsCatalogStore.getState().loadCatalog({ refresh: true }) : useSkillsCatalogStore.getState().loadSource('fixture', { refresh: true });
    await until(() => requests.some((entry) => entry.path === path)); switchTo('b');
    const current = [item('B-only')]; useSkillsCatalogStore.setState({ itemsBySource: { fixture: current } });
    held.finish(Response.json(kind === 'catalog' ? { ok: true, sources: [] } : kind === 'source-fallback' ? { ok: false } : { ok: true, items: [item('A-only')] }, { status: kind === 'source-fallback' ? 500 : 200 }));
    expect(await pending).toBe(false); expect(useSkillsCatalogStore.getState().itemsBySource.fixture).toBe(current);
    expect(requests.filter((entry) => entry.host === 'skill-b.invalid' && entry.path.startsWith('/api/config/skills'))).toEqual([]);
  });
}
