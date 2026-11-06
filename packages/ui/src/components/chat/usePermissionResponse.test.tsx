import { expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { usePermissionResponse } from './usePermissionResponse';
import { ChatColumnActionsContext } from './chatColumnSession';
import { opencodeClient } from '@/lib/opencode/client';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { ChildStoreManager } from '@/sync/child-store';
import { setActionRefs } from '@/sync/session-actions';
import { shortcutRegistry } from '@/lib/shortcuts';

test('newest main and pinned permissions own capture before the composer, with suspension and retry', async () => {
  const dom = new Window({ url: 'http://permission.test' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator, Element: dom.Element, HTMLElement: dom.HTMLElement, Event: dom.Event, KeyboardEvent: dom.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const connection = useConfigStore.getState();
  const overrides = useUIStore.getState().shortcutOverrides;
  const originalReply = opencodeClient.replyToPermission;
  const originalError = console.error;
  const stores = new ChildStoreManager();
  setActionRefs(stores, () => '/workspace');
  useConfigStore.setState({ isConnected: true, hasEverConnected: true });
  useUIStore.setState({ shortcutOverrides: { permission_allow_once: 'ctrl+y' } });
  const requests: string[] = [];
  let settle: (value: boolean) => void = () => {};
  opencodeClient.replyToPermission = async (_session, id) => {
    requests.push(id);
    return new Promise<boolean>(resolve => { settle = resolve; });
  };
  let errorCount = 0;
  console.error = () => { errorCount += 1; };
  const root = createRoot(document.body.appendChild(document.createElement('div')));
  let composer = 0;
  function Card({ id }: { id: string }) {
    usePermissionResponse({ id, sessionID: 'session', action: 'bash', resources: [], metadata: {} });
    return null;
  }
  const press = (id: string, extra: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key: 'y', code: 'KeyY', ctrlKey: true, bubbles: true, cancelable: true, ...extra });
    document.getElementById(id)!.dispatchEvent(event);
    return event;
  };
  try {
    await act(async () => root.render(<>
      <Card id="old-main" /><Card id="new-main" />
      <textarea id="main" />
      <ChatColumnActionsContext.Provider value={{ pinned: true, openSession() {}, openTimelineDialog() {}, focusInput() {} }}>
        <Card id="pinned" />
        <div data-chat-column="pinned"><textarea id="pinned-input" /></div>
      </ChatColumnActionsContext.Provider>
    </>));
    document.getElementById("main")!.addEventListener("keydown", () => { composer += 1; });
    const resume = shortcutRegistry.suspend();
    await act(async () => { press('main'); });
    expect(requests).toEqual([]);
    resume();
    await act(async () => { press('main', { repeat: true }); press('main', { isComposing: true }); });
    expect(requests).toEqual([]);
    const before = composer;
    await act(async () => { expect(press('main').defaultPrevented).toBe(true); press('main'); });
    expect(requests).toEqual(['new-main']);
    // The answered keystroke never reaches the composer's bubbling handler.
    expect(composer).toBe(before + 1);
    await act(async () => { settle(false); });
    expect(errorCount).toBe(1);
    await act(async () => { press('main'); });
    expect(requests).toEqual(['new-main', 'new-main']);
    await act(async () => { settle(true); });
    await act(async () => { press('pinned-input'); });
    expect(requests.at(-1)).toBe('pinned');
    await act(async () => { settle(true); });
    await act(async () => { press('main'); });
    expect(requests.at(-1)).toBe('old-main');
    await act(async () => { settle(true); });
  } finally {
    await act(async () => root.unmount());
    stores.disposeAll();
    opencodeClient.replyToPermission = originalReply;
    console.error = originalError;
    useConfigStore.setState({ isConnected: connection.isConnected, hasEverConnected: connection.hasEverConnected });
    useUIStore.setState({ shortcutOverrides: overrides });
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
    await dom.happyDOM.close();
  }
});
