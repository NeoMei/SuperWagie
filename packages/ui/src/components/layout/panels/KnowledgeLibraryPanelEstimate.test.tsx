import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';

const browser = new Window({ url: 'http://library.test' });
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser, document: browser.document, navigator: browser.navigator, location: browser.location,
  localStorage: browser.localStorage, Element: browser.Element, HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement, Node: browser.Node, Event: browser.Event,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  getComputedStyle: browser.getComputedStyle.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
})) {
  savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true });
}

const { createRoot } = await import('react-dom/client');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { createWebAPIs } = await import('../../../../../web/src/api/index');
const { I18nProvider, useI18nStore } = await import('@/lib/i18n');
const { getRuntimeUrlResolver, setRuntimeUrlResolver } = await import('@/lib/runtime-url');
const { KnowledgeLibraryPanel } = await import('./KnowledgeLibraryPanel');

afterAll(async () => {
  await browser.happyDOM.close();
  for (const [name, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

describe('KnowledgeLibraryPanel cost notice', () => {
  test('shows the remote indexing cost before the user chooses a folder', async () => {
    Object.defineProperty(window, '__OPENCHAMBER_ELECTRON__', { value: { runtime: 'electron' }, configurable: true });
    Object.defineProperty(window, '__OPENCHAMBER_LOCAL_ORIGIN__', { value: 'http://library.test', configurable: true });
    Object.defineProperty(window, '__OPENCHAMBER_DESKTOP__', {
      value: { invoke: async () => null, openDialog: async () => '/picked-folder' },
      configurable: true,
    });
    const previousResolver = getRuntimeUrlResolver();
    const previousLocale = useI18nStore.getState().locale;
    useI18nStore.getState().setLocale('en');
    const fetchFixture = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const path = new URL(input instanceof Request ? input.url : String(input), browser.location.href).pathname;
      if (path.endsWith('/api/knowledge-library/status')) return Response.json({
        supported: true, enabled: true, provisioned: true, backend: { state: 'running', port: 8877 },
        stats: { libraries: 0, files: 0, indexable: 0, skipped: 0 },
      });
      if (path.endsWith('/api/knowledge-library/libraries')) return Response.json({ libraries: [] });
      if (path.endsWith('/api/knowledge-library/documents')) return Response.json({ total: 0, documents: [] });
      if (path.endsWith('/api/knowledge-library/libraries/preview')) return Response.json({
        total: 100,
        indexable: 80,
        skipped: 20,
        estimate: { tokensMin: 500_000, tokensMax: 2_000_000, secondsMin: 120, secondsMax: 3_600, imageHeavyFiles: 3 },
      });
      throw new Error(`Unexpected request: ${path}`);
    });
    const host = document.createElement('div');
    document.body.append(host);
    let root: Root | null = null;
    try {
      root = createRoot(host);
      await act(async () => root?.render(
        <RuntimeAPIContext.Provider value={createWebAPIs()}>
          <I18nProvider><KnowledgeLibraryPanel visible /></I18nProvider>
        </RuntimeAPIContext.Provider>,
      ));
      await act(async () => { await Promise.resolve(); });
      expect(host.textContent).toContain('The first index calls a paid remote model.');
      expect(host.textContent).toContain('estimated tokens, cost and time');
      const add = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Add folder');
      if (!add) throw new Error('Missing Add folder button');
      await act(async () => add.click());
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
      expect(document.body.textContent).toContain('Estimated remote use: 500K–2M tokens');
      expect(document.body.textContent).toContain('3 PDF or presentation files may contain images');
      expect([...document.querySelectorAll('button')].some((button) => button.textContent === 'Confirm and start indexing')).toBe(true);
    } finally {
      if (root) await act(async () => root?.unmount());
      fetchFixture.mockRestore();
      setRuntimeUrlResolver(previousResolver);
      useI18nStore.getState().setLocale(previousLocale);
      host.remove();
    }
  });
});
