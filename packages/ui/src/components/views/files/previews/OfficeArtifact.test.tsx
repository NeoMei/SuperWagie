import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement, Event: browser.Event, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
const { I18nProvider, useI18nStore } = await import('@/lib/i18n');
const { OfficeArtifact } = await import('./OfficeArtifact');
import type { OfficeViewerMount } from './officeViewer';

let root: Root | null = null;
let container: HTMLElement | null = null;
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
const render = async (path: string, readBytes: (signal: AbortSignal) => Promise<Uint8Array>, mountViewer: OfficeViewerMount, revision = 0, sizeBytes: number | null = null) => {
  if (!root) { container = document.createElement('div'); document.body.append(container); root = createRoot(container); }
  useI18nStore.getState().setLocale('en');
  await act(async () => root?.render(<I18nProvider><OfficeArtifact name="same.xlsx" path={path} sizeBytes={sizeBytes} revision={revision} readBytes={readBytes} mountViewer={mountViewer} /></I18nProvider>));
};
const mount: OfficeViewerMount = async (_kind, _input, host) => { host.textContent = 'mounted'; return { dispose() { host.replaceChildren(); } }; };
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); root = null; container = null; });

describe('Office preview lifecycle', () => {
  test('a stale display size does not veto a newer bounded read after the file shrinks', async () => {
    let reads = 0;
    await render('/a/same.xlsx', async () => { reads += 1; return new Uint8Array([1]); }, mount, 1, 31_457_281);
    expect(reads).toBe(1);
    expect(container?.textContent).toContain('mounted');
  });
  test('a read failure exposes retry and a new attempt returns to loading then renders', async () => {
    let reads = 0;
    const next = deferred<Uint8Array>();
    await render('/a/same.xlsx', async () => { if (++reads === 1) throw new Error('failed read'); return next.promise; }, mount);
    expect(container?.textContent).toContain('failed read');
    const button = Array.from(container?.querySelectorAll('button') ?? []).find((element) => element.textContent === 'Retry');
    expect(button).toBeDefined();
    await act(async () => button?.click());
    expect(reads).toBe(2);
    expect(container?.textContent).toContain('Opening file');
    await act(async () => next.resolve(new Uint8Array([1])));
    expect(container?.textContent).toContain('mounted');
    expect(container?.textContent).not.toContain('failed read');
  });

  test('same-name path changes abort the old read before it can mount', async () => {
    const old = deferred<Uint8Array>(); let signal: AbortSignal | undefined; let mounts = 0;
    const counted: OfficeViewerMount = async (...args) => { mounts += 1; return mount(...args); };
    await render('/a/same.xlsx', async (value) => { signal = value; return old.promise; }, counted);
    await render('/b/same.xlsx', async () => new Uint8Array([2]), counted);
    expect(signal?.aborted).toBe(true);
    await act(async () => old.resolve(new Uint8Array([1])));
    expect(mounts).toBe(1);
    expect(container?.textContent).toContain('mounted');
  });

  test('a late mount is disposed in its own detached host and cannot clear the current viewer', async () => {
    const old = deferred<{ dispose(): void }>(); let oldHost: HTMLElement | undefined; let oldSignal: AbortSignal | undefined; let disposed = 0;
    const delayed: OfficeViewerMount = async (_kind, _input, host, signal) => { oldHost = host; oldSignal = signal; return old.promise; };
    await render('/a/same.xlsx', async () => new Uint8Array([1]), delayed);
    await render('/b/same.xlsx', async () => new Uint8Array([2]), mount);
    expect(oldSignal?.aborted).toBe(true);
    expect(oldHost?.isConnected).toBe(false);
    await act(async () => old.resolve({ dispose() { disposed += 1; oldHost?.replaceChildren(); } }));
    expect(disposed).toBe(1);
    expect(container?.textContent).toContain('mounted');
  });

  test('revision refresh disposes its old viewer and unmount aborts the current owner', async () => {
    let disposals = 0; const signals: AbortSignal[] = [];
    const mounted: OfficeViewerMount = async (_kind, _input, _host, signal) => { signals.push(signal); return { dispose() { disposals += 1; } }; };
    const read = async () => new Uint8Array([1]);
    await render('/a/same.xlsx', read, mounted);
    await render('/a/same.xlsx', read, mounted, 1);
    expect(disposals).toBe(1);
    expect(signals[0]?.aborted).toBe(true);
    await act(async () => root?.unmount()); root = null;
    expect(signals[1]?.aborted).toBe(true);
    expect(disposals).toBe(2);
  });

  test('an obsolete read failure cannot replace a newly ready viewer', async () => {
    let reject!: (error: Error) => void;
    const pending = new Promise<Uint8Array>((_resolve, fail) => { reject = fail; });
    await render('/a/same.xlsx', async () => pending, mount);
    await render('/b/same.xlsx', async () => new Uint8Array([2]), mount);
    await act(async () => reject(new Error('stale failure')));
    expect(container?.textContent).toContain('mounted');
    expect(container?.textContent).not.toContain('stale failure');
  });

  test('locale changes translate held loading without rereading the document', async () => {
    let reads = 0;
    const pending = deferred<Uint8Array>();
    await render('/a/same.xlsx', async () => { reads += 1; return pending.promise; }, mount);
    await act(async () => {
      useI18nStore.getState().setLocale('zh-CN');
      if (useI18nStore.getState().loadingLocale) await new Promise<void>((resolve) => {
        const unsubscribe = useI18nStore.subscribe((state) => { if (!state.loadingLocale) { unsubscribe(); resolve(); } });
      });
    });
    expect(container?.textContent).toContain('正在打开文件');
    expect(reads).toBe(1);
  });
});
