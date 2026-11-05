import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import type { ProductHelpAnswer } from '@/lib/product-help/client';

const browser = new Window({ url: 'http://localhost/' });
const globals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser, document: browser.document, navigator: browser.navigator,
  HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node,
  Event: browser.Event, MutationObserver: browser.MutationObserver,
  localStorage: browser.localStorage, sessionStorage: browser.sessionStorage,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true });
}
const catalog = { catalogVersion: 'second', articles: [{ id: 'models', title: 'Current models', text: 'Current instructions', actions: [] }] };
let reads = 0;
const fetchFixture = spyOn(globalThis, 'fetch').mockImplementation(async input => {
  if (String(input).includes('/api/product-help/articles')) { reads++; return Response.json(catalog); }
  if (String(input).endsWith('/api/fs/home')) return Response.json({ home: '/fixture' });
  if (String(input).endsWith('/api/session-warming')) return Response.json({ revision: 1, enabled: false, minutes: 60, sessions: [] });
  return Response.json({ error: 'Not used by this fixture' }, { status: 503 });
});
const { createRoot } = await import('react-dom/client');
const { OpenCode } = await import('@opencode/client');
const { SyncProvider } = await import('@/sync/sync-context');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { I18nProvider } = await import('@/lib/i18n');
const { ProductHelpPanel } = await import('./ProductHelpPanel');
const { useProductHelpStore: help } = await import('@/lib/product-help/store');
const { useProductHelpGuidanceStore: guide } = await import('@/lib/product-help/guidance-store');
const { useUIStore: ui } = await import('@/stores/useUIStore');
const sdk = OpenCode.make({ baseUrl: 'http://help.test', fetch: () => new Promise<Response>(() => undefined) });
const focus = spyOn(document, 'hasFocus');
focus.mockReturnValue(true);
const timers = new Map<ReturnType<typeof browser.setInterval>, () => void>();
const originalSetInterval = browser.setInterval.bind(browser);
const originalClearInterval = browser.clearInterval.bind(browser);
const intervals = spyOn(browser, 'setInterval').mockImplementation((handler, delay, ...args) => {
  const id = originalSetInterval(handler, delay, ...args);
  if (delay === 300_000) {
    originalClearInterval(id);
    timers.set(id, () => handler(...args));
  }
  return id;
});
const clearIntervals = spyOn(browser, 'clearInterval').mockImplementation(id => {
  timers.delete(id);
  originalClearInterval(id);
});
let host: HTMLDivElement;
let root: Root;
const render = async (visible = false, duplicate = false) => {
  await act(async () => root.render(
    <SyncProvider sdk={sdk} directory=""><ThemeSystemProvider><I18nProvider>
      <ProductHelpPanel visible={visible} />
      {duplicate && <ProductHelpPanel visible={visible} embedded />}
    </I18nProvider></ThemeSystemProvider></SyncProvider>,
  ));
};
beforeEach(() => {
  reads = 0;
  focus.mockReturnValue(true);
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  guide.getState().stop();
  help.getState().syncRuntime('reset');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
});
afterAll(async () => {
  intervals.mockRestore(); clearIntervals.mockRestore(); focus.mockRestore(); fetchFixture.mockRestore();
  await browser.happyDOM.close();
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

describe('product help content refresh', () => {
  test('answer and article buttons open the registered settings page and retain the clicked guide text', async () => {
    await render();
    const actions: ProductHelpAnswer['actions'] = [
      { id: 'mcp-locate', kind: 'locate', target: 'mcp' }, { id: 'mcp-guide', kind: 'guide', target: 'mcp' },
    ];
    await act(async () => help.setState({ ...catalog, messages: [{ id: 1, role: 'assistant', answer: {
      kind: 'answer', text: 'Original MCP setup instructions', sources: [], actions, mode: 'local', modelStatus: 'unconfigured',
    } }] }));
    const buttons = host.querySelectorAll<HTMLButtonElement>('article button');
    expect(buttons.length).toBe(2);
    await act(async () => buttons[0].click());
    expect(ui.getState().isSettingsDialogOpen).toBe(true);
    expect(ui.getState().settingsJumpRequest?.page).toBe('mcp');
    expect(guide.getState().session?.mode).toBe('locate');
    await act(async () => guide.getState().stop());
    await act(async () => host.querySelectorAll<HTMLButtonElement>('article button')[1].click());
    expect(guide.getState().session?.mode).toBe('guide');
    expect(host.textContent).toContain('Original MCP setup instructions');
    await act(async () => help.setState({ articles: [{ id: 'mcp', title: 'MCP', text: 'New catalog text', actions }] }));
    expect(guide.getState().session?.instructions).toBe('Original MCP setup instructions');
    await act(async () => { guide.getState().stop(); help.setState({ messages: [] }); });
    const articleButton = [...host.querySelectorAll<HTMLButtonElement>('details button')].at(-1);
    if (!articleButton) throw new Error('Missing article guide button');
    await act(async () => articleButton.click());
    expect(guide.getState().session?.instructions).toBe('New catalog text');
  });
  for (const version of ['first', undefined]) {
    test(`keeps an answer and source title without expanding a ${version ?? 'legacy'} source against newer articles`, async () => {
      await render();
      const answer: ProductHelpAnswer = {
        kind: 'answer', text: 'Original answer', catalogVersion: version,
        sources: [{ id: 'models', title: 'Original models' }],
        actions: [{ id: 'locate-models', kind: 'locate', target: 'models' }], mode: 'local', modelStatus: 'not-used',
      };
      await act(async () => help.setState({ ...catalog, messages: [{ id: 1, role: 'assistant', answer }] }));
      const message = host.querySelector('article');
      expect(message?.textContent).toContain('Original answer');
      expect(message?.textContent).toContain('Original models');
      expect(message?.textContent).not.toContain('Current instructions');
      expect(message?.querySelector('button')).not.toBeNull();
      expect(message?.querySelector('details details')).toBeNull();
    });
  }
  test('expands a source from the same catalog version', async () => {
    await render();
    await act(async () => help.setState({ ...catalog, messages: [{ id: 1, role: 'assistant', answer: {
      kind: 'answer', text: 'Current answer', catalogVersion: 'second',
      sources: [{ id: 'models', title: 'Current models' }], actions: [], mode: 'local', modelStatus: 'not-used',
    } }] }));
    expect(host.querySelector('article details details')?.textContent).toContain('Current instructions');
  });
  test('refreshes visible panels once per cache period and pauses while hidden or in the background', async () => {
    await render(false, true);
    expect(reads).toBe(0);
    await render(true, true);
    expect(reads).toBe(1);
    expect(timers.size).toBeGreaterThan(0);
    await act(async () => { for (const tick of timers.values()) tick(); });
    expect(reads).toBe(1);
    await act(async () => {
      help.setState({ articlesLoadedAt: Date.now() - 300_001 });
      for (const tick of timers.values()) tick();
    });
    expect(reads).toBe(2);
    await act(async () => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(timers.size).toBe(0);
    await act(async () => {
      help.setState({ articlesLoadedAt: Date.now() - 300_001 });
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(reads).toBe(3);
    await act(async () => { focus.mockReturnValue(false); window.dispatchEvent(new Event('blur')); });
    expect(timers.size).toBe(0);
    await act(async () => { focus.mockReturnValue(true); window.dispatchEvent(new Event('focus')); });
    expect(reads).toBe(3);
    await render(false, true);
    expect(timers.size).toBe(0);
  });
});
