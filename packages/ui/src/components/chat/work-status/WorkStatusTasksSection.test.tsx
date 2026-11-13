import { expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import { useSessionTodosStore } from '@/stores/useSessionTodosStore';
import { WorkStatusTasksSection } from './WorkStatusTasksSection';
import { useLoadSessionTodos } from './useLoadSessionTodos';

const entry = { directory: '/repo', state: 'ready' as const, todos: [{ content: 'Verify invoice', status: 'completed' as const }], revision: 3, failures: 0, stale: false };
test('renders only the selected session and keeps read failure distinct from an empty list', async () => {
  const win = new Window({ url: 'http://steps.test' });
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({ window: win, document: win.document, navigator: win.navigator, HTMLElement: win.HTMLElement, Element: win.Element, Node: win.Node, localStorage: win.localStorage, IS_REACT_ACT_ENVIRONMENT: true })) {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  useSessionTodosStore.setState({ entries: { ses_a: entry, ses_b: { ...entry, todos: [], failures: 1 } } });
  try {
    await act(async () => root.render(<I18nProvider><WorkStatusTasksSection sessionId="ses_a" /></I18nProvider>));
    expect(container.textContent).toContain('Verify invoice');
    expect(container.textContent).toContain('1/1');
    await act(async () => root.render(<I18nProvider><WorkStatusTasksSection sessionId="ses_b" /></I18nProvider>));
    expect(container.textContent).not.toContain('Verify invoice');
    expect(container.querySelector('[data-work-status-section="tasks"]')).not.toBeNull();
    await act(async () => root.render(<I18nProvider><WorkStatusTasksSection sessionId="unknown" /></I18nProvider>));
    expect(container.textContent).toBe('');
  } finally {
    await act(async () => root.unmount());
    useSessionTodosStore.getState().reset();
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await win.happyDOM.close();
  }
});
test('hidden and isolated-space sessions perform no history request', async () => {
  const dom = installHookTestDom();
  const root = createRoot(dom.container);
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = Object.assign(async () => { requests += 1; return new Response(null, { status: 503 }); }, original);
  const Loader = ({ visible, directory }: { visible: boolean; directory: string }) => { useLoadSessionTodos('ses_a', directory, visible); return null; };
  try {
    await act(async () => root.render(<Loader visible={false} directory="/repo" />));
    expect(requests).toBe(0);
    await act(async () => root.render(<Loader visible directory="/spaces/abcdef123456/repo" />));
    expect(requests).toBe(0);
    expect(useSessionTodosStore.getState().entries.ses_a?.state).toBe('unsupported');
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = original;
    useSessionTodosStore.getState().reset();
    dom.restore();
  }
});

test('an oversized-list read error keeps the previous progress visible with a refresh failure notice', async () => {
  const win = new Window({ url: 'http://steps.test' });
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({ window: win, document: win.document, navigator: win.navigator, HTMLElement: win.HTMLElement, Element: win.Element, Node: win.Node, localStorage: win.localStorage, IS_REACT_ACT_ENVIRONMENT: true })) {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  const original = globalThis.fetch;
  let oversized = false;
  useSessionTodosStore.getState().reset();
  globalThis.fetch = Object.assign(async () => oversized
    ? Response.json({ code: 'todo-list-too-large', error: 'The todo list exceeds 200 items' }, { status: 502 })
    : Response.json({ revision: 1, state: 'ready', todos: [{ content: 'Previous pending step', status: 'pending' }] }), original);
  try {
    await useSessionTodosStore.getState().load('ses_large', '/repo');
    await act(async () => root.render(<I18nProvider><WorkStatusTasksSection sessionId="ses_large" /></I18nProvider>));
    oversized = true;
    await act(async () => {
      await expect(useSessionTodosStore.getState().load('ses_large', '/repo')).rejects.toThrow();
    });
    expect(container.textContent).toContain('Previous pending step');
    expect(container.textContent).toContain('0/1');
    expect(container.textContent).not.toContain('200/200');
    expect(useSessionTodosStore.getState().entries.ses_large).toMatchObject({ failures: 1, stale: true });
    expect(container.textContent).toContain('Could not refresh');
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = original;
    useSessionTodosStore.getState().reset();
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await win.happyDOM.close();
  }
});
