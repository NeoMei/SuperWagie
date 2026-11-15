import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser, document: browser.document, navigator: browser.navigator,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  HTMLButtonElement: browser.HTMLButtonElement, HTMLInputElement: browser.HTMLInputElement,
  HTMLIFrameElement: browser.HTMLIFrameElement, SVGElement: browser.SVGElement,
  Document: browser.Document, DocumentFragment: browser.DocumentFragment,
  Event: browser.Event, CustomEvent: browser.CustomEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  localStorage: browser.localStorage, getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
})) {
  savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true });
}
window.__OPENCHAMBER_ELECTRON__ = { runtime: 'electron' };

const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { useI18nStore } = await import('@/lib/i18n/store');
const { useUpdateStore } = await import('@/stores/useUpdateStore');
const { AboutDialog } = await import('./AboutDialog');
const { useProductHelpGuidanceStore } = await import('@/lib/product-help/guidance-store');
const fetchFixture = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
  const path = String(input instanceof Request ? input.url : input);
  if (path.endsWith('/api/system/info')) return Response.json({ openchamberVersion: '2.7.54' });
  if (path.endsWith('/api/opencode/upgrade-status')) return Response.json({ currentVersion: '2.0.0' });
  if (path.includes('/api/openchamber/update-check?')) return Response.json({ available: false, currentVersion: '2.7.98' });
  throw new Error(`Unexpected request: ${path}`);
});

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  useProductHelpGuidanceStore.getState().stop();
  useI18nStore.getState().setLocale('en');
  useUpdateStore.getState().reset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useUpdateStore.getState().reset();
  useProductHelpGuidanceStore.getState().stop();
});

test('keeps update instructions and the end-guide control accessible inside About', async () => {
  await import('@/components/product-help/ProductHelpPanel');
  useProductHelpGuidanceStore.getState().start('updates', 'guide', 'Check the installed version, then choose Check for updates.');
  await act(async () => root.render(<I18nProvider><AboutDialog open onOpenChange={() => {}} /></I18nProvider>));
  expect(document.querySelector('[data-product-help-target="about"]')).not.toBeNull();
  expect(document.body.textContent).toContain('Check the installed version, then choose Check for updates.');
  const end = [...document.querySelectorAll('button')].find(button => button.textContent === 'End guide');
  if (!end) throw new Error('Missing end-guide control');
  await act(async () => end.click());
  expect(useProductHelpGuidanceStore.getState().session).toBeNull();
});

afterAll(async () => {
  fetchFixture.mockRestore();
  await browser.happyDOM.close();
  for (const [name, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test('checks for updates once when About opens', async () => {
  const checkForUpdates = spyOn(useUpdateStore.getState(), 'checkForUpdates').mockResolvedValue(null);
  try {
    await act(async () => root.render(<I18nProvider><AboutDialog open onOpenChange={() => {}} /></I18nProvider>));
    expect(checkForUpdates).toHaveBeenCalledTimes(1);

    await act(async () => root.render(<I18nProvider><AboutDialog open onOpenChange={() => {}} /></I18nProvider>));
    expect(checkForUpdates).toHaveBeenCalledTimes(1);

    await act(async () => root.render(<I18nProvider><AboutDialog open={false} onOpenChange={() => {}} /></I18nProvider>));
    await act(async () => root.render(<I18nProvider><AboutDialog open onOpenChange={() => {}} /></I18nProvider>));
    expect(checkForUpdates).toHaveBeenCalledTimes(2);
  } finally {
    checkForUpdates.mockRestore();
  }
});

test('shows check progress in the About button and restores retry after a failed check', async () => {
  await act(async () => root.render(<I18nProvider><AboutDialog open onOpenChange={() => {}} /></I18nProvider>));
  const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes('Check for updates'));
  if (!button) throw new Error('Expected Check for updates button');
  let requests = 0;
  const startCheck = () => {
    requests += 1;
    useUpdateStore.setState({ checking: true, error: null });
  };
  window.addEventListener('openchamber:check-for-updates', startCheck);
  try {
    await act(async () => button.click());
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.querySelector('[data-spinner]')).not.toBeNull();
    expect(button.querySelector('span[aria-hidden="false"]')?.textContent).toContain('Checking');
    await act(async () => button.click());
    expect(requests).toBe(1);

    await act(async () => useUpdateStore.setState({ checking: false, error: 'Network unavailable' }));
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-busy')).toBe('false');
    expect(button.querySelector('[data-spinner]')).toBeNull();
    expect(button.querySelector('span[aria-hidden="false"]')?.textContent).toContain('Check for updates');
    await act(async () => button.click());
    expect(requests).toBe(2);
  } finally {
    window.removeEventListener('openchamber:check-for-updates', startCheck);
  }
});
