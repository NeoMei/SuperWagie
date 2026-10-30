import { expect, jest, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';

test('indexing indicators stop their clock while the mounted library is hidden and resume when shown', async () => {
  const dom = new Window({ url: 'http://library.test' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator, location: dom.location,
    localStorage: dom.localStorage, Element: dom.Element, HTMLElement: dom.HTMLElement,
    HTMLInputElement: dom.HTMLInputElement, Node: dom.Node, Event: dom.Event, KeyboardEvent: dom.KeyboardEvent,
    MutationObserver: dom.MutationObserver, getComputedStyle: dom.getComputedStyle.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }

  const { createRoot } = await import('react-dom/client');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { createWebAPIs } = await import('../../../../../web/src/api/index');
  const { I18nProvider, useI18nStore } = await import('@/lib/i18n');
  const { getRuntimeUrlResolver, setRuntimeUrlResolver } = await import('@/lib/runtime-url');
  const { KnowledgeLibraryPanel } = await import('./KnowledgeLibraryPanel');
  const previousResolver = getRuntimeUrlResolver();
  const previousLocale = useI18nStore.getState().locale;
  const apis = createWebAPIs();
  useI18nStore.getState().setLocale('en');

  let requests = 0;
  let searches = 0; let pendingSearch = false;
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    requests += 1;
    const path = new URL(input instanceof Request ? input.url : String(input), dom.location.href).pathname;
    if (path.endsWith('/search')) { searches += 1; return pendingSearch ? Response.json({ error: 'knowledge_work_outcome_pending' }, { status: 503 }) : Response.json({ query: 'needle', documents: [], passages: [] }); }
    if (path.endsWith('/status')) return Response.json({
      supported: true, enabled: true, provisioned: true, backend: { state: 'running', port: 8877 },
    });
    if (path.endsWith('/libraries')) return Response.json({ libraries: [
      { id: 'library', root: '/library', name: 'Library', slug: 'library' },
    ] });
    if (path.endsWith('/documents')) return Response.json({ total: 1, documents: [
      { id: 'document', libraryId: 'library', relPath: 'report.md', absPath: '/library/report.md', size: 32, state: 'parsing' },
    ] });
    throw new Error(`Unexpected request: ${path}`);
  });
  jest.useFakeTimers();
  const setInterval = spyOn(window, 'setInterval');
  const clearInterval = spyOn(window, 'clearInterval');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (visible: boolean) => act(async () => root.render(
    <RuntimeAPIContext.Provider value={apis}>
      <I18nProvider><KnowledgeLibraryPanel visible={visible} /></I18nProvider>
    </RuntimeAPIContext.Provider>,
  ));
  const advance = (milliseconds: number) => act(async () => { jest.advanceTimersByTime(milliseconds); });
  const documentDot = () => {
    const row = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('report.md'));
    const dot = row?.querySelector('span[aria-hidden]');
    if (!dot) throw new Error('The parsing document did not render its status dot');
    return dot;
  };
  const spinnerPhase = () => host.querySelector('[data-spinner] path')?.getAttribute('opacity');
  try {
    await render(true);
    expect(documentDot().classList.contains('waiting-dim')).toBe(false);
    const firstPhase = spinnerPhase();
    expect(firstPhase).toBe('1');
    await advance(250);
    expect(spinnerPhase()).not.toBe(firstPhase);
    await advance(750);
    expect(documentDot().classList.contains('waiting-dim')).toBe(true);
    expect(setInterval.mock.calls.map((call) => call[1])).toEqual([250]);

    await render(false);
    const hiddenDot = documentDot();
    const hiddenClass = hiddenDot.className;
    const hiddenPhase = spinnerPhase();
    const hiddenRequests = requests;
    expect(clearInterval.mock.calls.length).toBe(setInterval.mock.calls.length);
    const hiddenTimerStarts = setInterval.mock.calls.length;
    await advance(6000);
    expect(documentDot()).toBe(hiddenDot);
    expect(documentDot().className).toBe(hiddenClass);
    expect(spinnerPhase()).toBe(hiddenPhase);
    expect(requests).toBe(hiddenRequests);
    expect(setInterval.mock.calls.length).toBe(hiddenTimerStarts);

    await render(true);
    expect(setInterval.mock.calls.length - clearInterval.mock.calls.length).toBe(1);
    expect(setInterval.mock.calls.at(-1)?.[1]).toBe(250);
    expect(documentDot().classList.contains('waiting-dim')).toBe(false);
    await advance(1000);
    expect(documentDot().classList.contains('waiting-dim')).toBe(true);
    expect(requests).toBeGreaterThan(hiddenRequests);

    // Draft input and polling must not create a billable semantic action.
    const search = host.querySelector('input');
    if (!search) throw new Error('Search input is missing');
    const setValue = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')?.set;
    if (!setValue) throw new Error('Input setter is missing');
    await act(async () => { setValue.call(search, 'needle'); search.dispatchEvent(new Event('input', { bubbles: true })); });
    await advance(6_000);
    expect(searches).toBe(0);
    await act(async () => { search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true })); });
    expect(searches).toBe(0);
    await act(async () => { search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(searches).toBe(1);
    await act(async () => { search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, repeat: true })); });
    await advance(6_000);
    expect(searches).toBe(1);
    pendingSearch = true;
    await act(async () => { search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(searches).toBe(2);
    expect(host.textContent).toContain('Search is still running. Continue this search shortly.');
    expect(host.textContent).not.toContain('knowledge_work_outcome_pending');
    expect(host.textContent).not.toContain('Search failed.');
    await act(async () => {
      const loaded = new Promise<void>((resolve) => {
        const unsubscribe = useI18nStore.subscribe((state) => { if (state.locale === 'zh-CN' && state.loadingLocale === null) { unsubscribe(); resolve(); } });
      });
      useI18nStore.getState().setLocale('zh-CN'); await loaded;
    });
    expect(host.textContent).toContain('检索仍在进行，请稍后继续查询');
    await advance(6_000); expect(searches).toBe(2);
    pendingSearch = false;
    await act(async () => { search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(searches).toBe(3); expect(host.textContent).not.toContain('检索仍在进行');

  } finally {
    await act(async () => root.unmount());
    setInterval.mockRestore();
    clearInterval.mockRestore();
    jest.useRealTimers();
    fetch.mockRestore();
    setRuntimeUrlResolver(previousResolver);
    useI18nStore.getState().setLocale(previousLocale);
    await dom.happyDOM.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
