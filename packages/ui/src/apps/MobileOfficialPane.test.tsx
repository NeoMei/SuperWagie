import { expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { OpenCode } from '@opencode/client';
import { Window } from 'happy-dom';

import { I18nProvider } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { SyncProvider } from '@/sync/sync-context';
import { MobileOfficialPane } from '@/apps/MobileOfficialPane';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { notifyPlatformAccountState } from '@/lib/platformAccount';

// The user presses Generate, closes the panel before the model answers, and
// opens it again: the answer reaches the new frame once, through
// `generate-late`, instead of being thrown away with the old frame.
test('phone project and account switches discard old results and a failed read remains an error', async () => {
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
  const reads: Array<{ projectId: string; finish: (response: Response) => void }> = [];
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const target = String(input instanceof Request ? input.url : input);
    if (target.includes('/api/mobile-official')) return new Promise<Response>((finish) => { reads.push({ projectId: new URL(target, 'http://guest.test').searchParams.get('projectId') ?? '', finish }); });
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
  const runtimeKey = getRuntimeKey();
  const previousProjects = useProjectsStore.getState();
  const previousSession = useSessionUIStore.getState();
  useProjectsStore.setState({ hasServerSnapshot: true, projects: [{ id: 'a', path: '/a' }, { id: 'b', path: '/b' }] });
  const setDirectory = (directory: string) => useSessionUIStore.setState({ currentSessionId: null, newSessionDraft: {
    ...previousSession.newSessionDraft, open: true, target: 'project', directoryOverride: directory,
    preparedChatDirectory: null, bootstrapPendingDirectory: null, pendingWorktreeRequestId: null,
  } });
  setDirectory('/a');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const pane = () => <I18nProvider><SyncProvider sdk={sdk} directory="/a"><MobileOfficialPane visible /></SyncProvider></I18nProvider>;
  const flush = async () => { for (let index = 0; index < 3; index++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
  const selection = (title: string) => ({ id: 'ee45c031-2ac2-46ee-9d9d-5ae92ed79d8a', projectId: 'a', projectName: 'A',
    extensionId: 'openchamber-builtin-creation', sessionId: null, createdAt: 1, revision: 'a'.repeat(64),
    source: { kind: 'artifact', path: 'sample.md' }, card: { title, path: 'sample.md' }, preview: { kind: 'unavailable', contentType: 'text/plain', byteLength: 0 } });
  try {
    await act(async () => root.render(pane()));
    await flush();
    expect(reads.map((read) => read.projectId)).toEqual(['a']);
    await act(async () => { setDirectory('/b'); });
    await flush();
    expect(reads.map((read) => read.projectId)).toEqual(['a', 'b']);
    await act(async () => { reads[0].finish(Response.json({ state: 'ready', selections: [selection('Old A title')] })); reads[1].finish(Response.json({ error: 'offline' }, { status: 503 })); });
    await flush();
    expect(container.textContent).not.toContain('Old A title');
    expect(/无法读取|Could not read/.test(container.textContent ?? '')).toBe(true);
    expect(/尚未选择资料|No material has been selected/.test(container.textContent ?? '')).toBe(false);
    await act(async () => { setDirectory('/a'); });
    await flush();
    await act(async () => { reads[2].finish(Response.json({ state: 'ready', selections: [selection('Current A title')] })); });
    await flush();
    expect(container.textContent).toContain('Current A title');
    await act(async () => { notifyPlatformAccountState({ status: 'signed-out' }, runtimeKey); });
    expect(container.textContent).not.toContain('Current A title');
    await flush();
    const previousReadCount = reads.length;
    Object.defineProperty(dom, 'Capacitor', { configurable: true, value: { isNativePlatform: () => true } });
    await act(async () => root.render(pane()));
    expect(container.textContent).toMatch(/移动网页|mobile webpage/);
    expect(reads.length).toBe(previousReadCount);
  } finally {
    await act(async () => root.unmount());
    const eventSocketCount = eventSockets.length;
    const eventSocketsClosed = eventSockets.every((socket) => socket.readyState === 3);
    fetch.mockRestore();
    useProjectsStore.setState(previousProjects);
    useSessionUIStore.setState(previousSession);
    await dom.happyDOM.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    expect(eventSocketCount).toBe(1);
    expect(eventSocketsClosed).toBe(true);
  }
});
