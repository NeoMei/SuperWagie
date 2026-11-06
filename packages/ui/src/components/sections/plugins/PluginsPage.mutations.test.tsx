import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { PluginDraft, PluginEntry, PluginFile, RegistryResult } from '@/stores/usePluginsStore';

const browser = new Window({ url: 'http://fixture.invalid/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator,
  localStorage: browser.localStorage, sessionStorage: browser.sessionStorage,
  Event: browser.Event, FocusEvent: browser.FocusEvent, CustomEvent: browser.CustomEvent,
  MouseEvent: browser.MouseEvent, Node: browser.Node, Element: browser.Element,
  KeyboardEvent: browser.KeyboardEvent,
  HTMLElement: browser.HTMLElement, HTMLInputElement: browser.HTMLInputElement,
  HTMLTextAreaElement: browser.HTMLTextAreaElement, MutationObserver: browser.MutationObserver,
  ResizeObserver: browser.ResizeObserver, getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});

const deferred = <T,>() => {
  let resolve: (value: T) => void = () => { throw new Error('Deferred not initialized'); };
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
};
const requests: Request[] = [];
const unexpected: string[] = [];
type Handler = (request: Request) => Promise<Response>;
let handlePlugin: Handler = async (request) => { throw new Error(`Plugin handler missing for ${request.url}`); };
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
  const request = input instanceof Request ? input : new Request(new URL(String(input), window.location.href), init);
  requests.push(request);
  const url = new URL(request.url);
  if (url.protocol !== 'http:' || !['fixture.invalid', 'runtime-a.invalid', 'runtime-b.invalid'].includes(url.hostname)) {
    unexpected.push(`${request.method} ${request.url}`);
    throw new Error(`Disallowed origin ${request.url}`);
  }
  if (request.method === 'GET' && url.pathname === '/api/fs/home') return Response.json({ home: '/fixture-home' });
  if (request.method === 'GET' && url.pathname === '/api/location') return Response.json({ data: { directory: '/shared' } });
  if (request.method === 'GET' && url.pathname === '/api/session') return Response.json({ data: [], cursor: {} });
  if (request.method === 'GET' && url.pathname === '/api/plugin') return Response.json({ location: { directory: '/shared' }, data: [] });
  if (request.method === 'GET' && url.pathname === '/api/config/themes') return Response.json({ themes: [] });
  if (request.method === 'POST' && url.pathname === '/auth/url-token') return Response.json({ token: 'fixture-only', expiresAt: Date.now() + 60000, expiresIn: 60000 });
  if (url.pathname.startsWith('/api/config/plugins')) return handlePlugin(request);
  unexpected.push(`${request.method} ${request.url}`);
  throw new Error(`Unexpected request ${request.method} ${request.url}`);
});

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { useI18nStore } = await import('@/lib/i18n/store');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { usePluginsStore, getPluginsScopeKey } = await import('@/stores/usePluginsStore');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { switchRuntimeEndpoint, getRuntimeKey } = await import('@/lib/runtime-switch');
const { toast } = await import('@/components/ui');
const { PluginsPage } = await import('@/components/sections/plugins/PluginsPage');
const success = spyOn(toast, 'success').mockImplementation(() => 'success');
const error = spyOn(toast, 'error').mockImplementation(() => 'error');
const warning = spyOn(toast, 'warning').mockImplementation(() => 'warning');
const originalStore = usePluginsStore.getState();
const entry: PluginEntry = {
  id: 'config:user:plugin-a', kind: 'config', scope: 'user', parsedKind: 'npm',
  spec: 'plugin-a', sourcePath: '/fixture-home/.config/opencode/opencode.json', options: { owner: 'a' },
};
const registry: RegistryResult = {
  kind: 'npm-ok', spec: 'plugin-a', name: 'plugin-a', currentVersion: '1.0.0',
  latestVersion: '1.0.0', versions: ['1.0.0'], hasUpdate: false,
};
const bDraft: PluginDraft = {
  mode: 'entry', scope: 'user', spec: 'plugin-a', optionsJson: '{"owner":"b-unsaved"}',
  fileName: '', content: '',
};
const switchTo = (id: 'a' | 'b') => switchRuntimeEndpoint({ apiBaseUrl: `http://runtime-${id}.invalid`, runtimeKey: `plugin-prep-${id}` });
const seed = (owner: 'a' | 'b') => usePluginsStore.setState({
  ...originalStore, entries: [{ ...entry, options: { owner } }], files: [], selectedId: entry.id,
  draft: null, loadedDirectory: '/shared', loadedRuntimeKey: getRuntimeKey(),
  registryInfo: { [entry.spec]: registry }, isLoading: false, isLoadingRegistry: false,
  runtime: { kind: 'ready', scope: getPluginsScopeKey('/shared'), plugins: [] }, packageUpdates: {},
});
let root: ReturnType<typeof createRoot> | null = null;
const pendingReads: Array<ReturnType<typeof deferred<Response>>> = [];
let deleteResponse = deferred<Response>();
let deleteStarted = deferred<void>();
let releaseDelete = () => deleteResponse.resolve(Response.json({ success: true, requiresReload: false, message: 'deleted' }));
let listEntries: PluginEntry[] = [];

beforeEach(() => {
  requests.length = 0; unexpected.length = 0;
  success.mockClear(); error.mockClear(); warning.mockClear();
  deleteResponse = deferred<Response>(); deleteStarted = deferred<void>();
  releaseDelete = () => deleteResponse.resolve(Response.json({ success: true, requiresReload: false, message: 'deleted' }));
  listEntries = [];
  handlePlugin = async (request) => {
    const url = new URL(request.url);
    if (request.method === 'DELETE' && url.pathname === `/api/config/plugins/entry/${encodeURIComponent(entry.id)}`) {
      deleteStarted.resolve(); return deleteResponse.promise;
    }
    if (request.method === 'GET' && url.pathname === '/api/config/plugins') return Response.json({ entries: listEntries, files: [] });
    if (request.method === 'GET' && url.pathname === '/api/config/plugins/registry') return Response.json({ results: [registry] });
    unexpected.push(`${request.method} ${request.url}`);
    throw new Error(`Unexpected plugin request ${request.method} ${request.url}`);
  };
  switchTo('a');
  useProjectsStore.setState({ projects: [{ id: 'shared', path: '/shared' }], activeProjectId: 'shared' });
  useI18nStore.getState().setLocale('en');
  seed('a');
});
afterEach(async () => {
  releaseDelete();
  await act(async () => { root?.unmount(); }); root = null;
  for (const pending of pendingReads.splice(0)) pending.resolve(Response.json({ fileName: 'plugin.ts', scope: 'user', content: 'b-saved' }));
  expect(unexpected).toEqual([]);
  usePluginsStore.setState(originalStore);
});
afterAll(() => {
  success.mockRestore(); error.mockRestore(); warning.mockRestore(); fetchSpy.mockRestore(); browser.close();
});

const mutations = () => requests.filter((request) => request.method !== 'GET' && new URL(request.url).pathname.startsWith('/api/config/plugins'));
const configRequests = () => requests.filter((request) => new URL(request.url).pathname.startsWith('/api/config/plugins'));
const featureFollowUps = (boundary: number) => requests.slice(boundary).filter((request) => {
  const path = new URL(request.url).pathname;
  return path === '/api/plugin' || path.startsWith('/api/plugin/') || path.startsWith('/api/config/plugins');
});
const click = (label: string, selector = 'button') => {
  const match = [...document.querySelectorAll<HTMLButtonElement>(selector)].find((button) => button.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button ${label}`);
  match.click();
};
const renderPage = async () => {
  const container = document.createElement('div'); document.body.replaceChildren(container);
  root = createRoot(container);
  await act(async () => { root?.render(<I18nProvider><ThemeSystemProvider><PluginsPage /></ThemeSystemProvider></I18nProvider>); });
  return container;
};
const startPageDelete = async () => {
  await act(async () => click('Delete'));
  await act(async () => click('Delete', '[role="dialog"] button'));
  await deleteStarted.promise;
};

test('store same-owner DELETE clears its selected entry and registry', async () => {
  const pending = usePluginsStore.getState().deleteEntry(entry.id);
  await deleteStarted.promise;
  releaseDelete();
  expect(await pending).toEqual({ ok: true, reloadFailed: false, message: 'deleted', warning: undefined });
  expect(mutations().map((request) => `${request.method} ${request.url}`)).toEqual([
    'DELETE http://runtime-a.invalid/api/config/plugins/entry/config%3Auser%3Aplugin-a?directory=%2Fshared',
  ]);
  expect(mutations()[0]?.headers.get('x-opencode-directory')).toBe('/shared');
  expect(usePluginsStore.getState().selectedId).toBeNull();
  expect(usePluginsStore.getState().registryInfo['plugin-a']).toBeUndefined();
});

for (const returnToA of [false, true]) {
  test(`store retired DELETE preserves current same-ID selection draft and registry after ${returnToA ? 'A-B-A' : 'A-B'}`, async () => {
    const pending = usePluginsStore.getState().deleteEntry(entry.id);
    await deleteStarted.promise;
    switchTo('b'); if (returnToA) switchTo('a');
    seed('b'); usePluginsStore.getState().setDraft(bDraft);
    listEntries = [{ ...entry, options: { owner: 'b' } }];
    const boundary = requests.length;
    releaseDelete();
    const result = await pending;
    const state = usePluginsStore.getState();
    console.log(JSON.stringify({ proof: 'store-late-delete', returnToA, result, selectedId: state.selectedId,
      draft: state.draft, registryRetained: state.registryInfo[entry.spec] === registry,
      followUps: requests.slice(boundary).map((request) => `${request.method} ${request.url}`) }));
    expect(result.ok).toBe(false);
    expect(featureFollowUps(boundary)).toHaveLength(0);
    expect(state.selectedId).toBe(entry.id);
    expect(state.draft).toBe(bDraft);
    expect(state.registryInfo[entry.spec]).toBe(registry);
  });
}

test('page same-owner confirmed DELETE clears its editor and reports success', async () => {
  await renderPage();
  await startPageDelete();
  await act(async () => releaseDelete());
  expect(usePluginsStore.getState().selectedId).toBeNull();
  expect(usePluginsStore.getState().draft).toBeNull();
  expect(document.querySelector('[role="dialog"]') === null).toBe(true);
  expect(success).toHaveBeenCalledTimes(1);
  expect(error).not.toHaveBeenCalled();
  expect(mutations()).toHaveLength(1);
});

test('page late A DELETE preserves B same-ID unsaved editor and registry without stale feedback', async () => {
  const container = await renderPage();
  await startPageDelete();
  await act(async () => { switchTo('b'); seed('b'); });
  await act(async () => usePluginsStore.getState().setDraft(bDraft));
  expect(container.querySelector('textarea')?.value).toBe('{"owner":"b-unsaved"}');
  listEntries = [{ ...entry, options: { owner: 'b' } }];
  const boundary = requests.length;
  await act(async () => releaseDelete());
  const state = usePluginsStore.getState();
  console.log(JSON.stringify({ proof: 'page-late-delete', selectedId: state.selectedId, draft: state.draft,
    editor: container.querySelector('textarea')?.value ?? null, registryRetained: state.registryInfo[entry.spec] === registry,
    successes: success.mock.calls.length, errors: error.mock.calls.length,
    followUps: requests.slice(boundary).map((request) => `${request.method} ${request.url}`),
    mutations: mutations().map((request) => `${request.method} ${request.url}`),
    configReads: configRequests().filter((request) => request.method === 'GET').length }));
  expect(state.selectedId).toBe(entry.id);
  expect(state.draft).toBe(bDraft);
  expect(state.registryInfo[entry.spec]).toBe(registry);
  expect(container.querySelector('textarea')?.value).toBe('{"owner":"b-unsaved"}');
  expect(featureFollowUps(boundary)).toHaveLength(0);
  expect(success).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled(); expect(warning).not.toHaveBeenCalled();
  expect(mutations().map((request) => `${request.method} ${request.url}`)).toEqual([
    'DELETE http://runtime-a.invalid/api/config/plugins/entry/config%3Auser%3Aplugin-a?directory=%2Fshared',
  ]);
});

test('page old-render confirmation cannot dispatch its first DELETE on B before a React commit', async () => {
  await renderPage();
  await act(async () => click('Delete'));
  await act(async () => {
    switchTo('b');
    click('Delete', '[role="dialog"] button');
    await Promise.resolve();
  });
  console.log(JSON.stringify({ proof: 'old-render-delete-dispatch', mutations: mutations().map((request) => `${request.method} ${request.url}`) }));
  expect(mutations()).toHaveLength(0);
});

for (const failed of [false, true]) test(`page ${failed ? 'failed' : 'held'} B file hydration cannot submit dirty A content through the B editor`, async () => {
  const file: PluginFile = { id: 'file:user:plugin.ts', fileName: 'plugin.ts', kind: 'file', scope: 'user', absolutePath: '/shared/.opencode/plugins/plugin.ts' };
  const originalHandler = handlePlugin;
  handlePlugin = async (request) => {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === `/api/config/plugins/file/${encodeURIComponent(file.id)}`) {
      if (url.hostname === 'runtime-a.invalid') return Response.json({ fileName: 'plugin.ts', scope: 'user', content: 'a-saved' });
      const pending = deferred<Response>(); pendingReads.push(pending); return pending.promise;
    }
    if (request.method === 'PUT' && url.pathname === `/api/config/plugins/file/${encodeURIComponent(file.id)}`) {
      return Response.json({ success: true, requiresReload: false });
    }
    if (request.method === 'GET' && url.pathname === '/api/config/plugins') return Response.json({ entries: [], files: [file] });
    return originalHandler(request);
  };
  usePluginsStore.setState({ entries: [], files: [file], selectedId: file.id });
  const container = await renderPage();
  expect(container.querySelector('textarea')?.value).toBe('a-saved');
  await act(async () => {
    const draft = usePluginsStore.getState().draft;
    if (!draft) throw new Error('A file draft missing');
    usePluginsStore.getState().setDraft({ ...draft, content: 'a-unsaved' });
  });
  const previousEditor = container.querySelector('textarea');
  await act(async () => {
    switchTo('b');
    await usePluginsStore.getState().loadPlugins({ force: true });
  });
  expect(pendingReads.length).toBeGreaterThan(0);
  if (failed) await act(async () => {
    for (const pending of pendingReads.splice(0)) pending.resolve(Response.json({ error: 'fixture file failure' }, { status: 500 }));
  });
  const editor = container.querySelector('textarea') ?? previousEditor;
  if (!editor) throw new Error('File editor fixture missing');
  await act(async () => { editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })); });
  const writes = mutations();
  console.log(JSON.stringify({ proof: 'unhydrated-b-file-write', visibleContent: editor.value,
    disabled: editor.disabled, pendingBReads: pendingReads.length,
    writes: await Promise.all(writes.map(async (request) => ({ method: request.method, url: request.url, body: await request.clone().json() }))) }));
  expect(writes).toHaveLength(0);
  if (failed) await act(async () => { await usePluginsStore.getState().loadPlugins({ force: true }); });
  await act(async () => {
    for (const pending of pendingReads.splice(0)) pending.resolve(Response.json({ fileName: 'plugin.ts', scope: 'user', content: 'b-saved' }));
  });
  expect(container.querySelector('textarea')?.value).toBe('b-saved');
  await act(async () => {
    const draft = usePluginsStore.getState().draft;
    if (!draft) throw new Error('Hydrated B draft missing');
    usePluginsStore.getState().setDraft({ ...draft, content: 'b-unsaved' });
  });
  await act(async () => { container.querySelector('textarea')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })); });
  expect(await mutations()[0]?.clone().json()).toEqual({ content: 'b-unsaved' });
});

test('retired page unmount preserves the replacement runtime selection and draft', async () => {
  await renderPage();
  await act(async () => {
    switchTo('b'); seed('b'); usePluginsStore.getState().setDraft(bDraft);
    root?.unmount(); root = null;
  });
  expect(usePluginsStore.getState().selectedId).toBe(entry.id);
  expect(usePluginsStore.getState().draft).toBe(bDraft);
});

test('old delete completion preserves a new same-ID confirmation after selection round trip', async () => {
  const list = deferred<Response>(); const listStarted = deferred<void>();
  const originalHandler = handlePlugin;
  handlePlugin = async (request) => {
    if (request.method === 'GET' && new URL(request.url).pathname === '/api/config/plugins') { listStarted.resolve(); return list.promise; }
    return originalHandler(request);
  };
  await renderPage(); await startPageDelete();
  await act(async () => releaseDelete()); await listStarted.promise;
  await act(async () => { usePluginsStore.getState().setSelected(null); usePluginsStore.getState().setSelected(entry.id); });
  await act(async () => click('Delete'));
  await act(async () => list.resolve(Response.json({ entries: [entry], files: [] })));
  expect(usePluginsStore.getState().selectedId).toBe(entry.id);
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog).not.toBeNull();
  if (!dialog) throw new Error('Replacement confirmation missing');
  expect([...dialog.querySelectorAll<HTMLButtonElement>('button')].some((button) => button.textContent?.trim() === 'Delete' && !button.disabled)).toBe(true);
  expect(success).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
});

test('successful catalog removal and reappearance revoke the old rendered entry model', async () => {
  const container = await renderPage();
  await act(async () => {
    const draft = usePluginsStore.getState().draft;
    if (!draft) throw new Error('Entry draft missing');
    usePluginsStore.getState().setDraft({ ...draft, optionsJson: '{"owner":"old-dirty"}' });
  });
  const input = container.querySelector('input'); if (!input) throw new Error('Entry input missing');
  await act(async () => {
    usePluginsStore.setState({ entries: [] });
    usePluginsStore.setState({ entries: [{ ...entry, options: { owner: 'fresh' } }] });
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
  expect(mutations()).toHaveLength(0);
  expect(JSON.parse(usePluginsStore.getState().draft?.optionsJson ?? '{}')).toEqual({ owner: 'fresh' });
});
