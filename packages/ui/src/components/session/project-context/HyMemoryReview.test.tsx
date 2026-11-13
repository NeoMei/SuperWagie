import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';
import type { HyTidyItem } from '@/lib/hyMemoryTidy';

const browser = new Window({ url: 'http://hy-review.test/' });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser, document: browser.document, navigator: browser.navigator, location: browser.location,
  HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, Event: browser.Event, KeyboardEvent: browser.KeyboardEvent,
  HTMLInputElement: browser.HTMLInputElement, MutationObserver: browser.MutationObserver,
  ResizeObserver: browser.ResizeObserver, localStorage: browser.localStorage, sessionStorage: browser.sessionStorage,
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  getComputedStyle: browser.getComputedStyle.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
})) {
  originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
const { createRoot } = await import('react-dom/client');
const { I18nProvider, useI18nStore } = await import('@/lib/i18n');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { createWebAPIs } = await import('../../../../../web/src/api/index');
const { HyMemoryReview } = await import('./HyMemoryReview');
const apis = createWebAPIs();
const item: HyTidyItem = { id: 'a', kind: 'manual', type: 'fact', version: 'v', sourceVersion: 's', sourceSessionIds: [],
  sourceHash: null, sourceReferences: [], verification: 'unverified', before: { title: ' Original title ', body: ' Original body ' },
  after: { title: 'Original title', body: 'Original body' }, reasons: ['whitespace'] };
let root: Root;
let host: HTMLDivElement;
let fetchFixture: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>;
let calls: Array<{ path: string; body: string }>;
let applied: boolean;
let failure: boolean;
let exportConflict: boolean;
let externalEdit: boolean;
const render = async (projectPath = '/repo', isVSCode = false) => act(async () => root.render(
  <RuntimeAPIContext.Provider value={{ ...apis, runtime: { ...apis.runtime, isVSCode } }}>
    <I18nProvider><HyMemoryReview projectPath={projectPath} /></I18nProvider>
  </RuntimeAPIContext.Provider>,
));
const button = (text: string): HTMLButtonElement => {
  const result = [...document.querySelectorAll('button')].find((element) => element.textContent?.trim() === text);
  if (!result) throw new Error(`Missing button ${text}`); return result;
};
const click = (text: string) => act(async () => button(text).click());
const select = () => act(async () => document.querySelector<HTMLElement>('[role="checkbox"]')?.click());

beforeEach(() => {
  useI18nStore.getState().setLocale('en');
  calls = []; applied = false; failure = false; exportConflict = false; externalEdit = false;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  fetchFixture = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), browser.location.href);
    calls.push({ path: url.pathname, body: String(init?.body ?? '') });
    if (failure) return Response.json({ error: 'memory_backend_unavailable' }, { status: 503 });
    if (url.pathname.endsWith('/revisions')) return Response.json({ revisions: applied ? [{ ...item, revisionId: 'revision' }] : [], unavailable: 0 });
    if (url.pathname.endsWith('/apply')) { applied = true; return Response.json({ results: [{ id: 'a', kind: 'manual', state: 'applied', revisionId: 'revision' }] }); }
    if (url.pathname.endsWith('/undo')) { applied = false; return Response.json({ results: [{ revisionId: 'revision', state: 'undone' }] }); }
    if (url.pathname.endsWith('/export/preview')) return Response.json({ exportId: 'export', target: '/repo/AGENTS.md', before: externalEdit ? '# External rules' : '# Previous rules', after: '# Reviewed rules' });
    if (url.pathname.endsWith('/export/confirm')) {
      if (exportConflict) { exportConflict = false; externalEdit = true; return Response.json({ error: 'hy_tidy_export_conflict' }, { status: 409 }); }
      return Response.json({ written: true, target: '/repo/AGENTS.md' });
    }
    return Response.json({ previewId: 'preview', items: [{ ...item, reasons: applied ? [] : item.reasons }], unavailable: 0, truncated: false });
  });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); fetchFixture.mockRestore(); });
afterAll(() => {
  browser.happyDOM.abort();
  for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
});

test('review applies only selected changes, exposes per-entry undo and separately confirms a shown file preview', async () => {
  await render(); expect(calls).toHaveLength(0);
  await click('Review memory');
  expect(document.body.textContent).toContain('Current'); expect(document.body.textContent).toContain('Proposed');
  expect(button('Apply selected changes').disabled).toBe(true);
  await select(); await click('Apply selected changes');
  expect(JSON.parse(calls.find((call) => call.path.endsWith('/apply'))?.body ?? '{}').selectedIds).toEqual(['manual:a']);
  expect(document.body.textContent).toContain('Change applied');
  await click('Undo this entry');
  expect(JSON.parse(calls.find((call) => call.path.endsWith('/undo'))?.body ?? '{}').revisionIds).toEqual(['revision']);
  expect(document.body.textContent).toContain('Revision undone');
  await select(); await click('Preview AGENTS.md export');
  expect(document.body.textContent).toContain('# Previous rules'); expect(document.body.textContent).toContain('# Reviewed rules');
  expect(calls.some((call) => call.path.endsWith('/export/confirm'))).toBe(false);
  await click('Cancel export'); expect(calls.some((call) => call.path.endsWith('/export/confirm'))).toBe(false);
  await click('Preview AGENTS.md export'); await click('Confirm file write');
  expect(JSON.parse(calls.find((call) => call.path.endsWith('/export/confirm'))?.body ?? '{}')).toEqual({ directory: '/repo', exportId: 'export', confirmed: true });
});

test('failed reads show an error and a runtime switch closes the review before late results arrive', async () => {
  await render(); failure = true; await click('Review memory');
  expect(document.body.textContent).toContain('memory_backend_unavailable');
  expect(document.body.textContent).not.toContain('No eligible project memories');
  let finish: ((response: Response) => void) | undefined;
  fetchFixture.mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve; }));
  await act(async () => { button('Refresh').click(); });
  await act(async () => { browser.dispatchEvent(new browser.CustomEvent('openchamber:runtime-endpoint-will-change', { detail: {} })); });
  await act(async () => { finish?.(Response.json({ previewId: 'stale', items: [item], unavailable: 0, truncated: false })); });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.body.textContent).not.toContain('Original body');
});

test('changing project retires the displayed entries and unsupported runtimes never read memory', async () => {
  await render(); await click('Review memory');
  expect(document.body.textContent).toContain('Original body');
  await render('/other'); expect(document.querySelector('[role="dialog"]')).toBeNull();
  calls = []; await render('/repo', true); expect(button('Review memory').disabled).toBe(true); expect(calls).toHaveLength(0);
  await render('/spaces/0123456789ab/project'); expect(button('Review memory').disabled).toBe(true); expect(calls).toHaveLength(0);
});


test('an external rule edit refreshes the diff and requires another file confirmation', async () => {
  await render(); await click('Review memory'); await select(); await click('Preview AGENTS.md export');
  exportConflict = true; await click('Confirm file write');
  expect(document.body.textContent).toContain('# External rules');
  expect(document.body.textContent).toContain('Review the refreshed diff and confirm again.');
  expect(calls.filter((call) => call.path.endsWith('/export/confirm'))).toHaveLength(1);
  await click('Confirm file write');
  expect(calls.filter((call) => call.path.endsWith('/export/confirm'))).toHaveLength(2);
  expect(document.body.textContent).toContain('Rule file written');
});

test('language switching keeps the selected entry and shows translated review actions', async () => {
  await render(); await click('Review memory'); await select();
  await act(async () => {
    useI18nStore.getState().setLocale('zh-CN');
    if (useI18nStore.getState().loadingLocale) await new Promise<void>((resolve) => {
      const unsubscribe = useI18nStore.subscribe((state) => { if (!state.loadingLocale) { unsubscribe(); resolve(); } });
    });
  });
  expect(document.body.textContent).toContain('应用所选修改');
  expect(document.body.textContent).toContain('去除首尾空白');
  expect(document.querySelector('[role="checkbox"]')?.getAttribute('aria-checked')).toBe('true');
});
