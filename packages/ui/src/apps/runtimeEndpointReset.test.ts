import { afterEach, describe, expect, test } from 'bun:test';
import { installRuntimeEndpointReset } from './runtimeEndpointReset';
import { opencodeClient } from '@/lib/opencode/client';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { useMcpConfigStore } from '@/stores/useMcpConfigStore';
import { useMcpStore } from '@/stores/useMcpStore';
import { useConfigStore } from '@/stores/useConfigStore';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalFetch = globalThis.fetch;

const installWindow = (): void => {
  const events = new EventTarget();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
    },
  });
};

// The switch mints a URL auth token in the background; answer it locally so the
// test never reaches the network.
const stubFetch = (): void => {
  // SAFETY: the endpoint switch only calls fetch(input, init); Bun's extra
  // `preconnect` member is never read.
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow) {
    Object.defineProperty(globalThis, 'window', originalWindow);
  } else {
    Reflect.deleteProperty(globalThis, 'window');
  }
});

describe('installRuntimeEndpointReset', () => {
  // #4219: the login screen unmounts App, so a host switch made from it must
  // still move the SDK client; otherwise App mounts against Local with a client
  // that keeps calling the remote and the startup overlay never lifts.
  test('rebinds the SDK client and resets init state without any mounted UI', () => {
    installWindow();
    stubFetch();
    const uninstall = installRuntimeEndpointReset();
    try {
      switchRuntimeEndpoint({ apiBaseUrl: 'https://remote.example', runtimeKey: 'remote' });
      expect(opencodeClient.getBaseUrl().startsWith('https://remote.example')).toBe(true);

      useConfigStore.setState({ isInitialized: true, isConnected: true });
      switchRuntimeEndpoint({ apiBaseUrl: 'http://127.0.0.1:4100', runtimeKey: 'local' });

      expect(opencodeClient.getBaseUrl().startsWith('http://127.0.0.1:4100')).toBe(true);
      expect(useConfigStore.getState().isInitialized).toBe(false);
      expect(useConfigStore.getState().isConnected).toBe(false);
    } finally {
      uninstall();
    }
  });

  // The login gate re-applies the same endpoint with a fresh client token after
  // sign-in, while App is unmounted. That must not wipe the host's state.
  test('leaves a same-runtime credential change to App', () => {
    installWindow();
    stubFetch();
    switchRuntimeEndpoint({ apiBaseUrl: 'https://remote.example', runtimeKey: 'remote' });
    const uninstall = installRuntimeEndpointReset();
    try {
      useConfigStore.setState({ isInitialized: true, isConnected: true });
      const catalog = [{ name: 'retained', type: 'local' as const, command: ['fixture'] }];
      useMcpConfigStore.setState({ serversByDirectory: { '/fixture': catalog }, mcpServers: catalog });
      switchRuntimeEndpoint({ apiBaseUrl: 'https://remote.example', clientToken: 'fresh-token', runtimeKey: 'remote' });
      expect(useMcpConfigStore.getState().serversByDirectory['/fixture']).toBe(catalog);
      expect(useMcpConfigStore.getState().mcpServers).toBe(catalog);

      expect(useConfigStore.getState().isInitialized).toBe(true);
      expect(useConfigStore.getState().isConnected).toBe(true);
    } finally {
      uninstall();
    }
  });

  test('stops resetting once uninstalled', () => {
    installWindow();
    stubFetch();
    const uninstall = installRuntimeEndpointReset();
    switchRuntimeEndpoint({ apiBaseUrl: 'https://first.example', runtimeKey: 'first' });
    uninstall();

    switchRuntimeEndpoint({ apiBaseUrl: 'https://second.example', runtimeKey: 'second' });

    expect(opencodeClient.getBaseUrl().startsWith('https://first.example')).toBe(true);
  });
});

for (const returnToA of [false, true]) {
  test(`MCP catalog authority and TTL reset for the same path${returnToA ? ' after A-to-B-to-A' : ' on B'}`, async () => {
    installWindow();
    let reads = 0;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      if (!String(input instanceof Request ? input.url : input).includes('/api/config/mcp')) return new Response(null, { status: 404 });
      reads += 1;
      return Response.json([{ name: `catalog-${reads}`, type: 'local', command: ['fixture'] }]);
    };
    switchRuntimeEndpoint({ apiBaseUrl: 'https://mcp-a.example', runtimeKey: 'mcp-a' });
    const uninstall = installRuntimeEndpointReset();
    try {
      await useMcpConfigStore.getState().loadMcpConfigs({ force: true, directory: '/fixture' });
      useMcpStore.setState({ byDirectory: { '/fixture': { old: { name: 'old', status: { status: 'connected' } } } } });
      switchRuntimeEndpoint({ apiBaseUrl: 'https://mcp-b.example', runtimeKey: 'mcp-b' });
      if (returnToA) switchRuntimeEndpoint({ apiBaseUrl: 'https://mcp-a.example', runtimeKey: 'mcp-a' });
      expect(useMcpConfigStore.getState().serversByDirectory['/fixture']).toBeUndefined();
      expect(useMcpConfigStore.getState().mcpServers).toEqual([]);
      expect(useMcpConfigStore.getState().isLoading).toBe(false);
      expect(useMcpStore.getState().getStatusForDirectory('/fixture')).toEqual({});
      expect(await useMcpConfigStore.getState().loadMcpConfigs({ directory: '/fixture' })).toBe(true);
      expect(reads).toBe(2);
      expect(useMcpConfigStore.getState().getMcpServersForDirectory('/fixture')[0]?.name).toBe('catalog-2');
    } finally { uninstall(); }
  });
}

test('retired MCP inflight completion cannot satisfy or untrack the replacement runtime read', async () => {
  installWindow();
  let reads = 0;
  let finishOld!: (response: Response) => void;
  let finishNew!: (response: Response) => void;
  const old = new Promise<Response>((resolve) => { finishOld = resolve; });
  const current = new Promise<Response>((resolve) => { finishNew = resolve; });
  globalThis.fetch = async (input: RequestInfo | URL) => {
    if (!String(input instanceof Request ? input.url : input).includes('/api/config/mcp')) return new Response(null, { status: 404 });
    reads += 1;
    return reads === 1 ? old : current;
  };
  switchRuntimeEndpoint({ apiBaseUrl: 'https://pending-a.example', runtimeKey: 'pending-a' });
  const uninstall = installRuntimeEndpointReset();
  try {
    const oldLoad = useMcpConfigStore.getState().loadMcpConfigs({ force: true, directory: '/fixture' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    switchRuntimeEndpoint({ apiBaseUrl: 'https://pending-b.example', runtimeKey: 'pending-b' });
    switchRuntimeEndpoint({ apiBaseUrl: 'https://pending-a.example', runtimeKey: 'pending-a' });
    const newLoad = useMcpConfigStore.getState().loadMcpConfigs({ directory: '/fixture' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reads).toBe(2);
    finishOld(Response.json([{ name: 'retired', type: 'local', command: ['old'] }]));
    expect(await oldLoad).toBe(false);
    expect(useMcpConfigStore.getState().serversByDirectory['/fixture']).toBeUndefined();
    expect(useMcpConfigStore.getState().isLoading).toBe(true);
    const joined = useMcpConfigStore.getState().loadMcpConfigs({ directory: '/fixture' });
    await Promise.resolve(); expect(reads).toBe(2);
    finishNew(Response.json([{ name: 'current', type: 'local', command: ['current'] }]));
    expect(await newLoad).toBe(true); expect(await joined).toBe(true);
    expect(useMcpConfigStore.getState().getMcpServersForDirectory('/fixture')[0]?.name).toBe('current');
  } finally { finishOld(Response.json([])); finishNew(Response.json([])); uninstall(); }
});
