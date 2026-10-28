import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import type { KnowledgeLibraryStatus } from '@/lib/knowledgeLibrary';

const browser = new Window({ url: 'http://localhost/' });
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser, document: browser.document, navigator: browser.navigator,
  HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, Event: browser.Event,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  localStorage: browser.localStorage, sessionStorage: browser.sessionStorage,
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  getComputedStyle: browser.getComputedStyle.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
})) {
  savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true });
}

const { createRoot } = await import('react-dom/client');
const { I18nProvider, useI18nStore } = await import('@/lib/i18n');
const { useUIStore } = await import('@/stores/useUIStore');
const { KnowledgeLibrarySettings } = await import('./KnowledgeLibrarySettings');

afterAll(async () => {
  await browser.happyDOM.close();
  for (const [name, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

describe('KnowledgeLibrarySettings', () => {
  let host: HTMLDivElement;
  let root: Root;
  let fetchFixture: ReturnType<typeof spyOn> | null = null;
  beforeEach(() => {
    useI18nStore.getState().setLocale('en');
    useUIStore.setState({ knowledgeLibraryEnabled: true });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    fetchFixture?.mockRestore();
    fetchFixture = null;
    host.remove();
  });

  const renderStatus = async (status: Partial<KnowledgeLibraryStatus>, options: { afterSave?: Partial<KnowledgeLibraryStatus> } = {}) => {
    let current: KnowledgeLibraryStatus = {
      supported: true,
      enabled: true,
      provisioned: false,
      backend: { state: 'stopped', port: 17808, logPath: '/data/embedded-knowledge/app.log' },
      stats: { libraries: 0, files: 0, indexable: 0, skipped: 0 },
      ...status,
    };
    fetchFixture = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : String(input), browser.location.href).pathname;
      if (path.endsWith('/api/knowledge-library/status')) {
        return Response.json(current);
      }
      if (path.endsWith('/api/config/settings') && (input instanceof Request ? input.method : init?.method) === 'PUT') {
        current = { ...current, ...options.afterSave };
        return Response.json(current);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    await act(async () => root.render(<I18nProvider><KnowledgeLibrarySettings /></I18nProvider>));
    await act(async () => { await Promise.resolve(); });
  };

  test('shows the saved server switch even when the local store still says on', async () => {
    await renderStatus({ enabled: false });
    const toggle = host.querySelector<HTMLElement>('[role="button"][aria-pressed]');
    expect(toggle?.getAttribute('aria-pressed')).toBe('false');
    expect(host.textContent).toContain('Disabled in the saved settings');
    expect([...host.querySelectorAll('button')].find((button) => button.textContent === 'Retry')?.disabled).toBe(true);
  });

  test('shows the startup failure code returned by the backend', async () => {
    await renderStatus({
      enabled: true,
      backend: { state: 'stopped', port: 17808, error: 'backend_spawn_failed', logPath: '/data/embedded-knowledge/app.log' },
    });
    expect(host.textContent).toContain('backend_spawn_failed');
  });

  test('keeps the switch responsive while saving it', async () => {
    await renderStatus({ enabled: false }, { afterSave: { enabled: true } });
    const toggle = () => host.querySelector<HTMLElement>('[role="button"][aria-pressed]');
    expect(toggle()?.getAttribute('aria-pressed')).toBe('false');
    await act(async () => toggle()?.click());
    expect(toggle()?.getAttribute('aria-pressed')).toBe('true');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(toggle()?.getAttribute('aria-pressed')).toBe('true');
  });
});
