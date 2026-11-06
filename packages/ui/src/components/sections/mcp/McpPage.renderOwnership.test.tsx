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
const server = (name = 'lab', url = 'https://initial.test') => ({ name, type: 'remote' as const, url, oauth: false as const });
const draft = (url = 'https://draft-a.test'): McpDraft => ({
  name: 'lab', scope: 'user', type: 'remote', command: [], url, environment: [], headers: [],
  oauthEnabled: false, oauthClientId: '', oauthClientSecret: '', oauthScope: '', oauthRedirectUri: '',
  oauthCallbackPort: '', oauthAuthServerMetadataUrl: '', protocol: 'legacy', timeoutStartup: '',
  timeoutCatalog: '', timeoutExecution: '', codemode: 'default', disabled: false,
});
const deferred = <T,>() => {
  let finish: (value: T) => void = () => { throw new Error('Uninitialized deferred'); };
  const promise = new Promise<T>((resolve) => { finish = resolve; });
  return { promise, finish };
};
const writes: Array<{ method: string; url: string; body: string }> = [];
let mutationReply = async () => Response.json({});
let catalogReply = async (_url: URL) => Response.json([server(), server('other', 'https://other.test')]);
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  if (url.pathname.startsWith('/api/config/mcp/') && method !== 'GET') {
    writes.push({ method, url: url.href, body: String(init?.body ?? '') });
    return mutationReply();
  }
  if (url.pathname === '/api/config/mcp') return catalogReply(url);
  if (url.pathname.endsWith('/integration')) return Response.json({ location: { directory: '/fixture' }, data: [] });
  if (url.pathname.endsWith('/mcp') || url.pathname.endsWith('/config')) return Response.json([]);
  return Response.json({ home: '/fixture' });
});
const { act, useLayoutEffect } = await import('react');
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
let root: ReturnType<typeof createRoot> | null = null;
let layoutAction: (() => void) | null = null;
const Witness = () => {
  const currentDraft = useMcpConfigStore((state) => state.mcpDraft);
  useLayoutEffect(() => { layoutAction?.(); }, [currentDraft]);
  return null;
};
const switchTo = (id: string) => switchRuntimeEndpoint({ apiBaseUrl: `http://mcp-${id}.invalid`, runtimeKey: `mcp-${id}` });
const button = (label: string, selector = 'button') => {
  const node = [...document.querySelectorAll<HTMLButtonElement>(selector)].find((entry) => entry.textContent?.trim() === label);
  if (!node) throw new Error(`Missing ${label}`);
  return node;
};
const urlField = () => {
  const field = [...document.querySelectorAll<HTMLInputElement>('input')].find((entry) => entry.value.startsWith('https://'));
  if (!field) throw new Error('Missing URL field');
  return field;
};
const edit = async (value: string, blur = true) => {
  const field = urlField();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) throw new Error('Missing input setter');
  await act(async () => { setter.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); });
  if (blur) await act(async () => field.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
};
const render = async (kind: 'draft' | 'detail' | 'grid' = 'detail') => {
  switchTo('a');
  layoutAction = null;
  mutationReply = async () => Response.json({});
  catalogReply = async () => Response.json([server(), server('other', 'https://other.test')]);
  useProjectsStore.setState({ projects: [{ id: 'fixture', path: '/fixture' }, { id: 'other', path: '/other' }], activeProjectId: 'fixture' });
  useUIStore.setState({ settingsProjectPath: '/fixture' });
  useI18nStore.getState().setLocale('en');
  useMcpConfigStore.setState({ ...originalConfig, selectedMcpName: kind === 'grid' ? null : 'lab',
    mcpDraft: kind === 'draft' ? draft() : null, serversByDirectory: { '/fixture': kind === 'draft' ? [] : [server(), server('other')] } });
  useMcpStore.setState({ ...originalRuntime, byDirectory: {}, refresh: async () => {} });
  const container = document.createElement('div'); document.body.replaceChildren(container);
  root = createRoot(container);
  await act(async () => root?.render(<I18nProvider><ThemeSystemProvider>
    {kind === 'grid' ? <McpGrid /> : <McpPage />}<Witness />
  </ThemeSystemProvider></I18nProvider>));
  writes.length = 0; success.mockClear(); warning.mockClear(); error.mockClear();
};
const confirmDelete = async (kind: 'detail' | 'grid') => {
  if (kind === 'grid') {
    const actions = document.querySelector<HTMLButtonElement>('[aria-label="Actions for lab"]');
    if (!actions) throw new Error('Missing actions');
    await act(async () => actions.click());
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((entry) => entry.textContent?.includes('Delete'));
    if (!item) throw new Error('Missing Delete menu item');
    await act(async () => item.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  } else await act(async () => button('Delete').click());
  return button('Delete', '[role="dialog"] button');
};
afterEach(async () => {
  layoutAction = null;
  await act(async () => root?.unmount()); root = null;
  useMcpConfigStore.getState().resetForRuntimeSwitch();
  useMcpConfigStore.setState(originalConfig); useMcpStore.setState(originalRuntime);
});
afterAll(() => { policy.mockRestore(); success.mockRestore(); warning.mockRestore(); error.mockRestore(); fetchSpy.mockRestore(); browser.close(); });

for (const kind of ['detail', 'grid'] as const) {
  for (const transition of ['selection', 'directory', 'directory-roundtrip', 'active-fallback', 'removed-project']) {
    test(`${kind} old confirmation rejects authoritative ${transition} before commit`, async () => {
      await render(kind);
      const action = await confirmDelete(kind);
      await act(async () => {
        if (transition === 'selection') useMcpConfigStore.getState().setSelectedMcp('other');
        else if (transition === 'active-fallback') {
          useUIStore.setState({ settingsProjectPath: null });
          useProjectsStore.setState({ activeProjectId: 'other' });
        } else if (transition === 'removed-project') useProjectsStore.setState({ projects: [{ id: 'other', path: '/other' }], activeProjectId: 'other' });
        else {
          useUIStore.setState({ settingsProjectPath: '/other' });
          if (transition.endsWith('roundtrip')) useUIStore.setState({ settingsProjectPath: '/fixture' });
        }
        action.click();
      });
      expect(writes).toEqual([]);
      expect(error).not.toHaveBeenCalled(); expect(success).not.toHaveBeenCalled();
    });
  }
}

test('same-name draft replacement retires the old Create and the new form submits its own values', async () => {
  await render('draft');
  const action = button('Create');
  await act(async () => {
    useMcpConfigStore.getState().setMcpDraft(draft('https://draft-b.test'));
    action.click();
  });
  expect(writes).toEqual([]);
  await act(async () => button('Create').click());
  expect(writes).toHaveLength(1);
  expect(writes[0].body).toContain('https://draft-b.test');
});

test('a current render cannot create with fields whose draft hydration has not committed', async () => {
  await render('draft');
  layoutAction = () => { layoutAction = null; button('Create').click(); };
  await act(async () => useMcpConfigStore.getState().setMcpDraft(draft('https://hydrated-b.test')));
  expect(writes).toEqual([]);
  await act(async () => button('Create').click());
  expect(writes).toHaveLength(1);
  expect(writes[0].body).toContain('https://hydrated-b.test');
});

for (const transition of ['directory', 'runtime'] as const) {
  for (const outcome of ['pending', 'failed'] as const) {
    test(`${transition} ${outcome} catalog cannot authorize a retained previous form`, async () => {
      await render();
      const catalog = deferred<Response>();
      catalogReply = () => catalog.promise;
      let read: Promise<boolean> = Promise.resolve(false);
      await act(async () => {
        if (transition === 'runtime') { switchTo('b'); useMcpConfigStore.getState().resetForRuntimeSwitch(); }
        else useUIStore.setState({ settingsProjectPath: '/other' });
        read = useMcpConfigStore.getState().loadMcpConfigs({ force: true, directory: transition === 'runtime' ? '/fixture' : '/other' });
      });
      if (outcome === 'failed') await act(async () => { catalog.finish(Response.json({ error: 'fixture read failure' }, { status: 500 })); await read; });
      await edit('https://retained-a.test');
      const retainedWrites = writes.slice();
      if (outcome === 'pending') await act(async () => { catalog.finish(Response.json([server('lab', 'https://hydrated-b.test')])); await read; });
      else {
        catalogReply = async () => Response.json([server('lab', 'https://hydrated-b.test')]);
        await act(async () => { await useMcpConfigStore.getState().loadMcpConfigs({ force: true, directory: transition === 'runtime' ? '/fixture' : '/other' }); });
      }
      expect(urlField().value).toBe('https://hydrated-b.test');
      catalogReply = async () => Response.json([server('lab', 'https://edited-b.test')]);
      await edit('https://edited-b.test');
      expect(writes).toHaveLength(1);
      expect(writes[0].url).toContain(transition === 'runtime' ? 'http://mcp-b.invalid/' : 'directory=%2Fother');
      expect(writes[0].body).toContain('https://edited-b.test');
      expect(retainedWrites).toEqual([]);
    });
  }
}

test('current serialized saves preserve a newer edit through successful catalog echoes', async () => {
  await render();
  const first = deferred<Response>();
  mutationReply = () => writes.length === 1 ? first.promise : Promise.resolve(Response.json({}));
  await edit('https://first.test');
  await edit('https://second.test');
  expect(writes).toHaveLength(1);
  await act(async () => first.finish(Response.json({})));
  expect(writes).toHaveLength(2);
  expect(writes[0].body).toContain('https://first.test');
  expect(writes[1].body).toContain('https://second.test');
  expect(urlField().value).toBe('https://second.test');
  expect(error).not.toHaveBeenCalled();
});

test('current failed save retains its dirty form for a successful retry', async () => {
  await render();
  mutationReply = async () => Response.json({ error: 'fixture denied' }, { status: 403 });
  await edit('https://retry.test');
  expect(writes).toHaveLength(1); expect(error).toHaveBeenCalledTimes(1);
  mutationReply = async () => Response.json({});
  await act(async () => urlField().dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
  expect(writes).toHaveLength(2);
  expect(writes[1].body).toBe(writes[0].body);
  expect(urlField().value).toBe('https://retry.test');
});

test('real current delete retains its own store-owned null clear and success', async () => {
  await render();
  const action = await confirmDelete('detail');
  await act(async () => action.click());
  expect(writes).toHaveLength(1); expect(writes[0].method).toBe('DELETE');
  expect(useMcpConfigStore.getState().selectedMcpName).toBeNull();
  expect(success).toHaveBeenCalledTimes(1); expect(error).not.toHaveBeenCalled();
});

test('same-owner loaded catalog refresh preserves dirty content and its save authority', async () => {
  await render();
  await edit('https://dirty.test', false);
  await act(async () => { await useMcpConfigStore.getState().loadMcpConfigs({ force: true, directory: '/fixture' }); });
  expect(urlField().value).toBe('https://dirty.test');
  await act(async () => urlField().dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
  expect(writes).toHaveLength(1); expect(writes[0].body).toContain('https://dirty.test');
});

for (const empty of [false, true]) {
  test(`a successful ${empty ? 'empty' : 'remaining-entry'} catalog revokes a removed selected form until fresh hydration`, async () => {
    await render();
    await edit('https://removed-dirty.test', false);
    catalogReply = async () => Response.json(empty ? [] : [server('other')]);
    await act(async () => { await useMcpConfigStore.getState().loadMcpConfigs({ force: true, directory: '/fixture' }); });
    expect(useMcpConfigStore.getState().getMcpByName('lab', '/fixture')).toBeUndefined();
    expect(urlField().value).toBe('https://removed-dirty.test');
    await act(async () => urlField().dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(writes).toEqual([]);
    catalogReply = async () => Response.json([server('lab', 'https://returned.test')]);
    await act(async () => { await useMcpConfigStore.getState().loadMcpConfigs({ force: true, directory: '/fixture' }); });
    expect(urlField().value).toBe('https://returned.test');
    await edit('https://current-returned.test');
    expect(writes).toHaveLength(1);
    expect(writes[0].body).toContain('https://current-returned.test');
  });
}

test('a catalog removal and reappearance batched before commit requires freshly hydrated fields', async () => {
  await render();
  await edit('https://removed-dirty.test', false);
  await act(async () => {
    catalogReply = async () => Response.json([server('other')]);
    await useMcpConfigStore.getState().loadMcpConfigs({ force: true, directory: '/fixture' });
    catalogReply = async () => Response.json([server('lab', 'https://returned.test')]);
    await useMcpConfigStore.getState().loadMcpConfigs({ force: true, directory: '/fixture' });
    urlField().dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
  expect(writes).toEqual([]);
  expect(urlField().value).toBe('https://returned.test');
  await edit('https://current-returned.test');
  expect(writes).toHaveLength(1);
  expect(writes[0].body).toContain('https://current-returned.test');
});

test('a failed same-owner catalog refresh preserves its known entry and dirty save authority', async () => {
  await render();
  await edit('https://dirty-after-failed-read.test', false);
  catalogReply = async () => Response.json({ error: 'fixture read failure' }, { status: 500 });
  let loaded = true;
  await act(async () => { loaded = await useMcpConfigStore.getState().loadMcpConfigs({ force: true, directory: '/fixture' }); });
  expect(loaded).toBe(false);
  expect(useMcpConfigStore.getState().getMcpByName('lab', '/fixture')).toBeDefined();
  expect(urlField().value).toBe('https://dirty-after-failed-read.test');
  catalogReply = async () => Response.json([server()]);
  await act(async () => urlField().dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
  expect(writes).toHaveLength(1);
  expect(writes[0].body).toContain('https://dirty-after-failed-read.test');
});
