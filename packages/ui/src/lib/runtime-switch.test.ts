import { describe, expect, test } from 'bun:test';
import {
  getRuntimeApiBaseUrl,
  getRuntimeKey,
  initializeRuntimeEndpoint,
  isSshForwardedRuntime,
  subscribeRuntimeEndpointChanged,
  subscribeRuntimeEndpointWillChange,
  switchRuntimeEndpoint,
} from './runtime-switch';
import { clearRuntimeUrlAuthToken, refreshRuntimeUrlAuthToken, setRuntimeExtraHeaders } from './runtime-auth';
import {
  activateRelayTunnel,
  deactivateRelayTunnel,
  getActiveRelayDescriptor,
} from './relay/runtime-tunnel';

describe('runtime endpoint switching', () => {
  const mockUrlTokenMint = (url: string, response: Response) => {
    const requests: string[] = [];
    const expectedRequest = `POST ${url}`;
    return {
      fetch: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = `${init?.method ?? (input instanceof Request ? input.method : 'GET')} ${input instanceof Request ? input.url : String(input)}`;
        requests.push(request);
        if (request !== expectedRequest || requests.length !== 1) {
          throw new Error(`Unexpected URL-token mint request: ${request}`);
        }
        return response;
      }, { preconnect: () => {} }),
      settle: async () => {
        await Promise.allSettled([refreshRuntimeUrlAuthToken()]);
        expect(requests).toEqual([expectedRequest]);
      },
    };
  };

  test('uses the injected SSH forward at boot and replaces it on host switches', async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const previousFetch = globalThis.fetch;
    const forwarded = 'http://127.0.0.1:54000';
    const mint = mockUrlTokenMint('http://127.0.0.1:54000/auth/url-token', new Response(null, { status: 404 }));
    try {
      globalThis.fetch = mint.fetch;
      const runtimeWindow = { __OPENCHAMBER_API_BASE_URL__: forwarded, dispatchEvent: () => true };
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: runtimeWindow,
      });

      initializeRuntimeEndpoint({ apiBaseUrl: forwarded, runtimeKey: 'host:ssh-1' });
      expect(isSshForwardedRuntime()).toBe(false);
      Object.defineProperty(runtimeWindow, '__OPENCHAMBER_SSH_FORWARD_API_URL__', { value: forwarded });
      expect(isSshForwardedRuntime()).toBe(true);
      switchRuntimeEndpoint({ apiBaseUrl: forwarded, runtimeKey: 'host:ssh-1', sshForwarded: true });
      expect(isSshForwardedRuntime()).toBe(true);
      switchRuntimeEndpoint({ apiBaseUrl: forwarded, runtimeKey: 'host:local-2' });
      expect(isSshForwardedRuntime()).toBe(false);
      switchRuntimeEndpoint({ apiBaseUrl: forwarded, runtimeKey: 'host:ssh-1', sshForwarded: true });
      switchRuntimeEndpoint({ apiBaseUrl: forwarded, runtimeKey: 'host:ssh-1', clientToken: 'new-token' });
      expect(isSshForwardedRuntime()).toBe(true);
    } finally {
      try {
        await mint.settle();
      } finally {
        globalThis.fetch = previousFetch;
        if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
        else Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });

  test('exposes a credential-free copy of the active relay descriptor', () => {
    const descriptor = {
      relayUrl: 'wss://relay.example.com',
      serverId: 'server-1',
      hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'public-x', y: 'public-y' },
      grant: 'one-time-secret',
    };

    try {
      activateRelayTunnel(descriptor);
      const exposed = getActiveRelayDescriptor();
      expect(exposed).toEqual({
        relayUrl: descriptor.relayUrl,
        serverId: descriptor.serverId,
        hostEncPubJwk: descriptor.hostEncPubJwk,
      });
      expect(exposed).not.toBe(descriptor);
      expect(exposed?.hostEncPubJwk).not.toBe(descriptor.hostEncPubJwk);
    } finally {
      deactivateRelayTunnel();
    }
  });

  test('notifies listeners before and after mutating the active endpoint', async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const previousFetch = globalThis.fetch;
    const mint = mockUrlTokenMint('https://runtime-b.example/auth/url-token', new Response(null, { status: 404 }));
    const events = new EventTarget();
    const runtimeWindow = {
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
    };

    try {
      globalThis.fetch = mint.fetch;
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: runtimeWindow,
      });
      switchRuntimeEndpoint({ apiBaseUrl: 'https://runtime-a.example', runtimeKey: 'runtime-a' });
      const observed: Array<[string, string, string]> = [];
      const unsubscribeWillChange = subscribeRuntimeEndpointWillChange((detail) => {
        observed.push(['will-change', getRuntimeKey(), detail.previousRuntimeKey]);
      });
      const unsubscribeChanged = subscribeRuntimeEndpointChanged((detail) => {
        observed.push(['changed', getRuntimeKey(), detail.runtimeKey]);
      });

      switchRuntimeEndpoint({ apiBaseUrl: 'https://runtime-b.example', runtimeKey: 'runtime-b' });

      expect(observed).toEqual([
        ['will-change', 'runtime-a', 'runtime-a'],
        ['changed', 'runtime-b', 'runtime-b'],
      ]);
      unsubscribeWillChange();
      unsubscribeChanged();
    } finally {
      try {
        await mint.settle();
      } finally {
        globalThis.fetch = previousFetch;
        if (previousWindow) {
          Object.defineProperty(globalThis, 'window', previousWindow);
        } else {
          Reflect.deleteProperty(globalThis, 'window');
        }
      }
    }
  });

  test('does not throw when Electron preload globals are read-only', async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const previousFetch = globalThis.fetch;
    const mint = mockUrlTokenMint('https://remote.example/auth/url-token', Response.json({ token: 'url-token', expiresAt: Date.now() + 60_000 }));
    const runtimeWindow = {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
    };

    try {
      clearRuntimeUrlAuthToken();
      setRuntimeExtraHeaders(null);
      globalThis.fetch = mint.fetch;
      Object.defineProperty(runtimeWindow, '__OPENCHAMBER_API_BASE_URL__', {
        configurable: true,
        value: 'http://127.0.0.1:3000',
        writable: false,
      });
      Object.defineProperty(runtimeWindow, '__OPENCHAMBER_CLIENT_TOKEN__', {
        configurable: true,
        value: '',
        writable: false,
      });
      Object.defineProperty(runtimeWindow, '__OPENCHAMBER_RUNTIME_HEADERS__', {
        configurable: true,
        value: {},
        writable: false,
      });
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: runtimeWindow,
      });

      let thrown: unknown = null;
      try {
        switchRuntimeEndpoint({
          apiBaseUrl: 'https://remote.example',
          clientToken: 'client-token',
          requestHeaders: null,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeNull();
      expect(getRuntimeApiBaseUrl()).toBe('https://remote.example');
    } finally {
      try {
        await mint.settle();
      } finally {
        globalThis.fetch = previousFetch;
        clearRuntimeUrlAuthToken();
        setRuntimeExtraHeaders(null);
        if (previousWindow) {
          Object.defineProperty(globalThis, 'window', previousWindow);
        } else {
          Reflect.deleteProperty(globalThis, 'window');
        }
      }
    }
  });
});
