import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
};

async function setup(surface: 'sidebar' | 'view' = 'sidebar') {
  const dom = new Window({ url: 'https://file-tree.invalid', settings: { disableIframePageLoading: true, disableCSSFileLoading: true, disableJavaScriptFileLoading: true } });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const mutations: Array<{ runtime: string; url: string; body: string; finish: ReturnType<typeof deferred<Response>> }> = [];
  const listings: Array<{ runtime: string; path: string }> = [];
  let holdRefresh = false;
  let pendingRefresh: ReturnType<typeof deferred<Response>> | null = null;
  let currentRuntime = () => 'uninitialized';
  const fixtureFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'https://file-tree.invalid');
    if (url.pathname === '/api/fs/rename' || url.pathname === '/api/fs/delete'
      || url.pathname === '/api/fs/create' || url.pathname === '/api/fs/mkdir') {
      const finish = deferred<Response>();
      mutations.push({ runtime: currentRuntime(), url: url.href, body: String(init?.body ?? ''), finish });
      return finish.promise;
    }
    if (url.pathname === '/api/fs/list') {
      const path = url.searchParams.get('path') ?? '/repo';
      listings.push({ runtime: currentRuntime(), path });
      if (holdRefresh) {
        holdRefresh = false;
        pendingRefresh = deferred<Response>();
        return pendingRefresh.promise;
      }
      return Response.json({ directory: path, entries: [{ name: 'example.txt', path: `${path}/example.txt`, isDirectory: false }] });
    }
    if (url.pathname.includes('/auth/url-token')) return Response.json({ token: 'synthetic-file-tree-token', expiresAt: Date.now() + 60000 });
    return new Promise<Response>(() => {});
  };
  Object.defineProperty(dom, 'fetch', { configurable: true, value: fixtureFetch });
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator, location: dom.location, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, Node: dom.Node,
    SVGElement: dom.SVGElement, ShadowRoot: dom.ShadowRoot, DOMRect: dom.DOMRect, Document: dom.Document, Text: dom.Text, Range: dom.Range, customElements: dom.customElements, CSSStyleSheet: dom.CSSStyleSheet,
    Event: dom.Event, CustomEvent: dom.CustomEvent, KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent,
    PointerEvent: dom.PointerEvent, MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
    IntersectionObserver: dom.IntersectionObserver,
    Worker: class extends EventTarget { postMessage() {} terminate() {} },
    WebSocket: class extends dom.EventTarget {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      readyState = 0; send() {} close() { this.readyState = 3; }
    },
    getComputedStyle: dom.getComputedStyle.bind(dom), requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), fetch: fixtureFetch, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  for (const name of ['offsetHeight', 'offsetWidth', 'clientHeight', 'clientWidth']) {
    Object.defineProperty(dom.HTMLElement.prototype, name, { configurable: true, get: () => 600 });
  }
  const { createRoot } = await import('react-dom/client');
  const { toast } = await import('@/components/ui/toast');
  const { I18nProvider } = await import('@/lib/i18n');
  const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { createWebAPIs } = await import('../../../../web/src/api/index');
  const { createContentCachedFiles } = await import('@/contexts/content-cache-owner');
  const { useSessionUIStore } = await import('@/sync/session-ui-store');
  const { useFilesViewTabsStore } = await import('@/stores/useFilesViewTabsStore');
  const { useUIStore } = await import('@/stores/useUIStore');
  const { useGitStore } = await import('@/stores/useGitStore');
  const { useDirectoryStore } = await import('@/stores/useDirectoryStore');
  const { SyncProvider } = await import('@/sync/sync-context');
  const { OpenCode } = await import('@opencode/client');
  const { SidebarFilesTree } = await import('@/components/layout/SidebarFilesTree');
  const { FilesView } = await import('@/components/views/FilesView');
  const { moveWorkspacePath } = await import('@/components/views/files/moveWorkspacePath');
  const { isFilePathMoveInFlight, subscribeToFilePathMoves } = await import('@/lib/filePathMoves');
  const { getRuntimeKey, switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
  currentRuntime = getRuntimeKey;
  const changeRuntime = (name: string) => {
    switchRuntimeEndpoint({ apiBaseUrl: `https://${name.toLowerCase()}.invalid`, runtimeKey: name });
    useFilesViewTabsStore.getState().resetForRuntimeSwitch(name);
    useGitStore.setState({ runtimeKey: name });
  };
  changeRuntime('A');
  useFilesViewTabsStore.setState({ byRoot: {}, runtimeSnapshots: {} });
  useUIStore.setState({ contextPanelByDirectory: {} });
  const openFile = () => {
    useUIStore.getState().openContextFile('/repo', '/repo/example.txt');
    useFilesViewTabsStore.getState().setSelectedPath('/repo', '/repo/example.txt');
    useFilesViewTabsStore.getState().expandPath('/repo', '/repo/folder');
  };
  openFile();
  useSessionUIStore.getState().openNewSessionDraft({ directoryOverride: '/repo', preserveDirectoryOverride: true });
  const web = createWebAPIs();
  const owner = createContentCachedFiles(web.files);
  const sdk = OpenCode.make({ baseUrl: 'https://sync.invalid', fetch: () => new Promise<Response>(() => {}) });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let mounted = false;
  const flush = async () => {
    for (let index = 0; index < 5; index++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  };
  const render = async (strict = false) => {
    const view = (
      <SyncProvider sdk={sdk} directory="/repo"><I18nProvider><ThemeSystemProvider><RuntimeAPIContext.Provider value={{ ...web, files: owner.files }}>
        {surface === 'sidebar' ? <SidebarFilesTree /> : <FilesView />} 
      </RuntimeAPIContext.Provider></ThemeSystemProvider></I18nProvider></SyncProvider>
    );
    await act(async () => root.render(strict ? <React.StrictMode>{view}</React.StrictMode> : view));
    mounted = true;
    await flush();
  };
  const click = async (element: Element | null | undefined) => {
    if (!(element instanceof HTMLElement)) throw new Error(`Expected interactive element; DOM ${document.body.textContent?.replace(/\s+/g, ' ').slice(-1200)}`);
    await act(async () => element.click());
    await flush();
  };
  const dialog = async (kind: 'Rename' | 'Delete', submit = true) => {
    if (surface === 'sidebar') await click(container.querySelector('button[aria-label="File menu"]'));
    else {
      const row = container.querySelector('[title="/repo/example.txt"]')?.closest('button');
      if (!row) throw new Error('Missing file row');
      await act(async () => row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })));
      await flush();
    }
    await click([...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent?.trim() === kind));
    if (kind === 'Rename') {
      const input = document.querySelector<HTMLInputElement>('[role="dialog"] input');
      if (!input) throw new Error('Missing name input');
      await act(async () => {
        Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')!.set!.call(input, 'renamed.txt');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await flush();
    }
    if (!submit) return;
    await click([...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent === (kind === 'Delete' ? 'Delete' : 'Confirm')));
    expect(mutations).toHaveLength(1);
    expect(mutations[0].runtime).toBe('A');
  };
  const create = async (kind: 'file' | 'folder', name = kind === 'file' ? 'new.txt' : 'new-folder') => {
    const label = kind === 'file' ? 'New File' : 'New Folder';
    if (surface === 'sidebar') {
      await click(container.querySelector('[aria-label="New file, folder, or upload"]'));
      await click([...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent?.trim() === label));
    } else await click(container.querySelector(`[aria-label="${label}"]`));
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input');
    if (!input) throw new Error('Missing create input');
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')!.set!.call(input, name);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
    await click([...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent === 'Confirm'));
  };
  const state = () => ({ context: structuredClone(useUIStore.getState().contextPanelByDirectory), tabs: structuredClone(useFilesViewTabsStore.getState().byRoot) });
  const unmount = async () => { if (mounted) { await act(async () => root.unmount()); mounted = false; } };
  const cleanup = async () => {
    await unmount(); owner.dispose();
    for (const mutation of mutations) mutation.finish.resolve(Response.json({ success: false }));
    pendingRefresh?.resolve(Response.json({ directory: '/repo', entries: [] }));
    await flush();
    container.remove(); dom.happyDOM.cancelAsync();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
  };
  return { changeRuntime, openFile, owner, moveWorkspacePath, isFilePathMoveInFlight, subscribeToFilePathMoves,
    mutations, listings, render, dialog, create, toast, state, flush, unmount, cleanup, click,
    sessionUI: useSessionUIStore, directoryStore: useDirectoryStore,
    changeDirectory: (directory: string) => useSessionUIStore.getState().openNewSessionDraft({ directoryOverride: directory, preserveDirectoryOverride: true }),
    holdRefresh: () => { holdRefresh = true; }, refresh: () => pendingRefresh,
    tabs: useFilesViewTabsStore };
}

test.each(['same-owner', 'failure', 'A-B', 'A-B-A'])('move helper ownership %s', async mode => {
  const v = await setup();
  let notified = 0;
  const unsubscribe = v.subscribeToFilePathMoves(() => { notified++; });
  try {
    const operation = v.moveWorkspacePath(v.owner.files, { tabs: '/repo', files: '/repo' }, '/repo/example.txt', '/repo/renamed.txt');
    await v.flush();
    expect(v.mutations).toHaveLength(1);
    expect(v.isFilePathMoveInFlight('/repo/example.txt')).toBe(true);
    if (mode.startsWith('A-B')) { v.changeRuntime('B'); v.openFile(); }
    if (mode === 'A-B-A') { v.changeRuntime('A'); v.openFile(); }
    const before = v.state();
    v.mutations[0].finish.resolve(Response.json({ success: mode !== 'failure', path: '/repo/renamed.txt' }));
    const result = await operation;
    if (mode === 'same-owner') {
      expect(result).toBe('moved'); expect(notified).toBe(1);
      expect(v.tabs.getState().byRoot['/repo'].selectedPath).toBe('/repo/renamed.txt');
    } else {
      expect(v.state()).toEqual(before);
      expect(notified).toBe(0);
    }
    expect(v.isFilePathMoveInFlight('/repo/example.txt')).toBe(false);
  } finally { unsubscribe(); await v.cleanup(); }
});

test.each((['sidebar', 'view'] as const).flatMap(surface => ['same-owner', 'failure', 'A-B-before-response', 'A-B-A-before-response', 'A-B-during-refresh', 'unmount-before-response'].map(mode => ({ surface, mode }))))('$surface delete ownership $mode', async ({ surface, mode }) => {
  const v = await setup(surface);
  try {
    await v.render(); await v.dialog('Delete');
    if (mode === 'A-B-before-response' || mode === 'A-B-A-before-response') {
      await act(async () => { v.changeRuntime('B'); v.openFile(); }); await v.flush();
      if (mode === 'A-B-A-before-response') { await act(async () => { v.changeRuntime('A'); v.openFile(); }); await v.flush(); }
    }
    if (mode === 'unmount-before-response') await v.unmount();
    if (mode === 'A-B-during-refresh') v.holdRefresh();
    const before = v.state();
    const listCount = v.listings.length;
    await act(async () => v.mutations[0].finish.resolve(Response.json({ success: mode !== 'failure' })));
    await v.flush();
    if (mode === 'A-B-during-refresh') {
      expect(v.refresh()).not.toBeNull();
      await act(async () => { v.changeRuntime('B'); v.openFile(); }); await v.flush();
      const afterSwitch = v.state();
      await act(async () => v.refresh()?.resolve(Response.json({ directory: '/repo', entries: [] }))); await v.flush();
      expect(v.state()).toEqual(afterSwitch);
    } else if (mode === 'same-owner') {
      expect(v.tabs.getState().byRoot['/repo'].openPaths).not.toContain('/repo/example.txt');
      expect(v.tabs.getState().byRoot['/repo'].selectedPath).toBeNull();
    } else {
      expect(v.state()).toEqual(before);
      if (mode !== 'failure') expect(v.listings.length).toBe(listCount);
    }
    expect(v.mutations).toHaveLength(1);
  } finally { await v.cleanup(); }
});


test.each((['sidebar', 'view'] as const).flatMap(surface => ['same-owner', 'failure', 'A-B'].map(mode => ({ surface, mode }))))('$surface rename completion $mode', async ({ surface, mode }) => {
  const v = await setup(surface);
  try {
    await v.render(); await v.dialog('Rename');
    if (mode === 'A-B') { await act(async () => { v.changeRuntime('B'); v.openFile(); }); await v.flush(); }
    const before = v.state(); const count = v.listings.length;
    await act(async () => v.mutations[0].finish.resolve(Response.json({ success: mode !== 'failure', path: '/repo/renamed.txt' })));
    await v.flush();
    if (mode === 'same-owner') expect(v.tabs.getState().byRoot['/repo'].selectedPath).toBe('/repo/renamed.txt');
    else {
      expect(v.state()).toEqual(before);
      expect(v.listings.length).toBe(count);
    }
    expect(v.mutations).toHaveLength(1);
  } finally { await v.cleanup(); }
});


test.each((['sidebar', 'view'] as const).flatMap(surface => ['directory-ABA', 'dialog-reopen'].map(mode => ({ surface, mode }))))('$surface delete retains later $mode visit', async ({ surface, mode }) => {
  const v = await setup(surface);
  try {
    await v.render(); await v.dialog('Delete');
    if (mode === 'directory-ABA') {
      await act(async () => v.changeDirectory('/other')); await v.flush();
      await act(async () => v.changeDirectory('/repo')); await v.flush();
    } else {
      await v.click([...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent === 'Close'));
      await v.dialog('Delete', false);
    }
    const before = v.state();
    await act(async () => v.mutations[0].finish.resolve(Response.json({ success: true })));
    await v.flush();
    if (mode === 'dialog-reopen') expect(Boolean(document.querySelector('[role="dialog"]'))).toBe(true);
    else expect(v.state()).toEqual(before);
    expect(v.mutations).toHaveLength(1);
  } finally { await v.cleanup(); }
});


test.each((['sidebar', 'view'] as const).flatMap(surface => (['Rename', 'Delete'] as const).map(kind => ({ surface, kind }))))('$surface $kind failure stays editable and retries in Strict Mode', async ({ surface, kind }) => {
  const v = await setup(surface);
  try {
    await v.render(true); await v.dialog(kind);
    const before = v.state();
    await act(async () => v.mutations[0].finish.resolve(Response.json({ error: 'Synthetic denied write' }, { status: 500 })));
    await v.flush();
    expect(v.state()).toEqual(before);
    const confirmText = kind === 'Delete' ? 'Delete' : 'Confirm';
    const confirm = () => [...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent === confirmText);
    expect(confirm()?.hasAttribute('disabled')).toBe(false);
    if (kind === 'Rename') expect(document.querySelector<HTMLInputElement>('[role="dialog"] input')?.value).toBe('renamed.txt');
    await v.click(confirm());
    expect(v.mutations).toHaveLength(2);
    await act(async () => v.mutations[1].finish.resolve(Response.json({ success: true, path: '/repo/renamed.txt' })));
    await v.flush();
    expect(Boolean(document.querySelector('[role="dialog"]'))).toBe(false);
    expect(v.tabs.getState().byRoot['/repo'].selectedPath).toBe(kind === 'Rename' ? '/repo/renamed.txt' : null);
  } finally { await v.cleanup(); }
});


test.each(['sidebar', 'view'] as const)('%s rename conflict preserves the typed name and retries', async surface => {
  const v = await setup(surface);
  try {
    await v.render(); await v.dialog('Rename');
    const before = v.state();
    await act(async () => v.mutations[0].finish.resolve(Response.json({ error: 'Taken', reason: 'already-exists' }, { status: 409 })));
    await v.flush();
    expect(v.state()).toEqual(before);
    expect(document.querySelector<HTMLInputElement>('[role="dialog"] input')?.value).toBe('renamed.txt');
    const confirm = [...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent === 'Confirm');
    expect(confirm?.hasAttribute('disabled')).toBe(false);
    await v.click(confirm);
    expect(v.mutations).toHaveLength(2);
    await act(async () => v.mutations[1].finish.resolve(Response.json({ success: true, path: '/repo/renamed.txt' })));
    await v.flush();
    expect(v.tabs.getState().byRoot['/repo'].selectedPath).toBe('/repo/renamed.txt');
    expect(Boolean(document.querySelector('[role="dialog"]'))).toBe(false);
  } finally { await v.cleanup(); }
});

test('retiring A move leaves B same-path save hold until its own response', async () => {
  const v = await setup();
  let notified = 0;
  const unsubscribe = v.subscribeToFilePathMoves(() => { notified++; });
  try {
    const a = v.moveWorkspacePath(v.owner.files, { tabs: '/repo', files: '/repo' }, '/repo/example.txt', '/repo/a.txt');
    await v.flush();
    v.changeRuntime('B'); v.openFile();
    const before = v.state();
    const b = v.moveWorkspacePath(v.owner.files, { tabs: '/repo', files: '/repo' }, '/repo/example.txt', '/repo/b.txt');
    await v.flush();
    expect(v.mutations.map(mutation => mutation.runtime)).toEqual(['A', 'B']);
    v.mutations[0].finish.resolve(Response.json({ success: true, path: '/repo/a.txt' }));
    expect(await a).toBe('retired');
    expect(v.state()).toEqual(before);
    expect(notified).toBe(0);
    expect(v.isFilePathMoveInFlight('/repo/example.txt')).toBe(true);
    v.mutations[1].finish.resolve(Response.json({ success: true, path: '/repo/b.txt' }));
    expect(await b).toBe('moved');
    expect(v.isFilePathMoveInFlight('/repo/example.txt')).toBe(false);
    expect(notified).toBe(1);
    expect(v.tabs.getState().byRoot['/repo'].selectedPath).toBe('/repo/b.txt');
  } finally { unsubscribe(); await v.cleanup(); }
});


test.each(['sidebar', 'view'] as const)('%s old delete cannot finish a newer pending dialog', async surface => {
  const v = await setup(surface);
  try {
    await v.render(); await v.dialog('Delete');
    await v.click([...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent === 'Close'));
    await v.dialog('Delete', false);
    await v.click([...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent === 'Delete'));
    // CA12 queues the newer write behind the already-issued operation.
    expect(v.mutations).toHaveLength(1);
    const before = v.state();
    await act(async () => v.mutations[0].finish.resolve(Response.json({ success: true })));
    await v.flush();
    expect(v.mutations).toHaveLength(2);
    expect(v.state()).toEqual(before);
    const cancel = () => [...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent === 'Cancel');
    expect(cancel()?.hasAttribute('disabled')).toBe(true);
    await act(async () => v.mutations[1].finish.resolve(Response.json({ error: 'Denied' }, { status: 500 })));
    await v.flush();
    expect(cancel()?.hasAttribute('disabled')).toBe(false);
    expect(Boolean(document.querySelector('[role="dialog"]'))).toBe(true);
  } finally { await v.cleanup(); }
});


test.each((['sidebar', 'view'] as const).flatMap(surface => (['Rename', 'Delete'] as const).map(kind => ({ surface, kind }))))('$surface $kind rejects a batched authoritative directory round trip', async ({ surface, kind }) => {
  const v = await setup(surface);
  try {
    await v.render(); await v.dialog(kind);
    await act(async () => { v.changeDirectory('/other'); v.changeDirectory('/repo'); });
    await v.flush();
    const before = v.state();
    await act(async () => v.mutations[0].finish.resolve(Response.json({ success: true, path: '/repo/renamed.txt' })));
    await v.flush();
    expect(v.state()).toEqual(before);
    expect(Boolean(document.querySelector('[role="dialog"]'))).toBe(false);
    expect(v.mutations).toHaveLength(1);
  } finally { await v.cleanup(); }
});

test.each(['sidebar', 'view'] as const)('%s unrelated session UI updates preserve a pending rename', async surface => {
  const v = await setup(surface);
  try {
    await v.render(); await v.dialog('Rename');
    await act(async () => v.sessionUI.setState({ currentSessionDirectory: '/unrelated' }));
    await v.flush();
    await act(async () => v.mutations[0].finish.resolve(Response.json({ success: true, path: '/repo/renamed.txt' })));
    await v.flush();
    expect(v.tabs.getState().byRoot['/repo'].selectedPath).toBe('/repo/renamed.txt');
    expect(Boolean(document.querySelector('[role="dialog"]'))).toBe(false);
  } finally { await v.cleanup(); }
});


test.each(['sidebar', 'view'] as const)('%s active project root ignores unrelated fallback directory visits', async surface => {
  const v = await setup(surface);
  try {
    v.sessionUI.setState({ currentSessionId: 'fixed-project', worktreeMetadata: new Map([['fixed-project', { path: '/repo', projectDirectory: '/repo', branch: 'main', label: 'Fixed project' }]]) });
    await v.render(); await v.dialog('Rename');
    await act(async () => {
      v.directoryStore.setState({ currentDirectory: '/unrelated' });
      v.directoryStore.setState({ currentDirectory: '/repo' });
      v.sessionUI.setState({ newSessionDraft: { ...v.sessionUI.getState().newSessionDraft, directoryOverride: '/unrelated-draft' } });
    });
    await v.flush();
    await act(async () => v.mutations[0].finish.resolve(Response.json({ success: true, path: '/repo/renamed.txt' })));
    await v.flush();
    expect(v.tabs.getState().byRoot['/repo'].selectedPath).toBe('/repo/renamed.txt');
    expect(Boolean(document.querySelector('[role="dialog"]'))).toBe(false);
  } finally { await v.cleanup(); }
});

test.each((['sidebar', 'view'] as const).flatMap(surface => (['file', 'folder'] as const).flatMap(kind =>
  ['current-success', 'current-failure', 'runtime-success', 'runtime-failure', 'directory-success', 'directory-failure'].map(mode => ({ surface, kind, mode }))
)))('$surface create $kind completion $mode', async ({ surface, kind, mode }) => {
  const v = await setup(surface);
  try {
    await v.render();
    await v.create(kind);
    expect(v.mutations).toHaveLength(1);
    expect(v.mutations[0].runtime).toBe('A');
    expect(v.mutations[0].url).toBe(kind === 'file' ? 'https://a.invalid/api/fs/create' : 'https://a.invalid/api/fs/mkdir');
    expect(JSON.parse(v.mutations[0].body)).toEqual({ path: kind === 'file' ? '/repo/new.txt' : '/repo/new-folder' });
    if (mode.startsWith('runtime')) {
      await act(async () => { v.changeRuntime('B'); v.openFile(); });
      await v.flush();
    }
    if (mode.startsWith('directory')) {
      await act(async () => v.changeDirectory('/other'));
      await v.flush();
    }
    const listCount = v.listings.length;
    const toastCount = v.toast.getHistory().length;
    const before = v.state();
    const failure = mode.endsWith('failure');
    await act(async () => v.mutations[0].finish.resolve(Response.json(
      failure ? { error: 'Synthetic create denied' } : { success: true, path: kind === 'file' ? '/repo/new.txt' : '/repo/new-folder' },
      { status: failure ? 500 : 200 }
    )));
    await v.flush();
    expect(v.mutations).toHaveLength(1);
    const feedback = v.toast.getHistory().slice(toastCount).map(item => 'type' in item ? item.type : 'dismiss');
    const followup = v.listings.slice(listCount);
    if (mode.startsWith('current')) {
      expect(feedback).toEqual([failure ? 'error' : 'success']);
      expect(followup).toEqual(failure ? [] : [{ runtime: 'A', path: '/repo' }]);
      expect(Boolean(document.querySelector('[role="dialog"]'))).toBe(failure);
      if (failure) {
        expect(document.querySelector<HTMLInputElement>('[role="dialog"] input')?.value).toBe(kind === 'file' ? 'new.txt' : 'new-folder');
        expect([...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent === 'Confirm')?.hasAttribute('disabled')).toBe(false);
      }
    } else {
      expect({ followup, feedback }).toEqual({ followup: [], feedback: [] });
      expect(v.state()).toEqual(before);
    }
  } finally { await v.cleanup(); }
});

test.each((['sidebar', 'view'] as const).flatMap(surface => (['file', 'folder'] as const).map(kind => ({ surface, kind }))))('$surface old create $kind cannot finish a newer pending dialog', async ({ surface, kind }) => {
  const v = await setup(surface);
  try {
    await v.render();
    await v.create(kind);
    expect(v.mutations).toHaveLength(1);
    await v.click([...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent === 'Close'));
    const newerName = kind === 'file' ? 'newer.txt' : 'newer-folder';
    await v.create(kind, newerName);
    // File creation uses the cache mutation queue; mkdir dispatches directly.
    expect(v.mutations).toHaveLength(kind === 'file' ? 1 : 2);
    const listCount = v.listings.length;
    const toastCount = v.toast.getHistory().length;
    const cancel = () => [...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent === 'Cancel');
    expect(cancel()?.hasAttribute('disabled')).toBe(true);
    await act(async () => v.mutations[0].finish.resolve(Response.json({ success: true, path: kind === 'file' ? '/repo/new.txt' : '/repo/new-folder' })));
    await v.flush();
    expect(v.mutations).toHaveLength(2);
    expect(v.mutations[1].runtime).toBe('A');
    expect(JSON.parse(v.mutations[1].body)).toEqual({ path: `/repo/${newerName}` });
    expect(v.listings.slice(listCount)).toEqual([]);
    expect(v.toast.getHistory().slice(toastCount)).toEqual([]);
    expect(cancel()?.hasAttribute('disabled')).toBe(true);
    expect(document.querySelector<HTMLInputElement>('[role="dialog"] input')?.value).toBe(newerName);
    await act(async () => v.mutations[1].finish.resolve(Response.json({ error: 'Synthetic denied write' }, { status: 500 })));
    await v.flush();
    expect(cancel()?.hasAttribute('disabled')).toBe(false);
    expect(document.querySelector<HTMLInputElement>('[role="dialog"] input')?.value).toBe(newerName);
    expect(v.toast.getHistory().slice(toastCount).map(item => 'type' in item ? item.type : 'dismiss')).toEqual(['error']);
    expect(v.listings.slice(listCount)).toEqual([]);
  } finally { await v.cleanup(); }
});
