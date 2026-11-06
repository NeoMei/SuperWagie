import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
const globals = {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  localStorage: browser.localStorage,
  Node: browser.Node,
  Element: browser.Element,
  HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement,
  HTMLTextAreaElement: browser.HTMLTextAreaElement,
  Event: browser.Event,
  FocusEvent: browser.FocusEvent,
  CustomEvent: browser.CustomEvent,
  MutationObserver: browser.MutationObserver,
  ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previousGlobals = Object.keys(globals).map((name) => ({
  name,
  descriptor: Object.getOwnPropertyDescriptor(globalThis, name),
}));
for (const [name, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
Object.assign(window, { __OPENCHAMBER_ELECTRON__: { runtime: 'electron', platform: 'darwin' } });

interface SessionRequest {
  host: string;
  kind: 'gate' | 'confirmation';
  status?: number;
}
interface HeldRequest {
  record: SessionRequest;
  finish: (status: number) => void;
}

const requests: SessionRequest[] = [];
const held: HeldRequest[] = [];
const unexpectedRequests: string[] = [];
let holdGate = false;
let sessionStatus = 200;
let caseNumber = 0;
const transport = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (/^gate-[ab]\.invalid$/.test(url.hostname)) {
    if (url.pathname === '/auth/url-token' && request.method === 'POST') {
      return new Response(null, { status: 404 });
    }
    if (request.method === 'GET') {
      if (url.pathname === '/auth/session' && request.credentials === 'include') {
        const record: SessionRequest = {
          host: url.hostname,
          kind: request.headers.has('Accept') ? 'gate' : 'confirmation',
        };
        requests.push(record);
        const answer = (status: number) => {
          record.status = status;
          return Response.json({ authenticated: status === 200 }, { status });
        };
        if (holdGate && record.kind === 'gate') {
          return new Promise<Response>((resolve) => held.push({ record, finish: (status) => resolve(answer(status)) }));
        }
        return answer(sessionStatus);
      }
      if (url.pathname === '/auth/passkey/status') {
        return Response.json({ enabled: false, hasPasskeys: false, passkeyCount: 0, rpID: null });
      }
      if (url.pathname === '/api/fixture') return new Response(null, { status: 401 });
      if (url.pathname === '/api/config/themes') return Response.json({ themes: [] });
      if (url.pathname === '/api/session-folders') return Response.json({ exists: true, foldersMap: {}, updatedAt: 0 });
    }
  }
  unexpectedRequests.push(`${request.method} ${request.url}`);
  throw new Error(`Unexpected fixture request: ${request.method} ${request.url}`);
});
Object.defineProperty(browser, 'fetch', { configurable: true, value: transport });

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
const { runtimeFetch } = await import('@/lib/runtime-fetch');
const { useAuthSessionStore } = await import('@/lib/runtime-auth-expiry');
const { isDesktopShell } = await import('@/lib/desktop');
const { SessionAuthGate } = await import('./SessionAuthGate');
const { I18nProvider } = await import('@/lib/i18n');
const { useI18nStore } = await import('@/lib/i18n/store');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { installRuntimeEndpointReset } = await import('@/apps/runtimeEndpointReset');
const removeRuntimeReset = installRuntimeEndpointReset();

let root: ReturnType<typeof createRoot> | null = null;
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const until = async (ready: () => boolean) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await act(settle);
    if (ready()) return;
  }
  throw new Error(`Gate fixture timed out: ${JSON.stringify(requests)}`);
};
const switchTo = (instance: 'a' | 'b', clientToken = `dummy-${instance}`) => switchRuntimeEndpoint({
  apiBaseUrl: `http://gate-${instance}.invalid`,
  runtimeKey: `gate-${caseNumber}-${instance}`,
  clientToken,
});
const workspace = () => document.querySelector('[data-workspace]');
const banner = () => document.querySelector('[role="alert"]');
const passwordInput = () => document.querySelector('input[type="password"]');
const authenticatedRead = (host: string, from = 0) => requests.slice(from)
  .some((request) => request.host === host && request.kind === 'gate' && request.status === 200);

beforeEach(async () => {
  caseNumber += 1;
  requests.length = 0;
  held.length = 0;
  unexpectedRequests.length = 0;
  holdGate = false;
  sessionStatus = 200;
  useAuthSessionStore.getState().markAuthenticated();
  useI18nStore.setState({ locale: 'en' });
  await act(async () => { switchTo('a'); await settle(); });
  const container = document.createElement('div');
  document.body.append(container);
  const mountedRoot = createRoot(container);
  root = mountedRoot;
  await act(async () => {
    mountedRoot.render(createElement(I18nProvider, null,
      createElement(ThemeSystemProvider, null,
        createElement(SessionAuthGate, { deferRuntimeBootstrap: true, children:
          createElement('div', { 'data-workspace': true }, 'Workspace fixture') }))));
  });
  await until(() => workspace() !== null);
  expect(isDesktopShell()).toBe(true);
  expect(authenticatedRead('gate-a.invalid')).toBe(true);
  expect(banner()).toBeNull();
});

afterEach(async () => {
  holdGate = false;
  await act(async () => {
    for (const pending of held) {
      if (pending.record.status === undefined) pending.finish(200);
    }
    await settle();
    root?.unmount();
    root = null;
  });
  document.body.innerHTML = '';
  useAuthSessionStore.getState().markAuthenticated();
  expect(unexpectedRequests).toEqual([]);
});

afterAll(async () => {
  removeRuntimeReset();
  transport.mockRestore();
  await browser.happyDOM.close();
  for (const { name, descriptor } of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const beginReauthentication = async () => {
  sessionStatus = 401;
  await act(async () => { await runtimeFetch('/api/fixture'); });
  await until(() => banner() !== null);
  expect(useAuthSessionStore.getState().state).toBe('expired');
  expect(workspace()).not.toBeNull();
  expect(requests.filter((request) => request.kind === 'confirmation')).toEqual([
    { host: 'gate-a.invalid', kind: 'confirmation', status: 401 },
  ]);
  const login = banner()?.querySelector('button');
  if (!login) throw new Error('Missing expiry banner login action');
  sessionStatus = 200;
  holdGate = true;
  await act(async () => { login.click(); });
  await until(() => held.length === 1);
  holdGate = false;
  expect(useAuthSessionStore.getState().state).toBe('reauthenticating');
  expect(workspace()).not.toBeNull();
  expect(banner()).toBeNull();
};

const finishOldRead = async (status: number) => {
  const pending = held[0];
  if (!pending) throw new Error('Missing held Gate status read');
  await act(async () => { pending.finish(status); await settle(); });
};

const switchAndAuthenticate = async (instance: 'a' | 'b', clientToken?: string) => {
  const before = requests.length;
  await act(async () => { switchTo(instance, clientToken); });
  await until(() => authenticatedRead(`gate-${instance}.invalid`, before) && workspace() !== null);
  expect(useAuthSessionStore.getState().state).toBe('ok');
};

test('current banner reauthentication success preserves the workspace', async () => {
  await beginReauthentication();
  await finishOldRead(200);
  expect(workspace()).not.toBeNull();
  expect(useAuthSessionStore.getState().state).toBe('ok');
  expect(banner()).toBeNull();
});

test('current banner reauthentication 401 locks the Gate', async () => {
  await beginReauthentication();
  await finishOldRead(401);
  expect(workspace()).toBeNull();
  expect(passwordInput()).not.toBeNull();
});

test('switching to B discards the old A banner reauthentication 401', async () => {
  await beginReauthentication();
  await switchAndAuthenticate('b');
  await finishOldRead(401);
  expect(workspace()).not.toBeNull();
  expect(useAuthSessionStore.getState().state).toBe('ok');
  expect(banner()).toBeNull();
});

test('returning to authenticated A discards a previous A visit reauthentication 401', async () => {
  await beginReauthentication();
  await switchAndAuthenticate('b');
  await switchAndAuthenticate('a');
  await finishOldRead(401);
  expect(workspace()).not.toBeNull();
  expect(passwordInput()).toBeNull();
  expect(useAuthSessionStore.getState().state).toBe('ok');
});

test('same-instance credential refresh preserves the held Gate status ownership', async () => {
  await beginReauthentication();
  await switchAndAuthenticate('a', 'dummy-a-renewed');
  await finishOldRead(401);
  expect(workspace()).toBeNull();
  expect(passwordInput()).not.toBeNull();
});
