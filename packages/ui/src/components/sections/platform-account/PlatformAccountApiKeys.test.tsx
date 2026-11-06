import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import type { PlatformAccountKeySetupState } from '@/lib/platformApiKeys';

const browser = new Window({ url: 'http://localhost/' });
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, Event: browser.Event, CustomEvent: browser.CustomEvent, localStorage: browser.localStorage, IS_REACT_ACT_ENVIRONMENT: true })) {
  savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true });
}
const emptyState = (accountId = 'account-a'): PlatformAccountKeySetupState => ({ accountId, enterpriseMode: false, activation: null });
const readyState = (accountId = 'account-a'): PlatformAccountKeySetupState => ({
  accountId, enterpriseMode: false,
  activation: {
    operationId: 'activation-operation', status: 'ready', stage: 'test',
    key: { id: 'credential-record-id', last4: 'A7q9', createdAt: '2026-11-06T00:00:00Z', expiresAt: null },
    modelId: 'superwagie-chat', connectionId: 'managed-connection', providerId: 'superwagie',
    test: { status: 'verified', testedAt: '2026-11-06T00:01:00Z', errorCode: null },
    testRunId: null, tests: [{ id: 'account-chat', purpose: 'agent', modelId: 'superwagie-chat', status: 'verified', applied: true, testedAt: '2026-11-06T00:01:00Z', errorCode: null }],
    errorCode: null, actions: ['retest'],
  },
});
const failedState = (stage: 'configure' | 'test'): PlatformAccountKeySetupState => {
  const result = readyState();
  if (!result.activation) throw new Error('Missing activation fixture');
  result.activation.status = 'failed'; result.activation.stage = stage;
  result.activation.errorCode = stage === 'test' ? 'model_configuration_provider_unreachable' : 'model_configuration_write_failed';
  result.activation.test = stage === 'test' ? { status: 'failed', testedAt: '2026-11-06T00:01:00Z', errorCode: 'model_configuration_provider_unreachable' } : null;
  result.activation.actions = stage === 'test' ? ['retest'] : ['resume'];
  if (stage === 'configure') { result.activation.connectionId = null; result.activation.providerId = null; }
  return result;
};
const runningState = (stage: 'issue' | 'configure' | 'test'): PlatformAccountKeySetupState => {
  const result = readyState();
  if (!result.activation) throw new Error('Missing activation fixture');
  result.activation.stage = stage;
  result.activation.status = stage === 'issue' ? 'issuing' : stage === 'configure' ? 'configuring' : 'testing';
  result.activation.test = null; result.activation.actions = [];
  if (stage !== 'test') { result.activation.connectionId = null; result.activation.providerId = null; }
  if (stage === 'issue') { result.activation.key = null; result.activation.modelId = null; }
  return result;
};
type ModelTestStatus = NonNullable<PlatformAccountKeySetupState['activation']>['tests'][number]['status'];
const modelState = (runId: string, statuses: ModelTestStatus[]): PlatformAccountKeySetupState => {
  const result = readyState();
  if (!result.activation) throw new Error('Missing activation fixture');
  const purposes = ['agent', 'auxiliary', 'vision', 'embedding', 'rerank', 'tts', 'image-generation'] as const;
  result.activation.testRunId = runId;
  result.activation.tests = statuses.map((status, index) => ({
    id: `test-${purposes[index]}`, purpose: purposes[index], modelId: `model-${purposes[index]}`, status,
    applied: status === 'verified',
    testedAt: status === 'verified' || status === 'failed' ? '2026-11-06T00:01:00Z' : null,
    errorCode: status === 'failed' ? 'model_configuration_provider_http_401' : null,
  }));
  if (statuses.some(status => status === 'queued' || status === 'testing')) {
    result.activation.status = 'testing'; result.activation.test = null; result.activation.actions = [];
  } else if (statuses.includes('unknown') || statuses.includes('failed')) {
    result.activation.status = statuses.includes('unknown') ? 'unknown' : 'failed';
    result.activation.test = { status: result.activation.status, testedAt: '2026-11-06T00:01:00Z', errorCode: null };
  }
  return result;
};
let readPayload = emptyState();
let writePayload = readyState();
let readStatus = 200;
let writeStatus = 200;
let pendingRead: Promise<Response> | null = null;
let pendingWrite: Promise<Response> | null = null;
const requests: Array<{ path: string; method: string; body: BodyInit | null }> = [];
const configured: string[] = [];
const fetchFixture = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
  const url = new URL(String(input), 'http://localhost/');
  if (url.pathname === '/auth/url-token') return Response.json({ token: '', expiresAt: 0 });
  requests.push({ path: url.pathname + url.search, method: init?.method ?? 'GET', body: init?.body ?? null });
  if (url.pathname !== '/api/model-configuration/bootstrap/account-key') throw new Error(`Unexpected route: ${url.pathname}`);
  if (init?.method === 'POST') {
    if (pendingWrite) { const pending = pendingWrite; pendingWrite = null; return pending; }
    return Response.json(writeStatus === 200 ? writePayload : { error: 'request_failed' }, { status: writeStatus });
  }
  if (pendingRead) { const pending = pendingRead; pendingRead = null; return pending; }
  return Response.json(readStatus === 200 ? readPayload : { error: readStatus === 403 ? 'forbidden' : 'request_failed' }, { status: readStatus });
});
const { createRoot } = await import('react-dom/client');
const { I18nProvider, useI18nStore } = await import('@/lib/i18n');
const { getRuntimeKey, getRuntimeApiBaseUrl, switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
const { PlatformAccountApiKeys } = await import('./PlatformAccountApiKeys');
const initialRuntime = { runtimeKey: getRuntimeKey(), apiBaseUrl: getRuntimeApiBaseUrl() };
let root: Root | undefined;
let host: HTMLDivElement | undefined;
const render = async (accountId = 'account-a') => {
  if (!root) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); }
  useI18nStore.getState().setLocale('en');
  await act(async () => root?.render(<I18nProvider><PlatformAccountApiKeys key={getRuntimeKey()} accountId={accountId} onConfigured={() => { configured.push(accountId); }} /></I18nProvider>));
};
const findButton = (label: string) => [...(host?.querySelectorAll('button') ?? [])].find(button => button.textContent?.trim() === label);
const click = async (label: string) => {
  const button = findButton(label);
  if (!button) throw new Error(`Missing button: ${label}`);
  await act(async () => button.click());
};
const mutations = () => requests.filter(request => request.method !== 'GET');
const setupPanel = () => {
  const panel = host?.querySelector('[role="region"][aria-label="Setup and connection test"]');
  if (!panel) throw new Error('Missing setup and connection test region');
  return panel;
};
const expectStep = (label: string, status: string) => {
  const step = [...setupPanel().querySelectorAll('li, [role="listitem"]')].find(item => item.textContent?.includes(label));
  expect(step?.textContent).toContain(status);
  expect(step?.getAttribute('aria-current')).toBe(status === 'In progress' ? 'step' : null);
};
const waitForRead = async (previousCount: number) => {
  const deadline = Date.now() + 2000;
  while (requests.filter(request => request.method === 'GET').length <= previousCount && Date.now() < deadline) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  }
  expect(requests.filter(request => request.method === 'GET').length).toBeGreaterThan(previousCount);
};
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined; host?.remove(); host = undefined;
  if (getRuntimeKey() !== initialRuntime.runtimeKey) await act(async () => switchRuntimeEndpoint(initialRuntime));
  readPayload = emptyState(); writePayload = readyState(); readStatus = 200; writeStatus = 200;
  pendingRead = null; pendingWrite = null; requests.length = 0; configured.length = 0;
});
afterAll(async () => {
  fetchFixture.mockRestore(); await browser.happyDOM.close();
  for (const [name, descriptor] of savedGlobals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
});

test('opening the key panel only reads account state and waits for explicit activation', async () => {
  await render();
  expect(findButton('Activate and configure')?.disabled).toBe(false);
  expect(requests).toEqual([{ path: '/api/model-configuration/bootstrap/account-key?accountId=account-a', method: 'GET', body: null }]);
  expect(configured).toEqual([]);
  expect(host?.textContent).not.toContain('Connection test passed');
});

test('one activation configures the model and shows the real masked key only after a verified result', async () => {
  await render(); await click('Activate and configure');
  expect(mutations()).toEqual([{ path: '/api/model-configuration/bootstrap/account-key', method: 'POST', body: JSON.stringify({ accountId: 'account-a', action: 'activate' }) }]);
  expect(host?.textContent).toContain('•••• A7q9');
  expect(host?.textContent).toContain('Connection test passed');
  expect(host?.textContent).not.toContain('credential-record-id');
  expect(host?.textContent).not.toContain('activation-operation');
  expect(/UniHub|LLMRouter/i.test(host?.textContent ?? '')).toBe(false);
  expect(findButton('Activate and configure')).toBeUndefined();
  expect(configured).toEqual(['account-a']);
});

test('a pending activation prevents a second key issuance', async () => {
  let finish: (value: Response) => void = () => {};
  pendingWrite = new Promise(resolve => { finish = resolve; });
  await render();
  const activate = findButton('Activate and configure');
  if (!activate) throw new Error('Missing activation button');
  await act(async () => { activate.click(); activate.click(); });
  expect(mutations()).toHaveLength(1);
  expect(activate.disabled).toBe(true);
  await act(async () => finish(Response.json(readyState())));
  expect(host?.textContent).toContain('Connection test passed');
  expect(configured).toEqual(['account-a']);
});

test('activation immediately shows its pending request even before the server returns an operation', async () => {
  let finish: (value: Response) => void = () => {};
  pendingWrite = new Promise(resolve => { finish = resolve; });
  await render(); await click('Activate and configure');
  expect(setupPanel().querySelector('[role="status"]')?.textContent).toContain('Submitting setup request…');
  expectStep('Activate key', 'In progress');
  expectStep('Configure models', 'Pending');
  expectStep('Test connection', 'Pending');
  await waitForRead(1);
  expect(setupPanel().textContent).toContain('Submitting setup request…');
  expect(setupPanel().textContent).not.toContain('Connection test passed');
  expect(mutations()).toHaveLength(1);
  await act(async () => finish(Response.json(readyState())));
  expect(setupPanel().textContent).toContain('Connection test passed');
});

test('server progress distinguishes pending, active and completed stages without another key or test mutation', async () => {
  let finish: (value: Response) => void = () => {};
  pendingWrite = new Promise(resolve => { finish = resolve; });
  await render(); await click('Activate and configure');
  readPayload = runningState('issue');
  await waitForRead(1);
  expectStep('Activate key', 'In progress');
  expectStep('Configure models', 'Pending');
  expectStep('Test connection', 'Pending');
  expect(setupPanel().textContent).not.toContain('Connection test passed');

  const issuedReads = requests.filter(request => request.method === 'GET').length;
  readPayload = runningState('configure');
  await waitForRead(issuedReads);
  expectStep('Activate key', 'Completed');
  expectStep('Configure models', 'In progress');
  expectStep('Test connection', 'Pending');
  expect(setupPanel().textContent).toContain('•••• A7q9');

  const configuredReads = requests.filter(request => request.method === 'GET').length;
  readPayload = runningState('test');
  await waitForRead(configuredReads);
  expectStep('Activate key', 'Completed');
  expectStep('Configure models', 'Completed');
  expectStep('Test connection', 'In progress');
  expect(setupPanel().textContent).not.toContain('Connection test passed');
  expect(mutations()).toHaveLength(1);
  expect(configured).toEqual([]);

  // A completed GET can arrive before the POST response. Keep the furthest
  // observed stage while waiting, rather than restarting the progress display.
  const testingReads = requests.filter(request => request.method === 'GET').length;
  readPayload = readyState();
  await waitForRead(testingReads);
  expectStep('Activate key', 'Completed');
  expectStep('Configure models', 'Completed');
  expectStep('Test connection', 'In progress');
  expect(setupPanel().textContent).not.toContain('Connection test passed');

  await act(async () => finish(Response.json(readyState())));
  expectStep('Activate key', 'Completed');
  expectStep('Configure models', 'Completed');
  expectStep('Test connection', 'Completed');
  expect(setupPanel().textContent).toContain('Connection test passed');
  expect(configured).toEqual(['account-a']);
});

test('a pending retest hides the previous success even when polling returns the previous receipt', async () => {
  readPayload = readyState();
  let finish: (value: Response) => void = () => {};
  pendingWrite = new Promise(resolve => { finish = resolve; });
  await render();
  expect(setupPanel().textContent).toContain('Connection test passed');
  await click('Test and apply to features');
  expect(setupPanel().textContent).toContain('Submitting test request…');
  expect(setupPanel().textContent).not.toContain('Connection test passed');
  expectStep('Activate key', 'Completed');
  expectStep('Configure models', 'Completed');
  expectStep('Test connection', 'In progress');
  await waitForRead(1);
  expect(setupPanel().textContent).not.toContain('Connection test passed');
  expectStep('Test connection', 'In progress');
  expect(mutations().map(request => request.body)).toEqual([JSON.stringify({ accountId: 'account-a', action: 'retest' })]);

  const unknown = readyState();
  if (!unknown.activation) throw new Error('Missing activation fixture');
  unknown.activation.status = 'unknown'; unknown.activation.errorCode = 'account_key_test_unknown';
  unknown.activation.test = { status: 'unknown', testedAt: null, errorCode: 'account_key_test_unknown' };
  await act(async () => finish(Response.json(unknown)));
  expectStep('Test connection', 'Unconfirmed');
  expect(setupPanel().querySelector('[role="alert"]')?.textContent).toContain('test result is uncertain');
  expect(setupPanel().textContent).not.toContain('Connection test passed');
  expect(findButton('Test and apply to features')?.disabled).toBe(false);
  expect(mutations()).toHaveLength(1);
});

test('configuration failure keeps the issued key and resumes without another activate request', async () => {
  writePayload = failedState('configure');
  await render(); await click('Activate and configure');
  expect(host?.textContent).toContain('•••• A7q9');
  expect(host?.textContent).not.toContain('Connection test passed');
  expect(findButton('Activate and configure')).toBeUndefined();
  expect(findButton('Continue setup')?.disabled).toBe(false);
  expect(configured).toEqual([]);
  writePayload = readyState(); await click('Continue setup');
  expect(mutations().map(request => request.body)).toEqual([
    JSON.stringify({ accountId: 'account-a', action: 'activate' }),
    JSON.stringify({ accountId: 'account-a', action: 'resume' }),
  ]);
  expect(host?.textContent).toContain('Connection test passed');
  expect(configured).toEqual(['account-a']);
});

test('failed connectivity preserves saved configuration and tests again only on a user click', async () => {
  writePayload = failedState('test');
  await render(); await click('Activate and configure');
  expect(host?.textContent).not.toContain('Connection test passed');
  expectStep('Test connection', 'Failed');
  expect(setupPanel().querySelector('[role="alert"]')?.textContent).toContain('connection test failed');
  expect(findButton('Test and apply to features')?.disabled).toBe(false);
  expect(configured).toEqual(['account-a']);
  expect(mutations()).toHaveLength(1);
  readPayload = failedState('test'); await click('Refresh');
  expect(mutations()).toHaveLength(1);
  expect(configured).toEqual(['account-a']);
  writePayload = readyState(); await click('Test and apply to features');
  expect(mutations().map(request => request.body)).toEqual([
    JSON.stringify({ accountId: 'account-a', action: 'activate' }),
    JSON.stringify({ accountId: 'account-a', action: 'retest' }),
  ]);
  expect(host?.textContent).toContain('Connection test passed');
});

test('permission denial clears prior results without offering activation as an empty-state fallback', async () => {
  readPayload = readyState(); await render(); readStatus = 403; await click('Refresh');
  expect(host?.querySelector('[role="alert"]')).not.toBeNull();
  expect(host?.textContent).not.toContain('•••• A7q9');
  expect(host?.textContent).not.toContain('Connection test passed');
  expect(findButton('Activate and configure')).toBeUndefined();
  expect(mutations()).toHaveLength(0);
});

test('an unknown issuance outcome cannot claim readiness or automatically issue another key', async () => {
  const state = readyState();
  if (!state.activation) throw new Error('Missing activation fixture');
  state.activation.status = 'unknown'; state.activation.stage = 'issue';
  state.activation.key = null; state.activation.connectionId = null; state.activation.providerId = null;
  state.activation.modelId = null; state.activation.test = null;
  state.activation.errorCode = 'model_configuration_bootstrap_issue_unknown'; state.activation.actions = [];
  readPayload = state; await render();
  expectStep('Activate key', 'Unconfirmed');
  expect(setupPanel().querySelector('[role="alert"]')?.textContent).toContain('activation outcome is uncertain');
  expect(host?.textContent).not.toContain('Connection test passed');
  expect(host?.textContent).not.toContain('••••');
  expect(findButton('Activate and configure')).toBeUndefined();
  expect(findButton('Continue setup')).toBeUndefined();
  expect(findButton('Test and apply to features')).toBeUndefined();
  expect(findButton('Refresh')?.disabled).toBe(false);
  expect(mutations()).toHaveLength(0);
  expect(configured).toEqual([]);
});

test('an HTTP read failure remains an error until an explicit refresh recovers authoritative state', async () => {
  readStatus = 503; await render();
  expect(host?.querySelector('[role="alert"]')).not.toBeNull();
  expect(findButton('Activate and configure')).toBeUndefined();
  readStatus = 200; readPayload = readyState(); await click('Refresh');
  expect(host?.querySelector('[role="alert"]')).toBeNull();
  expect(host?.textContent).toContain('Connection test passed');
  expect(mutations()).toHaveLength(0);
});

test('a lost activation response recovers by reading status without repeating the mutation', async () => {
  writeStatus = 503; await render(); await click('Activate and configure');
  expect(host?.querySelector('[role="alert"]')).not.toBeNull();
  expect(setupPanel().querySelector('[role="alert"]')?.textContent).toContain('Could not confirm the setup status');
  expect(host?.textContent).not.toContain('Connection test passed');
  expect(findButton('Activate and configure')).toBeUndefined();
  readPayload = readyState(); await click('Refresh');
  expect(host?.textContent).toContain('Connection test passed');
  expect(mutations()).toHaveLength(1);
  expect(configured).toEqual(['account-a']);
});

test('refreshing an already ready key performs no mutation or duplicate configuration notification', async () => {
  readPayload = readyState(); await render();
  expect(configured).toEqual(['account-a']);
  await click('Refresh'); await click('Refresh');
  expect(mutations()).toHaveLength(0);
  expect(requests.filter(request => request.method === 'GET')).toHaveLength(3);
  expect(configured).toEqual(['account-a']);
  expect(host?.textContent).toContain('Connection test passed');
});

test('enterprise mode prevents key activation', async () => {
  readPayload = { ...emptyState(), enterpriseMode: true }; await render();
  const activate = findButton('Activate and configure');
  expect(!activate || activate.disabled).toBe(true);
  if (activate) await act(async () => activate.click());
  expect(mutations()).toHaveLength(0);
  expect(configured).toEqual([]);
});

test('a response for another account is rejected instead of displaying its key', async () => {
  readPayload = readyState('account-b'); await render();
  expect(host?.querySelector('[role="alert"]')).not.toBeNull();
  expect(host?.textContent).not.toContain('•••• A7q9');
  expect(host?.textContent).not.toContain('Connection test passed');
  expect(configured).toEqual([]);
});

test('an earlier account read cannot replace the new account state', async () => {
  let finish: (value: Response) => void = () => {};
  pendingRead = new Promise(resolve => { finish = resolve; });
  await render(); readPayload = emptyState('account-b'); await render('account-b');
  await act(async () => finish(Response.json(readyState())));
  expect(findButton('Activate and configure')?.disabled).toBe(false);
  expect(host?.textContent).not.toContain('•••• A7q9');
  expect(host?.textContent).not.toContain('Connection test passed');
  expect(configured).toEqual([]);
  expect(mutations()).toHaveLength(0);
});

test('an activation completed for the previous account cannot refresh the new account models', async () => {
  let finish: (value: Response) => void = () => {};
  pendingWrite = new Promise(resolve => { finish = resolve; });
  await render(); await click('Activate and configure');
  readPayload = emptyState('account-b'); await render('account-b');
  await act(async () => finish(Response.json(readyState())));
  expect(findButton('Activate and configure')?.disabled).toBe(false);
  expect(host?.textContent).not.toContain('•••• A7q9');
  expect(configured).toEqual([]);
  expect(mutations().map(request => request.body)).toEqual([JSON.stringify({ accountId: 'account-a', action: 'activate' })]);
});

test('a previous runtime activation cannot populate the new runtime or call onConfigured', async () => {
  let finish: (value: Response) => void = () => {};
  pendingWrite = new Promise(resolve => { finish = resolve; });
  await render(); await click('Activate and configure');
  await act(async () => switchRuntimeEndpoint({ apiBaseUrl: 'http://next-runtime.test', runtimeKey: 'key-setup-next-runtime' }));
  await render(); await act(async () => finish(Response.json(readyState())));
  expect(findButton('Activate and configure')?.disabled).toBe(false);
  expect(host?.textContent).not.toContain('•••• A7q9');
  expect(host?.textContent).not.toContain('Connection test passed');
  expect(configured).toEqual([]);
  expect(mutations()).toHaveLength(1);
});

test('model rows grow only as tests start and update independently without losing earlier results', async () => {
  readPayload = modelState('run-a', ['testing', 'testing', 'testing', 'queued', 'queued', 'queued', 'queued']);
  await render();
  expect(host?.querySelectorAll('[data-account-model-test]')).toHaveLength(3);
  expect(host?.querySelectorAll('[data-test-status="testing"]')).toHaveLength(3);
  expect(host?.textContent).toContain('0 of 7 model tests passed');
  expect(host?.textContent).not.toContain('model-embedding');
  expect(/\d+\s*%/.test(host?.textContent ?? '')).toBe(false);
  const originalAgent = host?.querySelector('[data-account-model-test="agent"]');
  readPayload = modelState('run-a', ['verified', 'failed', 'testing', 'testing', 'testing', 'queued', 'queued']);
  await click('Refresh');
  expect(host?.querySelectorAll('[data-account-model-test]')).toHaveLength(5);
  expect(host?.querySelectorAll('[data-test-status="testing"]')).toHaveLength(3);
  expect(host?.querySelector('[data-account-model-test="agent"]')).toBe(originalAgent);
  expect(originalAgent?.getAttribute('data-test-status')).toBe('verified');
  expect(host?.textContent).toContain('1 of 7 model tests passed');
  expect(host?.querySelector('[data-account-model-test="auxiliary"]')?.textContent).toContain('API key');
  expect(host?.textContent).not.toContain('model_configuration_provider_http_401');
  readPayload = modelState('run-a', ['verified', 'failed', 'verified', 'verified', 'verified', 'verified', 'unknown']);
  await click('Refresh');
  expect(host?.querySelectorAll('[data-account-model-test]')).toHaveLength(7);
  expect(host?.querySelectorAll('[data-account-model-test] [data-spinner]')).toHaveLength(0);
  expect(host?.querySelector('[data-account-model-test="image-generation"]')?.getAttribute('data-test-status')).toBe('unknown');
  expect(mutations()).toHaveLength(0);
});

test('a polling failure preserves confirmed rows and stops unconfirmed activity without claiming full success', async () => {
  readPayload = modelState('run-a', ['verified', 'failed', 'testing', 'queued', 'queued', 'queued', 'queued']);
  await render(); readStatus = 503; await click('Refresh');
  expect(host?.querySelector('[data-account-model-test="agent"]')?.getAttribute('data-test-status')).toBe('verified');
  expect(host?.querySelector('[data-account-model-test="agent"] [title]')?.getAttribute('title')).toContain('2026');
  expect(host?.querySelector('[data-account-model-test="auxiliary"]')?.getAttribute('data-test-status')).toBe('failed');
  expect(host?.querySelector('[data-account-model-test="vision"]')?.getAttribute('data-test-status')).toBe('unknown');
  expect(host?.querySelectorAll('[data-account-model-test]')).toHaveLength(3);
  expect(host?.querySelector('[data-spinner]')).toBeNull();
  expect(host?.textContent).not.toContain('Connection test passed');
  expect(host?.querySelector('[role="alert"]')?.textContent).toContain('Could not confirm the setup status');
  expect(mutations()).toHaveLength(0);
});

test('a lost retest cannot redisplay the old run or admit another test before a new run is observed', async () => {
  readPayload = modelState('run-old', ['verified', 'verified', 'verified', 'verified', 'verified', 'verified', 'verified']);
  await render(); writeStatus = 503; await click('Test and apply to features');
  expect(host?.querySelectorAll('[data-account-model-test]')).toHaveLength(0);
  expect(host?.textContent).not.toContain('Connection test passed');
  expect(findButton('Test and apply to features')?.disabled).toBe(true);
  await click('Refresh');
  expect(host?.querySelectorAll('[data-account-model-test]')).toHaveLength(0);
  expect(findButton('Test and apply to features')?.disabled).toBe(true);
  expect(mutations()).toHaveLength(1);
  readPayload = modelState('run-new', ['testing', 'testing', 'testing', 'queued', 'queued', 'queued', 'queued']);
  await click('Refresh');
  expect(host?.querySelectorAll('[data-account-model-test]')).toHaveLength(3);
  expect(host?.querySelectorAll('[data-test-status="verified"]')).toHaveLength(0);
  expect(host?.querySelector('[role="alert"]')).toBeNull();
  expect(mutations()).toHaveLength(1);
});

test('a lost POST after partial polling progress retains only the new run confirmed results', async () => {
  readPayload = modelState('run-old', ['verified', 'verified', 'verified', 'verified', 'verified', 'verified', 'verified']);
  let finish: (value: Response) => void = () => {};
  pendingWrite = new Promise(resolve => { finish = resolve; });
  await render(); await click('Test and apply to features');
  expect(host?.querySelectorAll('[data-account-model-test]')).toHaveLength(0);
  readPayload = modelState('run-new', ['verified', 'testing', 'testing', 'testing', 'queued', 'queued', 'queued']);
  await waitForRead(1);
  expect(host?.querySelectorAll('[data-account-model-test]')).toHaveLength(4);
  await act(async () => finish(Response.json({ error: 'request_failed' }, { status: 503 })));
  expect(host?.querySelectorAll('[data-test-status="verified"]')).toHaveLength(1);
  expect(host?.querySelectorAll('[data-test-status="unknown"]')).toHaveLength(3);
  expect(host?.querySelectorAll('[data-spinner]')).toHaveLength(0);
  expect(host?.textContent).not.toContain('Connection test passed');
  expect(mutations()).toHaveLength(1);
});

test('skipped purposes remain in the total and prevent historical ready receipts claiming full success', async () => {
  const next = modelState('run-a', ['verified', 'skipped']);
  if (!next.activation) throw new Error('Missing activation fixture');
  next.activation.tests[1].modelId = null;
  next.activation.tests[1].errorCode = 'account_key_model_unavailable';
  readPayload = next; await render();
  const skipped = host?.querySelector('[data-account-model-test="auxiliary"]');
  expect(skipped?.getAttribute('data-test-status')).toBe('skipped');
  expect(skipped?.textContent).toContain('Not tested');
  expect(skipped?.textContent).toContain('No compatible model is available');
  expect(skipped?.textContent).not.toContain('account_key_model_unavailable');
  expect(host?.textContent).toContain('1 of 2 model tests passed');
  expect(setupPanel().textContent).toContain('Some features are not complete');
  expect(setupPanel().textContent).not.toContain('Connection test passed');
  expect(mutations()).toHaveLength(0);
});

test('preserved legacy configuration explanations appear after the real tests finish', async () => {
  const next = modelState('run-a', ['testing', 'skipped', 'skipped']);
  if (!next.activation) throw new Error('Missing activation fixture');
  next.activation.tests[1].errorCode = 'account_key_existing_configuration';
  next.activation.tests[2].errorCode = 'account_key_existing_configuration_unknown';
  readPayload = next; await render();
  expect(host?.querySelectorAll('[data-account-model-test]')).toHaveLength(1);
  expect(host?.textContent).not.toContain('Your existing configuration was preserved');
  next.activation.status = 'ready';
  next.activation.test = { status: 'verified', testedAt: '2026-11-06T00:01:00Z', errorCode: null };
  next.activation.tests[0].status = 'verified'; next.activation.tests[0].testedAt = '2026-11-06T00:01:00Z';
  await click('Refresh');
  expect(host?.querySelectorAll('[data-account-model-test]')).toHaveLength(3);
  expect(host?.querySelector('[data-account-model-test="auxiliary"]')?.textContent).toContain('Your existing configuration was preserved. Test and apply again to connect this feature with the current key.');
  expect(host?.querySelector('[data-account-model-test="vision"]')?.textContent).toContain('The existing model configuration could not be read. It was preserved without changes.');
  expect(host?.textContent).toContain('1 of 3 model tests passed');
  expect(setupPanel().textContent).toContain('Some features are not complete');
  expect(setupPanel().textContent).not.toContain('Connection test passed');
});


test('each completed batch refreshes configured features once after applying, including partial batches', async () => {
  readPayload = modelState('initial', ['testing', 'queued']);
  await render();
  expect(configured).toEqual([]);
  readPayload = modelState('initial', ['verified', 'verified']);
  await click('Refresh');
  expect(configured).toEqual(['account-a']);
  await click('Refresh');
  expect(configured).toEqual(['account-a']);

  let finish: (value: Response) => void = () => {};
  pendingWrite = new Promise(resolve => { finish = resolve; });
  await click('Test and apply to features');
  await waitForRead(3);
  expect(configured).toEqual(['account-a']);
  readPayload = modelState('second', ['testing', 'testing']);
  await waitForRead(4);
  expect(configured).toEqual(['account-a']);
  await act(async () => finish(Response.json(modelState('second', ['verified', 'failed']))));
  expect(configured).toEqual(['account-a', 'account-a']);
  readPayload = modelState('second', ['verified', 'failed']);
  await click('Refresh');
  expect(configured).toEqual(['account-a', 'account-a']);
  expect(mutations()).toHaveLength(1);
});

test('a consumer rebuild refusal describes the preserved index and does not claim that feature was applied', async () => {
  const next = modelState('apply', ['verified', 'failed']);
  if (!next.activation) throw new Error('Missing activation fixture');
  next.activation.tests[1].purpose = 'embedding';
  next.activation.tests[1].errorCode = 'model_configuration_embedding_rebuild_required';
  readPayload = next;
  await render();
  const embedding = host?.querySelector('[data-account-model-test="embedding"]');
  expect(embedding?.textContent).toContain('Rebuild the knowledge index');
  expect(embedding?.textContent).toContain('existing configuration and index are preserved');
  expect(embedding?.textContent).not.toContain('model_configuration_embedding_rebuild_required');
  expect(setupPanel().textContent).not.toContain('Connection test passed');
  expect(host?.textContent).not.toContain('Existing model defaults and chat selections are preserved');
  expect(mutations()).toHaveLength(0);
});


test('a passed probe without confirmed application never claims that a feature is connected', async () => {
  const next = modelState('unapplied', ['verified']);
  if (!next.activation) throw new Error('Missing activation fixture');
  next.activation.tests[0].applied = false;
  readPayload = next; await render();
  expect(setupPanel().textContent).toContain('Some features are not complete');
  expect(setupPanel().textContent).not.toContain('Connection test passed');
  const row = host?.querySelector('[data-account-model-test="agent"]');
  expect(row?.textContent).toContain('Passed');
  expect(row?.textContent).not.toContain('Passed and connected');
  next.activation.tests[0].applied = true;
  await click('Refresh');
  expect(row?.textContent).toContain('Passed and connected');
  expect(setupPanel().textContent).toContain('Connection test passed');
  expect(mutations()).toHaveLength(0);
});

test('a legacy receipt requires explicit application without losing its recorded test result', async () => {
  const next = readyState();
  if (!next.activation) throw new Error('Missing activation fixture');
  next.activation.tests = [];
  next.activation.status = 'unknown';
  next.activation.errorCode = 'account_key_apply_required';
  readPayload = next; await render();
  expect(setupPanel().textContent).toContain('previous tests did not confirm that every feature uses this key');
  expect(setupPanel().textContent).not.toContain('Connection test passed');
  expect(findButton('Test and apply to features')?.disabled).toBe(false);
  expect(mutations()).toHaveLength(0);
});
