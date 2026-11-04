import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser, document: browser.document, navigator: browser.navigator,
  HTMLElement: browser.HTMLElement, HTMLInputElement: browser.HTMLInputElement,
  Element: browser.Element, Node: browser.Node, Event: browser.Event,
  CustomEvent: browser.CustomEvent, MutationObserver: browser.MutationObserver,
  ResizeObserver: browser.ResizeObserver, localStorage: browser.localStorage,
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  getComputedStyle: browser.getComputedStyle.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
})) {
  savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true });
}
window.__OPENCHAMBER_ELECTRON__ = { runtime: 'electron' };
window.__OPENCHAMBER_LOCAL_ORIGIN__ = 'http://localhost';

const { createRoot } = await import('react-dom/client');
const { I18nProvider, useI18nStore } = await import('@/lib/i18n');
const { useUpdateStore } = await import('@/stores/useUpdateStore');
const { toast } = await import('@/components/ui');
const device = await import('@/lib/device');
const { AboutSettings } = await import('./AboutSettings');

let root: Root;
let host: HTMLDivElement;
let nativeError: Error | null = null;
let readOpenCode: (() => Promise<Response>) | null = null;
let restoreDevice: (() => void) | null = null;
const fetchFixture = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
  const path = new URL(input instanceof Request ? input.url : String(input), browser.location.href).pathname;
  if (path === '/api/system/info') return Response.json({ openchamberVersion: '2.7.54' });
  if (path === '/api/opencode/upgrade-status') return readOpenCode
    ? readOpenCode()
    : Response.json({ available: false, currentVersion: '2.2.5', upgrade: { supported: true } });
  if (path === '/api/openchamber/update-check') return Response.json({ available: false, currentVersion: '2.7.54' });
  throw new Error(`Unexpected request: ${path}`);
});

beforeEach(() => {
  useI18nStore.getState().setLocale('en');
  useUpdateStore.getState().reset();
  readOpenCode = null;
  nativeError = null;
  Object.defineProperty(window, '__OPENCHAMBER_DESKTOP__', {
    configurable: true,
    value: {
      invoke: async (command: string) => {
        if (command === 'desktop_set_locale') return null;
        if (command !== 'desktop_check_for_updates') throw new Error(`Unexpected command: ${command}`);
        if (nativeError) throw nativeError;
        return { available: false, currentVersion: '2.7.54' };
      },
    },
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  restoreDevice?.();
  restoreDevice = null;
  host.remove();
  useUpdateStore.getState().reset();
  toast.dismiss();
});

afterAll(async () => {
  fetchFixture.mockRestore();
  await browser.happyDOM.close();
  for (const [name, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const render = async () => {
  await act(async () => root.render(<I18nProvider><AboutSettings /></I18nProvider>));
};

const checkButton = () => {
  const button = [...host.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes('Check for updates'));
  if (!button) throw new Error('Expected Check for updates button');
  return button;
};

const waitForFeedback = async () => {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 850)); });
};

const waitForRetry = async () => {
  const deadline = Date.now() + 3000;
  while (checkButton().disabled && Date.now() < deadline) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  }
  expect(checkButton().disabled).toBe(false);
};

test('keeps the clicked button busy until the engine check also settles', async () => {
  await render();
  let resolveEngineCheck: (response: Response) => void = () => { throw new Error('Expected a pending engine check'); };
  const engineCheck = new Promise<Response>((resolve) => {
    resolveEngineCheck = resolve;
  });
  readOpenCode = () => engineCheck;
  const previousToasts = toast.getHistory().length;
  await act(async () => checkButton().click());
  expect(checkButton().disabled).toBe(true);
  expect(checkButton().getAttribute('aria-busy')).toBe('true');
  expect(checkButton().querySelector('[data-spinner]')).not.toBeNull();
  await waitForFeedback();
  expect(useUpdateStore.getState().checking).toBe(false);
  expect(checkButton().disabled).toBe(true);
  expect(toast.getHistory()).toHaveLength(previousToasts);

  await act(async () => resolveEngineCheck(Response.json({ available: false, currentVersion: '2.2.5', upgrade: { supported: true } })));
  await waitForRetry();
  expect(checkButton().querySelector('[data-spinner]')).toBeNull();
  expect(toast.getHistory()).toHaveLength(previousToasts + 1);
});

test('does not announce a background check as a manual check', async () => {
  await render();
  const previousToasts = toast.getHistory().length;
  await act(async () => useUpdateStore.setState({ checking: true }));
  expect(checkButton().disabled).toBe(true);
  await act(async () => useUpdateStore.setState({ checking: false }));
  await waitForRetry();
  expect(toast.getHistory()).toHaveLength(previousToasts);
});

test('keeps an available update action in place while checking again', async () => {
  useUpdateStore.setState({
    available: true,
    info: { available: true, currentVersion: '2.7.54', version: '2.7.55' },
  });
  await render();
  const updateButton = [...host.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes('Update'));
  if (!updateButton) throw new Error('Expected update action');
  await act(async () => useUpdateStore.setState({ checking: true }));
  expect(updateButton.isConnected).toBe(true);
  expect(updateButton.disabled).toBe(true);
  expect(checkButton().disabled).toBe(true);
  await act(async () => useUpdateStore.setState({ checking: false }));
  await waitForRetry();
  expect(updateButton.isConnected).toBe(true);
  expect(updateButton.disabled).toBe(false);
});

test('keeps a failed check retryable in the mobile layout', async () => {
  const deviceFixture = spyOn(device, 'useDeviceInfo');
  deviceFixture.mockReturnValue({
    isMobile: true, isTablet: false, isDesktop: false, deviceType: 'mobile',
    screenWidth: 390, breakpoint: 'xs', hasTouchInput: true, hasTouchOnlyPointer: true,
  });
  restoreDevice = () => deviceFixture.mockRestore();
  await render();
  const previousToasts = toast.getHistory().length;
  nativeError = new Error('Network unavailable');
  await act(async () => checkButton().click());
  await waitForRetry();
  expect(host.textContent).toContain('Network unavailable');
  expect(toast.getHistory()).toHaveLength(previousToasts);

  nativeError = null;
  await act(async () => checkButton().click());
  expect(checkButton().disabled).toBe(true);
  expect(checkButton().querySelector('[data-spinner]')).not.toBeNull();
  await waitForRetry();
  expect(host.textContent).not.toContain('Network unavailable');
});
