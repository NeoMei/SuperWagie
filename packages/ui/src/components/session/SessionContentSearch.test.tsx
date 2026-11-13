import { afterAll, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://search.test' });
const descriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, localStorage: browser.localStorage, IS_REACT_ACT_ENVIRONMENT: true })) {
  descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
browser.localStorage.setItem('openchamber.i18n.v1', JSON.stringify({ locale: 'en' }));
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { useUIStore } = await import('@/stores/useUIStore');
const { SessionContentSearch } = await import('./SessionContentSearch');
const host = document.createElement('div');
document.body.append(host);
const root = createRoot(host);
const originalFetch = globalThis.fetch;
const requests: URL[] = [];
let fail = false;
globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
  requests.push(new URL(input instanceof Request ? input.url : String(input), 'http://search.test'));
  if (fail) return Response.json({ error: 'offline' }, { status: 500 });
  return Response.json({ status: 'ok', hits: [{ messageId: 'message-a', sessionId: 'session-a', sessionTitle: '预算', directory: '/a', role: 'user', createdAt: 1, snippet: '报价单', matchCount: 1, archived: true }], next: null, index: null });
}, originalFetch);
const render = async (query: string, lifecycle: 'active' | 'archived' = 'active') => act(async () => root.render(<I18nProvider><SessionContentSearch query={query} lifecycle={lifecycle} onNavigate={() => {}} /></I18nProvider>));

test('index off and short Chinese searches disclose title-only scope without body requests', async () => {
  await act(async () => useUIStore.setState({ messageSearchEnabled: false }));
  await render('报价单');
  expect(host.textContent).toContain('Message indexing is off');
  expect(requests).toHaveLength(0);
  await render('报价');
  await act(async () => useUIStore.setState({ messageSearchEnabled: true }));
  expect(host.textContent).toContain('3 consecutive characters');
  expect(requests).toHaveLength(0);
});

test('archived bodies use the archived backend scope and preserve error status', async () => {
  await render('报价单', 'archived');
  expect(requests.at(-1)?.pathname).toBe('/api/openchamber/message-search/sessions');
  expect(requests.at(-1)?.searchParams.get('lifecycle')).toBe('archived');
  expect(host.textContent).toContain('Archived sessions');
  expect(host.textContent).toContain('预算');
  fail = true;
  await render('合同书', 'archived');
  expect(host.querySelector('[role="status"]')?.textContent).toBe("Couldn't search messages");
  expect(host.textContent).not.toContain('预算');
  expect(host.textContent).not.toContain('No messages');
});

afterAll(async () => {
  await act(async () => root.unmount());
  globalThis.fetch = originalFetch;
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  browser.happyDOM.abort();
});
