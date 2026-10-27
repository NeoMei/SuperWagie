import { afterAll, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';

const dom = new Window({ url: 'http://library.test' });
dom.document.write('<!doctype html><html><head></head><body></body></html>');
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: dom, document: dom.document, navigator: dom.navigator, location: dom.location,
  localStorage: dom.localStorage, Element: dom.Element, HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement, HTMLButtonElement: dom.HTMLButtonElement,
  HTMLAnchorElement: dom.HTMLAnchorElement, SVGElement: dom.SVGElement, Text: dom.Text,
  DOMParser: dom.DOMParser, XMLSerializer: dom.XMLSerializer,
  ResizeObserver: dom.ResizeObserver, IntersectionObserver: dom.IntersectionObserver,
  Node: dom.Node, Event: dom.Event, MouseEvent: dom.MouseEvent, MutationObserver: dom.MutationObserver,
  getComputedStyle: dom.getComputedStyle.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
})) {
  originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

const { createRoot } = await import('react-dom/client');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { createWebAPIs } = await import('../../../../../web/src/api/index');
const { I18nProvider, useI18nStore } = await import('@/lib/i18n');
const { KnowledgeLibraryPanel } = await import('./KnowledgeLibraryPanel');

afterAll(async () => {
  await dom.happyDOM.close();
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test('gallery previews preserve image details and open only the identified source on request', async () => {
  const previousLocale = useI18nStore.getState().locale;
  useI18nStore.getState().setLocale('en');
  const apis = createWebAPIs();
  const opened: string[] = [];
  let galleryFails = false;
  apis.editor = {
    openFile: async (path) => { opened.push(path); },
    openDiff: async () => {},
  };
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input), dom.location.href);
    const path = url.pathname;
    if (path.endsWith('/status')) return Response.json({
      supported: true, enabled: true, provisioned: true, backend: { state: 'running', port: 8877 },
    });
    if (path.endsWith('/libraries')) return Response.json({ libraries: [
      { id: 'library', root: '/library', name: 'Library', slug: 'library' },
    ] });
    // The source is outside the documents page. A same-name row must not
    // override the gallery's authoritative source projection.
    if (path.endsWith('/documents')) return Response.json({ total: 5001, documents: [
      { id: 'wrong', libraryId: 'library', relPath: 'other/report.pdf', absPath: '/library/other/report.pdf', size: 32, state: 'ready' },
    ] });
    if (path.endsWith('/images') && galleryFails) return new Response(null, { status: 503 });
    if (path.endsWith('/images')) return Response.json({ total: 3, images: [
      { id: 'figure', source: { documentId: 'right', path: '/library/chosen/report.pdf', relPath: 'chosen/report.pdf' }, sourceName: 'report.pdf', caption: 'A complete figure summary.', url: 'resource://figure' },
      { id: 'orphan', source: null, sourceName: 'report.pdf', caption: '', url: 'resource://orphan' },
      { id: 'broken', source: { documentId: 'right', path: '/library/chosen/report.pdf', relPath: 'chosen/report.pdf' }, sourceName: 'report.pdf', caption: 'The image is unavailable, but its summary remains.', url: 'resource://broken' },
    ] });
    if (path.endsWith('/images/content') && url.searchParams.get('url') === 'resource://broken') {
      return new Response(null, { status: 404 });
    }
    if (path.endsWith('/images/content')) return new Response('image bytes', { headers: { 'Content-Type': 'image/png' } });
    throw new Error(`Unexpected request: ${path}`);
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const click = async (element: Element | null | undefined) => {
    if (!element) throw new Error('Expected a clickable gallery control');
    await act(async () => element.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  };
  try {
    await act(async () => root.render(
      <RuntimeAPIContext.Provider value={apis}>
        <I18nProvider><KnowledgeLibraryPanel /></I18nProvider>
      </RuntimeAPIContext.Provider>,
    ));
    await click([...host.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === 'Gallery'));
    await click([...host.querySelectorAll('button')].find((button) => button.textContent === 'A complete figure summary.'));

    const preview = document.querySelector('[role="dialog"]');
    expect(preview).not.toBeNull();
    if (!preview) throw new Error('The gallery did not open its image preview');
    expect(preview?.querySelector('img')?.getAttribute('src')?.startsWith('blob:')).toBe(true);
    expect(preview?.textContent).toContain('A complete figure summary.');
    expect(opened).toEqual([]);
    await click([...preview.querySelectorAll('button')].find((button) => button.textContent?.includes('Open source')));
    expect(opened).toEqual(['/library/chosen/report.pdf']);

    await click([...host.querySelectorAll('button')].find((button) => button.title === 'report.pdf' && button.textContent === 'report.pdf'));
    const orphan = document.querySelector('[role="dialog"]');
    expect(orphan?.textContent).toContain('No summary available.');
    expect(orphan?.textContent).toContain('Source unavailable');
    const source = [...(orphan?.querySelectorAll('button') ?? [])].find((button) => button.textContent?.includes('Open source'));
    expect(source?.disabled).toBe(true);
    expect(opened).toEqual(['/library/chosen/report.pdf']);
    await click(document.querySelector('[data-slot="dialog-close"]'));

    await click([...host.querySelectorAll('button')].find((button) => button.textContent?.startsWith('The image is unavailable')));
    const broken = document.querySelector('[role="dialog"]');
    expect(broken?.querySelector('[role="alert"]')?.textContent).toBe('Could not load this image.');
    expect(broken?.textContent).toContain('The image is unavailable, but its summary remains.');
    expect(opened).toEqual(['/library/chosen/report.pdf']);
    await click(document.querySelector('[data-slot="dialog-close"]'));

    galleryFails = true;
    await click([...host.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === 'Documents'));
    await click([...host.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === 'Gallery'));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not load the gallery.');
    expect(host.textContent).not.toContain('No images indexed yet.');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    fetch.mockRestore();
    useI18nStore.getState().setLocale(previousLocale);
  }
});
