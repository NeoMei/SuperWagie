import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { IntegrationOauthConnectOutput } from '@opencode/client';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  Event: browser.Event, MutationObserver: browser.MutationObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { useI18nStore } = await import('@/lib/i18n/store');
const { opencodeClient } = await import('@/lib/opencode/client');
const { ProviderOAuthMethods } = await import('./ProviderOAuthMethods');
useI18nStore.getState().setLocale('en');
const a = opencodeClient.getScopedSdkClient('/repo/a');
const b = opencodeClient.getScopedSdkClient('/repo/b');
const spies: Array<{ mockRestore: () => void }> = [];
const host = document.createElement('div');
document.body.append(host);
let root = createRoot(host);
let connected = 0;

const attempt = (mode: 'auto' | 'code', attemptID = 'test-attempt'): IntegrationOauthConnectOutput => ({
  location: { directory: '/repo/a' },
  data: { attemptID, url: '', instructions: '', mode, time: { created: 1, expires: 60_001 } },
});
const render = async ({ directory, external = false }: { directory?: string; external?: boolean } = {}) => {
  await act(async () => root.render(
    <I18nProvider>
      <ProviderOAuthMethods integrationId="example" methods={[{ id: 'login', type: external ? 'external' : 'oauth', label: 'Browser login' }]} directory={directory}
        onConnected={() => { connected += 1; }} />
    </I18nProvider>,
  ));
};
const click = async (label: string) => {
  const button = [...host.querySelectorAll('button')].find((node) => node.textContent?.trim() === label);
  if (!button) throw new Error(`Missing button: ${label}`);
  await act(async () => button.click());
};
beforeEach(() => {
  opencodeClient.setDirectory('/repo/a');
  connected = 0;
});
afterEach(async () => {
  await act(async () => root.unmount());
  for (const spy of spies.splice(0)) spy.mockRestore();
  opencodeClient.setDirectory(undefined);
  root = createRoot(host);
});
afterAll(async () => {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
});

test('OAuth status stays in the location that started the attempt after the app changes project', async () => {
  const connect = spyOn(a.integration.oauth, 'connect').mockResolvedValue(attempt('auto'));
  const status = spyOn(a.integration.oauth, 'status').mockResolvedValue({ location: { directory: '/repo/a' }, data: { status: 'complete', time: { created: 1, expires: 60_001 } } });
  const other = spyOn(b.integration.oauth, 'status').mockRejectedValue(new Error('Wrong location'));
  spies.push(connect, status, other);
  await render();
  await click('Connect');
  opencodeClient.setDirectory('/repo/b');
  await render();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 1600)));
  expect(connect).toHaveBeenCalledTimes(1);
  expect(status).toHaveBeenCalledTimes(1);
  expect(other).not.toHaveBeenCalled();
  expect(connected).toBe(1);
});

test('Cancel keeps the attempt location after a project change', async () => {
  const connect = spyOn(a.integration.oauth, 'connect').mockResolvedValue(attempt('code'));
  const cancel = spyOn(a.integration.oauth, 'cancel').mockResolvedValue(undefined);
  const other = spyOn(b.integration.oauth, 'cancel').mockRejectedValue(new Error('Wrong location'));
  spies.push(connect, cancel, other);
  await render();
  await click('Connect');
  opencodeClient.setDirectory('/repo/b');
  await render();
  await click('Cancel');
  expect(cancel).toHaveBeenCalledWith({ integrationID: 'example', attemptID: 'test-attempt' });
  expect(other).not.toHaveBeenCalled();
  expect(connected).toBe(0);
});

test('code completion keeps the attempt location after a project change', async () => {
  const connect = spyOn(a.integration.oauth, 'connect').mockResolvedValue(attempt('code'));
  const complete = spyOn(a.integration.oauth, 'complete').mockResolvedValue(undefined);
  const other = spyOn(b.integration.oauth, 'complete').mockRejectedValue(new Error('Wrong location'));
  spies.push(connect, complete, other);
  await render();
  await click('Connect');
  opencodeClient.setDirectory('/repo/b');
  await render();
  const field = host.querySelector('input');
  const setter = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set;
  if (!field || !setter) throw new Error('Authorization code field missing');
  await act(async () => {
    setter.call(field, 'test-code');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('Complete');
  expect(complete).toHaveBeenCalledWith({ integrationID: 'example', attemptID: 'test-attempt', code: 'test-code' });
  expect(other).not.toHaveBeenCalled();
  expect(connected).toBe(1);
});

test('a connect response arriving after unmount is cancelled', async () => {
  let finish: () => void = () => { throw new Error('No pending connection'); };
  const connect = spyOn(a.integration.oauth, 'connect').mockImplementation(() => new Promise((resolve) => {
    finish = () => resolve(attempt('code'));
  }));
  const cancel = spyOn(a.integration.oauth, 'cancel').mockResolvedValue(undefined);
  spies.push(connect, cancel);
  await render();
  await click('Connect');
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => finish());
  expect(cancel).toHaveBeenCalledWith({ integrationID: 'example', attemptID: 'test-attempt' });
  expect(connected).toBe(0);
});

test('a failed sign-in can start a fresh attempt', async () => {
  const connect = spyOn(a.integration.oauth, 'connect').mockResolvedValue(attempt('code')).mockRejectedValueOnce(new Error('Sign-in service unavailable'));
  const cancel = spyOn(a.integration.oauth, 'cancel').mockResolvedValue(undefined);
  spies.push(connect, cancel);
  await render();
  await click('Connect');
  expect(host.textContent).toContain('Sign-in service unavailable');
  await click('Connect');
  expect(connect).toHaveBeenCalledTimes(2);
  expect(host.querySelector('input')).not.toBeNull();
  await click('Cancel');
});


test('a new OAuth attempt selects the current project after cancellation', async () => {
  const connectA = spyOn(a.integration.oauth, 'connect').mockResolvedValue(attempt('code'));
  const connectB = spyOn(b.integration.oauth, 'connect').mockResolvedValue(attempt('code', 'attempt-b'));
  const cancelA = spyOn(a.integration.oauth, 'cancel').mockResolvedValue(undefined);
  const cancelB = spyOn(b.integration.oauth, 'cancel').mockResolvedValue(undefined);
  spies.push(connectA, connectB, cancelA, cancelB);
  await render();
  await click('Connect');
  opencodeClient.setDirectory('/repo/b');
  await render();
  await click('Cancel');
  await click('Connect');
  expect([connectA.mock.calls.length, connectB.mock.calls.length]).toEqual([1, 1]);
  await click('Cancel');
  expect(cancelB).toHaveBeenCalledWith({ integrationID: 'example', attemptID: 'attempt-b' });
});

test('a new OAuth attempt selects the current project after completion', async () => {
  const cancelA = spyOn(a.integration.oauth, 'cancel').mockResolvedValue(undefined);
  spies.push(cancelA);
  const connectA = spyOn(a.integration.oauth, 'connect').mockResolvedValue(attempt('auto'));
  const statusA = spyOn(a.integration.oauth, 'status').mockResolvedValue({ location: { directory: '/repo/a' }, data: { status: 'complete', time: { created: 1, expires: 60_001 } } });
  const connectB = spyOn(b.integration.oauth, 'connect').mockResolvedValue(attempt('code', 'attempt-b'));
  const cancelB = spyOn(b.integration.oauth, 'cancel').mockResolvedValue(undefined);
  spies.push(connectA, statusA, connectB, cancelB);
  await render();
  await click('Connect');
  opencodeClient.setDirectory('/repo/b');
  await render();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 1600)));
  expect(connected).toBe(1);
  await click('Connect');
  expect([connectA.mock.calls.length, connectB.mock.calls.length]).toEqual([1, 1]);
  await click('Cancel');
});

test('an explicit directory change retires a pending OAuth response without replacing the new attempt', async () => {
  let finish: () => void = () => { throw new Error('No pending connection'); };
  const connectA = spyOn(a.integration.oauth, 'connect').mockImplementation(() => new Promise((resolve) => {
    finish = () => resolve(attempt('code', 'attempt-a'));
  }));
  const connectB = spyOn(b.integration.oauth, 'connect').mockResolvedValue(attempt('code', 'attempt-b'));
  const cancelA = spyOn(a.integration.oauth, 'cancel').mockResolvedValue(undefined);
  const cancelB = spyOn(b.integration.oauth, 'cancel').mockResolvedValue(undefined);
  spies.push(connectA, connectB, cancelA, cancelB);
  await render({ directory: '/repo/a' });
  await click('Connect');
  await render({ directory: '/repo/b' });
  const button = [...host.querySelectorAll('button')].find((node) => node.textContent?.trim() === 'Connect');
  expect(button?.disabled).toBe(false);
  await click('Connect');
  await act(async () => finish());
  expect(cancelA).toHaveBeenCalledWith({ integrationID: 'example', attemptID: 'attempt-a' });
  expect(connected).toBe(0);
  await click('Cancel');
  expect(cancelB).toHaveBeenCalledWith({ integrationID: 'example', attemptID: 'attempt-b' });
});

test('external connects select the current project for each new request', async () => {
  const connectA = spyOn(a.integration.connect, 'external').mockResolvedValue(undefined);
  const connectB = spyOn(b.integration.connect, 'external').mockResolvedValue(undefined);
  spies.push(connectA, connectB);
  await render({ external: true });
  await click('Connect');
  opencodeClient.setDirectory('/repo/b');
  await render({ external: true });
  await click('Connect');
  expect([connectA.mock.calls.length, connectB.mock.calls.length]).toEqual([1, 1]);
  expect(connected).toBe(2);
});

test('a pending external response cannot complete the form after its explicit directory changes', async () => {
  let finish: () => void = () => { throw new Error('No pending connection'); };
  const connectA = spyOn(a.integration.connect, 'external').mockImplementation(() => new Promise((resolve) => {
    finish = () => resolve();
  }));
  const connectB = spyOn(b.integration.connect, 'external').mockResolvedValue(undefined);
  spies.push(connectA, connectB);
  await render({ directory: '/repo/a', external: true });
  await click('Connect');
  await render({ directory: '/repo/b', external: true });
  await click('Connect');
  expect(connected).toBe(1);
  await act(async () => finish());
  expect(connected).toBe(1);
});


test('a pending OAuth attempt keeps its owner across an ambient project change and ordinary rerender', async () => {
  let finish: () => void = () => { throw new Error('No pending connection'); };
  const connectA = spyOn(a.integration.oauth, 'connect').mockImplementation(() => new Promise((resolve) => {
    finish = () => resolve(attempt('code', 'attempt-a'));
  }));
  const connectB = spyOn(b.integration.oauth, 'connect').mockResolvedValue(attempt('code', 'attempt-b'));
  const cancelA = spyOn(a.integration.oauth, 'cancel').mockResolvedValue(undefined);
  const cancelB = spyOn(b.integration.oauth, 'cancel').mockResolvedValue(undefined);
  spies.push(connectA, connectB, cancelA, cancelB);
  await render();
  await click('Connect');
  opencodeClient.setDirectory('/repo/b');
  await render();
  await act(async () => finish());
  expect(cancelA).not.toHaveBeenCalled();
  expect(host.querySelector('input')).not.toBeNull();
  await click('Cancel');
  expect(cancelA).toHaveBeenCalledWith({ integrationID: 'example', attemptID: 'attempt-a' });
  await click('Connect');
  expect(connectB).toHaveBeenCalledTimes(1);
  await click('Cancel');
});

test('an explicit A-to-B-to-A change cannot revive the first pending request', async () => {
  let finish: () => void = () => { throw new Error('No pending connection'); };
  const connect = spyOn(a.integration.oauth, 'connect').mockImplementationOnce(() => new Promise((resolve) => {
    finish = () => resolve(attempt('code', 'old-a'));
  })).mockResolvedValue(attempt('code', 'new-a'));
  const cancel = spyOn(a.integration.oauth, 'cancel').mockResolvedValue(undefined);
  spies.push(connect, cancel);
  await render({ directory: '/repo/a' });
  await click('Connect');
  await render({ directory: '/repo/b' });
  await render({ directory: '/repo/a' });
  await click('Connect');
  await act(async () => finish());
  expect(cancel).toHaveBeenCalledWith({ integrationID: 'example', attemptID: 'old-a' });
  await click('Cancel');
  expect(cancel).toHaveBeenCalledWith({ integrationID: 'example', attemptID: 'new-a' });
  expect(connected).toBe(0);
});
