import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import JSZip from 'jszip';
import type { DataPreviewKind } from './dataFilePreview';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement, Event: browser.Event, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
const { I18nProvider, useI18nStore } = await import('@/lib/i18n');
const { DataFileArtifact } = await import('./DataFileArtifact');
let root: Root | null = null;
let container: HTMLElement | null = null;
const notebook = (source: string) => new TextEncoder().encode(JSON.stringify({ nbformat: 4, cells: [{ cell_type: 'code', source, outputs: [] }] }));
const render = async (path: string, kind: DataPreviewKind, readBytes: (signal: AbortSignal, maxBytes: number) => Promise<Uint8Array>, sizeBytes: number | null = null) => {
  if (!root) { container = document.createElement('div'); document.body.append(container); root = createRoot(container); }
  useI18nStore.getState().setLocale('en');
  await act(async () => root?.render(<I18nProvider><DataFileArtifact kind={kind} name={path.split('/').pop() ?? path} path={path} revision={0} sizeBytes={sizeBytes} readBytes={readBytes} download={<button>Download original</button>} /></I18nProvider>));
};
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); root = null; container = null; });

describe('read-only data preview lifecycle', () => {
  test('shows static notebook source as text without mounting markup or executing code', async () => {
    await render('/repo/view.ipynb', 'notebook', async () => notebook('<script>throw 42</script><img src="https://example.test/leak">'));
    expect(container?.textContent).toContain('<script>throw 42</script>');
    expect(container?.querySelector('script')).toBeNull();
    expect(container?.querySelector('img')).toBeNull();
    expect(container?.querySelector('textarea')).toBeNull();
  });
  test('switching files aborts a pending read and ignores its late completion', async () => {
    let finish: (bytes: Uint8Array) => void = () => {};
    let signal: AbortSignal | undefined;
    const old = new Promise<Uint8Array>((resolve) => { finish = resolve; });
    await render('/a/same.ipynb', 'notebook', async (value) => { signal = value; return old; });
    await render('/b/same.ipynb', 'notebook', async () => notebook('new file'));
    expect(signal?.aborted).toBe(true);
    await act(async () => finish(notebook('old file')));
    expect(container?.textContent).toContain('new file');
    expect(container?.textContent).not.toContain('old file');
  });
  test('a damaged file retains the original and does not stop a later valid archive', async () => {
    await render('/repo/bad.zip', 'zip', async () => new Uint8Array([1]));
    expect(container?.textContent).toContain('damaged');
    expect(container?.textContent).toContain('Download original');
    const zip = new JSZip(); zip.file('预算.txt', 'private data');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    await render('/repo/good.zip', 'zip', async () => bytes);
    expect(container?.textContent).toContain('预算.txt');
    expect(container?.textContent).not.toContain('private data');
  });
  test('stale display size does not reject a file that now fits the bounded read', async () => {
    let limit = 0;
    await render('/repo/small.ipynb', 'notebook', async (_signal, maxBytes) => { limit = maxBytes; return notebook('fits now'); }, 99_999_999);
    expect(container?.textContent).toContain('fits now');
    expect(limit).toBe(5 * 1024 * 1024);
  });
  test('an oversized table file retains the original without starting a decoder', async () => {
    let reads = 0;
    await render('/repo/data.parquet', 'parquet', async () => { reads += 1; return new Uint8Array(20 * 1024 * 1024 + 1); });
    expect(reads).toBe(1);
    expect(container?.textContent).toContain('limit');
    expect(container?.textContent).toContain('Download original');
  });
});
