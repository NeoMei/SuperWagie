import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
const browser = new Window({ url: 'http://fixture.invalid/' });
Object.assign(globalThis, { window: browser, document: browser.document, navigator: browser.navigator,
  localStorage: browser.localStorage, sessionStorage: browser.sessionStorage, Event: browser.Event, CustomEvent: browser.CustomEvent,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement, HTMLInputElement: browser.HTMLInputElement,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver, getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true });
const deferred = <T,>() => { let finish: (value: T) => void = () => {}; const promise = new Promise<T>((resolve) => { finish = resolve; }); return { promise, finish }; };
const requests: Request[] = []; const unexpected: string[] = [];
let held = deferred<Response>(); let started = deferred<void>();
let catalogSpec = 'lab@1';
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
  const request = input instanceof Request ? input : new Request(new URL(String(input), window.location.href), init); requests.push(request);
  const path = new URL(request.url).pathname;
  if (path === '/auth/url-token') return Response.json({ token: 'fixture-only', expiresAt: Date.now() + 60000 });
  if (path === '/api/fs/home') return Response.json({ home: '/fixture-home' });
  if (path === '/api/location') return Response.json({ data: { directory: '/shared' } });
  if (path === '/api/session') return Response.json({ data: [], cursor: {} });
  if (path === '/api/config/themes') return Response.json({ themes: [] });
  if (path === '/api/plugin') return Response.json({ location: { directory: '/shared' }, data: [] });
  if (path === '/api/config/plugins' && request.method === 'GET') return Response.json({ entries: [{ id: 'one', spec: catalogSpec, kind: 'config', parsedKind: 'npm', scope: 'user' }], files: [] });
  if (path === '/api/config/plugins/registry') return Response.json({ results: [] });
  if ((path === '/api/config/plugins/entry' && request.method === 'POST') || (path.startsWith('/api/config/plugins/entry/') && request.method === 'PATCH')) { started.finish(); return held.promise; }
  if (path === '/api/plugin/update' && request.method === 'POST') { started.finish(); return held.promise; }
  unexpected.push(`${request.method} ${request.url}`); throw new Error(`Unexpected ${request.url}`);
});
const { act } = await import('react'); const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n'); const { useI18nStore } = await import('@/lib/i18n/store');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { usePluginsStore, getPluginsScopeKey } = await import('@/stores/usePluginsStore'); const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { switchRuntimeEndpoint, getRuntimeKey } = await import('@/lib/runtime-switch'); const { toast } = await import('@/components/ui');
const { AddPluginDialog } = await import('./AddPluginDialog'); const { RegistryBanner } = await import('./RegistryBanner');
const { PluginStatusBanner } = await import('./PluginStatusBanner'); const { PluginsGrid } = await import('./PluginsGrid');
const { PluginsPage } = await import('./PluginsPage');
const success = spyOn(toast, 'success').mockImplementation(() => 'success'); const error = spyOn(toast, 'error').mockImplementation(() => 'error');
const warning = spyOn(toast, 'warning').mockImplementation(() => 'warning');
const original = usePluginsStore.getState(); let root: ReturnType<typeof createRoot> | null = null; const closes: boolean[] = [];
const switchTo = (host: string) => switchRuntimeEndpoint({ apiBaseUrl: `http://runtime-${host}.invalid`, runtimeKey: `plugin-callers-${host}` });
beforeEach(() => {
  held = deferred<Response>(); started = deferred<void>(); requests.length = 0; unexpected.length = 0; closes.length = 0;
  catalogSpec = 'lab@1';
  success.mockClear(); error.mockClear(); warning.mockClear(); switchTo('a'); useI18nStore.getState().setLocale('en');
  useProjectsStore.setState({ projects: [{ id: 'a', path: '/shared' }], activeProjectId: 'a' });
  usePluginsStore.setState({ ...original, entries: [{ id: 'one', spec: 'lab@1', kind: 'config', parsedKind: 'npm', scope: 'user' }],
    registryInfo: { 'lab@1': { kind: 'npm-ok', spec: 'lab@1', name: 'lab', currentVersion: '1', latestVersion: '2', versions: ['1', '2'], hasUpdate: true } } });
});
afterEach(async () => { held.finish(Response.json({ success: true })); await act(async () => root?.unmount()); root = null; expect(unexpected).toEqual([]); usePluginsStore.setState(original); });
afterAll(() => { success.mockRestore(); error.mockRestore(); warning.mockRestore(); fetchSpy.mockRestore(); browser.close(); });
const render = async (node: React.ReactNode) => { const container = document.createElement('div'); document.body.replaceChildren(container); root = createRoot(container); await act(async () => root?.render(<I18nProvider><ThemeSystemProvider>{node}</ThemeSystemProvider></I18nProvider>)); };
const submit = () => { const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === 'Add'); if (!button) throw new Error('Add button missing'); button.click(); };
const fill = async () => {
  const field = document.querySelector<HTMLInputElement>('#plugin-spec'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!field || !setter) throw new Error('Plugin spec input missing');
  await act(async () => { setter.call(field, 'lab'); field.dispatchEvent(new Event('input', { bubbles: true })); });
};
test('same-owner add closes only after its real POST succeeds', async () => {
  await render(<AddPluginDialog open onOpenChange={(open) => closes.push(open)} />); await fill();
  await act(async () => submit()); await started.promise;
  await act(async () => held.finish(Response.json({ success: true })));
  expect(closes).toEqual([false]); expect(success).toHaveBeenCalledTimes(1);
  const request = requests.find((request) => request.method === 'POST' && new URL(request.url).pathname === '/api/config/plugins/entry');
  expect(request?.url).toBe('http://runtime-a.invalid/api/config/plugins/entry?directory=%2Fshared');
  expect(await request?.clone().json()).toEqual({ spec: 'lab', scope: 'user' });
});
test('old rendered add cannot send its first POST on B', async () => {
  await render(<AddPluginDialog open onOpenChange={(open) => closes.push(open)} />); await fill();
  await act(async () => { switchTo('b'); submit(); });
  expect(requests.filter((request) => request.method === 'POST' && new URL(request.url).pathname === '/api/config/plugins/entry')).toHaveLength(0);
});
test('retired add completion preserves the open form and suppresses failure feedback', async () => {
  await render(<AddPluginDialog open onOpenChange={(open) => closes.push(open)} />); await fill();
  await act(async () => submit()); await started.promise;
  await act(async () => switchTo('b'));
  await act(async () => held.finish(Response.json({ success: true })));
  expect(closes).toEqual([]); expect(success).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
});
test('retired pin banner suppresses its result and finalizer after selection changes', async () => {
  await render(<RegistryBanner entryId="one" spec="lab@1" />);
  const button = document.querySelector<HTMLButtonElement>('button'); if (!button) throw new Error('Update missing');
  await act(async () => button.click()); await started.promise;
  await act(async () => usePluginsStore.getState().setSelected('another'));
  await act(async () => held.finish(Response.json({ success: true })));
  expect(success).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
});

for (const outcome of ['invalid-spec', 'http-error', 'success']) test(`reopened add form preserves its fields after old ${outcome}`, async () => {
  const form = (open: boolean) => <I18nProvider><ThemeSystemProvider><AddPluginDialog open={open} onOpenChange={(next) => closes.push(next)} /></ThemeSystemProvider></I18nProvider>;
  await render(<AddPluginDialog open onOpenChange={(open) => closes.push(open)} />); await fill();
  await act(async () => submit()); await started.promise;
  await act(async () => root?.render(form(false))); await act(async () => root?.render(form(true))); await fill();
  await act(async () => held.finish(Response.json(outcome === 'invalid-spec' ? { code: 'UNLOADABLE_SPEC' } : {}, { status: outcome === 'success' ? 200 : 400 })));
  expect(closes).toEqual([]); expect(document.querySelector<HTMLInputElement>('#plugin-spec')?.value).toBe('lab');
  expect(document.querySelector('#plugin-spec')?.getAttribute('aria-invalid')).toBeNull();
  expect(success).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
});

for (const retired of [false, true]) test(`package status ${retired ? 'target round trip retires' : 'current owner reports'} real update completion`, async () => {
  usePluginsStore.setState({ runtime: { kind: 'ready', scope: getPluginsScopeKey('/shared'), plugins: [{ source: { kind: 'package', target: 'lab', version: '1', outdated: true, updating: false }, state: { kind: 'active' } }] } });
  const banner = (target: string) => <I18nProvider><ThemeSystemProvider><PluginStatusBanner target={{ kind: 'package', target }} name={target} /></ThemeSystemProvider></I18nProvider>;
  await render(<PluginStatusBanner target={{ kind: 'package', target: 'lab' }} name="lab" />);
  const button = document.querySelector<HTMLButtonElement>('button'); if (!button) throw new Error('Package update button missing');
  await act(async () => button.click()); await started.promise;
  if (retired) { await act(async () => root?.render(banner('other'))); await act(async () => root?.render(banner('lab'))); }
  await act(async () => held.finish(new Response(null, { status: 204 })));
  expect(success.mock.calls.length).toBe(retired ? 0 : 1); expect(error).not.toHaveBeenCalled();
  const request = requests.find((request) => new URL(request.url).pathname === '/api/plugin/update');
  expect(await request?.clone().json()).toEqual({ targets: ['lab'] });
});

test('grid pin update retires feedback when its mounted grid is left', async () => {
  await render(<PluginsGrid onAdd={() => {}} onDelete={() => {}} />);
  const actions = document.querySelector<HTMLButtonElement>('[aria-label="Actions for lab@1"]');
  if (!actions) throw new Error('Grid actions missing');
  await act(async () => actions.click());
  const update = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((node) => node.textContent?.includes('2'));
  if (!update) throw new Error('Grid update action missing');
  await act(async () => update.click()); await started.promise;
  await act(async () => root?.unmount()); root = null;
  held.finish(Response.json({ success: true }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(success).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
});

const renderPinPage = async () => {
  usePluginsStore.setState({ selectedId: 'one', loadedDirectory: '/shared', loadedRuntimeKey: getRuntimeKey() });
  await render(<PluginsPage />);
};
const pinButton = () => {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.includes('Update to'));
  if (!button) throw new Error('Actual page pin action missing');
  return button;
};

test('actual page pin retains success across its accepted catalog spec publication', async () => {
  await renderPinPage();
  await act(async () => pinButton().click()); await started.promise;
  catalogSpec = 'lab@2';
  await act(async () => held.finish(Response.json({ success: true })));
  expect(usePluginsStore.getState().entries[0]?.spec).toBe('lab@2');
  expect(success).toHaveBeenCalledTimes(1); expect(error).not.toHaveBeenCalled();
  const patch = requests.find((request) => request.method === 'PATCH');
  expect(patch?.url).toBe('http://runtime-a.invalid/api/config/plugins/entry/one?directory=%2Fshared');
  expect(await patch?.clone().json()).toEqual({ spec: 'lab@2' });
});

test('actual page pin failure releases its action and a current retry reports success', async () => {
  await renderPinPage();
  await act(async () => pinButton().click()); await started.promise;
  await act(async () => held.finish(Response.json({ error: 'fixture pin failure' }, { status: 500 })));
  expect(error).toHaveBeenCalledTimes(1); expect(success).not.toHaveBeenCalled();
  expect(pinButton().disabled).toBe(false);
  held = deferred<Response>(); started = deferred<void>();
  await act(async () => pinButton().click()); await started.promise;
  catalogSpec = 'lab@2';
  await act(async () => held.finish(Response.json({ success: true })));
  expect(success).toHaveBeenCalledTimes(1); expect(error).toHaveBeenCalledTimes(1);
  expect(requests.filter((request) => request.method === 'PATCH')).toHaveLength(2);
});

for (const retirement of ['external-target', 'batched-target', 'same-ID-visit']) test(`actual page pin stays retired after ${retirement} returns`, async () => {
  await renderPinPage(); await act(async () => pinButton().click()); await started.promise;
  await act(async () => {
    if (retirement === 'same-ID-visit') {
      usePluginsStore.getState().setSelected(null); usePluginsStore.getState().setSelected('one');
    } else {
      const entry = usePluginsStore.getState().entries[0]; if (!entry) throw new Error('Entry missing');
      usePluginsStore.setState({ entries: [{ ...entry, spec: 'external@1' }] });
      if (retirement === 'batched-target') usePluginsStore.setState({ entries: [{ ...entry, spec: 'lab@1' }] });
    }
  });
  if (retirement === 'external-target') await act(async () => {
    const entry = usePluginsStore.getState().entries[0]; if (!entry) throw new Error('Entry missing');
    usePluginsStore.setState({ entries: [{ ...entry, spec: 'lab@1' }] });
  });
  catalogSpec = 'lab@2'; await act(async () => held.finish(Response.json({ success: true })));
  expect(success).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
});

test('external expected-pin prop rebind cannot claim an authoritative echo or revive the old operation', async () => {
  const banner = (spec: string) => <I18nProvider><ThemeSystemProvider><RegistryBanner entryId="one" spec={spec} /></ThemeSystemProvider></I18nProvider>;
  await render(<RegistryBanner entryId="one" spec="lab@1" />);
  await act(async () => pinButton().click()); await started.promise;
  await act(async () => root?.render(banner('lab@2')));
  await act(async () => root?.render(banner('lab@1')));
  catalogSpec = 'lab@2'; await act(async () => held.finish(Response.json({ success: true })));
  expect(success).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
});
