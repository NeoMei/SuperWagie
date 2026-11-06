import { afterAll, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { McpServerStatus } from '@/lib/opencode/model';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement, HTMLTextAreaElement: browser.HTMLTextAreaElement,
  Event: browser.Event, FocusEvent: browser.FocusEvent, CustomEvent: browser.CustomEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});
let configResponse = async () => Response.json([]);
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
  const url = String(input instanceof Request ? input.url : input);
  return url.includes('/api/config/mcp') ? configResponse() : Response.json({ home: '/test' });
});
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { useI18nStore } = await import('@/lib/i18n/store');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { opencodeClient } = await import('@/lib/opencode/client');
const { useMcpConfigStore } = await import('@/stores/useMcpConfigStore');
const { useMcpStore } = await import('@/stores/useMcpStore');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { useUIStore } = await import('@/stores/useUIStore');
const { McpGrid } = await import('./McpGrid');
const policy = spyOn(opencodeClient, 'getIntegrationPolicies').mockResolvedValue([]);
const errors = spyOn(console, 'error').mockImplementation(() => undefined);
const configured = { name: 'context7', type: 'remote' as const, url: 'https://mcp.context7.com/mcp', scope: 'project' as const };
const connected: McpServerStatus['status'] = { status: 'connected' };
let root: ReturnType<typeof createRoot> | null = null;
const settle = async () => { await act(async () => new Promise((resolve) => setTimeout(resolve, 0))); };

afterAll(async () => {
  await act(async () => root?.unmount());
  policy.mockRestore(); errors.mockRestore(); fetchSpy.mockRestore(); browser.close();
});

const renderGrid = async (options: {
  catalog?: typeof configured[];
  statuses?: Record<string, McpServerStatus>;
  response?: () => Promise<Response>;
  blocked?: boolean;
} = {}) => {
  await act(async () => root?.unmount());
  root = null;
  useProjectsStore.setState({ projects: [{ id: 'fixture', path: '/fixture' }], activeProjectId: 'fixture' });
  useUIStore.setState({ settingsProjectPath: '/fixture' });
  useI18nStore.getState().setLocale('en');
  policy.mockResolvedValue(options.blocked ? [{ resource: 'mcp:console', effect: 'deny', path: null }] : []);
  configResponse = options.response ?? (async () => Response.json(options.catalog ?? [configured]));
  useMcpConfigStore.setState({ selectedMcpName: null, mcpDraft: null, isLoading: false, mcpServers: [], serversByDirectory: {} });
  useMcpStore.setState({ byDirectory: { '/fixture': options.statuses ?? {
    context7: { name: 'context7', status: connected }, console: { name: 'console', status: connected },
  } }, diagnosticsByDirectory: {} });
  const container = document.createElement('div'); document.body.replaceChildren(container);
  root = createRoot(container);
  await act(async () => { root?.render(<I18nProvider><ThemeSystemProvider><McpGrid /></ThemeSystemProvider></I18nProvider>); });
  await settle();
  return container;
};
const cardFor = (name: string) => {
  const title = browser.document.body.querySelector(`[title="${name}"]`);
  const card = title?.closest('.oc-tile');
  if (!card) throw new Error(`Missing card ${name}`);
  return card;
};

test('runtime-added rows join configured servers once and preserve configured open/delete actions', async () => {
  await renderGrid();
  expect(document.body.querySelectorAll('[title="context7"]')).toHaveLength(1);
  expect(cardFor('console').textContent).toContain('Provided by OpenCode');
  expect(cardFor('context7').textContent).toContain('Project');
  expect(document.body.querySelector('[aria-label="Actions for context7"]')).not.toBeNull();
  await act(async () => { cardFor('context7').dispatchEvent(new browser.MouseEvent('click', { bubbles: true })); });
  expect(useMcpConfigStore.getState().selectedMcpName).toBe('context7');
});

test('runtime rows have no open, edit, delete, context menu or authorization action', async () => {
  const sdk = opencodeClient.getSdkClient();
  const oauth = spyOn(sdk.integration.oauth, 'connect').mockRejectedValue(new Error('Unexpected OAuth'));
  const update = spyOn(useMcpConfigStore.getState(), 'updateMcp');
  const remove = spyOn(useMcpConfigStore.getState(), 'deleteMcp');
  try {
    await renderGrid();
    const card = cardFor('console');
    expect(card.tagName).toBe('DIV');
    expect(card.querySelector('button, [role="button"], [tabindex]')).toBeNull();
    expect(card.closest('[data-slot="context-menu-trigger"]')).toBeNull();
    expect(document.body.querySelector('[aria-label="Actions for console"]')).toBeNull();
    await act(async () => { card.dispatchEvent(new browser.MouseEvent('click', { bubbles: true })); });
    expect(useMcpConfigStore.getState().selectedMcpName).toBeNull();
    expect(useMcpConfigStore.getState().mcpDraft).toBeNull();
    expect(update).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled(); expect(oauth).not.toHaveBeenCalled();
  } finally { update.mockRestore(); remove.mockRestore(); oauth.mockRestore(); }
});

const runtimeStates: Array<{ status: McpServerStatus['status']; label: string }> = [
  { status: connected, label: 'Connected' },
  { status: { status: 'failed', error: 'offline' }, label: 'Failed' },
  { status: { status: 'needs_auth', error: 'sign in' }, label: 'Needs auth' },
  { status: { status: 'pending' }, label: 'Connecting' },
  { status: { status: 'disabled' }, label: 'Disabled' },
];
for (const { status, label } of runtimeStates) {
  test(`runtime-only ${status.status} uses its status pill after a successful empty config catalog`, async () => {
    await renderGrid({ catalog: [], statuses: { console: { name: 'console', status } } });
    expect(cardFor('console').textContent).toContain(label);
    expect(document.body.textContent).not.toContain('No MCP servers yet.');
    expect(document.body.querySelector('input[placeholder="Search servers"]')).not.toBeNull();
    if (status.status === 'disabled') expect(cardFor('console').querySelector('.opacity-60')).not.toBeNull();
  });
}

test('policy denial wins over a runtime connected status', async () => {
  await renderGrid({ catalog: [], blocked: true });
  expect(cardFor('console').textContent).toContain('Blocked by policy');
  expect(cardFor('console').textContent).not.toContain('Connected');
  expect(cardFor('console').querySelector('.opacity-60')).not.toBeNull();
});

test('runtime rows remain hidden while the real config read is pending and appear on successful empty completion', async () => {
  let finish!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => { finish = resolve; });
  await renderGrid({ response: () => response });
  expect(document.body.querySelector('[title="console"]')).toBeNull();
  await act(async () => { finish(Response.json([])); });
  expect(cardFor('console').textContent).toContain('Provided by OpenCode');
});
for (const response of [() => Promise.resolve(new Response(null, { status: 503 })), () => Promise.resolve(new Response('{bad json'))]) {
  test('an unsuccessful initial config read cannot classify runtime servers as unconfigured', async () => {
    await renderGrid({ response });
    expect(document.body.querySelector('[title="console"]')).toBeNull();
    expect(useMcpConfigStore.getState().serversByDirectory['/fixture']).toBeUndefined();
    expect(useMcpConfigStore.getState().isLoading).toBe(false);
  });
}

test('search includes runtime names and configured URLs, with a merged no-match state', async () => {
  await renderGrid();
  const search = browser.document.body.querySelector('input[placeholder="Search servers"]');
  if (!search) throw new Error('Search missing');
  const change = async (value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set?.call(search, value);
      search.dispatchEvent(new browser.Event('input', { bubbles: true }));
    });
  };
  await change('console');
  expect(document.body.querySelector('[title="console"]')).not.toBeNull();
  expect(document.body.querySelector('[title="context7"]') === null).toBe(true);
  await change('https://mcp.context7.com/mcp');
  expect(document.body.querySelector('[title="context7"]')).not.toBeNull();
  expect(document.body.querySelector('[title="console"]')).toBeNull();
  await change('zzzzzzzzzzz');
  expect(document.body.textContent).toContain('No servers match');
});

test('the runtime source label changes language without adding an action', async () => {
  await renderGrid({ catalog: [] });
  await act(async () => { useI18nStore.getState().setLocale('zh-CN'); await import('@/lib/i18n/messages/zh-CN'); }); await settle();
  expect(cardFor('console').textContent).toContain('由 OpenCode 提供');
  expect(cardFor('console').tagName).toBe('DIV');
});

test('a late directory A catalog cannot expose its rows in selected directory B', async () => {
  let finishA!: (response: Response) => void;
  const pendingA = new Promise<Response>((resolve) => { finishA = resolve; });
  await renderGrid({ response: () => pendingA });
  configResponse = async () => Response.json([]);
  await act(async () => {
    useProjectsStore.setState({ projects: [{ id: 'fixture', path: '/fixture' }, { id: 'b', path: '/b' }] });
    useMcpStore.setState({ byDirectory: {
      '/fixture': { retired: { name: 'retired', status: connected } },
      '/b': { current: { name: 'current', status: connected } },
    } });
    useUIStore.setState({ settingsProjectPath: '/b' });
  });
  await settle();
  expect(cardFor('current').textContent).toContain('Provided by OpenCode');
  await act(async () => { finishA(Response.json([configured])); });
  expect(document.body.querySelector('[title="retired"]') === null).toBe(true);
  expect(document.body.querySelector('[title="context7"]') === null).toBe(true);
  expect(cardFor('current').tagName).toBe('DIV');
});

test('configured cards keep their directory-scoped delete action', async () => {
  await renderGrid();
  const remove = spyOn(useMcpConfigStore.getState(), 'deleteMcp').mockResolvedValue({ ok: true });
  try {
    const actions = document.body.querySelector<HTMLButtonElement>('[aria-label="Actions for context7"]');
    if (!actions) throw new Error('Configured actions missing');
    await act(async () => actions.click());
    const menuDelete = [...browser.document.body.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent?.includes('Delete'));
    if (!menuDelete) throw new Error('Configured delete item missing');
    await act(async () => menuDelete.dispatchEvent(new browser.MouseEvent('click', { bubbles: true })));
    const confirm = [...document.body.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((item) => item.textContent?.trim() === 'Delete');
    if (!confirm) throw new Error('Delete confirmation missing');
    await act(async () => confirm.click());
    expect(remove).toHaveBeenCalledWith('context7', '/fixture');
  } finally { remove.mockRestore(); }
});
