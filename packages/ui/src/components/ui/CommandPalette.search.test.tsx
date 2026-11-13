import { afterAll, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import type { Session } from '@/lib/opencode/model';

const browser = new Window({ url: 'http://palette.test' });
const descriptors = new Map<string, PropertyDescriptor | undefined>();
const globals = {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, Text: browser.Text,
  HTMLInputElement: browser.HTMLInputElement, HTMLButtonElement: browser.HTMLButtonElement, HTMLDivElement: browser.HTMLDivElement,
  DocumentFragment: browser.DocumentFragment, MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  IntersectionObserver: browser.IntersectionObserver, ShadowRoot: browser.ShadowRoot,
  Event: browser.Event, CompositionEvent: browser.CompositionEvent,
  getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [key, value] of Object.entries(globals)) {
  descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
browser.localStorage.setItem('openchamber.i18n.v1', JSON.stringify({ locale: 'en' }));
const originalFetch = globalThis.fetch;
const searches: URL[] = [];
globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
  const url = new URL(input instanceof Request ? input.url : String(input), 'http://palette.test');
  if (url.pathname === '/api/openchamber/message-search') {
    searches.push(url);
    return Response.json({ status: 'ok', hits: [], next: null, index: null });
  }
  return Response.json({});
}, originalFetch);
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { createWebAPIs } = await import('../../../../web/src/api');
const { useUIStore } = await import('@/stores/useUIStore');
const { useGlobalSessionsStore } = await import('@/stores/useGlobalSessionsStore');
const { CommandPalette } = await import('./CommandPalette');
const { SyncProvider } = await import('@/sync/sync-context');
const { OpenCode } = await import('@opencode/client');
const sdk = OpenCode.make({ baseUrl: 'http://palette.test', fetch: async () => Response.json([]) });
const host = document.createElement('div');
document.body.append(host);
const root = createRoot(host);
const wait = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 230)); });

test('the palette waits for Chinese composition before requesting body search', async () => {
  useUIStore.setState({ isCommandPaletteOpen: true, messageSearchEnabled: true });
  await act(async () => root.render(<RuntimeAPIContext.Provider value={createWebAPIs()}><SyncProvider sdk={sdk} directory=""><I18nProvider><CommandPalette /></I18nProvider></SyncProvider></RuntimeAPIContext.Provider>));
  const input = document.querySelector<HTMLInputElement>('[cmdk-input]')!;
  expect(input).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    setter.call(input, '报价单');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await wait();
  expect(searches).toHaveLength(0);
  await act(async () => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
  await wait();
  expect(searches).toHaveLength(1);
  expect(searches[0]?.searchParams.get('q')).toBe('报价单');
});

test('two-character title matches keep archived conversations in a separate group', async () => {
  const row = (id: string, title: string, archived?: number): Session => {
    const time: Session['time'] = { created: 1, updated: 1 };
    if (archived !== undefined) time.archived = archived;
    return { id, title, directory: '/repo', projectID: 'project', cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time };
  };
  await act(async () => useGlobalSessionsStore.getState().applySnapshot([row('active', '报价')], [row('archived', '报价归档', 2)], 'ready'));
  const input = document.querySelector<HTMLInputElement>('[cmdk-input]')!;
  const setter = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, '报价');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await wait();
  expect(searches).toHaveLength(1);
  expect(document.body.textContent).toContain('3 consecutive characters');
  expect(document.body.textContent).toContain('报价归档');
  expect(document.body.textContent).toContain('Archived titles');
});

afterAll(async () => {
  await act(async () => root.unmount());
  globalThis.fetch = originalFetch;
  await browser.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
