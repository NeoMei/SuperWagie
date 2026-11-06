import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import { clearRuntimeAuthCredentialProvider } from './runtime-auth';
import {
  installAuthSessionFocusWatch,
  observeRuntimeAuthResponse,
  useAuthSessionStore,
  waitForAuthSession,
} from './runtime-auth-expiry';
import { runtimeFetch } from './runtime-fetch';
import { switchRuntimeEndpoint } from './runtime-switch';

const browser = new Window({ url: 'https://expiry-a.invalid' });
const previousGlobals = ['window', 'document', 'CustomEvent'].map((name) => ({
  name,
  descriptor: Object.getOwnPropertyDescriptor(globalThis, name),
}));
Object.defineProperties(globalThis, {
  window: { configurable: true, value: browser },
  document: { configurable: true, value: browser.document },
  CustomEvent: { configurable: true, value: browser.CustomEvent },
});

type Instance = 'a' | 'b';
interface Confirmation {
  host: string;
  authorization: string | null;
  finish: (status: number) => void;
  fail: () => void;
}

let now = Date.now();
let caseNumber = 0;
const clock = spyOn(Date, 'now').mockImplementation(() => now);
const confirmations: Confirmation[] = [];
const heldHosts = new Set<string>();
const sessionStatuses = new Map<string, number>();
const unexpectedRequests: string[] = [];
const transport = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (/^expiry-[ab]\.invalid$/.test(url.hostname)) {
    if (url.pathname === '/auth/url-token' && request.method === 'POST') {
      return new Response(null, { status: 404 });
    }
    if (url.pathname === '/api/fixture' && request.method === 'GET') {
      return new Response(null, { status: 401 });
    }
    if (url.pathname === '/auth/session' && request.method === 'GET' && request.credentials === 'include') {
      return new Promise<Response>((resolve, reject) => {
        const confirmation = {
          host: url.hostname,
          authorization: request.headers.get('authorization'),
          finish: (status: number) => resolve(new Response(null, { status })),
          fail: () => reject(new Error('Fixture offline')),
        };
        confirmations.push(confirmation);
        if (!heldHosts.has(url.hostname)) confirmation.finish(sessionStatuses.get(url.hostname) ?? 200);
      });
    }
  }
  unexpectedRequests.push(request.url);
  throw new Error(`Unexpected fixture request: ${request.method} ${request.url}`);
});

const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};
const switchTo = (instance: Instance, token = `dummy-${instance}`) => switchRuntimeEndpoint({
  apiBaseUrl: `https://expiry-${instance}.invalid`,
  runtimeKey: `expiry-${caseNumber}-${instance}`,
  clientToken: token,
});
const forInstance = (instance: Instance) => confirmations.filter(({ host }) => host === `expiry-${instance}.invalid`);
const confirmationAt = (instance: Instance, index = 0) => {
  const confirmation = forInstance(instance)[index];
  if (!confirmation) throw new Error(`Missing confirmation ${instance} ${index}`);
  return confirmation;
};
const suspect = async () => {
  await runtimeFetch('/api/fixture');
  await settle();
};
const holdConfirmation = async (instance: Instance) => {
  heldHosts.add(`expiry-${instance}.invalid`);
  await suspect();
  return confirmationAt(instance);
};
const focus = () => browser.dispatchEvent(new browser.Event('focus'));
const visibility = () => browser.document.dispatchEvent(new browser.Event('visibilitychange'));

beforeEach(async () => {
  caseNumber += 1;
  now += 60_000;
  confirmations.length = 0;
  heldHosts.clear();
  sessionStatuses.clear();
  useAuthSessionStore.getState().markAuthenticated();
  switchTo('a');
  await settle();
});

afterEach(async () => {
  for (const confirmation of confirmations) confirmation.finish(200);
  await settle();
  useAuthSessionStore.getState().markAuthenticated();
  expect(unexpectedRequests).toEqual([]);
});

afterAll(async () => {
  clearRuntimeAuthCredentialProvider();
  transport.mockRestore();
  clock.mockRestore();
  for (const { name, descriptor } of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  await browser.happyDOM.close();
});

test('a current 401 confirmation expires the session and pauses waiters', async () => {
  sessionStatuses.set('expiry-a.invalid', 401);
  await suspect();
  expect(useAuthSessionStore.getState().state).toBe('expired');
  let resumed = false;
  const abort = new AbortController();
  const waiting = waitForAuthSession(abort.signal).then(() => { resumed = true; });
  await settle();
  expect(resumed).toBe(false);
  useAuthSessionStore.getState().markAuthenticated();
  await waiting;
  expect(resumed).toBe(true);
});

test('a current successful confirmation keeps provider-like 401s from expiring the session', async () => {
  await suspect();
  expect(forInstance('a')).toHaveLength(1);
  expect(useAuthSessionStore.getState().state).toBe('ok');
});

test('transport failure preserves current authentication and releases the pending confirmation', async () => {
  const pending = await holdConfirmation('a');
  pending.fail();
  await settle();
  expect(useAuthSessionStore.getState().state).toBe('ok');
  now += 15_000;
  await suspect();
  expect(forInstance('a')).toHaveLength(2);
});

test('same-instance suspicion bursts share one confirmation and keep their throttle', async () => {
  const pending = await holdConfirmation('a');
  await Promise.all([suspect(), suspect(), suspect()]);
  expect(forInstance('a')).toHaveLength(1);
  now += 15_000;
  await suspect();
  expect(forInstance('a')).toHaveLength(1);
  pending.finish(200);
  await settle();
  now += 14_999;
  await suspect();
  expect(forInstance('a')).toHaveLength(1);
  now += 1;
  await suspect();
  expect(forInstance('a')).toHaveLength(2);
});

test('normal auth routes and responses do not trigger confirmations', async () => {
  for (const path of ['/auth/session', '/api/client-auth/redeem', '/health', 'invalid-url', 'https://expiry-a.invalid/auth/session']) {
    observeRuntimeAuthResponse(path, 401);
  }
  for (const status of [200, 403, 429, 500]) observeRuntimeAuthResponse('/api/fixture', status);
  await settle();
  expect(confirmations).toHaveLength(0);
  observeRuntimeAuthResponse('https://expiry-a.invalid/api/fixture', 401);
  await settle();
  expect(forInstance('a')).toHaveLength(1);
});

for (const revisitA of [false, true]) {
  test(`retirement before the deferred import prevents confirmation dispatch, revisit A=${revisitA}`, async () => {
    observeRuntimeAuthResponse('/api/fixture', 401);
    switchTo('b');
    if (revisitA) switchTo('a');
    await settle();
    expect(confirmations).toHaveLength(0);
    await suspect();
    expect(forInstance(revisitA ? 'a' : 'b')).toHaveLength(1);
  });

  test(`an issued A 401 cannot expire the current runtime, revisit A=${revisitA}`, async () => {
    const old = await holdConfirmation('a');
    switchTo('b');
    if (revisitA) switchTo('a');
    old.finish(401);
    await settle();
    expect(useAuthSessionStore.getState().state).toBe('ok');
    expect(confirmations).toHaveLength(1);
  });
}

test('an issued old success cannot clear expiry confirmed by the current instance', async () => {
  const old = await holdConfirmation('a');
  switchTo('b');
  sessionStatuses.set('expiry-b.invalid', 401);
  await suspect();
  expect(forInstance('b')).toHaveLength(1);
  expect(useAuthSessionStore.getState().state).toBe('expired');
  old.finish(200);
  await settle();
  expect(useAuthSessionStore.getState().state).toBe('expired');
});

for (const outcome of ['resolve', 'reject'] as const) {
  test(`an old A ${outcome} finalizer cannot release B's pending confirmation`, async () => {
    const old = await holdConfirmation('a');
    switchTo('b');
    const current = await holdConfirmation('b');
    if (outcome === 'resolve') old.finish(200);
    else old.fail();
    await settle();
    now += 16_000;
    await suspect();
    expect(forInstance('b')).toHaveLength(1);
    expect(useAuthSessionStore.getState().state).toBe('ok');
    current.finish(401);
    await settle();
    expect(useAuthSessionStore.getState().state).toBe('expired');
  });
}

test('a completed A throttle does not suppress B confirmation', async () => {
  await suspect();
  switchTo('b');
  sessionStatuses.set('expiry-b.invalid', 401);
  await suspect();
  expect(forInstance('a')).toHaveLength(1);
  expect(forInstance('b')).toHaveLength(1);
  expect(useAuthSessionStore.getState().state).toBe('expired');
});

test('same-instance credential refresh keeps the issued confirmation and its throttle', async () => {
  const current = await holdConfirmation('a');
  switchTo('a', 'dummy-renewed');
  await suspect();
  expect(forInstance('a')).toHaveLength(1);
  expect(current.authorization).toBe('Bearer dummy-a');
  current.finish(401);
  await settle();
  expect(useAuthSessionStore.getState().state).toBe('expired');
});

test('focus and visibility share the window interval and coalesce with current confirmation', async () => {
  installAuthSessionFocusWatch();
  installAuthSessionFocusWatch();
  now += 299_999;
  focus();
  visibility();
  await settle();
  expect(confirmations).toHaveLength(0);
  now += 1;
  heldHosts.add('expiry-a.invalid');
  focus();
  visibility();
  await settle();
  expect(forInstance('a')).toHaveLength(1);
  now += 300_000;
  focus();
  visibility();
  await suspect();
  expect(forInstance('a')).toHaveLength(1);
  confirmationAt('a').finish(200);
  await settle();
  now += 299_999;
  focus();
  visibility();
  await settle();
  expect(forInstance('a')).toHaveLength(1);
  now += 1;
  visibility();
  focus();
  await settle();
  expect(forInstance('a')).toHaveLength(2);
});

test('focus can confirm B while A is held and switching keeps the window interval', async () => {
  installAuthSessionFocusWatch();
  now += 300_000;
  focus();
  await settle();
  expect(forInstance('a')).toHaveLength(1);
  confirmations.length = 0;
  now += 15_000;
  const old = await holdConfirmation('a');
  switchTo('b');
  focus();
  visibility();
  await settle();
  expect(forInstance('b')).toHaveLength(0);
  now += 300_000;
  heldHosts.add('expiry-b.invalid');
  focus();
  visibility();
  await settle();
  expect(forInstance('b')).toHaveLength(1);
  old.finish(401);
  await settle();
  expect(useAuthSessionStore.getState().state).toBe('ok');
  now += 16_000;
  await suspect();
  expect(forInstance('b')).toHaveLength(1);
  confirmationAt('b').finish(401);
  await settle();
  expect(useAuthSessionStore.getState().state).toBe('expired');
  now += 300_000;
  focus();
  visibility();
  await settle();
  expect(forInstance('b')).toHaveLength(1);
});
