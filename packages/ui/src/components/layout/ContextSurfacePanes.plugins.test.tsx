import { expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { OpenCode } from '@opencode/client';
import { Window } from 'happy-dom';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';
import { I18nProvider } from '@/lib/i18n';
import { useGuestsStore } from '@/lib/guests/store';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { openGuestSurface } from '@/lib/guests/open-surface';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { SyncProvider } from '@/sync/sync-context';
import { setZoneBody, useZoneHostsStore } from './zoneHosts';

plugin({
  name: 'plugin-startup-worker-url',
  setup(build) {
    build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, ({ path }) => ({
      contents: `export default ${JSON.stringify(pathToFileURL(path.split('?')[0]).href)};`, loader: 'js',
    }));
  },
});
const { ContextSurfacePanes } = await import('./ContextSurfacePanes');

const directory = '/synthetic/plugin-startup';

async function withRestoredPlugins(count: number, open: boolean, check: (requests: string[]) => Promise<void>, strict = false) {
  const dom = new Window({ url: 'http://plugin-startup.test', settings: { disableIframePageLoading: true } });
  class EventSocket extends EventTarget {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    readyState = 0;
    send() {}
    close() { this.readyState = 3; }
  }
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ WebSocket: EventSocket, window: dom, document: dom.document, navigator: dom.navigator,
    localStorage: dom.localStorage, getComputedStyle: dom.getComputedStyle.bind(dom), Event: dom.Event,
    HTMLElement: dom.HTMLElement, MessageEvent: dom.MessageEvent, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const requests: string[] = [];
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    requests.push(url);
    if (url.includes('/api/session-warming')) return Response.json({ revision: 0, enabled: false, minutes: 60, sessions: [] });
    if (url.includes('/frame-grant')) return Response.json({ grant: 'synthetic-grant', expiresAt: Date.now() + 60_000 });
    if (url.includes('/auth/url-token')) return Response.json({ token: 'synthetic-token', expiresAt: Date.now() + 60_000 });
    if (url.includes('/event')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    return Response.json({ data: [] });
  });
  const sdk = OpenCode.make({ baseUrl: 'http://sync.test', fetch: async (request) => {
    const path = new URL(request instanceof Request ? request.url : request.toString()).pathname;
    if (path.endsWith('/event')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    return Response.json(path.endsWith('/session/active') ? {} : { data: [] });
  } });
  const theme = getDefaultTheme(false);
  const themeContext: ThemeContextValue = {
    currentTheme: theme, availableThemes: [theme], customThemeIds: [], setTheme: () => {}, customThemesLoading: false,
    reloadCustomThemes: async () => {}, importTheme: async () => theme, deleteImportedTheme: async () => {},
    isSystemPreference: false, setSystemPreference: () => {}, themeMode: 'light', setThemeMode: () => {},
    lightThemeId: theme.metadata.id, darkThemeId: theme.metadata.id, setLightThemePreference: () => {}, setDarkThemePreference: () => {},
  };
  const previousUI = useUIStore.getState();
  const previousDirectory = useDirectoryStore.getState().currentDirectory;
  const previousSession = useSessionUIStore.getState();
  const previousHosts = useZoneHostsStore.getState();
  const previousGuests = useGuestsStore.getState();
  const runtimeKey = getRuntimeKey();
  useDirectoryStore.setState({ currentDirectory: directory });
  useSessionUIStore.setState({ currentSessionId: null, newSessionDraft: { ...previousSession.newSessionDraft, open: false } });
  useUIStore.setState({ contextPanelByDirectory: {}, contextSurfaceZones: {}, contextEditorTreeVisible: false, contextEditorVisible: false });
  const guests = Array.from({ length: count }, (_, index) => ({ id: `startup-${index}`, name: `Synthetic ${index}`, icon: 'window', entry: 'panel/index.html', source: 'path' as const, capabilities: { requested: [], granted: [] } }));
  useGuestsStore.getState().resetForRuntimeSwitch(runtimeKey);
  useGuestsStore.getState().replaceCatalog(guests, runtimeKey);
  for (const guest of guests) useUIStore.getState().openContextPanelTab(directory, { mode: `plugin:${guest.id}` });
  if (!open) useUIStore.getState().closeContextZone(directory, 'right');
  for (const zone of ['left', 'right', 'bottom'] as const) {
    const host = document.createElement('div');
    document.body.append(host);
    setZoneBody(zone, host);
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    const content = <I18nProvider><ThemeSystemContext.Provider value={themeContext}>
      <SyncProvider sdk={sdk} directory={directory}><ContextSurfacePanes /></SyncProvider>
    </ThemeSystemContext.Provider></I18nProvider>;
    await act(async () => root.render(strict ? <React.StrictMode>{content}</React.StrictMode> : content));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
    await check(requests);
  } finally {
    await act(async () => root.unmount());
    fetch.mockRestore();
    useUIStore.setState(previousUI);
    useDirectoryStore.setState({ currentDirectory: previousDirectory });
    useSessionUIStore.setState(previousSession);
    useZoneHostsStore.setState(previousHosts);
    useGuestsStore.setState(previousGuests);
    await dom.happyDOM.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

for (const count of [0, 1, 8]) {
  test(`${count} restored plugin tabs do not load before their closed zone opens`, async () => {
    await withRestoredPlugins(count, false, async (requests) => {
      expect(document.querySelectorAll('iframe')).toHaveLength(0);
      expect(requests.filter((url) => url.includes('/frame-grant'))).toHaveLength(0);
    });
  });
  test(`${count} restored plugin tabs load only the visible tab at startup`, async () => {
    await withRestoredPlugins(count, true, async (requests) => {
      const visible = count > 0 ? 1 : 0;
      expect(document.querySelectorAll('iframe')).toHaveLength(visible);
      expect(requests.filter((url) => url.includes('/frame-grant'))).toHaveLength(visible);
    });
  });
}

test('opening, switching and closing plugins preserves only frames already shown', async () => {
  await withRestoredPlugins(8, false, async (requests) => {
    expect(document.querySelectorAll('iframe')).toHaveLength(0);
    const panel = useUIStore.getState().contextPanelByDirectory[directory];
    await act(async () => useUIStore.getState().setActiveContextPanelTab(directory, panel.tabs[0].id));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
    const first = document.querySelector('iframe');
    expect(first).not.toBeNull();
    expect(document.querySelectorAll('iframe')).toHaveLength(1);
    await act(async () => useUIStore.getState().setActiveContextPanelTab(directory, panel.tabs[1].id));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
    expect(document.querySelectorAll('iframe')).toHaveLength(2);
    expect(document.querySelectorAll('iframe')[0]).toBe(first);
    await act(async () => useUIStore.getState().closeContextZone(directory, 'right'));
    expect(document.querySelectorAll('iframe')).toHaveLength(2);
    await act(async () => useUIStore.getState().setActiveContextPanelTab(directory, panel.tabs[0].id));
    expect(document.querySelectorAll('iframe')[0]).toBe(first);
    expect(document.querySelectorAll('iframe')).toHaveLength(2);
    expect(new Set(requests.filter((url) => url.includes('/frame-grant'))).size).toBe(2);
    await act(async () => useUIStore.getState().closeContextPanelTab(directory, panel.tabs[0].id));
    expect(document.querySelectorAll('iframe')).toHaveLength(1);
  }, true);
});

test('the SDK openSurface route reveals an unopened restored plugin and stays open on repeat', async () => {
  await withRestoredPlugins(8, false, async () => {
    await act(async () => {
      expect(openGuestSurface({ mode: 'plugin:startup-3', directory, supported: true })).toEqual({ ok: true });
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
    const frame = document.querySelector('iframe');
    expect(frame).not.toBeNull();
    expect(document.querySelectorAll('iframe')).toHaveLength(1);
    await act(async () => {
      expect(openGuestSurface({ mode: 'plugin:startup-3', directory, supported: true })).toEqual({ ok: true });
    });
    expect(document.querySelector('iframe')).toBe(frame);
    expect(useUIStore.getState().contextPanelByDirectory[directory].isOpen).toBe(true);
  });
});
