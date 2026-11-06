import React, { act } from 'react';
import { afterAll, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { createRoot } from 'react-dom/client';
import { OpenCode } from '@opencode/client';
import { hostMessageSchema } from '@openchamber/sdk/schemas';
import type { GuestMessage, HostMessage } from '@openchamber/sdk';
import type { FilesAPI } from '@/lib/api/types';
import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { createContentCachedFiles } from '@/contexts/content-cache-owner';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { getDefaultTheme } from '@/lib/theme/themes';
import { opencodeClient } from '@/lib/opencode/client';
import { I18nProvider } from '@/lib/i18n';
import { getRuntimeApiBaseUrl, getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { useGuestsStore } from '@/lib/guests/store';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useGitStore } from '@/stores/useGitStore';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { SyncProvider } from '@/sync/sync-context';
import { createWebAPIs } from '../../../../web/src/api/index';
import { moveWorkspacePath } from './files/moveWorkspacePath';

let syntheticEventSockets = 0;
afterAll(() => { console.info('Synthetic save.test event sockets held pending:', syntheticEventSockets); });

const directory = '/save-owner';
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

type ImageRead = Awaited<ReturnType<NonNullable<FilesAPI['readFileBinary']>>>;

type FileRead = Awaited<ReturnType<NonNullable<FilesAPI['readFile']>>>;

type Stat = Awaited<ReturnType<NonNullable<FilesAPI['statFile']>>>;

async function setup(kind: 'text' | 'binary' | 'source' | 'image', mode: 'full' | 'editor-only' = 'editor-only', strict = false) {
  const dom = new Window({ url: 'http://save.test', settings: { disableIframePageLoading: true } });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const disk = new Map([[`${directory}/a.bin`, 'A'], [`${directory}/b.bin`, 'B']]);
  const writes: Array<{ runtime: string; path: string; content: string; finish: ReturnType<typeof deferred<{ success: boolean; path: string }>> }> = [];
  const stats = new Map<string, Stat>();
  const reads: Array<{ runtime: string; path: string }> = [];
  const heldImages = new Map<string, ReturnType<typeof deferred<ImageRead>>>();
  const heldReads = new Map<string, ReturnType<typeof deferred<FileRead>>>();
  const nextStats: Array<ReturnType<typeof deferred<Stat>>> = [];
  const statPaths: string[] = [];
  const polls: Array<() => void> = [];
  const timers: Array<{ delay: number; run: () => void; handle: ReturnType<typeof setTimeout> }> = [];
  const nativeSetTimeout = globalThis.setTimeout;
  const scheduleTimeout = (...args: Parameters<typeof setTimeout>) => {
    const [handler, delay] = args;
    const handle = nativeSetTimeout(...args);
    if (delay === 1500 || delay === 2000) timers.push({ delay, run: () => handler(), handle });
    return handle;
  };
  const setInterval = dom.setInterval.bind(dom);
  dom.setInterval = (handler, delay, ...args) => {
    if (delay === 2000 && typeof handler === 'function') polls.push(() => handler(...args));
    return setInterval(handler, delay, ...args);
  };
  const uploads: Array<{ path: string; bytes: Blob; finish: ReturnType<typeof deferred<{ success: boolean; path: string }>> }> = [];
  const files: FilesAPI = {
    listDirectory: async (path) => ({ directory: path, entries: [] }), search: async () => [],
    createDirectory: async (path) => ({ success: true, path }),
    readFileBinary: async (path) => heldImages.get(getRuntimeKey())?.promise ?? { path, dataUrl: 'data:image/png;base64,QQ==' },
    readFile: async (path) => {
      const runtime = getRuntimeKey();
      reads.push({ runtime, path });
      const held = heldReads.get(runtime);
      return held ? held.promise : { path, content: disk.get(path) ?? '' };
    },
    statFile: async (path) => {
      statPaths.push(path);
      const pending = nextStats.shift();
      return pending ? pending.promise : stats.get(path) ?? { path, isFile: true, size: 1, mtimeMs: 1 };
    },
    writeFile: async (path, content) => {
      const finish = deferred<{ success: boolean; path: string }>();
      writes.push({ runtime: getRuntimeKey(), path, content, finish });
      const result = await finish.promise;
      if (result.success) disk.set(path, content);
      return result;
    },
    uploadFile: async (path, bytes) => {
      const finish = deferred<{ success: boolean; path: string }>();
      uploads.push({ path, bytes, finish });
      const result = await finish.promise;
      if (result.success) disk.set(path, await bytes.text());
      return result;
    },
    rename: async (from, to) => { disk.set(to, disk.get(from) ?? ''); disk.delete(from); return { success: true, path: to }; },
  };
  const localFetch = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/session-warming')) return Response.json({ revision: 0, enabled: false, minutes: 60, sessions: [] });
    if (url.includes('/frame-grant')) return Response.json({ grant: 'test-grant', expiresAt: Date.now() + 60_000 });
    if (url.includes('/auth/url-token')) return Response.json({ token: 'test-token', expiresAt: Date.now() + 60_000 });
    if (url.includes('/api/fs/raw')) return new Response('A');
    if (url.includes('/event')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    return new Promise<Response>(() => {});
  };
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator, location: dom.location, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, Node: dom.Node,
    Document: dom.Document, Text: dom.Text, Range: dom.Range, customElements: dom.customElements, CSSStyleSheet: dom.CSSStyleSheet,
    Worker: class extends EventTarget { postMessage() {} terminate() {} },
    // SyncProvider opens its runtime event socket outside the fetch boundary.
    // Hold only this fixture's synthetic stream pending.
    WebSocket: class extends EventTarget {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      readyState = 0;
      constructor(address: string | URL) {
        super();
        const url = new URL(address);
        expect(url.host).toBe('save.test');
        expect(['ws:', 'wss:'].includes(url.protocol)).toBe(true);
        expect(url.pathname).toBe('/api/global/event/ws');
        expect(url.search).toBe('?oc_url_token=test-token');
        syntheticEventSockets += 1;
      }
      send() {}
      close() { this.readyState = 3; }
    },
    Event: dom.Event, MessageEvent: dom.MessageEvent, CustomEvent: dom.CustomEvent, KeyboardEvent: dom.KeyboardEvent,
    MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver, IntersectionObserver: dom.IntersectionObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom), requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), fetch: localFetch, setTimeout: scheduleTimeout, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  opencodeClient.reconnectToRuntimeBaseUrl();
  const previousUI = useUIStore.getState();
  const previousSession = useSessionUIStore.getState();
  const previousTabs = useFilesViewTabsStore.getState();
  const previousDirectory = useDirectoryStore.getState().currentDirectory;
  const previousGuests = useGuestsStore.getState();
  const previousGit = useGitStore.getState();
  const previousRuntime = { runtimeKey: getRuntimeKey(), apiBaseUrl: getRuntimeApiBaseUrl() || 'http://save.test' };
  const cached = createContentCachedFiles(files);
  const extension = kind === 'source' ? 'txt' : kind === 'text' ? 'canvas' : kind === 'image' ? 'png' : 'bin';
  const a = `${directory}/a.${extension}`;
  const b = `${directory}/b.${extension}`;
  disk.set(a, 'A'); disk.set(b, 'B');
  useDirectoryStore.setState({ currentDirectory: directory });
  useSessionUIStore.setState({ currentSessionId: null, newSessionDraft: { ...previousSession.newSessionDraft, open: false } });
  useFilesViewTabsStore.setState({ byRoot: {} });
  useFilesViewTabsStore.getState().setSelectedPath(directory, a);
  useFilesViewTabsStore.getState().addOpenPath(directory, b);
  useUIStore.setState({ autoSaveEnabled: false });
  useGuestsStore.setState({ runtimeKey: getRuntimeKey(), status: 'ready', guests: kind === 'source' ? [] : [{
    id: 'save-test', name: 'Save test', icon: 'window', capabilities: { requested: [], granted: [] },
    fileEditors: [{ id: 'editor', title: 'Test editor', entry: 'editor.html', match: ['*.canvas', '*.bin', '*.png'], content: kind === 'binary' || kind === 'image' ? 'binary' : 'text' }],
  }] });
  const theme = getDefaultTheme(false);
  const themeContext: ThemeContextValue = {
    currentTheme: theme, availableThemes: [theme], customThemeIds: [], setTheme: () => {}, customThemesLoading: false,
    reloadCustomThemes: async () => {}, importTheme: async () => theme, deleteImportedTheme: async () => {},
    isSystemPreference: false, setSystemPreference: () => {}, themeMode: 'light', setThemeMode: () => {},
    lightThemeId: theme.metadata.id, darkThemeId: theme.metadata.id, setLightThemePreference: () => {}, setDarkThemePreference: () => {},
  };
  const sdk = OpenCode.make({ baseUrl: 'http://sync.test', fetch: async () => new Promise<Response>(() => {}) });
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const guestWindows: Window[] = [];
  const flush = async () => {
    for (let index = 0; index < 5; index++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };
  let mounted = true;
  const unmount = async () => { if (mounted) { mounted = false; await act(async () => root.unmount()); } };
  const cleanup = async () => {
    await unmount();
    cached.dispose();
    await act(async () => {
      for (const held of heldReads.values()) held.resolve({ path: a, content: 'cleanup' });
      for (const held of heldImages.values()) held.resolve({ path: a, dataUrl: 'data:image/png;base64,QQ==' });
      for (const write of [...writes, ...uploads]) write.finish.resolve({ success: false, path: write.path });
      for (const stat of nextStats) stat.resolve({ path: a, isFile: true, size: 1 });
      switchRuntimeEndpoint(previousRuntime);
    });
    useGitStore.setState(previousGit);
    useUIStore.setState(previousUI); useSessionUIStore.setState(previousSession); useFilesViewTabsStore.setState(previousTabs);
    useDirectoryStore.setState({ currentDirectory: previousDirectory }); useGuestsStore.setState(previousGuests);
    for (const timer of timers) clearTimeout(timer.handle);
    for (const guestWindow of guestWindows) await guestWindow.happyDOM.close();
    await dom.happyDOM.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
  };
  const connect = async () => {
    await flush();
    const frame = container.querySelector<HTMLIFrameElement>('iframe');
    if (!frame) throw new Error(`File editor did not mount: ${container.textContent}`);
    const guestWindow = new Window(); guestWindows.push(guestWindow);
    Object.defineProperty(frame, 'contentWindow', { configurable: true, value: guestWindow });
    const received: HostMessage[] = [];
    guestWindow.postMessage = (data) => { received.push(hostMessageSchema.parse(data)); };
    const send = async (message: GuestMessage) => {
      await act(async () => { window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: message })); });
    };
    await send({ channel: 'openchamber.sdk', v: 1, type: 'hello' });
    expect(received.some((message) => message.type === 'file-open')).toBe(true);
    const dirty = () => send({ channel: 'openchamber.sdk', v: 1, type: 'file-change', payload: { dirty: true, edited: true } });
    const snapshotRequest = () => {
      const message = received.slice().reverse().find((entry) => entry.type === 'file-snapshot');
      if (!message || message.type !== 'file-snapshot') throw new Error('No snapshot was requested');
      return message.id;
    };
    const save = async () => {
      const before = received.length;
      await send({ channel: 'openchamber.sdk', v: 1, type: 'file-save' });
      const message = received.slice(before).reverse().find((entry) => entry.type === 'file-snapshot');
      if (!message || message.type !== 'file-snapshot') throw new Error('Save did not request a snapshot');
      return message.id;
    };
    const snapshot = (id: string, content = 'edited') => send({ channel: 'openchamber.sdk', v: 1, type: 'file-snapshot-result', id,
      payload: { snapshot: kind === 'binary' || kind === 'image' ? { bytes: new TextEncoder().encode(content), version: 'same-version' } : { content, version: 'same-version' } } });
    return { frame, received, dirty, save, snapshot, snapshotRequest,
      requestSave: () => send({ channel: 'openchamber.sdk', v: 1, type: 'file-save' }),
      failSnapshot: (id: string) => send({ channel: 'openchamber.sdk', v: 1, type: 'file-snapshot-result', id, payload: { error: 'Snapshot refused' } }),
    };
  };
  try {
    const { FilesViewCommitBoundary } = await import('./FilesViewCommitBoundary.fixture');
    const web = createWebAPIs();
    let commitNext: (run: () => void) => void = () => { throw new Error('Commit probe has not mounted'); };
    let setVisible: (visible: boolean) => void = () => { throw new Error('Visibility control has not mounted'); };
    const tree = <I18nProvider><ThemeSystemContext.Provider value={themeContext}>
      <SyncProvider sdk={sdk} directory={directory}><RuntimeAPIContext.Provider value={{ ...web, runtime: { ...web.runtime, isDesktop: kind === 'image', platform: kind === 'image' ? 'desktop' : 'web' }, files: cached.files }}>
        <FilesViewCommitBoundary mode={mode} receiveControls={(controls) => {
          commitNext = controls.commitNext;
          setVisible = controls.setVisible;
        }} />
      </RuntimeAPIContext.Provider></SyncProvider>
    </ThemeSystemContext.Provider></I18nProvider>;
    await act(async () => root.render(strict ? <React.StrictMode>{tree}</React.StrictMode> : tree));
    await flush();
    return { a, b, disk, writes, uploads, files, container, connect, flush, cleanup, unmount, stats, statPaths, timers, reads,
      commitNext: (run: () => void) => commitNext(run),
      setVisible: async (visible: boolean) => { await act(async () => setVisible(visible)); await flush(); },
      holdImage: (runtime: string) => {
        const held = deferred<ImageRead>(); heldImages.set(runtime, held); return held;
      },
      holdRead: (runtime: string) => {
        const held = deferred<FileRead>(); heldReads.set(runtime, held); return held;
      },
      rememberRuntime: (runtime: string) => {
        useSessionUIStore.getState().prepareForRuntimeSwitch(runtime);
        useFilesViewTabsStore.setState({ activeRuntimeKey: getRuntimeKey(), runtimeSnapshots: {
          ...useFilesViewTabsStore.getState().runtimeSnapshots,
          [runtime]: { byRoot: useFilesViewTabsStore.getState().byRoot, updatedAt: Date.now() },
        } });
      },
      visitRuntimeBeforeCommit: (runtime: string) => {
        const previous = getRuntimeKey();
        switchRuntimeEndpoint({ apiBaseUrl: `http://${runtime}.test`, runtimeKey: runtime });
        useSessionUIStore.getState().prepareForRuntimeSwitch(previous);
        useGitStore.getState().resetForRuntimeSwitch(runtime);
        useFilesViewTabsStore.getState().resetForRuntimeSwitch(runtime);
        useSessionUIStore.getState().restoreForRuntimeSwitch(runtime, previous);
        useGuestsStore.getState().resetForRuntimeSwitch(runtime);
      },
      deferStat: () => { const pending = deferred<Stat>(); nextStats.push(pending); return pending; },
      poll: async () => { await act(async () => { for (const poll of polls) poll(); }); await flush(); },
      switchRuntime: async (names: string[]) => {
        const catalog = useGuestsStore.getState().guests;
        await act(async () => {
          for (const name of names) {
            switchRuntimeEndpoint({ apiBaseUrl: `http://${name}.test`, runtimeKey: name });
            useGitStore.setState({ runtimeKey: name });
            useGuestsStore.getState().resetForRuntimeSwitch(name);
          }
        });
        await flush();
        await act(async () => useGuestsStore.getState().replaceCatalog(catalog, getRuntimeKey()));
        await flush();
      },
      click: async (selector: string) => {
        const button = document.querySelector<HTMLElement>(selector);
        if (!button) throw new Error(`Missing control ${selector}: ${container.textContent}`);
        await act(async () => button.click()); await flush();
      },
      editSource: async (content: string) => {
        const { EditorView } = await import('@codemirror/view');
        const element = container.querySelector<HTMLElement>('.cm-editor');
        const view = element && EditorView.findFromDOM(element);
        if (!view) throw new Error('Source editor did not mount');
        await act(async () => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content }, userEvent: 'input' }));
        return view;
      },
      select: async (path: string) => { await act(async () => useFilesViewTabsStore.getState().setSelectedPath(directory, path)); await flush(); } };
  } catch (error) { await cleanup(); throw error; }
}

test('a snapshot retained through a rename cannot recreate its former path', async () => {
  const view = await setup('text');
  try {
    const canvas = await view.connect();
    await canvas.dirty();
    const snapshot = await canvas.save();
    await act(async () => { await moveWorkspacePath(view.files, { tabs: directory, files: directory }, view.a, view.b); });
    await view.flush();
    expect(view.container.querySelector('iframe')).toBe(canvas.frame);
    await canvas.snapshot(snapshot);
    await view.flush();
    expect(view.writes).toEqual([]);
    expect(view.disk.has(view.a)).toBe(false);
    expect(canvas.received.filter((entry) => entry.type === 'file-saved')).toEqual([]);
    await canvas.snapshot(await canvas.save(), 'renamed draft');
    expect(view.writes.map(({ path, content }) => ({ path, content }))).toEqual([{ path: view.b, content: 'renamed draft' }]);
    await act(async () => view.writes[0].finish.resolve({ success: true, path: view.b }));
    expect(view.disk.get(view.b)).toBe('renamed draft');
    expect(view.container.querySelector('iframe')).toBe(canvas.frame);
  } finally { await view.cleanup(); }
});

test('an already-issued binary upload cannot mark the replacement canvas saved', async () => {
  const view = await setup('binary');
  try {
    const a = await view.connect(); await a.dirty(); await a.snapshot(await a.save(), 'A edited');
    expect(view.uploads).toHaveLength(1);
    await view.select(view.b);
    const b = await view.connect(); await b.dirty();
    await act(async () => view.uploads[0].finish.resolve({ success: true, path: view.a }));
    await view.flush();
    expect(b.received.filter((entry) => entry.type === 'file-saved')).toEqual([]);
    await b.snapshot(await b.save(), 'B edited');
    expect(view.uploads).toHaveLength(2);
    expect(view.uploads[1].path).toBe(view.b);
    await act(async () => view.uploads[1].finish.resolve({ success: true, path: view.b }));
  } finally { await view.cleanup(); }
});

test('a binary snapshot retained through rename is retired and a fresh save writes the adopted path', async () => {
  const view = await setup('binary');
  try {
    const canvas = await view.connect(); await canvas.dirty();
    const snapshot = await canvas.save();
    await act(async () => { await moveWorkspacePath(view.files, { tabs: directory, files: directory }, view.a, view.b); });
    await view.flush();
    expect(view.container.querySelector('iframe')).toBe(canvas.frame);
    await canvas.snapshot(snapshot, 'old snapshot');
    expect(view.uploads).toEqual([]);
    await canvas.snapshot(await canvas.save(), 'new snapshot');
    expect(view.uploads[0].path).toBe(view.b);
    await act(async () => view.uploads[0].finish.resolve({ success: true, path: view.b }));
    expect(view.disk.has(view.a)).toBe(false);
    expect(view.disk.get(view.b)).toBe('new snapshot');
  } finally { await view.cleanup(); }
});

test.each(['text', 'binary'] as const)('a %s snapshot cannot write while its rename is in flight', async (kind) => {
  const view = await setup(kind);
  const rename = deferred<{ success: boolean; path: string }>();
  let moved: Promise<string> | undefined;
  try {
    const canvas = await view.connect(); await canvas.dirty();
    const snapshot = await canvas.save();
    view.files.rename = async () => rename.promise;
    await act(async () => { moved = moveWorkspacePath(view.files, { tabs: directory, files: directory }, view.a, view.b); });
    await canvas.snapshot(snapshot);
    expect(view.writes).toEqual([]); expect(view.uploads).toEqual([]);
    await act(async () => rename.resolve({ success: true, path: view.b }));
    expect(await moved).toBe('moved');
  } finally {
    await act(async () => { rename.resolve({ success: true, path: view.b }); await moved; });
    await view.cleanup();
  }
});

test.each([false, true])('a file A-to-B-to-A visit retires an issued upload, batched=%s', async (batched) => {
  const view = await setup('binary');
  try {
    const old = await view.connect(); await old.dirty(); await old.snapshot(await old.save(), 'old A');
    if (batched) await act(async () => {
      useFilesViewTabsStore.getState().setSelectedPath(directory, view.b);
      useFilesViewTabsStore.getState().setSelectedPath(directory, view.a);
    });
    else { await view.select(view.b); await view.select(view.a); }
    const current = batched ? old : await view.connect();
    await current.dirty();
    await act(async () => view.uploads[0].finish.resolve({ success: true, path: view.a }));
    expect(current.received.filter((message) => message.type === 'file-saved')).toEqual([]);
    await current.snapshot(await current.save(), 'new A');
    expect(view.uploads).toHaveLength(2);
    await act(async () => view.uploads[1].finish.resolve({ success: true, path: view.a }));
    expect(view.disk.get(view.a)).toBe('new A');
  } finally { await view.cleanup(); }
});

test.each([['runtime-b'], ['runtime-b', 'runtime-a']])('runtime visit %j cannot revive an issued save', async (...names) => {
  const view = await setup('binary');
  try {
    await view.switchRuntime(['runtime-a']);
    const old = await view.connect(); await old.dirty(); await old.snapshot(await old.save(), 'old runtime');
    await view.switchRuntime(names);
    const current = await view.connect(); await current.dirty();
    await act(async () => view.uploads[0].finish.resolve({ success: true, path: view.a }));
    expect(current.received.filter((message) => message.type === 'file-saved')).toEqual([]);
    await current.snapshot(await current.save(), 'new runtime');
    expect(view.uploads).toHaveLength(2);
    await act(async () => view.uploads[1].finish.resolve({ success: true, path: view.a }));
  } finally { await view.cleanup(); }
});

test.each(['success', 'false', 'reject'] as const)('old upload %s cannot finalize a newer pending save', async (outcome) => {
  const view = await setup('binary');
  try {
    const old = await view.connect(); await old.dirty(); await old.snapshot(await old.save(), 'old');
    await view.select(view.b);
    const current = await view.connect(); await current.dirty(); await current.snapshot(await current.save(), 'current');
    const count = current.received.filter((message) => message.type === 'file-snapshot').length;
    await act(async () => {
      if (outcome === 'reject') view.uploads[0].finish.reject(new Error('Retired failure'));
      else view.uploads[0].finish.resolve({ success: outcome === 'success', path: view.a });
    });
    await current.requestSave();
    expect(current.received.filter((message) => message.type === 'file-snapshot')).toHaveLength(count);
    expect(current.received.filter((message) => message.type === 'file-saved')).toEqual([]);
    await act(async () => view.uploads[1].finish.resolve({ success: true, path: view.b }));
    expect(current.received.filter((message) => message.type === 'file-saved')).toHaveLength(1);
    expect(view.disk.get(view.b)).toBe('current');
  } finally { await view.cleanup(); }
});

test('a newer save may finish before the retired upload', async () => {
  const view = await setup('binary');
  try {
    const old = await view.connect(); await old.dirty(); await old.snapshot(await old.save());
    await view.select(view.b);
    const current = await view.connect(); await current.dirty(); await current.snapshot(await current.save(), 'B final');
    await act(async () => view.uploads[1].finish.resolve({ success: true, path: view.b }));
    await act(async () => view.uploads[0].finish.resolve({ success: true, path: view.a }));
    expect(current.received.filter((message) => message.type === 'file-saved')).toHaveLength(1);
    expect(view.disk.get(view.b)).toBe('B final');
    const before = current.received.length;
    await current.requestSave();
    expect(current.received.slice(before).filter((message) => message.type === 'file-snapshot')).toEqual([]);
  } finally { await view.cleanup(); }
});

test.each(['text', 'binary'] as const)('new %s edits remain dirty while the written snapshot is acknowledged', async (kind) => {
  const view = await setup(kind);
  try {
    const canvas = await view.connect(); await canvas.dirty(); await canvas.snapshot(await canvas.save(), 'written version');
    await canvas.dirty();
    const writes = kind === 'binary' ? view.uploads : view.writes;
    await act(async () => writes[0].finish.resolve({ success: true, path: view.a }));
    expect(view.disk.get(view.a)).toBe('written version');
    expect(view.container.querySelector('iframe')).toBe(canvas.frame);
    await canvas.snapshot(await canvas.save(), 'newer version');
    expect(writes).toHaveLength(2);
    await act(async () => writes[1].finish.resolve({ success: true, path: view.a }));
    expect(view.disk.get(view.a)).toBe('newer version');
  } finally { await view.cleanup(); }
});

test.each(['text', 'binary'] as const)('a current %s write failure retains the draft for retry', async (kind) => {
  const view = await setup(kind);
  try {
    const canvas = await view.connect(); await canvas.dirty(); await canvas.snapshot(await canvas.save(), 'retry draft');
    const writes = kind === 'binary' ? view.uploads : view.writes;
    await act(async () => writes[0].finish.resolve({ success: false, path: view.a }));
    expect(canvas.received.filter((message) => message.type === 'file-saved')).toEqual([]);
    expect(view.disk.get(view.a)).toBe('A');
    await canvas.snapshot(await canvas.save(), 'retry draft');
    await act(async () => writes[1].finish.resolve({ success: true, path: view.a }));
    expect(view.disk.get(view.a)).toBe('retry draft');
  } finally { await view.cleanup(); }
});

test('a current snapshot failure issues no mutation and leaves a retryable canvas', async () => {
  const view = await setup('text');
  try {
    const canvas = await view.connect(); await canvas.dirty(); await canvas.failSnapshot(await canvas.save());
    expect(view.writes).toEqual([]);
    await canvas.snapshot(await canvas.save(), 'after refusal');
    expect(view.writes).toHaveLength(1);
  } finally { await view.cleanup(); }
});

test('late stat from save 1 cannot replace save 2 baseline or remount its canvas', async () => {
  const view = await setup('binary');
  try {
    const canvas = await view.connect(); await canvas.dirty(); await canvas.snapshot(await canvas.save(), 'one');
    const firstStat = view.deferStat();
    await act(async () => view.uploads[0].finish.resolve({ success: true, path: view.a }));
    await canvas.dirty(); await canvas.snapshot(await canvas.save(), 'two');
    view.stats.set(view.a, { path: view.a, isFile: true, size: 3, mtimeMs: 20 });
    await act(async () => view.uploads[1].finish.resolve({ success: true, path: view.a }));
    await act(async () => firstStat.resolve({ path: view.a, isFile: true, size: 3, mtimeMs: 10 }));
    await view.poll();
    expect(view.container.querySelector('iframe')).toBe(canvas.frame);
    expect(view.disk.get(view.a)).toBe('two');
  } finally { await view.cleanup(); }
});

test('unmount disconnects the actual pending snapshot without writing', async () => {
  const view = await setup('text');
  try {
    const canvas = await view.connect(); await canvas.dirty(); await canvas.save();
    await view.unmount(); await view.flush();
    expect(view.writes).toEqual([]);
    expect(canvas.received.filter((message) => message.type === 'file-saved')).toEqual([]);
  } finally { await view.cleanup(); }
});

test('unmount retires the UI continuation of an already-issued upload', async () => {
  const view = await setup('binary');
  try {
    const canvas = await view.connect(); await canvas.dirty(); await canvas.snapshot(await canvas.save());
    const before = view.statPaths.length;
    await view.unmount();
    await act(async () => view.uploads[0].finish.resolve({ success: true, path: view.a }));
    expect(view.statPaths).toHaveLength(before);
    expect(canvas.received.filter((message) => message.type === 'file-saved')).toEqual([]);
  } finally { await view.cleanup(); }
});

test('a batched root round trip retires a pending upload and releases its busy owner', async () => {
  const view = await setup('binary');
  try {
    const canvas = await view.connect(); await canvas.dirty(); await canvas.snapshot(await canvas.save(), 'old root');
    await act(async () => {
      useDirectoryStore.setState({ currentDirectory: '/other-root' });
      useDirectoryStore.setState({ currentDirectory: directory });
    });
    await canvas.dirty();
    await act(async () => view.uploads[0].finish.resolve({ success: true, path: view.a }));
    expect(canvas.received.filter((message) => message.type === 'file-saved')).toEqual([]);
    await canvas.snapshot(await canvas.save(), 'current root');
    expect(view.uploads).toHaveLength(2);
  } finally { await view.cleanup(); }
});

test('a canvas toolbar success timer cannot clear a newer save indication', async () => {
  const view = await setup('binary');
  try {
    const canvas = await view.connect(); await canvas.dirty();
    await view.click('button[title="Save"]'); await canvas.snapshot(canvas.snapshotRequest(), 'one');
    await act(async () => view.uploads[0].finish.resolve({ success: true, path: view.a }));
    const firstTimer = view.timers.slice().reverse().find((timer) => timer.delay === 1500);
    if (!firstTimer) throw new Error('First status timer did not start');
    await canvas.dirty();
    await view.click('button[title="Save"]'); await canvas.snapshot(canvas.snapshotRequest(), 'two');
    await act(async () => view.uploads[1].finish.resolve({ success: true, path: view.a }));
    const secondTimer = view.timers.slice().reverse().find((timer) => timer.delay === 1500);
    if (!secondTimer || secondTimer === firstTimer) throw new Error('Second status timer did not start');
    const savedIndicator = () => view.container.querySelector('button[title="Save"] use[href="#oc-check"]');
    expect(savedIndicator()).not.toBeNull();
    await act(async () => firstTimer.run());
    expect(savedIndicator()).not.toBeNull();
    await act(async () => secondTimer.run());
    expect(savedIndicator()).toBeNull();
  } finally { await view.cleanup(); }
});

test('Save-and-continue cannot close a replacement file after the original upload finishes', async () => {
  const view = await setup('binary', 'full');
  try {
    const canvas = await view.connect(); await canvas.dirty();
    await view.click('button[aria-label="Close a.bin"]');
    const save = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === 'Save changes');
    if (!save) throw new Error('Save-and-continue dialog did not open');
    await act(async () => save.click());
    await canvas.snapshot(canvas.snapshotRequest(), 'old A');
    await view.select(view.b);
    const current = await view.connect(); await current.dirty();
    await act(async () => view.uploads[0].finish.resolve({ success: true, path: view.a }));
    expect(useFilesViewTabsStore.getState().byRoot[directory]?.selectedPath).toBe(view.b);
    expect(useFilesViewTabsStore.getState().byRoot[directory]?.openPaths).toContain(view.a);
    expect(current.received.filter((message) => message.type === 'file-saved')).toEqual([]);
  } finally { await view.cleanup(); }
});

test('binary fullscreen continuation is retired by a file round trip', async () => {
  const view = await setup('binary', 'full');
  try {
    const canvas = await view.connect(); await canvas.dirty();
    await view.click('button[title="Fullscreen"]');
    await canvas.snapshot(canvas.snapshotRequest(), 'before fullscreen');
    await view.select(view.b); await view.select(view.a);
    const current = await view.connect(); await current.dirty();
    await act(async () => view.uploads[0].finish.resolve({ success: true, path: view.a }));
    expect(view.container.querySelector('button[title="Exit fullscreen"]')).toBeNull();
    expect(view.container.querySelector('iframe')).toBe(current.frame);
  } finally { await view.cleanup(); }
});

test('source edits made during a save remain in the actual CodeMirror draft', async () => {
  const view = await setup('source');
  try {
    if (!view.container.querySelector('.cm-editor')) await view.click('button[aria-label="Switch to edit mode"]');
    const editor = await view.editSource('written source');
    const save = view.container.querySelector<HTMLButtonElement>('button[aria-label^="Save ("]');
    if (!save) throw new Error('Source save control did not mount');
    await act(async () => save.click());
    expect(view.writes[0].content).toBe('written source');
    await view.editSource('newer source');
    await act(async () => view.writes[0].finish.resolve({ success: true, path: view.a }));
    expect(editor.state.doc.toString()).toBe('newer source');
    expect(view.disk.get(view.a)).toBe('written source');
    expect(view.container.querySelector('button[aria-label^="Save ("]')).not.toBeNull();
  } finally { await view.cleanup(); }
});

test('native text autosave on a new runtime keeps its busy state after the old write completes', async () => {
  const view = await setup('source');
  try {
    await act(async () => useUIStore.setState({ autoSaveEnabled: true }));
    await view.editSource('old runtime source');
    const first = view.timers.slice().reverse().find((timer) => timer.delay === 1500);
    if (!first) throw new Error('Autosave was not scheduled');
    await act(async () => first.run());
    expect(view.writes[0].content).toBe('old runtime source');
    await view.switchRuntime(['autosave-new-runtime']);
    const editor = await view.editSource('current runtime source');
    const second = view.timers.slice().reverse().find((timer) => timer.delay === 1500);
    if (!second || second === first) throw new Error('New-owner autosave was not scheduled');
    await act(async () => second.run());
    expect(view.writes[1].content).toBe('current runtime source');
    await act(async () => view.writes[0].finish.resolve({ success: true, path: view.a }));
    expect(editor.state.doc.toString()).toBe('current runtime source');
    expect(view.container.textContent).toContain('Saving...');
    await act(async () => view.writes[1].finish.resolve({ success: true, path: view.a }));
    expect(view.container.textContent).toContain('Saved');
    expect(view.disk.get(view.a)).toBe('current runtime source');
  } finally { await view.cleanup(); }
});

test.each(['manual', 'autosave'] as const)('same-owner %s still dispatches through the real cache wrapper', async (boundary) => {
  const view = await setup('source');
  try {
    await view.switchRuntime(['render-owner-a']);
    if (boundary === 'autosave') await act(async () => useUIStore.setState({ autoSaveEnabled: true }));
    await view.editSource('PRIVATE A DRAFT');
    if (boundary === 'manual') await view.click('button[aria-label^="Save ("]');
    else {
      const timer = view.timers.slice().reverse().find((entry) => entry.delay === 1500);
      if (!timer) throw new Error('Actual autosave timer was not scheduled');
      await act(async () => timer.run());
    }
    expect(view.writes.map(({ runtime, path, content }) => ({ runtime, path, content }))).toEqual([
      { runtime: 'render-owner-a', path: view.a, content: 'PRIVATE A DRAFT' },
    ]);
  } finally { await view.cleanup(); }
});

test.each(['manual', 'autosave'] as const)('an old-render %s callback cannot acquire the destination runtime before commit', async (boundary) => {
  const view = await setup('source');
  try {
    await view.switchRuntime(['render-owner-a']);
    view.rememberRuntime('render-owner-b');
    if (boundary === 'autosave') await act(async () => useUIStore.setState({ autoSaveEnabled: true }));
    const editor = await view.editSource('PRIVATE A DRAFT');
    const save = view.container.querySelector<HTMLButtonElement>('button[aria-label^="Save ("]');
    if (!save) throw new Error('The actual source save control did not mount');
    const timer = view.timers.slice().reverse().find((entry) => entry.delay === 1500);
    const count = view.timers.length;
    await act(async () => {
      view.visitRuntimeBeforeCommit('render-owner-b');
      expect(view.container.querySelector('button[aria-label^="Save ("]')).toBe(save);
      expect(editor.state.doc.toString()).toBe('PRIVATE A DRAFT');
      if (boundary === 'manual') save.click();
      else {
        if (!timer) throw new Error('Actual autosave timer was not scheduled');
        timer.run();
        expect(view.timers).toHaveLength(count);
      }
    });
    await view.flush();
    expect(view.writes, 'B cannot receive the draft rendered on A').toEqual([]);
  } finally { await view.cleanup(); }
});

test('a newly committed B callback cannot save A content before the B load starts or while its read waits', async () => {
  const view = await setup('source');
  try {
    await view.switchRuntime(['content-owner-a']);
    view.rememberRuntime('content-owner-b');
    const editor = await view.editSource('PRIVATE A DRAFT');
    const held = view.holdRead('content-owner-b');
    let observedCommit = false;
    await act(async () => {
      view.visitRuntimeBeforeCommit('content-owner-b');
      view.commitNext(() => {
        observedCommit = true;
        expect(getRuntimeKey()).toBe('content-owner-b');
        expect(editor.state.doc.toString()).toBe('PRIVATE A DRAFT');
        const save = view.container.querySelector<HTMLButtonElement>('button[aria-label^="Save ("]');
        if (!save) throw new Error('Expected the transitional source save control');
        save.click();
      });
    });
    await view.flush();
    expect(observedCommit).toBe(true);
    expect(view.writes, 'A content must not be granted B ownership by its new render').toEqual([]);
    expect(view.reads).toContainEqual({ runtime: 'content-owner-b', path: view.a });
    const pendingSave = view.container.querySelector<HTMLButtonElement>('button[aria-label^="Save ("]');
    if (pendingSave) await act(async () => pendingSave.click());
    expect(view.writes).toEqual([]);
    await act(async () => held.resolve({ path: view.a, content: 'B authoritative bytes' }));
    await view.flush();
    await view.editSource('B own draft');
    await view.click('button[aria-label^="Save ("]');
    expect(view.writes.map(({ runtime, path, content }) => ({ runtime, path, content }))).toEqual([
      { runtime: 'content-owner-b', path: view.a, content: 'B own draft' },
    ]);
  } finally { await view.cleanup(); }
});

test('a native runtime round trip rejects the old callback and reads a fresh A document before saving', async () => {
  const view = await setup('source');
  try {
    await view.switchRuntime(['native-aba-a']);
    view.rememberRuntime('native-aba-b');
    const editor = await view.editSource('PRIVATE OLD A DRAFT');
    const oldSave = view.container.querySelector<HTMLButtonElement>('button[aria-label^="Save ("]');
    if (!oldSave) throw new Error('Original save control is missing');
    const held = view.holdRead('native-aba-a');
    const readsBefore = view.reads.filter((read) => read.runtime === 'native-aba-a').length;
    await act(async () => {
      view.visitRuntimeBeforeCommit('native-aba-b');
      view.visitRuntimeBeforeCommit('native-aba-a');
      expect(editor.state.doc.toString()).toBe('PRIVATE OLD A DRAFT');
      oldSave.click();
    });
    await view.flush();
    expect(view.writes).toEqual([]);
    expect(view.reads.filter((read) => read.runtime === 'native-aba-a')).toHaveLength(readsBefore + 1);
    const pendingSave = view.container.querySelector<HTMLButtonElement>('button[aria-label^="Save ("]');
    if (pendingSave) await act(async () => pendingSave.click());
    expect(view.writes).toEqual([]);
    await act(async () => held.resolve({ path: view.a, content: 'Fresh A authoritative bytes' }));
    await view.flush();
    await view.editSource('New A draft');
    await view.click('button[aria-label^="Save ("]');
    expect(view.writes.map(({ runtime, content }) => ({ runtime, content }))).toEqual([
      { runtime: 'native-aba-a', content: 'New A draft' },
    ]);
  } finally { await view.cleanup(); }
});

test.each(['file', 'root'] as const)('a native %s round trip retains its actual A draft for a fresh callback only', async (boundary) => {
  const view = await setup('source');
  try {
    await view.switchRuntime(['same-model-a']);
    const editor = await view.editSource('Retained same-runtime A draft');
    const oldSave = view.container.querySelector<HTMLButtonElement>('button[aria-label^="Save ("]');
    if (!oldSave) throw new Error('Original save control is missing');
    const readsBefore = view.reads.length;
    await act(async () => {
      if (boundary === 'file') {
        useFilesViewTabsStore.getState().setSelectedPath(directory, view.b);
        useFilesViewTabsStore.getState().setSelectedPath(directory, view.a);
      } else {
        useDirectoryStore.setState({ currentDirectory: '/transient-root' });
        useDirectoryStore.setState({ currentDirectory: directory });
      }
      oldSave.click();
    });
    await view.flush();
    expect(view.writes).toEqual([]);
    expect(editor.state.doc.toString()).toBe('Retained same-runtime A draft');
    expect(view.reads).toHaveLength(readsBefore);
    await view.click('button[aria-label^="Save ("]');
    expect(view.writes.map(({ runtime, content }) => ({ runtime, content }))).toEqual([
      { runtime: 'same-model-a', content: 'Retained same-runtime A draft' },
    ]);
  } finally { await view.cleanup(); }
});

test('failed B hydration never grants A retained content save authority', async () => {
  const view = await setup('source');
  try {
    await view.switchRuntime(['failed-read-a']);
    view.rememberRuntime('failed-read-b');
    await view.editSource('A retained draft');
    const held = view.holdRead('failed-read-b');
    await act(async () => view.visitRuntimeBeforeCommit('failed-read-b'));
    await view.flush();
    await act(async () => held.reject(new Error('B read failed')));
    await view.flush();
    const save = view.container.querySelector<HTMLButtonElement>('button[aria-label^="Save ("]');
    if (save) await act(async () => save.click());
    expect(view.container.textContent).toContain('B read failed');
    expect(view.writes).toEqual([]);
  } finally { await view.cleanup(); }
});

test('a retired A read failure cannot publish or clear the pending same-path B load hold', async () => {
  const view = await setup('source');
  try {
    const oldRead = view.holdRead('load-owner-a');
    await view.switchRuntime(['load-owner-a']);
    view.rememberRuntime('load-owner-b');
    const currentRead = view.holdRead('load-owner-b');
    await act(async () => view.visitRuntimeBeforeCommit('load-owner-b'));
    await view.flush();
    const countB = () => view.reads.filter((read) => read.runtime === 'load-owner-b').length;
    expect(countB()).toBe(1);
    await act(async () => oldRead.reject(new Error('Retired A read failed')));
    await view.flush();
    await view.setVisible(false); await view.setVisible(true);
    expect(countB()).toBe(1);
    expect(view.container.querySelector('.cm-editor')).toBeNull();
    expect(view.writes).toEqual([]);
    await act(async () => currentRead.resolve({ path: view.a, content: 'Current B bytes' }));
    await view.flush();
    const editor = await view.editSource('Current B draft');
    expect(editor.state.doc.toString()).toBe('Current B draft');
    await view.click('button[aria-label^="Save ("]');
    expect(view.writes.map(({ runtime, content }) => ({ runtime, content }))).toEqual([
      { runtime: 'load-owner-b', content: 'Current B draft' },
    ]);
  } finally { await view.cleanup(); }
});

test('effect replay keeps a fresh loaded native document saveable', async () => {
  const view = await setup('source', 'editor-only', true);
  try {
    await view.editSource('Strict-mode current draft');
    await view.click('button[aria-label^="Save ("]');
    expect(view.writes.map(({ content }) => content)).toEqual(['Strict-mode current draft']);
  } finally { await view.cleanup(); }
});

test('a desktop image loaded by its image effect remains saveable through its binary canvas', async () => {
  const view = await setup('image');
  try {
    const canvas = await view.connect(); await canvas.dirty();
    await canvas.snapshot(await canvas.save(), 'Edited image bytes');
    expect(view.uploads).toHaveLength(1);
    expect(view.uploads[0].path).toBe(view.a);
    await act(async () => view.uploads[0].finish.resolve({ success: true, path: view.a }));
    expect(view.disk.get(view.a)).toBe('Edited image bytes');
    expect(canvas.received.filter((message) => message.type === 'file-saved')).toHaveLength(1);
  } finally { await view.cleanup(); }
});

test('a retired desktop image completion cannot grant a pending B image save authority', async () => {
  const view = await setup('image');
  try {
    const old = view.holdImage('image-owner-a');
    await view.switchRuntime(['image-owner-a']);
    view.rememberRuntime('image-owner-b');
    const current = view.holdImage('image-owner-b');
    const catalog = useGuestsStore.getState().guests;
    await act(async () => view.visitRuntimeBeforeCommit('image-owner-b'));
    await act(async () => useGuestsStore.getState().replaceCatalog(catalog, 'image-owner-b'));
    await view.flush();
    await act(async () => old.resolve({ path: view.a, dataUrl: 'data:image/png;base64,QQ==' }));
    await view.flush();
    expect(view.container.querySelector('iframe')).toBeNull();
    expect(view.uploads).toEqual([]);
    await act(async () => current.resolve({ path: view.a, dataUrl: 'data:image/png;base64,Qg==' }));
    await view.flush();
    const canvas = await view.connect(); await canvas.dirty();
    await canvas.snapshot(await canvas.save(), 'B edited image');
    expect(view.uploads).toHaveLength(1);
    expect(await view.uploads[0].bytes.text()).toBe('B edited image');
  } finally { await view.cleanup(); }
});
