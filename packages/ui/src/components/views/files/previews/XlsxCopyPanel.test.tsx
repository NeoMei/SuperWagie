import { afterEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { XlsxCopyInspection } from '@/lib/api/types';
import type { TableQuote } from './tableSelection';
const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage, Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement, Event: browser.Event, CustomEvent: browser.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
const { I18nProvider, useI18nStore } = await import('@/lib/i18n');
const { XlsxCopyPanel } = await import('./XlsxCopyPanel');
import type { XlsxCopyAPI } from './XlsxCopyPanel';
const { getRuntimeApiBaseUrl, getRuntimeKey, switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
const inspected: XlsxCopyInspection = { version: 'version-one', sheets: [{ name: 'Main', truncated: false, cells: [{ address: 'A1', value: '4', editable: true }, { address: 'B1', value: '9', editable: false }] }] };
let root: Root | null = null; let host: HTMLElement;
const render = async (api: XlsxCopyAPI, path = '/a/book.xlsx', onQuote?: (quote: TableQuote) => boolean) => {
  if (!root) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); }
  useI18nStore.getState().setLocale('en');
  await act(async () => root?.render(<I18nProvider><XlsxCopyPanel key={path} path={path} name="book.xlsx" api={api} onQuote={onQuote} /></I18nProvider>));
};
const click = async (text: string) => { const target = Array.from(host.querySelectorAll('button')).find((button) => button.textContent?.includes(text)); expect(target).toBeDefined(); await act(async () => target?.click()); };
const type = async (label: string, value: string) => { const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`); expect(input).not.toBeNull(); await act(async () => { Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set?.call(input, value); const event = document.createEvent('Event'); event.initEvent('input', true, false); input?.dispatchEvent(event); }); };
afterEach(async () => { await act(async () => root?.unmount()); root = null; host?.remove(); });

test('saving submits only explicitly changed cells and retains draft after a collision', async () => {
  const requests: Parameters<XlsxCopyAPI['saveXlsxCopy']>[1][] = [];
  const api: XlsxCopyAPI = { inspectXlsxCopy: async () => inspected, saveXlsxCopy: async (_path, request) => { requests.push(request); throw new Error('already-exists'); } };
  await render(api);
  await click('A1'); await type('Cell value', '12'); await click('Apply cell change');
  await click('Save new copy');
  expect(requests).toEqual([{ version: 'version-one', name: 'book-copy.xlsx', edits: [{ sheet: 'Main', address: 'A1', value: '12', kind: 'string' }] }]);
  expect(host.textContent).toContain('Choose another filename');
  expect(host.querySelector<HTMLInputElement>('input[aria-label="Cell value"]')?.value).toBe('12');
  expect(host.textContent).toContain('1 pending');
});

test('a retired inspection cannot populate the new file', async () => {
  let finish!: (value: XlsxCopyInspection) => void; let oldSignal: AbortSignal | undefined;
  const pending = new Promise<XlsxCopyInspection>((resolve) => { finish = resolve; });
  await render({ inspectXlsxCopy: async (_path, signal) => { oldSignal = signal; return pending; }, saveXlsxCopy: async () => ({ success: true, path: '/unused' }) });
  await render({ inspectXlsxCopy: async () => ({ ...inspected, sheets: [{ name: 'Other', truncated: false, cells: [] }] }), saveXlsxCopy: async () => ({ success: true, path: '/unused' }) }, '/b/book.xlsx');
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => finish(inspected));
  expect(host.textContent).not.toContain('A1');
});

test('readonly cells quote exact source coordinates and cannot enter the edit set', async () => {
  const quotes: TableQuote[] = [];
  await render({ inspectXlsxCopy: async () => inspected, saveXlsxCopy: async () => ({ success: true, path: '/unused' }) }, '/a/book.xlsx', (quote) => { quotes.push(quote); return true; });
  await click('B1'); await click('Quote');
  expect(quotes).toEqual([{ range: "'Main'!B1", values: '[["9"]]' }]);
  expect(host.querySelector<HTMLInputElement>('input[aria-label="Cell value"]')?.disabled).toBe(true);
  expect(Array.from(host.querySelectorAll('button')).find((button) => button.textContent?.includes('Apply cell change'))?.disabled).toBe(true);
});

test('a retired save cannot report its success in a replacement file', async () => {
  let finish!: (value: { success: true; path: string }) => void; let signal: AbortSignal | undefined;
  const pending = new Promise<{ success: true; path: string }>((resolve) => { finish = resolve; });
  await render({ inspectXlsxCopy: async () => inspected, saveXlsxCopy: async (_path, _request, active) => { signal = active; return pending; } });
  await click('A1'); await type('Cell value', '12'); await click('Apply cell change'); await click('Save new copy');
  await render({ inspectXlsxCopy: async () => inspected, saveXlsxCopy: async () => ({ success: true, path: '/unused' }) }, '/b/book.xlsx');
  expect(signal?.aborted).toBe(true);
  await act(async () => finish({ success: true, path: '/a/old-copy.xlsx' }));
  expect(host.textContent).not.toContain('old-copy.xlsx');
  expect(host.textContent).toContain('0 pending');
});

test('a runtime switch before view replacement cannot send the old selection to the new runtime', async () => {
  const previous = { apiBaseUrl: getRuntimeApiBaseUrl(), runtimeKey: getRuntimeKey() }; let saves = 0;
  await render({ inspectXlsxCopy: async () => inspected, saveXlsxCopy: async () => { saves++; return { success: true, path: '/wrong-runtime.xlsx' }; } });
  await click('A1'); await type('Cell value', '12'); await click('Apply cell change');
  switchRuntimeEndpoint({ apiBaseUrl: 'https://changed-runtime.test', runtimeKey: 'xlsx-test-other' });
  await click('Save new copy');
  expect(saves).toBe(0);
  switchRuntimeEndpoint(previous);
});
