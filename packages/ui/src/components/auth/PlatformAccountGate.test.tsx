import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import type { PlatformIdentitySession } from '@/lib/platformAccount';

const browser = new Window({ url: 'http://localhost/' });
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement,
  Element: browser.Element,
  Event: browser.Event,
  CustomEvent: browser.CustomEvent,
  localStorage: browser.localStorage,
  sessionStorage: browser.sessionStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true });
}

const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { useI18nStore } = await import('@/lib/i18n/store');
const { PlatformAccountGate } = await import('./PlatformAccountGate');
const { logoutPlatformAccount } = await import('@/lib/platformAccount');
const { changePlatformPassword } = await import('@/lib/platformProfile');
const { switchRuntimeEndpoint } = await import('@/lib/runtime-switch');

let root: Root;
let host: HTMLDivElement;
let response: PlatformIdentitySession;
let readResponse: (() => Promise<Response>) | null;
const passwordWrites: string[] = [];
const fetchFixture = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
  const path = String(input instanceof Request ? input.url : input);
  if (path.endsWith('/api/platform-account/session')) return readResponse ? readResponse() : Response.json(response);
  if (path.endsWith('/api/platform-account/password')) {
    passwordWrites.push(String(init?.body));
    return Response.json({ status: 'signed-out' });
  }
  if (path.endsWith('/api/platform-account/logout')) return Response.json({ status: 'signed-out' });
  if (path.endsWith('/api/platform-account/password-login')) return Response.json(signedIn);
  if (path.endsWith('/api/platform-account/auth-methods')) return Response.json({ passwordLogin: true, registration: true, browserLogin: false });
  throw new Error(`Unexpected request: ${path}`);
});

const signedIn = {
  status: 'signed-in',
  user: { id: 'user-a', name: 'Alice', email: 'alice@example.test' },
  accounts: [{ id: 'account-a', kind: 'personal', name: 'Alice', role: 'owner' }],
  accountId: 'account-a',
  expiresAt: '2099-01-01T00:00:00.000Z',
  membership: [],
  credits: { available: '0', reserved: '0' },
  consoleUrl: null,
  modelService: 'unavailable',
} as const;

beforeEach(async () => {
  useI18nStore.getState().setLocale('en');
  response = { status: 'signed-out' };
  readResponse = null;
  passwordWrites.length = 0;
  localStorage.clear();
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

const render = async () => {
  await act(async () => {
    root.render(<I18nProvider><PlatformAccountGate><main>Application mounted</main></PlatformAccountGate></I18nProvider>);
  });
};

test('holds the application behind account sign-in', async () => {
  await render();
  expect(host.textContent).not.toContain('Application mounted');
  expect(host.textContent).toContain('Sign in to SuperWagie');
});

test('remembers the username after gate login and clears the password on sign-out', async () => {
  switchRuntimeEndpoint({ apiBaseUrl: 'http://gate-username.test', runtimeKey: 'test-gate-username' });
  await render();
  const fill = async (id: string, value: string) => {
    const field = host.querySelector<HTMLInputElement>(`#${id}`);
    if (!field) throw new Error(`Missing input ${id}`);
    await act(async () => { Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set?.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); });
  };
  await fill('unihub-username', 'alice');
  await fill('unihub-password', 'SyntheticPassword9!');
  await act(async () => { host.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  expect(host.textContent).toContain('Application mounted');
  await act(async () => { await logoutPlatformAccount(); });
  expect(host.querySelector<HTMLInputElement>('#unihub-username')?.value).toBe('alice');
  expect(host.querySelector<HTMLInputElement>('#unihub-password')?.value).toBe('');
});

test('clears gate credentials when switching to another signed-out runtime', async () => {
  switchRuntimeEndpoint({ apiBaseUrl: 'http://gate-a.test', runtimeKey: 'test-gate-a' });
  await render();
  await act(async () => {
    for (const [id, value] of [['unihub-username', 'alice'], ['unihub-password', 'SyntheticPassword9!']]) {
      const field = host.querySelector<HTMLInputElement>(`#${id}`);
      if (!field) throw new Error(`Missing input ${id}`);
      Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set?.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await act(async () => switchRuntimeEndpoint({ apiBaseUrl: 'http://gate-b.test', runtimeKey: 'test-gate-b' }));
  expect(host.querySelector<HTMLInputElement>('#unihub-username')?.value).toBe('');
  expect(host.querySelector<HTMLInputElement>('#unihub-password')?.value).toBe('');
});

test('mounts the application after the account reports a signed-in session', async () => {
  response = signedIn;
  await render();
  expect(host.textContent).toContain('Application mounted');
});

test('keeps the application blocked when account sign-in is not configured', async () => {
  response = { status: 'unconfigured' };
  await render();
  expect(host.textContent).not.toContain('Application mounted');
  expect(host.textContent).toContain('Account login is not configured');
});

test('blocks unsupported runtimes without checking platform identity', async () => {
  readResponse = async () => { throw new Error('Unsupported runtime must not read identity'); };
  await act(async () => {
    root.render(<I18nProvider><PlatformAccountGate unsupported><main>Application mounted</main></PlatformAccountGate></I18nProvider>);
  });
  expect(host.textContent).not.toContain('Application mounted');
  expect(host.textContent).toContain('not supported');
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

test('does not mount the application while the account read is pending', async () => {
  let complete: (response: Response) => void = () => { throw new Error('Missing read'); };
  readResponse = () => new Promise<Response>((resolve) => { complete = resolve; });
  await render();
  expect(host.textContent).not.toContain('Application mounted');
  await act(async () => complete(Response.json(signedIn)));
  expect(host.textContent).toContain('Application mounted');
});

test('rejects an already expired account before mounting the application', async () => {
  response = { ...signedIn, expiresAt: new Date(Date.now() - 1).toISOString() };
  await render();
  expect(host.textContent).not.toContain('Application mounted');
  expect(host.textContent).toContain('Sign in to SuperWagie');
});

test('unmounts the application when the known session expires', async () => {
  response = { ...signedIn, expiresAt: new Date(Date.now() + 70).toISOString() };
  await render();
  expect(host.textContent).toContain('Application mounted');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 90)); });
  expect(host.textContent).not.toContain('Application mounted');
});

test('unmounts the application immediately when its account is signed out', async () => {
  response = signedIn;
  await render();
  await act(async () => { await logoutPlatformAccount(); });
  expect(host.textContent).not.toContain('Application mounted');
});

test('returns to the account sign-in gate after a successful password change', async () => {
  response = signedIn;
  await render();
  await act(async () => { await changePlatformPassword({ currentPassword: 'OriginalPassword123', newPassword: 'ChangedPassword123' }); });
  expect(passwordWrites).toEqual([JSON.stringify({ currentPassword: 'OriginalPassword123', newPassword: 'ChangedPassword123' })]);
  expect(host.textContent).not.toContain('Application mounted');
  expect(host.textContent).toContain('Sign in to SuperWagie');
});

test('drops the previous runtime account response after a runtime switch', async () => {
  let complete: (response: Response) => void = () => { throw new Error('Missing read'); };
  readResponse = () => new Promise<Response>((resolve) => { complete = resolve; });
  await render();
  readResponse = null;
  await act(async () => window.dispatchEvent(new window.CustomEvent('openchamber:runtime-endpoint-changed')));
  await act(async () => complete(Response.json(signedIn)));
  expect(host.textContent).not.toContain('Application mounted');
});

test('closes the application when the active session check fails on focus', async () => {
  response = signedIn;
  await render();
  readResponse = async () => new Response(null, { status: 503 });
  await act(async () => window.dispatchEvent(new window.Event('focus')));
  expect(host.textContent).not.toContain('Application mounted');
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
});

test('keeps the sign-in form available after a stale session configuration error', async () => {
  response = signedIn;
  await render();
  readResponse = async () => Response.json({ error: 'platform_session_changed' }, { status: 409 });
  await act(async () => window.dispatchEvent(new window.Event('focus')));
  expect(host.textContent).not.toContain('Application mounted');
  expect(host.textContent).toContain('Username');
});
