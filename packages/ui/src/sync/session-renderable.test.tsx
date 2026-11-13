import { expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import { opencodeClient } from '@/lib/opencode/client';
import type { Message } from '@/lib/opencode/model';
import { SyncProvider, useSessionRenderable, useSyncRuntime } from './sync-context';
import type { SessionMessageLoader } from './session-message-loader';

test('renderability follows live status and revoked history without a message mutation', async () => {
  const win = new Window({ url: 'http://renderable-fixture.test' });
  const values = {
    window: win, document: win.document, navigator: win.navigator,
    Node: win.Node, Element: win.Element, HTMLElement: win.HTMLElement,
    HTMLButtonElement: win.HTMLButtonElement, HTMLIFrameElement: win.HTMLIFrameElement,
    localStorage: win.localStorage, getComputedStyle: win.getComputedStyle.bind(win),
    ResizeObserver: win.ResizeObserver, MutationObserver: win.MutationObserver,
    requestAnimationFrame: win.requestAnimationFrame.bind(win),
    cancelAnimationFrame: win.cancelAnimationFrame.bind(win), IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(values).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } }));
  const target = { directory: '/renderable-fixture', sessionID: 'renderable-fixture' };
  const user: Message = { id: 'render-user', sessionID: target.sessionID, role: 'user', time: { created: 1 } };
  const current: Message = {
    id: 'render-current', sessionID: target.sessionID, role: 'assistant', time: { created: 2 },
    providerID: 'fixture', modelID: 'fixture', agent: 'build',
  };
  const read = spyOn(opencodeClient, 'getSessionMessages').mockResolvedValue({ items: [{ info: user, parts: [] }], cursor: {} });
  let loader: SessionMessageLoader | undefined;
  const Probe = () => {
    const runtime = useSyncRuntime();
    loader = runtime.messageLoader;
    return <span>{String(useSessionRenderable(target.sessionID, target.directory))}</span>;
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const sdk = OpenCode.make({ baseUrl: 'http://renderable-fixture.test', fetch: () => new Promise<Response>(() => undefined) });
  try {
    await act(async () => root.render(<SyncProvider sdk={sdk} directory={target.directory}><Probe /></SyncProvider>));
    if (!loader) throw new Error('Expected the scoped message loader');
    const activeLoader = loader;
    await act(async () => activeLoader.ensure(target));
    // The loader's page is authoritative, and the current assistant arrives live.
    const { getSyncChildStores } = await import('./sync-refs');
    const store = getSyncChildStores().getChild(target.directory);
    if (!store) throw new Error('Expected the scoped directory');
    await act(async () => store.setState({ message: { [target.sessionID]: [user, current] }, part: {}, session_status: { [target.sessionID]: { type: 'busy' } } }));
    expect(container.textContent).toBe('true');
    await act(async () => store.setState({ session_status: { [target.sessionID]: { type: 'idle' } } }));
    expect(container.textContent).toBe('false');
    await act(async () => store.setState({ session_status: { [target.sessionID]: { type: 'busy' } } }));
    expect(container.textContent).toBe('true');
    await act(async () => activeLoader.markHistoryStale());
    expect(container.textContent).toBe('false');
  } finally {
    await act(async () => root.unmount());
    read.mockRestore();
    fetch.mockRestore();
    await win.happyDOM.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
