import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { PluginEntry, PluginFile } from './usePluginsStore';

const browser = new Window({ url: 'http://fixture.invalid/' });
Object.assign(globalThis, { window: browser, document: browser.document, navigator: browser.navigator,
  localStorage: browser.localStorage, sessionStorage: browser.sessionStorage, Event: browser.Event, CustomEvent: browser.CustomEvent });
const deferred = <T,>() => {
  let finish: (value: T) => void = () => { throw new Error('Missing deferred'); };
  let fail: (reason: Error) => void = () => { throw new Error('Missing deferred'); };
  const promise = new Promise<T>((resolve, reject) => { finish = resolve; fail = reject; });
  return { promise, finish, fail };
};
const requests: Request[] = [];
let handler = async (_request: Request): Promise<Response> => Response.json({});
const unexpected: string[] = [];
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
  const request = input instanceof Request ? input : new Request(new URL(String(input), window.location.href), init);
  requests.push(request);
  const path = new URL(request.url).pathname;
  if (path === '/auth/url-token') return Response.json({ token: 'fixture-only', expiresAt: Date.now() + 60000 });
  if (path === '/api/fs/home') return Response.json({ home: '/fixture-home' });
  if (path === '/api/location') return Response.json({ data: { directory: '/shared' } });
  if (path === '/api/session') return Response.json({ data: [], cursor: {} });
  if (path === '/api/plugin') return Response.json({ location: { directory: '/shared' }, data: [] });
  if (path.startsWith('/api/config/plugins') || path === '/api/plugin/update' || path === '/api/plugin/check' || path.endsWith('/opencode/health')) return handler(request);
  unexpected.push(`${request.method} ${request.url}`); throw new Error(`Unexpected ${request.url}`);
});
const { usePluginsStore } = await import('./usePluginsStore');
const { useProjectsStore } = await import('./useProjectsStore');
const { switchRuntimeEndpoint, getRuntimeKey } = await import('@/lib/runtime-switch');
const { getConfigUpdateSnapshot } = await import('@/lib/configUpdate');
const original = usePluginsStore.getState();
const entry: PluginEntry = { id: 'config:user:lab', spec: 'lab', kind: 'config', parsedKind: 'npm', scope: 'user' };
const file: PluginFile = { id: 'file:user:lab.ts', fileName: 'lab.ts', kind: 'file', scope: 'user' };
const switchTo = (host: string) => switchRuntimeEndpoint({ apiBaseUrl: `http://runtime-${host}.invalid`, runtimeKey: `plugin-mutations-${host}` });
beforeEach(() => {
  requests.length = 0; unexpected.length = 0;
  switchTo('a'); useProjectsStore.setState({ projects: [{ id: 'a', path: '/shared' }, { id: 'b', path: '/other' }], activeProjectId: 'a' });
  usePluginsStore.setState({ ...original, entries: [entry], files: [file], loadedDirectory: '/shared', loadedRuntimeKey: getRuntimeKey(), selectedId: entry.id,
    isLoading: false, isLoadingRegistry: false, isCheckingUpdates: false, packageUpdates: {}, registryInfo: {}, draft: null });
});
afterEach(() => { expect(unexpected).toEqual([]); usePluginsStore.setState(original); });
afterAll(() => { fetchSpy.mockRestore(); browser.close(); });
const operations = [
  { name: 'createEntry', method: 'POST', path: '/api/config/plugins/entry', run: () => usePluginsStore.getState().createEntry({ spec: 'lab', scope: 'user' }) },
  { name: 'updateEntry', method: 'PATCH', path: '/api/config/plugins/entry/config%3Auser%3Alab', run: () => usePluginsStore.getState().updateEntry(entry.id, { spec: 'lab@2' }) },
  { name: 'deleteEntry', method: 'DELETE', path: '/api/config/plugins/entry/config%3Auser%3Alab', run: () => usePluginsStore.getState().deleteEntry(entry.id) },
  { name: 'createFile', method: 'POST', path: '/api/config/plugins/file', run: () => usePluginsStore.getState().createFile({ fileName: 'lab.ts', content: 'export {}', scope: 'user' }) },
  { name: 'updateFile', method: 'PUT', path: '/api/config/plugins/file/file%3Auser%3Alab.ts', run: () => usePluginsStore.getState().updateFile(file.id, { content: 'export {}' }) },
  { name: 'deleteFile', method: 'DELETE', path: '/api/config/plugins/file/file%3Auser%3Alab.ts', run: () => usePluginsStore.getState().deleteFile(file.id) },
];
for (const operation of operations) for (const boundary of ['response', 'body', 'manual-read']) {
  test(`${operation.name} retires across ${boundary} and runtime round trip`, async () => {
    const response = deferred<Response>(); const started = deferred<void>();
    let deliverBody: () => void = () => {};
    let bodyResponse: Response | undefined;
    handler = async (request) => {
      const path = new URL(request.url).pathname;
      if (request.method === operation.method && path === operation.path) {
        if (boundary === 'manual-read') return Response.json({ success: true, requiresManualRestart: true, message: 'saved', warning: 'restart', reloadFailed: true });
        started.finish();
        if (boundary === 'response') return response.promise;
        bodyResponse = new Response(new ReadableStream({ start(controller) { deliverBody = () => { controller.enqueue(new TextEncoder().encode('{"success":true}')); controller.close(); }; } }), { headers: { 'Content-Type': 'application/json' } });
        return bodyResponse;
      }
      if (request.method === 'GET' && path === '/api/config/plugins') {
        if (boundary === 'manual-read') { started.finish(); return response.promise; }
        return Response.json({ entries: [entry], files: [file] });
      }
      if (path === '/api/config/plugins/registry') return Response.json({ results: [] });
      unexpected.push(`${request.method} ${request.url}`); throw new Error('Unexpected plugin request');
    };
    const pending = operation.run(); await started.promise;
    if (boundary === 'body') {
      for (let attempt = 0; attempt < 20 && !bodyResponse?.bodyUsed; attempt += 1) await Promise.resolve();
      expect(bodyResponse?.bodyUsed).toBe(true);
    }
    switchTo('b'); switchTo('a');
    const current = { ...entry, options: { owner: 'new-visit' } };
    usePluginsStore.setState({ entries: [current], files: [file], selectedId: entry.id });
    const count = requests.filter((request) => new URL(request.url).pathname.startsWith('/api/config/plugins')).length;
    if (boundary === 'body') deliverBody();
    else response.finish(Response.json(boundary === 'manual-read' ? { entries: [entry], files: [file] } : { success: true }));
    expect((await pending).ok).toBe(false);
    expect(usePluginsStore.getState().entries).toEqual([current]);
    expect(usePluginsStore.getState().selectedId).toBe(entry.id);
    expect(requests.filter((request) => new URL(request.url).pathname.startsWith('/api/config/plugins'))).toHaveLength(count);
  });
}
for (const manual of [false, true]) test(`current-owner mutation preserves ${manual ? 'manual' : 'plain'} result fields`, async () => {
  handler = async (request) => request.method === 'POST'
    ? Response.json({ success: true, requiresManualRestart: manual, reloadFailed: true, message: 'saved', warning: 'restart' })
    : Response.json(new URL(request.url).pathname.endsWith('/registry') ? { results: [] } : { entries: [entry], files: [file] });
  const result = await usePluginsStore.getState().createFile({ fileName: 'lab.ts', content: 'export {}', scope: 'user' });
  expect(result).toEqual({ ok: true, ...(manual ? { requiresManualRestart: true } : {}), reloadFailed: true, message: 'saved', warning: 'restart' });
});
test('same-runtime invalid spec stays distinguishable', async () => {
  handler = async () => Response.json({ code: 'UNLOADABLE_SPEC' }, { status: 400 });
  expect(await usePluginsStore.getState().createEntry({ spec: 'bad spec', scope: 'user' })).toEqual({ ok: false, invalidSpec: true });
});
test('retired registry chunk cannot dispatch its second chunk or publish', async () => {
  const held = deferred<Response>(); const started = deferred<void>();
  const specs = Array.from({ length: 100 }, (_, index) => `plugin-${index}-${'x'.repeat(20)}`);
  handler = async () => { started.finish(); return (await held.promise).clone(); };
  const pending = usePluginsStore.getState().loadRegistryInfo({ specs });
  await started.promise;
  switchTo('b');
  const replacement = { 'new': { kind: 'git-ok' as const, spec: 'new' } };
  usePluginsStore.setState({ registryInfo: replacement, isLoadingRegistry: true });
  const count = requests.filter((request) => new URL(request.url).pathname.endsWith('/registry')).length;
  held.finish(Response.json({ results: [{ kind: 'git-ok', spec: specs[0] }] }));
  expect(await pending).toBe(false);
  expect(requests.filter((request) => new URL(request.url).pathname.endsWith('/registry'))).toHaveLength(count);
  expect(usePluginsStore.getState().registryInfo).toBe(replacement);
  expect(usePluginsStore.getState().isLoadingRegistry).toBe(true);
});
for (const kind of ['check', 'update']) test(`retired package ${kind} cannot publish or follow up on B`, async () => {
  const held = deferred<Response>(); const started = deferred<void>(); handler = async () => { started.finish(); return held.promise; };
  const pending = kind === 'check' ? usePluginsStore.getState().checkUpdates() : usePluginsStore.getState().updatePackage('lab');
  await started.promise; switchTo('b');
  usePluginsStore.setState({ runtime: { kind: 'failed', scope: 'b' }, isCheckingUpdates: true });
  held.finish(kind === 'update' ? new Response(null, { status: 204 }) : Response.json({ location: { directory: '/shared' }, data: [] }));
  expect(await pending).toBe(false);
  expect(usePluginsStore.getState().runtime).toEqual({ kind: 'failed', scope: 'b' });
  expect(usePluginsStore.getState().isCheckingUpdates).toBe(true);
  expect(requests.filter((request) => new URL(request.url).hostname === 'runtime-b.invalid' && new URL(request.url).pathname.startsWith('/api/plugin'))).toHaveLength(0);
});

for (const outcome of ['http', 'transport']) test(`retired ${outcome} failure cannot log or mutate replacement state`, async () => {
  const held = deferred<Response>(); const started = deferred<void>();
  const errors = spyOn(console, 'error').mockImplementation(() => {});
  handler = async () => { started.finish(); return held.promise; };
  try {
    const pending = usePluginsStore.getState().createFile({ fileName: 'lab.ts', content: 'export {}', scope: 'user' });
    await started.promise; switchTo('b');
    const replacement = [{ ...entry, options: { owner: 'b' } }]; usePluginsStore.setState({ entries: replacement });
    if (outcome === 'http') held.finish(Response.json({ error: 'old failure' }, { status: 500 }));
    else held.fail(new Error('old connection failure'));
    expect(await pending).toEqual({ ok: false }); expect(errors).not.toHaveBeenCalled();
    expect(usePluginsStore.getState().entries).toBe(replacement);
  } finally { errors.mockRestore(); }
});

test('directory round trip retires a mutation through the actual config resolver', async () => {
  const held = deferred<Response>(); const started = deferred<void>();
  handler = async () => { started.finish(); return held.promise; };
  const pending = usePluginsStore.getState().deleteEntry(entry.id); await started.promise;
  useProjectsStore.setState({ activeProjectId: 'b' }); useProjectsStore.setState({ activeProjectId: 'a' });
  held.finish(Response.json({ success: true }));
  expect(await pending).toEqual({ ok: false }); expect(usePluginsStore.getState().selectedId).toBe(entry.id);
});

test('reload owner stops after a held real health probe and releases its update count', async () => {
  const health = deferred<Response>(); const started = deferred<void>();
  handler = async (request) => {
    if (new URL(request.url).pathname.endsWith('/opencode/health')) { started.finish(); return health.promise; }
    return Response.json({ success: true, requiresReload: true, reloadDelayMs: 0 });
  };
  const pending = usePluginsStore.getState().createFile({ fileName: 'lab.ts', content: 'export {}', scope: 'user' });
  await started.promise; expect(getConfigUpdateSnapshot().isUpdating).toBe(true);
  switchTo('b'); health.finish(Response.json({ healthy: true }));
  expect(await pending).toEqual({ ok: false }); expect(getConfigUpdateSnapshot().isUpdating).toBe(false);
  expect(requests.filter((request) => new URL(request.url).hostname === 'runtime-b.invalid' && new URL(request.url).pathname.startsWith('/api/'))).toHaveLength(0);
});
