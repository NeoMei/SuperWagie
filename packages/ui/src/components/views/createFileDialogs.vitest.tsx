import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { FilesAPI } from '@/lib/api/types';

test.each([
  { surface: 'sidebar', capability: 'both' },
  { surface: 'view', capability: 'both' },
  { surface: 'sidebar', capability: 'create-only' },
  { surface: 'view', capability: 'create-only' },
  { surface: 'sidebar', capability: 'unsupported' },
  { surface: 'view', capability: 'unsupported' },
])('$surface creation honors $capability capability and preserves collisions', async ({ surface, capability }) => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator, location: dom.location, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, Node: dom.Node,
    Document: dom.Document, Text: dom.Text, Range: dom.Range,
    customElements: dom.customElements, CSSStyleSheet: dom.CSSStyleSheet,
    Event: dom.Event, CustomEvent: dom.CustomEvent, KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent,
    PointerEvent: dom.PointerEvent, MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
    IntersectionObserver: dom.IntersectionObserver,
    // The empty file view warms highlighting workers. Keep that platform
    // dependency pending; this fixture never opens a code preview.
    Worker: class extends EventTarget { postMessage() {} terminate() {} },
    getComputedStyle: dom.getComputedStyle.bind(dom), requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  for (const name of ['offsetHeight', 'offsetWidth', 'clientHeight', 'clientWidth']) {
    Object.defineProperty(dom.HTMLElement.prototype, name, { configurable: true, get: () => 600 });
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => new Promise<Response>(() => {}), originalFetch);
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { createWebAPIs } = await import('../../../../web/src/api/index');
  const { useSessionUIStore } = await import('@/sync/session-ui-store');
  const { SyncProvider } = await import('@/sync/sync-context');
  const { OpenCode } = await import('@opencode/client');
  const { SidebarFilesTree } = await import('../layout/SidebarFilesTree');
  const { FilesView } = await import('./FilesView');
  const sdk = OpenCode.make({ baseUrl: 'http://files.test', fetch: () => new Promise<Response>(() => {}) });
  const web = createWebAPIs();
  const disk = new Map([['/repo/existing.txt', 'original']]);
  const created: string[] = [];
  let listings = 0;
  const files: FilesAPI = {
    ...web.files,
    listDirectory: async directory => {
      listings++;
      return { directory, entries: [] };
    },
    createFile: async path => {
      created.push(path);
      if (disk.has(path)) throw new Error('File already exists');
      disk.set(path, '');
      return { success: true, path };
    },
    writeFile: async (path, content) => { disk.set(path, content); return { success: true, path }; },
  };
  if (capability === 'create-only') files.writeFile = undefined;
  if (capability === 'unsupported') files.createFile = undefined;
  const apis = { ...web, files };
  useSessionUIStore.getState().openNewSessionDraft({ directoryOverride: '/repo', preserveDirectoryOverride: true });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const flush = async () => {
    for (let index = 0; index < 5; index++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  };
  const click = async (element: Element | null) => {
    if (!(element instanceof HTMLElement)) throw new Error('Expected an interactive element');
    await act(async () => element.click());
    await flush();
  };
  try {
    await act(async () => root.render(
      <SyncProvider sdk={sdk} directory="/repo"><I18nProvider><ThemeSystemProvider><RuntimeAPIContext.Provider value={apis}>
        {surface === 'sidebar' ? <SidebarFilesTree /> : <FilesView />}
      </RuntimeAPIContext.Provider></ThemeSystemProvider></I18nProvider></SyncProvider>,
    ));
    await flush();
    if (surface === 'sidebar') {
      await click(container.querySelector('button[aria-label="New file, folder, or upload"]'));
      const newFile = [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent?.includes('New File'));
      if (capability === 'unsupported') {
        expect(newFile).toBeUndefined();
        expect(disk.get('/repo/existing.txt')).toBe('original');
        return;
      }
      await click(newFile ?? null);
    } else {
      await click(container.querySelector('button[aria-label="New File"]'));
    }
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input');
    if (!input) throw new Error('Expected the new-file name input');
    const setName = async (value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await flush();
    };
    const confirm = () => [...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent === 'Confirm') ?? null;
    await setName('existing.txt');
    expect(confirm()?.hasAttribute('disabled')).toBe(false);
    const before = listings;
    await click(confirm());
    if (capability === 'unsupported') {
      expect(created).toEqual([]);
      expect(disk.get('/repo/existing.txt')).toBe('original');
      expect(input.value).toBe('existing.txt');
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      expect(confirm()?.hasAttribute('disabled')).toBe(false);
      expect(listings).toBe(before);
      return;
    }
    expect(created).toEqual(['/repo/existing.txt']);
    expect(disk.get('/repo/existing.txt')).toBe('original');
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(input.value).toBe('existing.txt');
    expect(confirm()?.hasAttribute('disabled')).toBe(false);
    expect(listings).toBe(before);
    await setName('new.txt');
    await click(confirm());
    expect(created).toEqual(['/repo/existing.txt', '/repo/new.txt']);
    expect(disk.get('/repo/new.txt')).toBe('');
    expect(listings).toBeGreaterThan(before);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
    dom.happyDOM.cancelAsync();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
