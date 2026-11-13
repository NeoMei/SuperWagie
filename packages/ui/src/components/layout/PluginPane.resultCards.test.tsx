import { expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { OpenCode } from '@opencode/client';
import { Window } from 'happy-dom';
import { hostMessageSchema } from '@openchamber/sdk/schemas';
import type { GuestMessage, HostMessage } from '@openchamber/sdk';

import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';
import { I18nProvider } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useGuestsStore } from '@/lib/guests/store';
import type { InstalledGuest } from '@/lib/guests/types';
import { SyncProvider } from '@/sync/sync-context';
import { PluginPane } from './PluginPane';

// The user presses Generate, closes the panel before the model answers, and
// opens it again: the answer reaches the new frame once, through
// `generate-late`, instead of being thrown away with the old frame.
test('official result cards are passive, project scoped and withdrawn with their host authority', async () => {
  const dom = new Window({ url: 'http://guest.test', settings: { disableIframePageLoading: true } });
  const eventSockets: Array<{ readyState: number }> = [];
  class PendingEventSocket extends EventTarget {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    readyState = 0;
    constructor(address: string | URL) {
      super();
      const url = new URL(address);
      expect(url.host).toBe('guest.test');
      expect(['ws:', 'wss:']).toContain(url.protocol);
      expect(url.pathname).toBe('/api/global/event/ws');
      expect(url.search).toBe('?oc_url_token=scoped-test');
      eventSockets.push(this);
    }
    send() {}
    close() { this.readyState = 3; }
  }
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ WebSocket: PendingEventSocket, window: dom, document: dom.document, navigator: dom.navigator,
    localStorage: dom.localStorage, getComputedStyle: dom.getComputedStyle.bind(dom), Event: dom.Event, MessageEvent: dom.MessageEvent,
    IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const target = String(input instanceof Request ? input.url : input);
    if (target.includes('/api/session-warming')) return Response.json({ revision: 0, enabled: false, minutes: 60, sessions: [] });
    if (target.includes('/frame-grant')) return Response.json({ grant: 'grant-test', expiresAt: Date.now() + 60_000 });
    if (target.includes('/auth/url-token')) return Response.json({ token: 'scoped-test', expiresAt: Date.now() + 60_000 });
    if (target.includes('/event')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    if (target.includes('/session/active')) return Response.json({});
    if (target.includes('/location')) return Response.json({ directory: '/visible', project: { id: 'project', directory: '/visible', canonical: '/visible' } });
    return Response.json({ data: [] });
  });
  const sdk = OpenCode.make({ baseUrl: 'http://sync.test', fetch: async (request) => {
    const path = new URL(request instanceof Request ? request.url : request.toString()).pathname;
    if (path.endsWith('/event')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    const body = path.endsWith('/location')
      ? { directory: '/visible', project: { id: 'project', directory: '/visible', canonical: '/visible' } }
      : path.endsWith('/session/active') ? {}
      : { data: [] };
    return Response.json(body);
  } });
  const theme = getDefaultTheme(false);
  const themeContext: ThemeContextValue = {
    currentTheme: theme, availableThemes: [theme], customThemeIds: [], setTheme: () => {}, customThemesLoading: false,
    reloadCustomThemes: async () => {}, importTheme: async () => theme, deleteImportedTheme: async () => {},
    isSystemPreference: false, setSystemPreference: () => {}, themeMode: 'light', setThemeMode: () => {},
    lightThemeId: theme.metadata.id, darkThemeId: theme.metadata.id, setLightThemePreference: () => {}, setDarkThemePreference: () => {},
  };
  const writer: InstalledGuest = {
    id: 'openchamber-builtin-creation', storageId: 'store-1', name: 'Creation', icon: 'window', entry: 'panel/index.html', source: 'bundled',
    capabilities: { requested: [], granted: [] },
  };
  const runtimeKey = getRuntimeKey();
  useGuestsStore.getState().resetForRuntimeSwitch(runtimeKey);
  useGuestsStore.getState().replaceCatalog([writer], runtimeKey);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const restores: Array<() => void> = [];
  let directory = '/visible';
  const pane = (open: boolean, headless = false) => (
    <I18nProvider><ThemeSystemContext.Provider value={themeContext}>
      <SyncProvider sdk={sdk} directory="/visible">{open ? <PluginPane mode="plugin:openchamber-builtin-creation" surface="panel" headless={headless} pinnedDirectory={directory} /> : null}</SyncProvider>
    </ThemeSystemContext.Provider></I18nProvider>
  );
  // Mount the panel and attach a stand-in for the document inside its frame.
  const openPanel = async (headless = false) => {
    await act(async () => root.render(pane(true, headless)));
    for (let attempt = 0; attempt < 100 && !container.querySelector('iframe'); attempt++) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
    const frame = container.querySelector<HTMLIFrameElement>('iframe');
    if (!frame) throw new Error('Panel iframe did not mount');
    const guestWindow = new Window();
    restores.push(() => { void guestWindow.happyDOM.close(); });
    Object.defineProperty(frame, 'contentWindow', { configurable: true, value: guestWindow });
    const frameWindow = frame.contentWindow;
    if (!frameWindow) throw new Error('Guest window is missing');
    const received: HostMessage[] = [];
    const post = spyOn(frameWindow, 'postMessage').mockImplementation((data) => { received.push(hostMessageSchema.parse(data)); });
    restores.push(() => post.mockRestore());
    const send = async (message: GuestMessage) => {
      await act(async () => { window.dispatchEvent(new MessageEvent('message', { source: frameWindow, data: message })); });
    };
    await send({ channel: 'openchamber.sdk', v: 1, type: 'hello' });
    return { received, send };
  };
  try {
    const frame = await openPanel();
    expect(frame.received.find((message) => message.type === 'ready')).toMatchObject({ payload: { features: { resultCards: true } } });
    const request: GuestMessage = { channel: 'openchamber.sdk', v: 1, type: 'result-cards', id: 'cards', payload: {
      directory: '/visible', cards: [{ title: 'Current sample', text: '<script>send()</script>', version: 'v2', path: 'sample.png' }],
    } };
    await frame.send(request);
    expect(frame.received.find((message) => message.type === 'result' && message.id === 'cards')).toMatchObject({ ok: true });
    expect(container.textContent).toContain('Current sample');
    expect(container.textContent).toContain('<script>send()</script>');
    expect(container.querySelector('script')).toBeNull();
    await frame.send({ ...request, id: 'wrong', payload: { directory: '/other', cards: [{ title: 'Wrong project' }] } });
    expect(frame.received.find((message) => message.type === 'result' && message.id === 'wrong')).toMatchObject({ ok: false, code: 'NO_DIRECTORY' });
    expect(container.textContent).not.toContain('Wrong project');
    directory = '/other';
    await act(async () => root.render(pane(true)));
    expect(container.textContent).not.toContain('Current sample');
    await act(async () => useGuestsStore.getState().replaceCatalog([{ ...writer, source: 'path' }], runtimeKey));
    await frame.send({ ...request, id: 'unofficial', payload: { directory, cards: [{ title: 'Untrusted card' }] } });
    expect(frame.received.find((message) => message.type === 'result' && message.id === 'unofficial')).toMatchObject({ ok: false, code: 'UNSUPPORTED' });
    expect(container.textContent).not.toContain('Untrusted card');
  } finally {
    await act(async () => root.unmount());
    const eventSocketCount = eventSockets.length;
    const eventSocketsClosed = eventSockets.every((socket) => socket.readyState === 3);
    for (const restore of restores) restore();
    fetch.mockRestore();
    await dom.happyDOM.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    expect(eventSocketCount).toBe(1);
    expect(eventSocketsClosed).toBe(true);
  }
});
