import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { McpDraft } from '@/stores/useMcpConfigStore';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement, HTMLTextAreaElement: browser.HTMLTextAreaElement,
  Event: browser.Event, MouseEvent: browser.MouseEvent, FocusEvent: browser.FocusEvent, CustomEvent: browser.CustomEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
  const path = new URL(input instanceof Request ? input.url : String(input), 'http://localhost').pathname;
  if (path.endsWith('/integration')) return Response.json({ location: { directory: '/fixture' }, data: [] });
  if (path.endsWith('/mcp') || path.endsWith('/config')) return Response.json([]);
  return Response.json({ home: '/fixture' });
});
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { useI18nStore } = await import('@/lib/i18n/store');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { useMcpConfigStore } = await import('@/stores/useMcpConfigStore');
const { useMcpStore } = await import('@/stores/useMcpStore');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { useUIStore } = await import('@/stores/useUIStore');
const { opencodeClient } = await import('@/lib/opencode/client');
const { switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
const { toast } = await import('@/components/ui');
const { McpPage } = await import('./McpPage');
const { McpGrid } = await import('./McpGrid');
const policy = spyOn(opencodeClient, 'getIntegrationPolicies').mockResolvedValue([]);
const success = spyOn(toast, 'success').mockImplementation(() => 'success');
const warning = spyOn(toast, 'warning').mockImplementation(() => 'warning');
const error = spyOn(toast, 'error').mockImplementation(() => 'error');
const originalConfig = useMcpConfigStore.getState();
const originalRuntime = useMcpStore.getState();
const draft = (name = 'lab'): McpDraft => ({
  name, scope: 'user', type: 'remote', command: [], url: 'https://mcp.test', environment: [], headers: [],
  oauthEnabled: false, oauthClientId: '', oauthClientSecret: '', oauthScope: '', oauthRedirectUri: '',
  oauthCallbackPort: '', oauthAuthServerMetadataUrl: '', protocol: 'legacy', timeoutStartup: '',
  timeoutCatalog: '', timeoutExecution: '', codemode: 'default', disabled: false,
});
const deferred = <T,>() => {
  let finish: (value: T) => void = () => { throw new Error('deferred not initialized'); };
  let fail: (reason: Error) => void = () => { throw new Error('deferred not initialized'); };
  const promise = new Promise<T>((resolve, reject) => { finish = resolve; fail = reject; });
  return { promise, finish, fail };
};
type Result = Awaited<ReturnType<typeof originalConfig.createMcp>>;
let root: ReturnType<typeof createRoot> | null = null;
let refreshCalls = 0;
let refreshImpl = async () => {};
const switchTo = (id: string) => switchRuntimeEndpoint({ apiBaseUrl: `http://runtime-${id}.invalid`, runtimeKey: `page-${id}` });
const button = (label: string, selector = 'button') => {
  const found = [...document.querySelectorAll<HTMLButtonElement>(selector)].find((node) => node.textContent?.trim() === label);
  if (!found) throw new Error(`Missing ${label} button`);
  return found;
};
const render = async (kind: 'create' | 'delete' | 'grid', mutation: Promise<Result>) => {
  switchTo('a');
  refreshCalls = 0; refreshImpl = async () => {};
  useProjectsStore.setState({ projects: [{ id: 'fixture', path: '/fixture' }], activeProjectId: 'fixture' });
  useUIStore.setState({ settingsProjectPath: '/fixture' });
  useI18nStore.getState().setLocale('en');
  const server = { name: 'lab', type: 'remote' as const, url: 'https://mcp.test', oauth: false as const };
  useMcpConfigStore.setState({
    ...originalConfig, selectedMcpName: kind === 'grid' ? null : 'lab', mcpDraft: kind === 'create' ? draft() : null,
    serversByDirectory: { '/fixture': kind === 'create' ? [] : [server] },
    loadMcpConfigs: async () => true,
    createMcp: async () => mutation, deleteMcp: async () => mutation,
  });
  useMcpStore.setState({ ...originalRuntime, byDirectory: {}, refresh: async () => { refreshCalls += 1; await refreshImpl(); } });
  const container = document.createElement('div'); document.body.replaceChildren(container);
  root = createRoot(container);
  await act(async () => { root?.render(<I18nProvider><ThemeSystemProvider>{kind === 'grid' ? <McpGrid /> : <McpPage />}</ThemeSystemProvider></I18nProvider>); });
  success.mockClear(); warning.mockClear(); error.mockClear();
  if (kind === 'create') await act(async () => button('Create').click());
  else {
    if (kind === 'grid') {
      const actions = document.querySelector<HTMLButtonElement>('[aria-label="Actions for lab"]');
      if (!actions) throw new Error('Missing actions');
      await act(async () => actions.click());
      const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((node) => node.textContent?.includes('Delete'));
      if (!item) throw new Error('Missing Delete menu item');
      await act(async () => item.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    } else await act(async () => button('Delete').click());
    await act(async () => button('Delete', '[role="dialog"] button').click());
  }
  return refreshCalls;
};
afterEach(async () => {
  await act(async () => root?.unmount()); root = null;
  useMcpConfigStore.setState(originalConfig); useMcpStore.setState(originalRuntime);
});
afterAll(() => { policy.mockRestore(); success.mockRestore(); warning.mockRestore(); error.mockRestore(); fetchSpy.mockRestore(); browser.close(); });

for (const returnToA of [false, true]) {
  for (const outcome of ['success', 'false', 'throw']) {
    test(`create ignores retired ${outcome} after ${returnToA ? 'A-to-B-to-A' : 'A-to-B'}`, async () => {
      const mutation = deferred<Result>();
      await render('create', mutation.promise);
      const newer = draft('newer');
      await act(async () => {
        switchTo('b'); if (returnToA) switchTo('a');
        useMcpConfigStore.setState({ selectedMcpName: 'newer', mcpDraft: newer });
      });
      const reads = refreshCalls;
      await act(async () => { if (outcome === 'throw') mutation.fail(new Error('old error')); else mutation.finish({ ok: outcome === 'success' }); });
      expect(useMcpConfigStore.getState().mcpDraft).toBe(newer);
      expect(useMcpConfigStore.getState().selectedMcpName).toBe('newer');
      expect(refreshCalls).toBe(reads);
      expect(success).not.toHaveBeenCalled(); expect(warning).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
    });
  }
}

test('create preserves a replacement draft on the same runtime', async () => {
  const mutation = deferred<Result>(); await render('create', mutation.promise);
  const newer = draft('newer');
  await act(async () => useMcpConfigStore.setState({ selectedMcpName: 'newer', mcpDraft: newer }));
  const reads = refreshCalls;
  await act(async () => mutation.finish({ ok: true }));
  expect(useMcpConfigStore.getState().mcpDraft).toBe(newer);
  expect(useMcpConfigStore.getState().selectedMcpName).toBe('newer');
  expect(refreshCalls).toBe(reads); expect(success).not.toHaveBeenCalled();
});

test('create returns without clearing its draft or refreshing when ok is false', async () => {
  const mutation = deferred<Result>(); const reads = await render('create', mutation.promise);
  const current = useMcpConfigStore.getState().mcpDraft;
  await act(async () => mutation.finish({ ok: false }));
  expect(useMcpConfigStore.getState().mcpDraft).toBe(current);
  expect(refreshCalls).toBe(reads); expect(success).not.toHaveBeenCalled();
});

test('create ignores success after a runtime switch during its status refresh', async () => {
  const mutation = deferred<Result>(); await render('create', mutation.promise);
  const status = deferred<void>(); refreshImpl = () => status.promise;
  await act(async () => mutation.finish({ ok: true }));
  const newer = draft('newer');
  await act(async () => { switchTo('b'); useMcpConfigStore.setState({ selectedMcpName: 'newer', mcpDraft: newer }); });
  await act(async () => status.finish());
  expect(useMcpConfigStore.getState().mcpDraft).toBe(newer);
  expect(success).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
});

for (const outcome of ['success', 'false', 'throw']) {
  test(`current-owner create ${outcome} retains its normal outcome`, async () => {
    const mutation = deferred<Result>(); const reads = await render('create', mutation.promise);
    await act(async () => { if (outcome === 'throw') mutation.fail(new Error('denied')); else mutation.finish({ ok: outcome === 'success' }); });
    expect(useMcpConfigStore.getState().mcpDraft === null).toBe(outcome === 'success');
    expect(refreshCalls - reads).toBe(outcome === 'success' ? 1 : 0);
    expect(success.mock.calls.length).toBe(outcome === 'success' ? 1 : 0);
    if (outcome === 'throw') expect(error).toHaveBeenCalledWith('denied');
  });
}

for (const kind of ['delete', 'grid'] as const) {
  for (const ok of [true, false]) {
    test(`${kind} ignores ${ok ? 'success' : 'failure'} on a retired runtime`, async () => {
      const mutation = deferred<Result>(); await render(kind, mutation.promise);
      await act(async () => { switchTo('b'); switchTo('a'); useMcpConfigStore.setState({ selectedMcpName: 'lab' }); });
      await act(async () => mutation.finish({ ok }));
      expect(useMcpConfigStore.getState().selectedMcpName).toBe('lab');
      expect(success).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
    });
  }
}

for (const kind of ['create', 'delete'] as const) {
  test(`${kind} cannot resume after selecting another server and returning in one render batch`, async () => {
    const mutation = deferred<Result>(); await render(kind, mutation.promise);
    const currentDraft = useMcpConfigStore.getState().mcpDraft;
    await act(async () => {
      useMcpConfigStore.getState().setSelectedMcp('other');
      useMcpConfigStore.getState().setSelectedMcp('lab');
    });
    const reads = refreshCalls;
    await act(async () => mutation.finish({ ok: true }));
    expect(useMcpConfigStore.getState().mcpDraft).toBe(currentDraft);
    expect(refreshCalls).toBe(reads); expect(success).not.toHaveBeenCalled();
  });
}

for (const kind of ['create', 'delete', 'grid'] as const) {
  test(`${kind} drops completion when its page unmounts`, async () => {
    const mutation = deferred<Result>(); await render(kind, mutation.promise);
    await act(async () => root?.unmount()); root = null;
    const newer = draft('newer');
    useMcpConfigStore.setState({ selectedMcpName: 'newer', mcpDraft: newer });
    const reads = refreshCalls;
    await act(async () => mutation.finish({ ok: true }));
    expect(useMcpConfigStore.getState().mcpDraft).toBe(newer);
    expect(refreshCalls).toBe(reads); expect(success).not.toHaveBeenCalled();
  });
}

for (const kind of ['delete', 'grid'] as const) {
  for (const ok of [true, false]) {
    test(`${kind} current-owner ${ok ? 'success' : 'failure'} keeps its normal toast`, async () => {
      const mutation = deferred<Result>(); await render(kind, mutation.promise);
      if (ok && kind === 'delete') await act(async () => useMcpConfigStore.getState().setSelectedMcp(null));
      await act(async () => mutation.finish({ ok }));
      expect(success.mock.calls.length).toBe(ok ? 1 : 0);
      expect(error.mock.calls.length).toBe(ok ? 0 : 1);
    });
  }
}

for (const kind of ['create', 'delete', 'grid'] as const) {
  test(`${kind} keeps the reload-failure warning for its current owner`, async () => {
    const mutation = deferred<Result>(); await render(kind, mutation.promise);
    await act(async () => mutation.finish({ ok: true, reloadFailed: true, message: 'saved with warning', warning: 'retry refresh' }));
    expect(warning).toHaveBeenCalledWith('saved with warning', { description: 'retry refresh' });
    expect(success).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
  });
}

test('retired page cleanup preserves the next runtime selection and draft', async () => {
  const mutation = deferred<Result>(); await render('create', mutation.promise);
  const newer = draft('newer');
  await act(async () => {
    switchTo('b');
    useMcpConfigStore.setState({ selectedMcpName: 'newer', mcpDraft: newer });
    root?.unmount(); root = null;
  });
  expect(useMcpConfigStore.getState().selectedMcpName).toBe('newer');
  expect(useMcpConfigStore.getState().mcpDraft).toBe(newer);
  await act(async () => mutation.finish({ ok: false }));
});

for (const outcome of ['success', 'failure', 'warning']) {
  test(`reopening the deleted grid row preserves its newer confirmation after old ${outcome}`, async () => {
    const mutation = deferred<Result>(); await render('delete', mutation.promise);
    // DELETE clears selection before its follow-up catalog GET settles.
    await act(async () => useMcpConfigStore.getState().setSelectedMcp(null));
    const card = [...document.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.includes('lab'));
    if (!card) throw new Error('Missing selectable stale catalog card');
    await act(async () => card.click());
    expect(useMcpConfigStore.getState().selectedMcpName).toBe('lab');
    await act(async () => button('Delete').click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => mutation.finish(outcome === 'warning'
      ? { ok: true, reloadFailed: true, message: 'old warning' }
      : { ok: outcome === 'success' }));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(button('Delete', '[role="dialog"] button').disabled).toBe(false);
    expect(success).not.toHaveBeenCalled(); expect(warning).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
  });
}
