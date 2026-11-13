import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { sqliteFixture } from './sqliteFixtures.fixture';
import { readFile } from 'node:fs/promises';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement, HTMLButtonElement: browser.HTMLButtonElement,
  Event: browser.Event, MouseEvent: browser.MouseEvent, KeyboardEvent: browser.KeyboardEvent,
  getComputedStyle: browser.getComputedStyle.bind(browser), ResizeObserver: browser.ResizeObserver,
  MutationObserver: browser.MutationObserver, requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
const { I18nProvider, useI18nStore } = await import('@/lib/i18n');
const { DataTableArtifact } = await import('./DataTableArtifact');
const wasm = await readFile(new URL(import.meta.resolve('sql.js/dist/sql-wasm-browser.wasm')));
const originalFetch = globalThis.fetch;
let assetReads = 0;
globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
  if (!String(input).endsWith('sql-wasm-browser.wasm')) throw new Error(`Unexpected asset request ${input}`);
  assetReads += 1;
  return new Response(wasm);
}, originalFetch);
let root: Root | null = null;
let container: HTMLElement | null = null;
const render = async (kind: 'sqlite' | 'parquet', bytes: Uint8Array, path = '/repo/data.db', onRead = () => {}) => {
  if (!root) { container = document.createElement('div'); document.body.append(container); root = createRoot(container); }
  useI18nStore.getState().setLocale('en');
  await act(async () => root?.render(<I18nProvider><DataTableArtifact key={path} kind={kind} path={path} revision={0} sizeBytes={bytes.byteLength} readBytes={async () => { onRead(); return bytes; }} download={<button>Download original</button>} /></I18nProvider>));
};
const until = async (ready: () => boolean) => {
  for (let attempts = 0; attempts < 100 && !ready(); attempts += 1) await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 10)); });
  expect(ready()).toBe(true);
};
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); root = null; container = null; });

describe('mounted data table preview', () => {
  test('table picker and pager use the real worker without rereading or writing the source', async () => {
    let reads = 0;
    const bytes = await sqliteFixture('picker'); const before = new Uint8Array(bytes);
    await render('sqlite', bytes, '/repo/data.db', () => { reads += 1; });
    await until(() => container?.textContent?.includes('Rows 1 to 100') ?? false);
    expect(container?.querySelectorAll('tbody tr').length).toBe(100);
    expect(assetReads).toBe(1);
    const next = container?.querySelector<HTMLButtonElement>('button[aria-label="Next page"]');
    expect(next).not.toBeNull();
    expect(next?.disabled).toBe(false);
    await act(async () => next?.click());
    await until(() => container?.textContent?.includes('Rows 101 to 105') ?? false);
    expect(container?.querySelectorAll('tbody tr').length).toBe(5);
    await act(async () => container?.querySelector<HTMLButtonElement>('[role="combobox"]')?.click());
    await until(() => document.querySelectorAll('[role="option"]').length === 2);
    const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((item) => item.textContent === 'B');
    expect(option).toBeDefined();
    await act(async () => option?.click());
    await until(() => container?.textContent?.includes('second table') ?? false);
    expect(container?.textContent).toContain('Rows 1 to 1');
    expect(reads).toBe(1);
    expect(bytes).toEqual(before);
    expect(container?.querySelector('textarea,[contenteditable="true"]')).toBeNull();
  });
  test('renders actual compressed Parquet columns and local samples', async () => {
    const bytes = new Uint8Array(await readFile(new URL('./__fixtures__/small-gzip.parquet', import.meta.url)));
    await render('parquet', bytes, '/repo/data.parquet');
    await until(() => container?.textContent?.includes('Rows 1 to 3 of 3') ?? false);
    expect(container?.textContent).toContain('预算');
    expect(container?.querySelectorAll('th').length).toBe(2);
    expect(container?.querySelector('[role="combobox"]')).toBeNull();
  });
  test('a damaged file keeps its original download and a subsequent file still loads', async () => {
    await render('parquet', new Uint8Array([1]), '/repo/bad.parquet');
    await until(() => container?.textContent?.includes('damaged') ?? false);
    expect(container?.textContent).toContain('Download original');
    const bytes = new Uint8Array(await readFile(new URL('./__fixtures__/nested.parquet', import.meta.url)));
    await render('parquet', bytes, '/repo/good.parquet');
    await until(() => container?.textContent?.includes('Rows 1 to 3 of 3') ?? false);
    expect(container?.textContent).toContain('{"label":"预算"}');
  });  test('file switching terminates an active decoder before rendering the next file', async () => {
    const OriginalWorker = globalThis.Worker;
    let created = 0;
    let terminated = 0;
    class SwitchingWorker extends OriginalWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(created++ === 0 ? new URL('./__fixtures__/hung-data.worker.fixture.ts', import.meta.url) : url, options);
      }
      terminate() { terminated += 1; super.terminate(); }
    }
    globalThis.Worker = SwitchingWorker;
    try {
      const bytes = new Uint8Array(await readFile(new URL('./__fixtures__/small-gzip.parquet', import.meta.url)));
      await render('parquet', bytes, '/a/old.parquet');
      await until(() => created === 1);
      await render('parquet', bytes, '/b/new.parquet');
      await until(() => container?.textContent?.includes('Rows 1 to 3 of 3') ?? false);
      expect(terminated).toBe(2);
      expect(container?.textContent).toContain('预算');
    } finally { globalThis.Worker = OriginalWorker; }
  });
  test('a runtime without workers exposes its unsupported decoder and retains the original', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
    Reflect.deleteProperty(globalThis, 'Worker');
    try {
      const bytes = new Uint8Array(await readFile(new URL('./__fixtures__/nested.parquet', import.meta.url)));
      await render('parquet', bytes);
      await until(() => container?.textContent?.includes('local decoder could not start') ?? false);
      expect(container?.textContent).toContain('Download original');
      expect(container?.querySelectorAll('tbody tr').length).toBe(0);
    } finally { if (descriptor) Object.defineProperty(globalThis, 'Worker', descriptor); }
  });

});
