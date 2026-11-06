import { afterAll, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { IntegrationInfo } from '@opencode/client';

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
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ home: '/test' }));
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { opencodeClient } = await import('@/lib/opencode/client');
const { useMcpConfigStore } = await import('@/stores/useMcpConfigStore');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { useUIStore } = await import('@/stores/useUIStore');
const { switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
const { useMcpStore } = await import('@/stores/useMcpStore');
const { McpPage } = await import('./McpPage');

const oauthIntegration: IntegrationInfo = {
  id: 'mcp_0123456789abcdef',
  name: 'gmail',
  metadata: { source: 'mcp' },
  methods: [{ id: 'mcp_0123456789abcdef', type: 'oauth', label: 'gmail' }],
  connections: [],
};
const sdk = opencodeClient.getSdkClient();
const policy = spyOn(opencodeClient, 'getIntegrationPolicies').mockResolvedValue([]);
const errors = spyOn(console, 'error').mockImplementation(() => undefined);
const scoped = spyOn(opencodeClient, 'getScopedSdkClient').mockImplementation(() => sdk);
let integrations: IntegrationInfo[] = [];
const list = spyOn(sdk.integration, 'list').mockImplementation(async () => ({ location: { directory: '/test' }, data: integrations }));

let root: ReturnType<typeof createRoot> | null = null;
afterAll(async () => {
  await act(async () => root?.unmount());
  policy.mockRestore();
  errors.mockRestore();
  list.mockRestore();
  scoped.mockRestore();
  fetchSpy.mockRestore();
  browser.close();
});

/** Renders the page for a connected `gmail` server and returns its button labels. */
const renderConnectedServer = async (
  withOAuth: boolean,
  methods = oauthIntegration.methods,
  options: { disabled?: boolean; blocked?: boolean; oauthFalse?: boolean; local?: boolean; needsAuth?: boolean; runtimeDisabled?: boolean } = {},
): Promise<string[]> => {
  // Leaving the page clears the selection, so the previous page goes first.
  await act(async () => root?.unmount());
  policy.mockResolvedValue(options.blocked ? [{ resource: 'mcp:gmail', effect: 'deny', path: null }] : []);
  integrations = withOAuth ? [{ ...oauthIntegration, methods }] : [];
  const statuses = { gmail: { name: 'gmail', status: options.runtimeDisabled ? { status: 'disabled' as const } : options.needsAuth
    ? { status: 'needs_auth' as const, error: 'Authorization required' } : { status: 'connected' as const } } };
  useMcpStore.setState({ refresh: async () => {}, getStatusForDirectory: () => statuses });
  useMcpConfigStore.setState({
    selectedMcpName: 'gmail',
    serversByDirectory: { __default__: [options.local
      ? { name: 'gmail', type: 'local', command: ['fixture'] }
      : { name: 'gmail', type: 'remote', url: 'https://gmailmcp.googleapis.com/mcp/v1', disabled: options.disabled, oauth: options.oauthFalse ? false : undefined }] },
    getMcpByName: () => useMcpConfigStore.getState().serversByDirectory.__default__?.[0] ?? null,
  });
  const container = document.createElement('div');
  document.body.replaceChildren(container);
  root = createRoot(container);
  const page = root;
  await act(async () => { page.render(<I18nProvider><McpPage /></I18nProvider>); });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  return [...container.querySelectorAll('button')].map((button) => button.textContent?.trim() ?? '');
};

test('a connected server with a browser sign-in offers Authorize beside Disconnect', async () => {
  const buttons = await renderConnectedServer(true);
  expect(buttons).toContain('Authorize');
  expect(buttons).toContain('Disconnect');
  expect(buttons).toContain('Test');
});

test('a connected server without a browser sign-in keeps its plain actions', async () => {
  const buttons = await renderConnectedServer(false);
  expect(buttons).not.toContain('Authorize');
  expect(buttons).toContain('Disconnect');
});

test('Authorize opens the sign-in on the connected server', async () => {
  const buttons = await renderConnectedServer(true);
  const authorize = [...document.body.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Authorize',
  );
  if (!authorize) throw new Error(`Authorize button missing; buttons: ${buttons.join(', ')}`);
  // The OAuth start fails against the offline test runtime; the flow renders
  // that failure as state, which is what proves the sign-in mounted.
  const connect = spyOn(sdk.integration.oauth, 'connect').mockImplementation(async () => {
    throw new Error('offline test runtime');
  });
  try {
    await act(async () => { authorize.click(); });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(document.body.textContent).toContain('Runtime status');
    expect(connect.mock.calls).toHaveLength(1);
  } finally {
    connect.mockRestore();
  }
});

test('Authorize keeps each OAuth method reachable when there is more than one', async () => {
  await renderConnectedServer(true, [
    { id: 'personal', type: 'oauth', label: 'Personal account' },
    { id: 'work', type: 'oauth', label: 'Work account' },
  ]);
  const connect = spyOn(sdk.integration.oauth, 'connect').mockImplementation(async () => {
    throw new Error('offline test runtime');
  });
  try {
    const authorize = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Authorize',
    );
    if (!authorize) throw new Error('Authorize button missing');
    await act(async () => { authorize.click(); });
    expect(connect.mock.calls).toHaveLength(0);
    expect(document.body.textContent).toContain('Personal account');
    expect(document.body.textContent).toContain('Work account');
    const starts = [...document.body.querySelectorAll('button')].filter(
      (button) => button.textContent?.trim() === 'Connect',
    );
    expect(starts).toHaveLength(2);
    await act(async () => { starts[0]!.click(); });
    expect(connect.mock.calls).toEqual([[{ integrationID: oauthIntegration.id, methodID: 'personal' }]]);
    await act(async () => { starts[1]!.click(); });
    expect(connect.mock.calls).toEqual([
      [{ integrationID: oauthIntegration.id, methodID: 'personal' }],
      [{ integrationID: oauthIntegration.id, methodID: 'work' }],
    ]);
  } finally {
    connect.mockRestore();
  }
});

test('Authorize survives needs_auth while browser sign-in is pending and reconnects', async () => {
  await renderConnectedServer(true);
  const time = { created: 1, expires: 2 };
  let startPoll!: () => void;
  const pollStarted = new Promise<void>((resolve) => { startPoll = resolve; });
  let finishPoll!: (result: Awaited<ReturnType<typeof sdk.integration.oauth.status>>) => void;
  const pollResult = new Promise<Awaited<ReturnType<typeof sdk.integration.oauth.status>>>((resolve) => {
    finishPoll = resolve;
  });
  const connect = spyOn(sdk.integration.oauth, 'connect').mockImplementation(async () => ({
    location: { directory: '/test' },
    data: { attemptID: 'pending-authorization', mode: 'auto', url: '', instructions: 'Finish signing in', time },
  }));
  const status = spyOn(sdk.integration.oauth, 'status').mockImplementation(() => {
    startPoll();
    return pollResult;
  });
  const cancel = spyOn(sdk.integration.oauth, 'cancel').mockImplementation(async () => {});
  const reconnect = spyOn(useMcpStore.getState(), 'connect').mockImplementation(async () => {});
  try {
    const authorize = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Authorize',
    );
    if (!authorize) throw new Error('Authorize button missing');
    await act(async () => { authorize.click(); });
    await act(async () => { await pollStarted; });
    const needsAuth = { gmail: { name: 'gmail', status: { status: 'needs_auth' as const, error: 'Authorization required' } } };
    await act(async () => {
      useMcpStore.setState({
        getStatusForDirectory: () => needsAuth,
      });
    });
    expect(cancel.mock.calls).toHaveLength(0);
    expect(connect.mock.calls).toHaveLength(1);
    await act(async () => {
      finishPoll({ location: { directory: '/test' }, data: { status: 'complete', time } });
    });
    expect(reconnect.mock.calls).toEqual([['gmail', null]]);
    expect(cancel.mock.calls).toHaveLength(0);
  } finally {
    finishPoll({ location: { directory: '/test' }, data: { status: 'complete', time } });
    await act(async () => root?.unmount());
    root = null;
    reconnect.mockRestore();
    cancel.mockRestore();
    status.mockRestore();
    connect.mockRestore();
  }
});


for (const options of [{ disabled: true }, { blocked: true }, { oauthFalse: true }, { local: true }, { needsAuth: true }, { runtimeDisabled: true }]) {
  test(`authorization requires an eligible explicit user action ${JSON.stringify(options)}`, async () => {
    const connect = spyOn(sdk.integration.oauth, 'connect').mockRejectedValue(new Error('Unexpected OAuth request'));
    try {
      const buttons = await renderConnectedServer(true, oauthIntegration.methods, options);
      expect(buttons).not.toContain('Authorize');
      expect(connect).not.toHaveBeenCalled();
    } finally { connect.mockRestore(); }
  });
}

test('an untouched connected page discovers metadata without starting OAuth', async () => {
  const connect = spyOn(sdk.integration.oauth, 'connect').mockRejectedValue(new Error('Unexpected OAuth request'));
  try {
    await renderConnectedServer(true);
    expect(connect).not.toHaveBeenCalled();
  } finally { connect.mockRestore(); }
});

test('disable retires an explicit pending attempt and cannot autoStart it again', async () => {
  await renderConnectedServer(true);
  const connect = spyOn(sdk.integration.oauth, 'connect').mockResolvedValue({
    location: { directory: '/test' },
    data: { attemptID: 'disabled-attempt', mode: 'code', url: '', instructions: '', time: { created: 1, expires: 60001 } },
  });
  const cancel = spyOn(sdk.integration.oauth, 'cancel').mockResolvedValue(undefined);
  try {
    const authorize = [...document.body.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Authorize');
    if (!authorize) throw new Error('Authorize missing');
    await act(async () => authorize.click());
    expect(connect).toHaveBeenCalledTimes(1);
    const server = useMcpConfigStore.getState().serversByDirectory.__default__?.[0];
    if (!server) throw new Error('Server missing');
    await act(async () => useMcpConfigStore.setState({ serversByDirectory: { __default__: [{ ...server, disabled: true }] } }));
    expect(cancel).toHaveBeenCalledWith({ integrationID: oauthIntegration.id, attemptID: 'disabled-attempt' });
    await act(async () => useMcpConfigStore.setState({ serversByDirectory: { __default__: [server] } }));
    expect(connect).toHaveBeenCalledTimes(1);
  } finally { await act(async () => root?.unmount()); root = null; cancel.mockRestore(); connect.mockRestore(); }
});

test('a policy read that blocks the selected server retires an already pending attempt', async () => {
  let finishPolicy!: (value: Awaited<ReturnType<typeof opencodeClient.getIntegrationPolicies>>) => void;
  policy.mockImplementationOnce(() => new Promise((resolve) => { finishPolicy = resolve; }));
  await renderConnectedServer(true);
  const connect = spyOn(sdk.integration.oauth, 'connect').mockResolvedValue({
    location: { directory: '/test' },
    data: { attemptID: 'blocked-attempt', mode: 'code', url: '', instructions: '', time: { created: 1, expires: 60001 } },
  });
  const cancel = spyOn(sdk.integration.oauth, 'cancel').mockResolvedValue(undefined);
  try {
    const authorize = [...document.body.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Authorize');
    if (!authorize) throw new Error('Authorize missing');
    await act(async () => authorize.click());
    await act(async () => finishPolicy([{ resource: 'mcp:gmail', effect: 'deny', path: null }]));
    expect(cancel).toHaveBeenCalledWith({ integrationID: oauthIntegration.id, attemptID: 'blocked-attempt' });
    expect([...document.body.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Authorize')).toBe(false);
    expect(connect).toHaveBeenCalledTimes(1);
  } finally { await act(async () => root?.unmount()); root = null; cancel.mockRestore(); connect.mockRestore(); }
});

for (const change of ['directory', 'runtime'] as const) {
  test(`a same-name ${change} switch cannot reuse an explicit authorization intent`, async () => {
    useProjectsStore.setState({ projects: [{ id: 'a', path: '/a' }, { id: 'b', path: '/b' }], activeProjectId: 'a' });
    useUIStore.setState({ settingsProjectPath: '/a' });
    switchRuntimeEndpoint({ apiBaseUrl: 'https://a.test', runtimeKey: 'a' });
    await renderConnectedServer(true);
    const connect = spyOn(sdk.integration.oauth, 'connect').mockResolvedValue({
      location: { directory: '/a' },
      data: { attemptID: 'retired-attempt', mode: 'code', url: '', instructions: '', time: { created: 1, expires: 60001 } },
    });
    const cancel = spyOn(sdk.integration.oauth, 'cancel').mockResolvedValue(undefined);
    try {
      const authorize = [...document.body.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Authorize');
      if (!authorize) throw new Error('Authorize missing');
      await act(async () => authorize.click());
      expect(connect).toHaveBeenCalledTimes(1);
      await act(async () => {
        if (change === 'directory') useUIStore.setState({ settingsProjectPath: '/b' });
        else { switchRuntimeEndpoint({ apiBaseUrl: 'https://b.test', runtimeKey: 'b' }); switchRuntimeEndpoint({ apiBaseUrl: 'https://a.test', runtimeKey: 'a' }); }
      });
      expect(cancel).toHaveBeenCalledWith({ integrationID: oauthIntegration.id, attemptID: 'retired-attempt' });
      expect(connect).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root?.unmount()); root = null;
      cancel.mockRestore(); connect.mockRestore();
      useProjectsStore.setState({ projects: [], activeProjectId: null }); useUIStore.setState({ settingsProjectPath: null });
    }
  });
}
