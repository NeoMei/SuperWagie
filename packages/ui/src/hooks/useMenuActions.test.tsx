import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { UpdateInfo } from '@/lib/desktop';

const browser = new Window({ url: 'http://localhost/' });
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser, document: browser.document, navigator: browser.navigator,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  MutationObserver: browser.MutationObserver, Event: browser.Event, CustomEvent: browser.CustomEvent,
  localStorage: browser.localStorage, getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
})) {
  savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true });
}

const deferred = <T,>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
};

let pendingCheck = deferred<UpdateInfo>();
let checks = 0;
Object.defineProperty(browser, '__OPENCHAMBER_ELECTRON__', { configurable: true, value: { runtime: 'electron' } });
Object.defineProperty(browser, '__OPENCHAMBER_DESKTOP__', {
  configurable: true,
  value: {
    invoke: async (command: string) => {
      if (command === 'desktop_check_for_updates') {
        checks += 1;
        return pendingCheck.promise;
      }
      return null;
    },
  },
});
const fetchFixture = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.endsWith('/api/config/themes')) return Response.json({ themes: [] });
  if (url.includes('/api/openchamber/update-check?')) return Response.json({ nextSuggestedCheckInSec: 3600 });
  throw new Error(`Unexpected request: ${url}`);
});
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { useI18nStore } = await import('@/lib/i18n/store');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { useUpdateStore } = await import('@/stores/useUpdateStore');
const { toast } = await import('sonner');
const { Toaster } = await import('@/components/ui/sonner');
const { useMenuActions } = await import('./useMenuActions');

function Harness() {
  useMenuActions();
  return <Toaster />;
}

let root: Root;
let host: HTMLDivElement;
beforeEach(async () => {
  checks = 0;
  pendingCheck = deferred<UpdateInfo>();
  useI18nStore.getState().setLocale('en');
  useUpdateStore.getState().reset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<I18nProvider><ThemeSystemProvider><Harness /></ThemeSystemProvider></I18nProvider>));
});

afterEach(async () => {
  pendingCheck.resolve({ available: false, currentVersion: '2.7.54' });
  await act(async () => {
    await pendingCheck.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    toast.dismiss();
    root.unmount();
  });
  host.remove();
  useUpdateStore.getState().reset();
});

afterAll(async () => {
  fetchFixture.mockRestore();
  await browser.happyDOM.close();
  for (const [name, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const flush = async () => {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
};

test('manual menu checks show a spinner until the same toast becomes the result', async () => {
  await act(async () => window.dispatchEvent(new CustomEvent('openchamber:menu-action', { detail: 'check-for-updates' })));
  await flush();
  const loading = document.querySelector<HTMLElement>('[data-sonner-toast][data-type="loading"]');
  expect(loading).not.toBeNull();
  expect(loading?.querySelector('[data-spinner]')).not.toBeNull();
  expect(loading?.textContent).toContain('Checking');

  await act(async () => window.dispatchEvent(new Event('openchamber:check-for-updates')));
  expect(checks).toBe(1);
  await act(async () => pendingCheck.resolve({ available: false, currentVersion: '2.7.54' }));
  await flush();
  const result = document.querySelector<HTMLElement>('[data-sonner-toast][data-type="success"]');
  expect(result).not.toBeNull();
  expect(result).toBe(loading);
  expect(result?.querySelector('[data-spinner]')).toBeNull();
  expect(document.querySelectorAll('[data-sonner-toast]')).toHaveLength(1);
});

test('a failed check replaces the loading toast and allows another manual attempt', async () => {
  await act(async () => window.dispatchEvent(new Event('openchamber:check-for-updates')));
  await flush();
  expect(document.querySelector('[data-type="loading"] [data-spinner]')).not.toBeNull();
  await act(async () => pendingCheck.reject(new Error('Network unavailable')));
  await flush();
  const result = document.querySelector('[data-sonner-toast][data-type="error"]');
  expect(result?.textContent).toContain('Network unavailable');
  expect(document.querySelector('[data-sonner-toast][data-type="loading"]')).toBeNull();

  pendingCheck = deferred<UpdateInfo>();
  await act(async () => window.dispatchEvent(new Event('openchamber:check-for-updates')));
  await flush();
  expect(checks).toBe(2);
  expect(document.querySelector('[data-type="loading"] [data-spinner]')).not.toBeNull();
  await act(async () => pendingCheck.resolve({ available: true, currentVersion: '2.7.54', version: '2.7.55' }));
  await flush();
  expect(toast.getToasts().filter((entry) => 'type' in entry && entry.type === 'loading')).toHaveLength(0);
});
