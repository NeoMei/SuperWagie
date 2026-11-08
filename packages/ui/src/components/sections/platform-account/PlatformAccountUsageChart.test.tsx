import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import type { PlatformUsageActivity } from '@/lib/platformUsageActivity';

const browser = new Window({ url: 'http://localhost/' });
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement, HTMLButtonElement: browser.HTMLButtonElement, KeyboardEvent: browser.KeyboardEvent, requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), getComputedStyle: browser.getComputedStyle.bind(browser), DocumentFragment: browser.DocumentFragment, Element: browser.Element, Node: browser.Node, Event: browser.Event, CustomEvent: browser.CustomEvent, MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver, localStorage: browser.localStorage, IS_REACT_ACT_ENVIRONMENT: true })) {
  savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true });
}
const from = '2025-11-09T00:00:00Z';
const activity: PlatformUsageActivity = {
  visibility: 'account', from, to: '2026-11-08T12:00:00Z', asOf: '2026-11-08T12:00:00Z',
  days: Array.from({ length: 365 }, (_, index) => ({ date: new Date(Date.parse(from) + index * 86_400_000).toISOString().slice(0, 10), calls: index === 364 ? '7' : '0' })),
  total: '7', complete: true, unknownTime: '0',
};
let pendingRead: Promise<Response> | null = null;
const requests: string[] = [];
const fetchFixture = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
  const url = new URL(String(input), 'http://localhost/');
  if (url.pathname === '/auth/url-token') return Response.json({ token: '', expiresAt: 0 });
  requests.push(url.pathname);
  if (url.pathname !== '/api/platform-account/usage/account-a/activity' || !pendingRead) throw new Error(`Unexpected route: ${url.pathname}`);
  const pending = pendingRead;
  pendingRead = null;
  return pending;
});
const { createRoot } = await import('react-dom/client');
const { I18nProvider, useI18nStore } = await import('@/lib/i18n');
const { getRuntimeKey, getRuntimeApiBaseUrl, switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
const { PlatformAccountUsageChart } = await import('./PlatformAccountUsageChart');
const initialRuntime = { runtimeKey: getRuntimeKey(), apiBaseUrl: getRuntimeApiBaseUrl() };
let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined; host?.remove(); host = undefined;
  if (getRuntimeKey() !== initialRuntime.runtimeKey) await act(async () => switchRuntimeEndpoint(initialRuntime));
  pendingRead = null; requests.length = 0;
});
afterAll(async () => {
  fetchFixture.mockRestore(); await browser.happyDOM.close();
  for (const [name, descriptor] of savedGlobals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
});

test('annual activity keeps seven fixed rows and 53 week columns with one keyboard entry point', async () => {
  pendingRead = Promise.resolve(Response.json(activity));
  useI18nStore.getState().setLocale('en');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root?.render(<I18nProvider><PlatformAccountUsageChart accountId="account-a" /></I18nProvider>));
  const matrix = host.querySelector<HTMLElement>('[role="group"]');
  expect(matrix?.style.gridTemplateRows).toBe('repeat(7, 11px)');
  expect(matrix?.style.gridTemplateColumns).toBe('repeat(53, 11px)');
  const days = Array.from(matrix?.querySelectorAll<HTMLButtonElement>('button') ?? []);
  expect(days).toHaveLength(365);
  expect(days.filter((day) => day.tabIndex === 0)).toHaveLength(1);
  expect(host.textContent).toContain('Last 365 days');
  expect(host.textContent).toContain('Mon');
  expect(host.textContent).toContain('Dec');
  await act(async () => days[364].focus());
  await act(async () => days[364].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })));
  expect(document.activeElement).toBe(days[357]);
  await act(async () => days[357].dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })));
  expect(document.activeElement).toBe(days[0]);
  await act(async () => days[1].focus());
  await act(async () => days[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })));
  expect(document.activeElement).toBe(days[1]);
});

test('an incomplete year labels unloaded dates unknown and observed counts as lower bounds', async () => {
  pendingRead = Promise.resolve(Response.json({ ...activity, complete: false }));
  useI18nStore.getState().setLocale('en');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root?.render(<I18nProvider><PlatformAccountUsageChart accountId="account-a" /></I18nProvider>));
  const days = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="group"] button'));
  expect(days[0].getAttribute('aria-label')).toContain('usage not fully loaded');
  expect(days[364].getAttribute('aria-label')).toContain('at least 7 calls');
  expect(days.some((day) => day.getAttribute('aria-label')?.includes('0 calls'))).toBe(false);
  expect(host.textContent).toContain('Unfilled dates are unknown');
});

test.each([200, 403])('a pending activity %s response cannot publish after an A-to-B-to-A runtime switch', async (status) => {
  let finish: (response: Response) => void = () => { throw new Error('Missing activity response gate'); };
  pendingRead = new Promise<Response>((resolve) => { finish = resolve; });
  switchRuntimeEndpoint({ apiBaseUrl: 'http://activity-runtime-a.test', runtimeKey: 'activity-runtime-a' });
  useI18nStore.getState().setLocale('en');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root?.render(<I18nProvider><PlatformAccountUsageChart accountId="account-a" /></I18nProvider>));
  expect(requests).toEqual(['/api/platform-account/usage/account-a/activity']);
  expect(host.querySelector('[role="status"]')?.textContent).toBe('Loading…');
  await act(async () => {
    switchRuntimeEndpoint({ apiBaseUrl: 'http://activity-runtime-b.test', runtimeKey: 'activity-runtime-b' });
    switchRuntimeEndpoint({ apiBaseUrl: 'http://activity-runtime-a.test', runtimeKey: 'activity-runtime-a' });
    finish(Response.json(status === 200 ? activity : { error: 'forbidden' }, { status }));
  });
  expect(host.querySelector('[role="status"]')?.textContent).toBe('Loading…');
  expect(host.textContent).not.toContain('7 model calls');
  expect(host.textContent).not.toContain('You do not have permission');
  expect(host.querySelector('[role="group"]')).toBeNull();
});
