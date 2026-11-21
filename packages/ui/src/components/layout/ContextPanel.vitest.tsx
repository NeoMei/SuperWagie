import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

test('file tab actions target the background tab without selecting it', async () => {
  const dom = new Window({ url: 'http://127.0.0.1:57123' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator, location: dom.location, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, Node: dom.Node,
    Event: dom.Event, CustomEvent: dom.CustomEvent, KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent,
    PointerEvent: dom.PointerEvent, DOMRect: dom.DOMRect, MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom), requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }

  const copied: string[] = [];
  const revealed: string[] = [];
  Object.defineProperty(dom.navigator, 'clipboard', { value: { writeText: async (text: string) => { copied.push(text); } } });
  Object.defineProperty(dom, '__OPENCHAMBER_ELECTRON__', { configurable: true, value: { runtime: 'electron' } });
  Object.defineProperty(dom, '__OPENCHAMBER_LOCAL_ORIGIN__', { configurable: true, value: dom.location.origin });
  Object.defineProperty(dom, '__OPENCHAMBER_API_BASE_URL__', { configurable: true, value: dom.location.origin });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => new Promise<Response>(() => {}), originalFetch);
  const { createRoot } = await import('react-dom/client');
  const { OpenCode } = await import('@opencode/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { createWebAPIs } = await import('../../../../web/src/api/index');
  const { SyncProvider } = await import('@/sync/sync-context');
  const { useUIStore } = await import('@/stores/useUIStore');
  const { useSessionUIStore } = await import('@/sync/session-ui-store');
  const { switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
  const { ContextPanel } = await import('./ContextPanel');
  const web = createWebAPIs();
  const apis = {
    ...web,
    files: {
      ...web.files,
      revealPath: async (filePath: string) => { revealed.push(filePath); return { success: true }; },
    },
  };
  const directory = '/repo';
  const background = '/repo/报价.txt';
  const foreground = '/repo/active.txt';
  const previousPanels = useUIStore.getState().contextPanelByDirectory;
  useSessionUIStore.getState().openNewSessionDraft({ directoryOverride: directory, preserveDirectoryOverride: true });
  useUIStore.getState().openContextFile(directory, background);
  useUIStore.getState().openContextFile(directory, foreground);
  const sdk = OpenCode.make({ baseUrl: 'http://panel.test', fetch: () => new Promise<Response>(() => undefined) });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const openBackgroundMenu = async () => {
    const button = [...container.querySelectorAll('button')].find((entry) => entry.textContent?.includes('报价.txt'));
    if (!button) throw new Error('Missing background file tab');
    await act(async () => {
      button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
    });
  };
  const menuItem = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((entry) => entry.textContent?.includes(label));
  const revealItem = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((entry) => /Finder|File Explorer|File Manager/i.test(entry.textContent ?? ''));
  const activeFile = () => {
    const panel = useUIStore.getState().contextPanelByDirectory[directory];
    return panel?.tabs.find((tab) => tab.id === panel.activeTabId)?.targetPath;
  };
  try {
    await act(async () => root.render(
      <SyncProvider sdk={sdk} directory={directory}>
        <I18nProvider><RuntimeAPIContext.Provider value={apis}><ContextPanel /></RuntimeAPIContext.Provider></I18nProvider>
      </SyncProvider>,
    ));
    expect(activeFile()).toBe(foreground);
    await openBackgroundMenu();
    expect(menuItem('Close')).toBeDefined();
    const copy = menuItem('Copy Path');
    expect(copy).toBeDefined();
    await act(async () => copy?.click());
    expect(copied).toEqual([background]);
    expect(activeFile()).toBe(foreground);

    await openBackgroundMenu();
    const reveal = revealItem();
    expect(reveal).toBeDefined();
    await act(async () => reveal?.click());
    expect(revealed).toEqual([background]);
    expect(activeFile()).toBe(foreground);

    await act(async () => switchRuntimeEndpoint({ apiBaseUrl: 'https://remote.test', runtimeKey: 'host:test' }));
    await openBackgroundMenu();
    expect(menuItem('Copy Path')).toBeDefined();
    expect(revealItem()).toBeUndefined();
  } finally {
    await act(async () => root.unmount());
    useUIStore.setState({ contextPanelByDirectory: previousPanels });
    switchRuntimeEndpoint({ apiBaseUrl: dom.location.origin, runtimeKey: 'local' });
    globalThis.fetch = originalFetch;
    await dom.happyDOM.abort();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
