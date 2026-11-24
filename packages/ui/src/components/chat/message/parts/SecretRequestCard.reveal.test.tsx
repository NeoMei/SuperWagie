import { afterAll, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';

import type { ToolPart } from '@/lib/opencode/model';
import type { SecretRunFields } from '@/lib/secretRequestAnswer';
import type { RequestedSecret, RequestedSecretRun } from '@/lib/opencode/tools';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  localStorage: browser.localStorage,
  Node: browser.Node,
  Element: browser.Element,
  HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement,
  HTMLButtonElement: browser.HTMLButtonElement,
  Event: browser.Event,
  MouseEvent: browser.MouseEvent,
  KeyboardEvent: browser.KeyboardEvent,
  ResizeObserver: browser.ResizeObserver,
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  MutationObserver: browser.MutationObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
});

mock.module('@/sync/sync-context', () => ({ useSessionDirectory: () => '/project' }));
mock.module('@/sync/global-blocking-requests', () => ({ useIsPageWaiting: () => true }));
let fieldsResponse: SecretRunFields | null = null;
let answerBody: object | null = null;
mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: async (url: string, options: RequestInit) => {
    if (url.endsWith('/fields')) return Response.json(fieldsResponse);
    answerBody = JSON.parse(String(options.body));
    return Response.json({ status: 'submitted' });
  },
}));
mock.module('@/components/ui', () => ({ toast: { error: () => undefined } }));
mock.module('@/components/chat/lib/scroll/timelineScrollIntent', () => ({ dispatchPageWaiting: () => undefined }));
mock.module('@/stores/useUIStore', () => ({ useUIStore: () => false }));
mock.module('./ToolPart', () => ({ default: () => null }));

const { createRoot } = await import('react-dom/client');
const { I18nProvider, useI18nStore } = await import('@/lib/i18n');
await useI18nStore.getState().setLocale('en');
const { SecretRequestCard, SecretRunCard } = await import('./SecretRequestCard');

afterAll(() => browser.close());

test('the eye reveals the typed value and hides it again', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const part: ToolPart = {
    id: 'part-1',
    sessionID: 'ses-1',
    messageID: 'msg-1',
    type: 'tool',
    tool: 'openchamber_secret',
    callID: 'call-1',
    state: { status: 'pending', input: {}, raw: '' },
  };
  const request: RequestedSecret = { label: 'API key', reason: 'Needed for the test run', placeholder: undefined };

  try {
    await act(async () => root.render(<I18nProvider><SecretRequestCard part={part} request={request} /></I18nProvider>));
    const input = () => container.querySelector<HTMLInputElement>('input[aria-label="Secret"]')!;
    const toggle = () => container.querySelector<HTMLButtonElement>('button[aria-pressed]')!;

    expect(input().type).toBe('password');
    expect(toggle().getAttribute('aria-label')).toBe('Show secret');
    expect(toggle().getAttribute('aria-pressed')).toBe('false');

    await act(async () => {
      Object.getOwnPropertyDescriptor(globalThis.HTMLInputElement.prototype, 'value')!.set!.call(input(), 'sk-test-value');
      input().dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(input().value).toBe('sk-test-value');
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);

    await act(async () => toggle().click());
    expect(input().type).toBe('text');
    expect(input().value).toBe('sk-test-value');
    expect(toggle().getAttribute('aria-label')).toBe('Hide secret');
    expect(toggle().getAttribute('aria-pressed')).toBe('true');

    await act(async () => toggle().click());
    expect(input().type).toBe('password');
    expect(input().value).toBe('sk-test-value');
    expect(toggle().getAttribute('aria-label')).toBe('Show secret');
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

const runPart: ToolPart = {
  id: 'secret-run', sessionID: 'ses-run', messageID: 'msg-run', type: 'tool',
  tool: 'openchamber_secret', callID: 'call-run',
  state: { status: 'running', input: {}, metadata: {}, time: { start: 0 } },
};
const run: RequestedSecretRun = {
  reason: 'Run with the API token', command: 'fixture', program: 'fixture',
  fields: [{ env: 'API_TOKEN', label: 'API token', placeholder: undefined }],
};

test('an all-saved card shows the project and sends only consent when Run is clicked', async () => {
  fieldsResponse = {
    fields: ['API_TOKEN'], reused: [], projectPath: '/projects/example',
    consent: 'card-consent', saved: { API_TOKEN: 'global' },
  };
  answerBody = null;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<I18nProvider><SecretRunCard part={runPart} run={run} /></I18nProvider>));
    expect(container.textContent).toContain('/projects/example');
    expect(container.textContent).toContain('Saved for all projects');
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(answerBody).toBeNull();
    const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(submit?.disabled).toBe(false);
    await act(async () => submit?.click());
    expect(answerBody).toEqual({
      sessionId: 'ses-run', callId: 'call-run', values: {}, remember: [],
      save: [], saveGlobally: [], consent: 'card-consent',
    });
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test.each([
  { projectPath: '/projects/example', label: 'Save for this project', save: ['API_TOKEN'], saveGlobally: [] },
  { projectPath: null, label: 'Save for all projects', save: [], saveGlobally: ['API_TOKEN'] },
])('a new value defaults to one run and follows $label', async ({ projectPath, label, save, saveGlobally }) => {
  fieldsResponse = { fields: ['API_TOKEN'], reused: [], projectPath, consent: 'card-consent', saved: {} };
  answerBody = null;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<I18nProvider><SecretRunCard part={runPart} run={run} /></I18nProvider>));
    const retention = container.querySelector<HTMLButtonElement>('[role="combobox"]');
    expect(retention?.textContent).toContain('Use once');
    const input = container.querySelector('input[type="password"]');
    await act(async () => {
      Object.getOwnPropertyDescriptor(globalThis.HTMLInputElement.prototype, 'value')?.set?.call(input, 'test-value');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
      retention?.click();
    });
    const options = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
    if (!projectPath) expect(options.map((option) => option.textContent)).not.toContain('Save for this project');
    const selected = options.find((option) => option.textContent === label);
    expect(selected).toBeDefined();
    await act(async () => selected?.click());
    expect(container.textContent).toContain('Saved values are stored unencrypted');
    await act(async () => container.querySelector<HTMLButtonElement>('button[type="submit"]')?.click());
    expect(answerBody).toMatchObject({ values: { API_TOKEN: 'test-value' }, save, saveGlobally });
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
