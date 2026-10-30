import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';

const browser = new Window({ url: 'http://localhost/' });
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser, document: browser.document, navigator: browser.navigator,
  HTMLElement: browser.HTMLElement, HTMLInputElement: browser.HTMLInputElement,
  Element: browser.Element, Node: browser.Node, Event: browser.Event,
  CustomEvent: browser.CustomEvent, MutationObserver: browser.MutationObserver,
  ResizeObserver: browser.ResizeObserver, localStorage: browser.localStorage,
  sessionStorage: browser.sessionStorage, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  getComputedStyle: browser.getComputedStyle.bind(browser),
})) {
  savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true });
}
Object.defineProperty(browser, '__OPENCHAMBER_ELECTRON__', { value: { runtime: 'electron' } });
const nativeWrites: string[] = [];
Object.defineProperty(browser, '__OPENCHAMBER_DESKTOP__', { value: {
  invoke: async (command: string) => {
    if (command === 'desktop_hosts_get') return { hosts: [], defaultHostId: null, localOrigin: null };
    if (command === 'desktop_ssh_instances_get') return { instances: [] };
    if (command === 'desktop_ssh_status' || command === 'desktop_ssh_import_hosts') return [];
    if (command === 'desktop_install_id_get') return 'recovery-fixture';
    if (command === 'desktop_local_client_token_get') return '';
    if (command === 'desktop_set_locale') return null;
    nativeWrites.push(command);
    throw new Error(`Unexpected native operation: ${command}`);
  },
  listen: async () => () => {},
} });
const requests: string[] = [];
const fetchFixture = spyOn(globalThis, 'fetch').mockImplementation(async input => {
  const pathname = new URL(input instanceof Request ? input.url : String(input), 'http://localhost').pathname;
  requests.push(pathname);
  if (pathname === '/api/platform-account/session') return Response.json({ status: 'signed-out' });
  if (pathname === '/api/platform-account/auth-methods') return Response.json({ passwordLogin: true, registration: true, browserLogin: false });
  if (pathname === '/api/config/settings') return Response.json({});
  throw new Error(`Unexpected recovery request: ${pathname}`);
});
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { useI18nStore } = await import('@/lib/i18n/store');
const { PlatformAccountGate } = await import('@/components/auth/PlatformAccountGate');
const { DesktopHostSwitcherDialog } = await import('./DesktopHostSwitcher');
const { useUIStore } = await import('@/stores/useUIStore');
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  useI18nStore.getState().setLocale('en');
  useUIStore.getState().setSettingsDialogOpen(false);
  requests.length = 0;
  nativeWrites.length = 0;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
afterAll(async () => {
  fetchFixture.mockRestore();
  await browser.happyDOM.close();
  for (const [name, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});
const button = (label: string) => {
  const element = [...document.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent?.trim() === label);
  if (!element) throw new Error(`Missing button: ${label}`);
  return element;
};
const click = (label: string) => act(async () => { button(label).click(); });
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });

test('opens existing connection settings while the authenticated app remains unmounted', async () => {
  await act(async () => root.render(
    <I18nProvider><PlatformAccountGate><main>Authenticated workspace</main></PlatformAccountGate></I18nProvider>,
  ));
  expect(host.textContent).not.toContain('Authenticated workspace');
  await click('Switch instance');
  await click('Add instance');
  await settle();
  expect(document.body.textContent).toContain('Remote instances');
  expect(useUIStore.getState().isSettingsDialogOpen).toBe(false);
  await click('Add server');
  const field = document.querySelector<HTMLInputElement>('input[placeholder="https://host:port"]');
  if (!field) throw new Error('Missing existing server URL field');
  await act(async () => {
    Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set?.call(field, 'https://remote.example.test');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(field.value).toBe('https://remote.example.test');
  expect(host.textContent).not.toContain('Authenticated workspace');
  expect(document.body.textContent).not.toContain('Trusted devices');
  await click('Cancel');
  const close = document.querySelector<HTMLButtonElement>('[data-slot="dialog-close"]');
  if (!close) throw new Error('Missing existing dialog close control');
  await act(async () => close.click());
  await settle();
  expect(document.body.textContent).not.toContain('Remote instances');
  await click('Switch instance');
  await click('Add instance');
  await settle();
  expect(document.body.textContent).toContain('Remote instances');
  await act(async () => window.dispatchEvent(new CustomEvent('openchamber:runtime-endpoint-changed')));
  await settle();
  expect(document.body.textContent).not.toContain('Remote instances');
  expect(nativeWrites).toEqual([]);
  expect(requests.every(path => ['/api/platform-account/session', '/api/platform-account/auth-methods', '/api/config/settings'].includes(path))).toBe(true);
});

test('keeps the authenticated host switcher on the normal Settings window path', async () => {
  await act(async () => root.render(<I18nProvider><DesktopHostSwitcherDialog open onOpenChange={() => {}} /></I18nProvider>));
  await click('Add instance');
  expect(useUIStore.getState().isSettingsDialogOpen).toBe(true);
  expect(useUIStore.getState().settingsPage).toBe('remote-instances');
  expect(document.body.textContent).not.toContain('Add server');
});
