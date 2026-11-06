import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Element as HappyElement, HTMLElement, Window } from 'happy-dom';
import type { IntegrationInfo } from '@opencode/client';

/** A card or button found by text, narrowed to happy-dom's clickable element. */
const findClickable = (elements: HappyElement[], text: string): HTMLElement | undefined =>
  elements.find((element): element is HTMLElement =>
    element instanceof HTMLElement && Boolean(element.textContent?.includes(text)));
const browser = new Window({ url: 'http://localhost' });
let root: Root;
const descriptors = new Map<string, PropertyDescriptor | undefined>();
// React DOM detects input-event support when imported, so install the DOM first.
for (const [key, value] of Object.entries({
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  localStorage: browser.localStorage,
  Element: browser.Element,
  HTMLElement: browser.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  // happy-dom has no animation frame; base-ui's Collapsible mounts one per panel.
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
  cancelAnimationFrame: (handle: number) => clearTimeout(handle),
  getComputedStyle: browser.getComputedStyle.bind(browser),
})) {
  descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true });
}
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { useUIStore } = await import('@/stores/useUIStore');
const { useMcpConfigStore } = await import('@/stores/useMcpConfigStore');
const { useMcpStore } = await import('@/stores/useMcpStore');
const { usePluginsStore } = await import('@/stores/usePluginsStore');
const { useSkillsStore } = await import('@/stores/useSkillsStore');
const { useDirectoryStore } = await import('@/stores/useDirectoryStore');
const { opencodeClient } = await import('@/lib/opencode/client');
const { switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
const { IntegrationsCatalogView } = await import('./IntegrationsCatalogView');
const initialUI = useUIStore.getState();
const initialMcpConfig = useMcpConfigStore.getState();
const initialMcp = useMcpStore.getState();
const initialPlugins = usePluginsStore.getState();
const initialSkills = useSkillsStore.getState();
const initialDirectory = useDirectoryStore.getState();
const policies = spyOn(opencodeClient, 'getIntegrationPolicies').mockResolvedValue([]);
const fetchGuard = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
  const path = new URL(input instanceof Request ? input.url : String(input), 'http://localhost').pathname;
  return Response.json(path.endsWith('/integration') ? { location: { directory: '/fixture' }, data: [] } : { guests: [] });
});

beforeEach(() => {
  policies.mockResolvedValue([]);
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  useUIStore.setState({ isIntegrationsCatalogOpen: true });
  // The page's mount effect refreshes each store; keep the test offline.
  useMcpConfigStore.setState({
    loadMcpConfigs: async () => true,
    createMcp: async () => ({ ok: true }),
    deleteMcp: async () => ({ ok: true }),
  });
  useMcpStore.setState({
    refresh: async () => undefined,
    connect: async () => undefined,
  });
  usePluginsStore.setState({
    loadPlugins: async () => true,
    loadRegistryInfo: async () => true,
    createEntry: async () => ({ ok: true }),
    deleteEntry: async () => ({ ok: true }),
  });
  useSkillsStore.setState({
    loadSkills: async () => true,
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  useUIStore.setState(initialUI);
  useMcpConfigStore.setState(initialMcpConfig);
  useMcpStore.setState(initialMcp);
  usePluginsStore.setState(initialPlugins);
  useSkillsStore.setState(initialSkills);
  useDirectoryStore.setState(initialDirectory);
  document.body.replaceChildren();
});

afterAll(async () => {
  policies.mockRestore();
  fetchGuard.mockRestore();
  await browser.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, { value: descriptor, configurable: true });
    else Reflect.deleteProperty(globalThis, key);
  }
});
test('the catalog lists entries, filters by category and opens a detail page on click', async () => {
  useMcpConfigStore.setState({
    mcpServers: [{
      name: 'linear',
      type: 'remote',
      url: 'https://mcp.linear.app/mcp',
      scope: 'user',
    }],
  });
  await act(async () => root.render(<I18nProvider><IntegrationsCatalogView /></I18nProvider>));
  const body = browser.document.body;

  expect(body.textContent?.includes('Linear')).toBe(true);
  expect(body.textContent?.includes('Playwright')).toBe(true);
  expect(body.textContent?.includes('Slack')).toBe(false);

  // Clicking a card opens that integration's detail page.
  const linearCard = findClickable([...body.querySelectorAll('[role="button"], button')], 'Linear');
  if (!linearCard) throw new Error('Linear card missing');
  await act(async () => linearCard.click());
  expect(body.textContent?.includes('Connect Linear so the agent can read your issues')).toBe(true);
  expect(body.textContent?.includes('Playwright')).toBe(false);

  // The detail breadcrumb returns to the grid.
  const back = findClickable([...body.querySelectorAll('nav button')], 'Integrations');
  if (!back) throw new Error('Back button missing');
  await act(async () => back.click());
  expect(body.textContent?.includes('Playwright')).toBe(true);
});

test('the category filter narrows the grid', async () => {
    await act(async () => root.render(<I18nProvider><IntegrationsCatalogView /></I18nProvider>));
    const body = browser.document.body;
    const codeChip = [...body.querySelectorAll('button')].find((button) => button.textContent?.startsWith('Code'));
    if (!codeChip) throw new Error('Category chip missing');
    await act(async () => codeChip.click());
    expect(body.textContent?.includes('GitHub')).toBe(true);
    expect(body.textContent?.includes('Playwright')).toBe(false);
  });

test('the rail lists installed integrations and opens one', async () => {
  useMcpConfigStore.setState({
    mcpServers: [{
      name: 'atlassian',
      type: 'remote',
      url: 'https://mcp.atlassian.com/v2/mcp',
      scope: 'user',
    }],
  });
  await act(async () => root.render(<I18nProvider><IntegrationsCatalogView /></I18nProvider>));
  const body = browser.document.body;
  const rail = body.querySelector('aside');
  if (!rail) throw new Error('Rail missing');
  expect(rail.textContent?.includes('Installed1')).toBe(true);
  expect(rail.textContent?.includes('Linear')).toBe(false);

  const atlassian = [...rail.querySelectorAll('button')].find((button) => button.textContent?.includes('Atlassian'));
  if (!atlassian) throw new Error('Installed entry missing');
  await act(async () => atlassian.click());
  expect(body.querySelector('main h1')?.textContent).toBe('Atlassian');
  expect(body.textContent?.includes('Connection')).toBe(true);
});

test('the catalog flag follows the mutually exclusive full-page surface contract', () => {
  const store = useUIStore.getState();
  store.setIntegrationsCatalogOpen(true);
  expect(useUIStore.getState().isIntegrationsCatalogOpen).toBe(true);

  // Opening another surface closes the catalog.
  useUIStore.getState().setArchivePageOpen(true);
  expect(useUIStore.getState().isIntegrationsCatalogOpen).toBe(false);
  expect(useUIStore.getState().isArchivePageOpen).toBe(true);

  // Opening the catalog closes the archive.
  useUIStore.getState().setIntegrationsCatalogOpen(true);
  expect(useUIStore.getState().isArchivePageOpen).toBe(false);
  expect(useUIStore.getState().isIntegrationsCatalogOpen).toBe(true);

  // Selecting a session closes every full-page surface.
  useUIStore.getState().closeMainSurfaces();
  expect(useUIStore.getState().isIntegrationsCatalogOpen).toBe(false);

  // Closing the catalog leaves the other surfaces untouched.
  useUIStore.getState().setIntegrationsCatalogOpen(true);
  useUIStore.getState().setIntegrationsCatalogOpen(false);
  expect(useUIStore.getState().isIntegrationsCatalogOpen).toBe(false);
  expect(useUIStore.getState().isUsageStatsPageOpen).toBe(false);
});

test('a needs-auth server shows the sign-in state on its detail page', async () => {
  // This view is mounted directly, so provide the authenticated directory
  // that SessionAuthGate + PlatformAccountGate establish before the app mounts.
  useDirectoryStore.setState({
    homeDirectory: '/home/user',
    currentDirectory: '/home/user/project',
    directoryHistory: ['/home/user/project'],
    historyIndex: 0,
    hasPersistedDirectory: false,
    isHomeReady: true,
    isSwitchingDirectory: false,
  });
  const directory = useDirectoryStore.getState().currentDirectory;
  useMcpConfigStore.setState({
    mcpServers: [{
      name: 'linear',
      type: 'remote',
      url: 'https://mcp.linear.app/mcp',
      scope: 'user',
    }],
  });
  useMcpStore.setState({
    byDirectory: { [directory]: { linear: { name: 'linear', status: { status: 'needs_auth', error: 'Authorization required' } } } },
  });
  await act(async () => root.render(<I18nProvider><IntegrationsCatalogView /></I18nProvider>));
  const pillBefore = browser.document.body.textContent?.includes('Sign-in required');
  expect(pillBefore).toBe(true);
  const linearCard = findClickable([...browser.document.body.querySelectorAll('[role="button"], button')], 'Linear');
  if (!linearCard) throw new Error('Linear card missing');
  await act(async () => linearCard.click());
  expect(browser.document.body.textContent?.includes('Waiting for sign-in')).toBe(true);
});

test('a failed OAuth server offers a fresh sign-in on its detail page', async () => {
  useDirectoryStore.setState({ homeDirectory: '/home/user', currentDirectory: '/home/user/project', isHomeReady: true });
  // The service rejected the stored token: Connect would only retry it.
  const linearSignIn: IntegrationInfo = {
    id: 'mcp_0123456789abcdef',
    name: 'linear',
    metadata: { source: 'mcp' },
    methods: [{ id: 'mcp_0123456789abcdef', type: 'oauth', label: 'Sign in to Linear' }],
    connections: [],
  };
  const lists = [opencodeClient.getSdkClient(), opencodeClient.getScopedSdkClient(useDirectoryStore.getState().currentDirectory ?? '')]
    .map((client) => spyOn(client.integration, 'list').mockImplementation(async () => ({ location: { directory: '/repo' }, data: [linearSignIn] })));
  try {
    useMcpConfigStore.setState({
      mcpServers: [{ name: 'linear', type: 'remote', url: 'https://mcp.linear.app/mcp', scope: 'user' }],
    });
    useMcpStore.setState({
      byDirectory: { [useDirectoryStore.getState().currentDirectory ?? '__global__']: { linear: { name: 'linear', status: { status: 'failed', error: 'Token refresh was rejected (access_denied)' } } } },
    });
    await act(async () => root.render(<I18nProvider><IntegrationsCatalogView /></I18nProvider>));
    const linearCard = findClickable([...browser.document.body.querySelectorAll('[role="button"], button')], 'Linear');
    if (!linearCard) throw new Error('Linear card missing');
    await act(async () => linearCard.click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(browser.document.body.textContent?.includes('Sign in to Linear')).toBe(true);
    expect(browser.document.body.textContent?.includes('Sign in again')).toBe(true);
    // The line about a sign-in in progress belongs to `needs_auth` only.
    expect(browser.document.body.textContent?.includes('Waiting for sign-in')).toBe(false);
  } finally {
    for (const list of lists) list.mockRestore();
  }
});

test('a connected OAuth server offers Authorize on its detail page', async () => {
  useDirectoryStore.setState({ homeDirectory: '/home/user', currentDirectory: '/home/user/project', isHomeReady: true });
  // Connected does not prove user authorization: the tools may still wait on
  // the consent this sign-in collects.
  const linearSignIn: IntegrationInfo = {
    id: 'mcp_0123456789abcdef',
    name: 'linear',
    metadata: { source: 'mcp' },
    methods: [{ id: 'mcp_0123456789abcdef', type: 'oauth', label: 'Sign in to Linear' }],
    connections: [],
  };
  const lists = [opencodeClient.getSdkClient(), opencodeClient.getScopedSdkClient(useDirectoryStore.getState().currentDirectory ?? '')]
    .map((client) => spyOn(client.integration, 'list').mockImplementation(async () => ({ location: { directory: '/repo' }, data: [linearSignIn] })));
  try {
    useMcpConfigStore.setState({
      mcpServers: [{ name: 'linear', type: 'remote', url: 'https://mcp.linear.app/mcp', scope: 'user' }],
    });
    useMcpStore.setState({
      byDirectory: { [useDirectoryStore.getState().currentDirectory ?? '__global__']: { linear: { name: 'linear', status: { status: 'connected' } } } },
    });
    await act(async () => root.render(<I18nProvider><IntegrationsCatalogView /></I18nProvider>));
    const linearCard = findClickable([...browser.document.body.querySelectorAll('[role="button"], button')], 'Linear');
    if (!linearCard) throw new Error('Linear card missing');
    await act(async () => linearCard.click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(browser.document.body.textContent?.includes('Authorize')).toBe(true);
    expect(browser.document.body.textContent?.includes('Waiting for sign-in')).toBe(false);
  } finally {
    for (const list of lists) list.mockRestore();
  }
});

for (const fixture of [
  { id: 'linear', name: 'Linear', status: 'connected', disabled: true, blocked: false },
  { id: 'linear', name: 'Linear', status: 'needs_auth', disabled: true, blocked: false },
  { id: 'linear', name: 'Linear', status: 'connected', disabled: false, blocked: true },
  { id: 'linear', name: 'Linear', status: 'needs_auth', disabled: false, blocked: true },
  { id: 'github', name: 'GitHub', status: 'connected', disabled: false, blocked: false },
  { id: 'github', name: 'GitHub', status: 'failed', disabled: false, blocked: false },
] as const) {
  test(`catalog authorization stays unavailable for ${JSON.stringify(fixture)}`, async () => {
    const directory = '/repo';
    useDirectoryStore.setState({ homeDirectory: '/home/user', currentDirectory: directory, isHomeReady: true });
    policies.mockResolvedValue(fixture.blocked ? [{ resource: `mcp:${fixture.id}`, effect: 'deny', path: null }] : []);
    useMcpConfigStore.setState({ mcpServers: [{ name: fixture.id, type: 'remote', url: 'https://fixture.test/mcp', disabled: fixture.disabled }] });
    useMcpStore.setState({ byDirectory: { [directory]: { [fixture.id]: {
      name: fixture.id, status: fixture.status === 'connected' ? { status: 'connected' } : { status: fixture.status, error: 'fixture' },
    } } } });
    const sdk = opencodeClient.getScopedSdkClient(directory);
    const connect = spyOn(sdk.integration.oauth, 'connect').mockRejectedValue(new Error('Unexpected OAuth request'));
    const list = spyOn(sdk.integration, 'list').mockResolvedValue({ location: { directory }, data: [] });
    try {
      await act(async () => root.render(<I18nProvider><IntegrationsCatalogView /></I18nProvider>));
      const card = findClickable([...browser.document.body.querySelectorAll('main [role="button"]')], fixture.name);
      if (!card) throw new Error('Catalog entry missing');
      await act(async () => card.click());
      expect([...browser.document.body.querySelectorAll('button')].some((button) => ['Authorize', 'Sign in again'].includes(button.textContent?.trim() ?? ''))).toBe(false);
      expect(connect).not.toHaveBeenCalled();
      expect(list).not.toHaveBeenCalled();
    } finally { list.mockRestore(); connect.mockRestore(); }
  });
}

test('connected catalog authorization starts only on a user click', async () => {
  const directory = '/repo';
  useDirectoryStore.setState({ homeDirectory: '/home/user', currentDirectory: directory, isHomeReady: true });
  useMcpConfigStore.setState({ mcpServers: [{ name: 'linear', type: 'remote', url: 'https://fixture.test/mcp' }] });
  useMcpStore.setState({ byDirectory: { [directory]: { linear: { name: 'linear', status: { status: 'connected' } } } } });
  const sdk = opencodeClient.getScopedSdkClient(directory);
  const list = spyOn(sdk.integration, 'list').mockResolvedValue({ location: { directory }, data: [{
    id: 'mcp_linear', name: 'linear', metadata: { source: 'mcp' }, connections: [],
    methods: [{ id: 'login', type: 'oauth', label: 'Linear login' }],
  }] });
  const connect = spyOn(sdk.integration.oauth, 'connect').mockResolvedValue({
    location: { directory }, data: { attemptID: 'catalog-attempt', mode: 'code', url: '', instructions: '', time: { created: 1, expires: 60001 } },
  });
  const cancel = spyOn(sdk.integration.oauth, 'cancel').mockResolvedValue(undefined);
  try {
    await act(async () => root.render(<I18nProvider><IntegrationsCatalogView /></I18nProvider>));
    const card = findClickable([...browser.document.body.querySelectorAll('main [role="button"]')], 'Linear');
    if (!card) throw new Error('Linear missing');
    await act(async () => card.click());
    expect(connect).not.toHaveBeenCalled();
    const authorize = [...browser.document.body.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Authorize');
    if (!authorize) throw new Error('Authorize missing');
    await act(async () => authorize.click());
    expect(connect).toHaveBeenCalledWith({ integrationID: 'mcp_linear', methodID: 'login' });
    await act(async () => useDirectoryStore.setState({ currentDirectory: '/other' }));
    expect(cancel).toHaveBeenCalledWith({ integrationID: 'mcp_linear', attemptID: 'catalog-attempt' });
    expect(connect).toHaveBeenCalledTimes(1);
  } finally { await act(async () => root.unmount()); list.mockRestore(); cancel.mockRestore(); connect.mockRestore(); }
});

for (const change of ['directory', 'disabled'] as const) {
test(`returning after a ${change} change cannot revive the install autoStart intent`, async () => {
  useDirectoryStore.setState({ homeDirectory: '/home/user', currentDirectory: '/repo', isHomeReady: true });
  useMcpConfigStore.setState({ mcpServers: [], createMcp: async () => {
    useMcpConfigStore.setState({ mcpServers: [{ name: 'tavily', type: 'remote', url: 'https://fixture.test/mcp' }] });
    useMcpStore.setState({ byDirectory: {
      '/repo': { tavily: { name: 'tavily', status: { status: 'needs_auth', error: 'fixture' } } },
      '/other': { tavily: { name: 'tavily', status: { status: 'needs_auth', error: 'fixture' } } },
    } });
    return { ok: true };
  } });
  const sdk = opencodeClient.getScopedSdkClient('/repo');
  const other = opencodeClient.getScopedSdkClient('/other');
  const metadata: IntegrationInfo = { id: 'mcp_tavily', name: 'tavily', metadata: { source: 'mcp' }, connections: [], methods: [{ id: 'login', type: 'oauth', label: 'Tavily login' }] };
  const lists = [sdk, other].map((client) => spyOn(client.integration, 'list').mockResolvedValue({ location: { directory: '/repo' }, data: [metadata] }));
  const connect = spyOn(sdk.integration.oauth, 'connect').mockResolvedValue({ location: { directory: '/repo' }, data: {
    attemptID: 'install-attempt', mode: 'code', url: '', instructions: '', time: { created: 1, expires: 60001 },
  } });
  const otherConnect = spyOn(other.integration.oauth, 'connect').mockRejectedValue(new Error('Unexpected OAuth request'));
  const cancel = spyOn(sdk.integration.oauth, 'cancel').mockResolvedValue(undefined);
  try {
    await act(async () => root.render(<I18nProvider><IntegrationsCatalogView /></I18nProvider>));
    const card = findClickable([...browser.document.body.querySelectorAll('main [role="button"]')], 'Tavily');
    if (!card) throw new Error('Tavily missing');
    await act(async () => card.click());
    const install = [...browser.document.body.querySelectorAll('main button')].find((button): button is HTMLElement => button instanceof HTMLElement && button.textContent?.trim() === 'Install');
    if (!install) throw new Error('Install missing');
    await act(async () => install.click());
    expect(connect).toHaveBeenCalledTimes(1);
    if (change === 'directory') {
      await act(async () => useDirectoryStore.setState({ currentDirectory: '/other' }));
      await act(async () => useDirectoryStore.setState({ currentDirectory: '/repo' }));
    } else {
      await act(async () => useMcpConfigStore.setState({ mcpServers: [{ name: 'tavily', type: 'remote', url: 'https://fixture.test/mcp', disabled: true }] }));
      await act(async () => useMcpConfigStore.setState({ mcpServers: [{ name: 'tavily', type: 'remote', url: 'https://fixture.test/mcp' }] }));
    }
    expect(otherConnect).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    for (const list of lists) list.mockRestore();
    connect.mockRestore(); otherConnect.mockRestore(); cancel.mockRestore();
  }
});
}

test('a retired install completion cannot reload or connect the newly selected runtime', async () => {
  switchRuntimeEndpoint({ apiBaseUrl: 'https://a.test', runtimeKey: 'a' });
  useDirectoryStore.setState({ homeDirectory: '/home/user', currentDirectory: '/repo', isHomeReady: true });
  let finish!: () => void;
  useMcpConfigStore.setState({ mcpServers: [], createMcp: () => new Promise((resolve) => { finish = () => resolve({ ok: true }); }) });
  const connect = spyOn(useMcpStore.getState(), 'connect').mockResolvedValue(undefined);
  try {
    await act(async () => root.render(<I18nProvider><IntegrationsCatalogView /></I18nProvider>));
    const card = findClickable([...browser.document.body.querySelectorAll('main [role="button"]')], 'Tavily');
    if (!card) throw new Error('Tavily missing');
    await act(async () => card.click());
    const install = [...browser.document.body.querySelectorAll('main button')].find((button): button is HTMLElement => button instanceof HTMLElement && button.textContent?.trim() === 'Install');
    if (!install) throw new Error('Install missing');
    await act(async () => install.click());
    await act(async () => switchRuntimeEndpoint({ apiBaseUrl: 'https://b.test', runtimeKey: 'b' }));
    const fetchCallsBeforeCompletion = fetchGuard.mock.calls.length;
    await act(async () => finish());
    expect(fetchGuard.mock.calls.slice(fetchCallsBeforeCompletion).some(([input]) => (input instanceof Request ? input.url : String(input)).includes('/api/config/reload'))).toBe(false);
    expect(connect).not.toHaveBeenCalled();
  } finally { connect.mockRestore(); }
});

for (const batched of [false, true]) {
test(`a directory round trip permanently retires a pending install completion, batched ${batched}`, async () => {
  useDirectoryStore.setState({ homeDirectory: '/home/user', currentDirectory: '/repo', isHomeReady: true });
  let finish!: () => void;
  useMcpConfigStore.setState({ mcpServers: [], createMcp: () => new Promise((resolve) => { finish = () => resolve({ ok: true }); }) });
  const connect = spyOn(useMcpStore.getState(), 'connect').mockResolvedValue(undefined);
  try {
    await act(async () => root.render(<I18nProvider><IntegrationsCatalogView /></I18nProvider>));
    const card = findClickable([...browser.document.body.querySelectorAll('main [role="button"]')], 'Tavily');
    if (!card) throw new Error('Tavily missing');
    await act(async () => card.click());
    const install = [...browser.document.body.querySelectorAll('main button')].find((button): button is HTMLElement => button instanceof HTMLElement && button.textContent?.trim() === 'Install');
    if (!install) throw new Error('Install missing');
    await act(async () => install.click());
    if (batched) {
      await act(async () => {
        useDirectoryStore.setState({ currentDirectory: '/other' });
        useDirectoryStore.setState({ currentDirectory: '/repo' });
      });
    } else {
      await act(async () => useDirectoryStore.setState({ currentDirectory: '/other' }));
      await act(async () => useDirectoryStore.setState({ currentDirectory: '/repo' }));
    }
    const fetchCallsBeforeCompletion = fetchGuard.mock.calls.length;
    await act(async () => finish());
    expect(fetchGuard.mock.calls.slice(fetchCallsBeforeCompletion).some(([input]) => (input instanceof Request ? input.url : String(input)).includes('/api/config/reload'))).toBe(false);
    expect(connect).not.toHaveBeenCalled();
  } finally { connect.mockRestore(); }
});
}

test('a same-named skill outside the catalog folder does not count as installed', async () => {
  useSkillsStore.setState({
    skills: [
      { id: 'pdf', name: 'pdf', path: '/home/user/.claude/skills/pdf/SKILL.md', scope: 'user', source: 'claude' },
      { id: 'pdf', name: 'pdf', path: '/repo/.agents/skills/pdf/SKILL.md', scope: 'project', source: 'agents' },
    ],
  });
  await act(async () => root.render(<I18nProvider><IntegrationsCatalogView /></I18nProvider>));
  const railText = () => browser.document.body.querySelector('aside')?.textContent ?? '';
  expect(railText().includes('Installed0')).toBe(true);

  // The catalog's own copy, in the user's OpenCode skills folder, counts.
  await act(async () => useSkillsStore.setState({
    skills: [
      ...useSkillsStore.getState().skills,
      { id: 'pdf', name: 'pdf', path: '/home/user/.config/opencode/skills/pdf/SKILL.md', scope: 'user', source: 'opencode' },
    ],
  }));
  expect(railText().includes('Installed1')).toBe(true);
});

test('a detail page opens at its top and going back restores the browse scroll', async () => {
  await act(async () => root.render(<I18nProvider><IntegrationsCatalogView /></I18nProvider>));
  const body = browser.document.body;
  const scroller = body.querySelector('main');
  if (!scroller) throw new Error('Scroller missing');
  scroller.scrollTop = 600;
  await act(async () => scroller.dispatchEvent(new browser.Event('scroll')));

  const card = findClickable([...body.querySelectorAll('main [role="button"]')], 'Notion');
  if (!card) throw new Error('Notion row missing');
  await act(async () => card.click());
  expect(scroller.scrollTop).toBe(0);

  const back = findClickable([...body.querySelectorAll('nav button')], 'Integrations');
  if (!back) throw new Error('Back button missing');
  await act(async () => back.click());
  expect(scroller.scrollTop).toBe(600);
});
