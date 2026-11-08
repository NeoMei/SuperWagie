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
const activity = {
  visibility: 'account', from, to: '2026-11-08T12:00:00Z', asOf: '2026-11-08T12:00:00Z',
  days: Array.from({ length: 365 }, (_, index) => ({ date: new Date(Date.parse(from) + index * 86_400_000).toISOString().slice(0, 10), calls: index === 364 ? '7' : '0' })),
  total: '7', complete: true, unknownTime: '0',
};
const savedActivity: PlatformUsageActivity = {
  ...activity, visibility: 'account',
  days: activity.days.map((day): PlatformUsageActivity['days'][number] => ({ ...day, coverage: 'complete' })),
  savedAt: activity.to, sync: { status: 'synced', lastSuccessAt: activity.to },
};
let pendingRead: Promise<Response> | null = null;
const requests: string[] = [];
const fetchFixture = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
  const url = new URL(String(input), 'http://localhost/');
  if (url.pathname === '/auth/url-token') return Response.json({ token: '', expiresAt: 0 });
  requests.push(url.pathname);
  if (!/^\/api\/platform-account\/usage\/account-[ab]\/activity$/.test(url.pathname) || !pendingRead) throw new Error(`Unexpected route: ${url.pathname}`);
  const pending = pendingRead;
  pendingRead = null;
  return pending;
});
const { createRoot } = await import('react-dom/client');
const { I18nProvider, useI18nStore } = await import('@/lib/i18n');
const { getRuntimeKey, getRuntimeApiBaseUrl, switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
const { PlatformAccountUsageChart } = await import('./PlatformAccountUsageChart');
const { ClockPausedContext } = await import('@/hooks/clockPausedContext');
const initialRuntime = { runtimeKey: getRuntimeKey(), apiBaseUrl: getRuntimeApiBaseUrl() };
let root: Root | undefined;
let host: HTMLDivElement | undefined;
let restorePollingHarness: (() => void) | undefined;
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined; host?.remove(); host = undefined;
  restorePollingHarness?.(); restorePollingHarness = undefined;
  if (getRuntimeKey() !== initialRuntime.runtimeKey) await act(async () => switchRuntimeEndpoint(initialRuntime));
  pendingRead = null; requests.length = 0;
});
afterAll(async () => {
  fetchFixture.mockRestore(); await browser.happyDOM.close();
  for (const [name, descriptor] of savedGlobals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
});

const renderChart = async (accountId = 'account-a') => {
  useI18nStore.getState().setLocale('en');
  if (!host) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); }
  await act(async () => root?.render(<I18nProvider><PlatformAccountUsageChart accountId={accountId} /></I18nProvider>));
};
const refreshChart = async () => {
  const refresh = Array.from(host?.querySelectorAll<HTMLButtonElement>('button') ?? []).find((button) => button.textContent === 'Refresh activity');
  if (!refresh) throw new Error('Missing activity refresh');
  await act(async () => refresh.click());
};
const pollingHarness = () => {
  const timers = new Map<ReturnType<typeof browser.setTimeout>, () => void>();
  const nativeSet = browser.setTimeout.bind(browser);
  const nativeClear = browser.clearTimeout.bind(browser);
  const set = spyOn(browser, 'setTimeout').mockImplementation((callback, delay, ...args) => {
    if (delay !== 10_000) return nativeSet(callback, delay, ...args);
    const timer = nativeSet(() => undefined, 0);
    nativeClear(timer);
    timers.set(timer, () => callback(...args));
    return timer;
  });
  const clear = spyOn(browser, 'clearTimeout').mockImplementation((timer) => { timers.delete(timer); nativeClear(timer); });
  const observerDescriptor = Object.getOwnPropertyDescriptor(browser, 'IntersectionObserver');
  const visibilityDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  let intersecting = true;
  const observers = new Set<VisibleObserver>();
  class VisibleObserver implements IntersectionObserver {
    readonly root = null;
    readonly rootMargin = '0px';
    readonly scrollMargin = '0px';
    readonly thresholds = [0];
    private target: Element | null = null;
    constructor(private callback: IntersectionObserverCallback) { observers.add(this); }
    observe(target: Element) { this.target = target; this.notify(); }
    unobserve() { this.target = null; }
    disconnect() { this.target = null; observers.delete(this); }
    takeRecords(): IntersectionObserverEntry[] { return []; }
    notify() {
      if (!this.target) return;
      const bounds = this.target.getBoundingClientRect();
      this.callback([{ target: this.target, isIntersecting: intersecting, intersectionRatio: intersecting ? 1 : 0, time: 0, rootBounds: bounds, boundingClientRect: bounds, intersectionRect: bounds }], this);
    }
  }
  Object.defineProperty(browser, 'IntersectionObserver', { value: VisibleObserver, configurable: true });
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  restorePollingHarness = () => {
    set.mockRestore(); clear.mockRestore();
    if (observerDescriptor) Object.defineProperty(browser, 'IntersectionObserver', observerDescriptor); else Reflect.deleteProperty(browser, 'IntersectionObserver');
    if (visibilityDescriptor) Object.defineProperty(document, 'visibilityState', visibilityDescriptor); else Reflect.deleteProperty(document, 'visibilityState');
  };
  return {
    timers,
    fire() {
      const entry = timers.entries().next().value;
      if (!entry) throw new Error('No activity poll scheduled');
      timers.delete(entry[0]); entry[1]();
    },
    setIntersecting(value: boolean) { intersecting = value; for (const observer of observers) observer.notify(); },
    setHidden(hidden: boolean) {
      Object.defineProperty(document, 'visibilityState', { value: hidden ? 'hidden' : 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    },
  };
};

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

test('daily coverage shows a confirmed zero beside unknown and partial saved days', async () => {
  pendingRead = Promise.resolve(Response.json({
    ...savedActivity, complete: false,
    days: savedActivity.days.map((day, index) => ({ ...day, coverage: index === 0 ? 'unknown' : index === 364 ? 'partial' : 'complete' })),
  }));
  await renderChart();
  const days = Array.from(host?.querySelectorAll<HTMLButtonElement>('[role="group"] button') ?? []);
  expect(days[0].getAttribute('aria-label')).toContain('usage not fully loaded');
  expect(days[1].getAttribute('aria-label')).toContain('0 calls');
  expect(days[364].getAttribute('aria-label')).toContain('at least 7 calls');
  expect(host?.textContent).toContain('At least 1 active day');
  expect(host?.textContent).toContain('Daily usage saved');
});

test('refresh keeps the saved calendar and focus, and a failed read retains the same snapshot', async () => {
  pendingRead = Promise.resolve(Response.json(savedActivity));
  await renderChart();
  const matrix = host?.querySelector('[role="group"]');
  const day = matrix?.querySelector<HTMLButtonElement>('button');
  await act(async () => day?.focus());
  let finish: (response: Response) => void = () => { throw new Error('Missing refresh gate'); };
  pendingRead = new Promise<Response>((resolve) => { finish = resolve; });
  await refreshChart();
  expect(host?.querySelector('[role="group"]') === matrix).toBe(true);
  expect(document.activeElement === day).toBe(true);
  expect(host?.textContent).toContain('Showing data saved');
  await act(async () => finish(Response.json({ error: 'platform_unavailable' }, { status: 503 })));
  expect(host?.querySelector('[role="group"]') === matrix).toBe(true);
  expect(host?.textContent).toContain('Refresh failed. Showing data saved');
  expect(host?.textContent).toContain('7 model calls');
});

test.each([
  [401, 'platform_session_expired'], [403, 'forbidden'], [409, 'platform_account_changed'], [409, 'platform_session_changed'],
])('an authoritative %s %s clears the previously visible saved calendar', async (status, error) => {
  pendingRead = Promise.resolve(Response.json(savedActivity));
  await renderChart();
  pendingRead = Promise.resolve(Response.json({ error }, { status }));
  await refreshChart();
  expect(host?.querySelector('[role="group"]')).toBeNull();
  expect(host?.textContent).not.toContain('7 model calls');
  expect(host?.textContent).not.toContain('Daily usage saved');
});

test('a backend synchronization failure retains its saved days and a legacy response never claims local saving', async () => {
  pendingRead = Promise.resolve(Response.json({ ...savedActivity, sync: { status: 'failed', lastSuccessAt: activity.to } }));
  await renderChart();
  expect(host?.querySelectorAll('[role="group"] button')).toHaveLength(365);
  expect(host?.textContent).toContain('Sync failed. Showing data saved');
  pendingRead = Promise.resolve(Response.json(activity));
  await refreshChart();
  expect(host?.textContent).not.toContain('saved');
});

test('changing the payer clears the previous calendar while its new read is pending', async () => {
  pendingRead = Promise.resolve(Response.json(savedActivity));
  await renderChart();
  pendingRead = new Promise<Response>(() => {});
  await renderChart('account-b');
  expect(host?.querySelector('[role="group"]')).toBeNull();
  expect(host?.textContent).not.toContain('7 model calls');
});

test('only a visible syncing local snapshot polls and repeated renders do not duplicate the timer', async () => {
  const polling = pollingHarness();
  const syncing = { ...savedActivity, sync: { status: 'syncing', lastSuccessAt: activity.to } };
  pendingRead = Promise.resolve(Response.json(syncing));
  await renderChart();
  expect(polling.timers.size).toBe(1);
  await renderChart();
  expect(polling.timers.size).toBe(1);
  pendingRead = Promise.resolve(Response.json(syncing));
  await act(async () => polling.fire());
  expect(requests).toHaveLength(2);
  expect(polling.timers.size).toBe(1);
  await act(async () => polling.setIntersecting(false));
  expect(polling.timers.size).toBe(0);
  await act(async () => polling.setIntersecting(true));
  expect(polling.timers.size).toBe(1);
  await act(async () => polling.setHidden(true));
  expect(polling.timers.size).toBe(0);
  await act(async () => polling.setHidden(false));
  expect(polling.timers.size).toBe(1);
  await act(async () => root?.unmount()); root = undefined;
  expect(polling.timers.size).toBe(0);
});

test.each(['synced', 'failed'])('polling stops immediately when the backend reports %s', async (status) => {
  const polling = pollingHarness();
  pendingRead = Promise.resolve(Response.json({ ...savedActivity, sync: { status: 'syncing', lastSuccessAt: activity.to } }));
  await renderChart();
  pendingRead = Promise.resolve(Response.json({ ...savedActivity, sync: { status, lastSuccessAt: activity.to } }));
  await act(async () => polling.fire());
  expect(requests).toHaveLength(2);
  expect(polling.timers.size).toBe(0);
  expect(host?.querySelectorAll('[role="group"] button')).toHaveLength(365);
});

test('polling never overlaps a pending read and a failed read stops polling without clearing saved days', async () => {
  const polling = pollingHarness();
  pendingRead = Promise.resolve(Response.json({ ...savedActivity, sync: { status: 'syncing', lastSuccessAt: activity.to } }));
  await renderChart();
  let finish: (response: Response) => void = () => { throw new Error('Missing poll gate'); };
  pendingRead = new Promise<Response>((resolve) => { finish = resolve; });
  const staleCallback = polling.timers.values().next().value;
  await act(async () => { polling.fire(); staleCallback?.(); });
  expect(requests).toHaveLength(2);
  expect(polling.timers.size).toBe(0);
  await refreshChart();
  expect(requests).toHaveLength(2);
  expect(host?.querySelectorAll('[role="group"] button')).toHaveLength(365);
  await act(async () => finish(Response.json({ error: 'platform_unavailable' }, { status: 503 })));
  expect(polling.timers.size).toBe(0);
  expect(host?.textContent).toContain('Refresh failed. Showing data saved');
});

test('published legacy reports do not start a local synchronization polling timer', async () => {
  const polling = pollingHarness();
  pendingRead = Promise.resolve(Response.json({ ...activity, complete: false }));
  await renderChart();
  expect(polling.timers.size).toBe(0);
  await act(async () => { polling.setHidden(true); polling.setHidden(false); });
  expect(polling.timers.size).toBe(0);
  expect(requests).toHaveLength(1);
});

test('a late permission failure for the previous payer cannot clear the new payer snapshot', async () => {
  pendingRead = Promise.resolve(Response.json(savedActivity));
  await renderChart();
  let finish: (response: Response) => void = () => { throw new Error('Missing previous payer gate'); };
  pendingRead = new Promise<Response>((resolve) => { finish = resolve; });
  await refreshChart();
  pendingRead = Promise.resolve(Response.json({ ...savedActivity, total: '9', days: savedActivity.days.map((day, index) => ({ ...day, calls: index === 364 ? '9' : '0' })) }));
  await renderChart('account-b');
  await act(async () => finish(Response.json({ error: 'forbidden' }, { status: 403 })));
  expect(host?.textContent).toContain('9 model calls');
  expect(host?.querySelectorAll('[role="group"] button')).toHaveLength(365);
});

test('an inherited paused surface stops the timer without discarding saved data', async () => {
  const polling = pollingHarness();
  pendingRead = Promise.resolve(Response.json({ ...savedActivity, sync: { status: 'syncing', lastSuccessAt: activity.to } }));
  useI18nStore.getState().setLocale('en');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const renderPaused = async (paused: boolean) => {
    await act(async () => root?.render(<I18nProvider><ClockPausedContext.Provider value={paused}><PlatformAccountUsageChart accountId="account-a" /></ClockPausedContext.Provider></I18nProvider>));
  };
  await renderPaused(false);
  expect(polling.timers.size).toBe(1);
  await renderPaused(true);
  expect(polling.timers.size).toBe(0);
  expect(host.querySelectorAll('[role="group"] button')).toHaveLength(365);
  await renderPaused(false);
  expect(polling.timers.size).toBe(1);
  expect(requests).toHaveLength(1);
});

test('an initial failed read cannot invent a zero-filled local snapshot', async () => {
  pendingRead = Promise.resolve(Response.json({ error: 'platform_unavailable' }, { status: 503 }));
  await renderChart();
  expect(host?.querySelector('[role="group"]')).toBeNull();
  expect(host?.textContent).not.toContain('0 model calls');
  expect(host?.textContent).not.toContain('saved');
});

test('language switching updates synchronization copy without remounting the calendar', async () => {
  pendingRead = Promise.resolve(Response.json({ ...savedActivity, sync: { status: 'failed', lastSuccessAt: activity.to } }));
  await renderChart();
  const matrix = host?.querySelector('[role="group"]');
  expect(host?.textContent).toContain('Sync failed. Showing data saved');
  await act(async () => { useI18nStore.getState().setLocale('zh-CN'); await import('@/lib/i18n/messages/zh-CN'); });
  expect(host?.querySelector('[role="group"]') === matrix).toBe(true);
  expect(host?.textContent).toContain('同步失败，仍显示保存于');
});
