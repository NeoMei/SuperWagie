import { describe, expect, test } from 'bun:test';
import {
  configureRuntimeUrlResolver,
  createRuntimeUrlResolver,
  getRuntimeUrlResolver,
  setRuntimeUrlResolver,
} from './runtime-url';
import { refreshLocalRuntimeUrlAuthToken, refreshRuntimeUrlAuthToken, setLocalRuntimeUrlAuthToken, setRuntimeBearerToken, setRuntimeExtraHeaders, setRuntimeUrlAuthToken } from './runtime-auth';

describe('createRuntimeUrlResolver', () => {
  const withWindow = async (
    value: {
      location: { origin: string; href: string };
      __OPENCHAMBER_API_BASE_URL__?: string;
      __OPENCHAMBER_LOCAL_ORIGIN__?: string;
    },
    expectedMints: string[],
    callback: () => void,
  ): Promise<void> => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    try {
      globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = `${init?.method ?? (input instanceof Request ? input.method : 'GET')} ${input instanceof Request ? input.url : String(input)}`;
        requests.push(request);
        if (request !== expectedMints[requests.length - 1]) {
          throw new Error(`Unexpected URL-token mint request: ${request}`);
        }
        return new Response(null, { status: 404 });
      }, { preconnect: () => {} });
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value,
      });
      callback();
    } finally {
      try {
        // Capture the local mint before an empty runtime-token read clears it.
        const localMint = value.__OPENCHAMBER_LOCAL_ORIGIN__
          ? refreshLocalRuntimeUrlAuthToken(value.__OPENCHAMBER_LOCAL_ORIGIN__)
          : Promise.resolve();
        await Promise.allSettled([localMint, refreshRuntimeUrlAuthToken()]);
        expect(requests).toEqual(expectedMints);
      } finally {
        globalThis.fetch = originalFetch;
        if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
        else Reflect.deleteProperty(globalThis, 'window');
      }
    }
  };

  test('preserves relative same-origin URLs by default', () => {
    const urls = createRuntimeUrlResolver({ currentHref: () => 'http://127.0.0.1:3000/app' });

    expect(urls.api('/api/config/settings')).toBe('/api/config/settings');
    expect(urls.health()).toBe('/health');
    expect(urls.rawFile('/tmp/a b.txt')).toBe('/api/fs/raw?path=%2Ftmp%2Fa+b.txt');
  });

  test('builds absolute API URLs when an API base URL is configured', () => {
    const urls = createRuntimeUrlResolver({ apiBaseUrl: 'https://server.example/base/' });

    // The base URL's path prefix (/base) is preserved so instances served
    // under a reverse-proxy sub-path receive requests at the right location.
    expect(urls.api('/api/config/settings')).toBe('https://server.example/base/api/config/settings');
    expect(urls.auth('/auth/device', { next: '/app' })).toBe('https://server.example/base/auth/device?next=%2Fapp');
    expect(urls.health({ probe: true })).toBe('https://server.example/base/health?probe=true');
  });

  test('builds absolute API URLs from an origin-only API base URL', () => {
    const urls = createRuntimeUrlResolver({ apiBaseUrl: 'https://server.example' });

    expect(urls.api('/api/config/settings')).toBe('https://server.example/api/config/settings');
    expect(urls.health({ probe: true })).toBe('https://server.example/health?probe=true');
  });

  test('drops a query or hash carried by a saved host URL', () => {
    const urls = createRuntimeUrlResolver({ apiBaseUrl: 'https://server.example:3000/?session=ses_1#top' });

    expect(urls.api('/api/config/settings')).toBe('https://server.example:3000/api/config/settings');
    expect(urls.health({ probe: true })).toBe('https://server.example:3000/health?probe=true');
  });

  test('uses realtime base URL for SSE and WebSocket URLs', () => {
    const urls = createRuntimeUrlResolver({
      apiBaseUrl: 'https://api.example',
      realtimeBaseUrl: 'https://realtime.example/root',
    });

    expect(urls.sse('/api/openchamber/events')).toBe('https://realtime.example/root/api/openchamber/events');
    expect(urls.websocket('/api/global/event/ws', { lastEventId: 'evt-1' })).toBe(
      'wss://realtime.example/root/api/global/event/ws?lastEventId=evt-1',
    );
  });

  test('converts absolute HTTP URLs to WebSocket URLs', () => {
    const urls = createRuntimeUrlResolver({ apiBaseUrl: 'https://api.example' });

    expect(urls.websocket('http://remote.example/api/terminal/ws')).toBe('ws://remote.example/api/terminal/ws');
    expect(urls.websocket('https://remote.example/api/global/event/ws', { lastEventId: '2' })).toBe(
      'wss://remote.example/api/global/event/ws?lastEventId=2',
    );
    expect(urls.websocket('wss://remote.example/api/terminal/ws')).toBe('wss://remote.example/api/terminal/ws');
  });

  test('derives WebSocket origin from the current page for default relative URLs', () => {
    const urls = createRuntimeUrlResolver({ currentHref: () => 'http://localhost:5173/mobile.html' });

    expect(urls.websocket('/api/terminal/ws')).toBe('ws://localhost:5173/api/terminal/ws');
  });

  test('uses injected desktop API base URL for packaged WebSocket URLs', async () => {
    await withWindow({
      location: { origin: 'openchamber-ui://app', href: 'openchamber-ui://app/index.html' },
      __OPENCHAMBER_API_BASE_URL__: 'http://127.0.0.1:57123',
    }, ['POST http://127.0.0.1:57123/auth/url-token'], () => {
      const urls = createRuntimeUrlResolver({});

      expect(urls.websocket('/api/global/event/ws')).toBe('ws://127.0.0.1:57123/api/global/event/ws');
    });
  });

  test('routes realtime URLs through local desktop proxy when runtime headers are configured', async () => {
    setRuntimeExtraHeaders({ 'CF-Access-Client-Id': 'client-id' });
    try {
      await withWindow({
        location: { origin: 'openchamber-ui://app', href: 'openchamber-ui://app/index.html' },
        __OPENCHAMBER_API_BASE_URL__: 'https://remote.example',
        __OPENCHAMBER_LOCAL_ORIGIN__: 'http://127.0.0.1:57123',
      }, [
        'POST http://127.0.0.1:57123/auth/url-token',
        'POST http://127.0.0.1:57123/auth/url-token',
        'POST https://remote.example/auth/url-token',
      ], () => {
        const urls = createRuntimeUrlResolver({});
        const sse = new URL(urls.sse('/api/global/event'));
        const ws = new URL(urls.websocket('/api/global/event/ws'));

        expect(sse.origin).toBe('http://127.0.0.1:57123');
        expect(sse.pathname).toBe('/api/openchamber/realtime-proxy/sse');
        expect(sse.searchParams.get('url')).toBe('https://remote.example/api/global/event');
        expect(ws.origin).toBe('ws://127.0.0.1:57123');
        expect(ws.pathname).toBe('/api/openchamber/realtime-proxy/ws');
        expect(ws.searchParams.get('url')).toBe('wss://remote.example/api/global/event/ws');
      });
    } finally {
      setRuntimeExtraHeaders(null);
    }
  });

  test('adds local URL auth token to desktop realtime proxy URL', async () => {
    setRuntimeExtraHeaders({ 'CF-Access-Client-Id': 'client-id' });
    setRuntimeUrlAuthToken('remote-url-token', Date.now() + 60_000);
    setLocalRuntimeUrlAuthToken('local-url-token', Date.now() + 60_000, 'http://127.0.0.1:57123');
    try {
      await withWindow({
        location: { origin: 'openchamber-ui://app', href: 'openchamber-ui://app/index.html' },
        __OPENCHAMBER_API_BASE_URL__: 'https://remote.example',
        __OPENCHAMBER_LOCAL_ORIGIN__: 'http://127.0.0.1:57123',
      }, [], () => {
        const urls = createRuntimeUrlResolver({});
        const sse = new URL(urls.sse('/api/global/event'));
        const target = new URL(sse.searchParams.get('url') || '');

        expect(sse.searchParams.get('oc_url_token')).toBe('local-url-token');
        expect(target.searchParams.get('oc_url_token')).toBe('remote-url-token');
      });
    } finally {
      setRuntimeExtraHeaders(null);
      setRuntimeUrlAuthToken(null, null);
      setLocalRuntimeUrlAuthToken(null, null);
    }
  });

  test('reads injected desktop API base URL at call time', async () => {
    await withWindow({
      location: { origin: 'openchamber-ui://app', href: 'openchamber-ui://app/index.html' },
    }, ['POST http://127.0.0.1:57123/auth/url-token'], () => {
      const urls = createRuntimeUrlResolver({});
      (window as typeof window & { __OPENCHAMBER_API_BASE_URL__?: string }).__OPENCHAMBER_API_BASE_URL__ = 'http://127.0.0.1:57123';

      expect(urls.api('/api/config/settings')).toBe('http://127.0.0.1:57123/api/config/settings');
      expect(urls.websocket('/api/global/event/ws')).toBe('ws://127.0.0.1:57123/api/global/event/ws');
    });
  });

  test('allows runtime-wide resolver configuration', () => {
    const previous = getRuntimeUrlResolver();
    try {
      const configured = configureRuntimeUrlResolver({ apiBaseUrl: 'https://api.example' });
      expect(getRuntimeUrlResolver()).toBe(configured);
      expect(getRuntimeUrlResolver().api('/api/version')).toBe('https://api.example/api/version');
    } finally {
      setRuntimeUrlResolver(previous);
    }
  });

  test('adds short-lived URL auth query to realtime and authenticated asset URLs only', () => {
    setRuntimeBearerToken('oc_client_secret');
    setRuntimeUrlAuthToken('oc_url_secret', Date.now() + 60_000);
    try {
      const urls = createRuntimeUrlResolver({ apiBaseUrl: 'https://api.example' });

      expect(urls.api('/api/config/settings')).toBe('https://api.example/api/config/settings');
      expect(urls.authenticatedAsset('/api/projects/p1/icon', { v: 123 })).toBe(
        'https://api.example/api/projects/p1/icon?v=123&oc_url_token=oc_url_secret',
      );
      expect(urls.sse('/api/openchamber/events')).toBe(
        'https://api.example/api/openchamber/events?oc_url_token=oc_url_secret',
      );
      expect(urls.websocket('/api/global/event/ws', { lastEventId: 'evt-1' })).toBe(
        'wss://api.example/api/global/event/ws?lastEventId=evt-1&oc_url_token=oc_url_secret',
      );
    } finally {
      setRuntimeBearerToken(null);
    }
  });

  test('replaces existing short-lived URL auth query on relative authenticated URLs', () => {
    setRuntimeUrlAuthToken('oc_url_secret', Date.now() + 60_000);
    try {
      const urls = createRuntimeUrlResolver();

      expect(urls.authenticatedAsset('/api/preview/proxy/abc/?oc_url_token=stale&x=1#top')).toBe(
        '/api/preview/proxy/abc/?oc_url_token=oc_url_secret&x=1#top',
      );
    } finally {
      setRuntimeUrlAuthToken(null, null);
    }
  });

  test('does not put the long-lived client token in URLs', () => {
    setRuntimeBearerToken('oc_client_secret');
    try {
      const urls = createRuntimeUrlResolver({ apiBaseUrl: 'https://api.example' });
      expect(urls.sse('/api/openchamber/events')).toBe('https://api.example/api/openchamber/events');
      expect(urls.websocket('/api/global/event/ws')).toBe('wss://api.example/api/global/event/ws');
      expect(urls.authenticatedAsset('/api/projects/p1/icon')).toBe('https://api.example/api/projects/p1/icon');
      expect(urls.assetWithUrlToken('/api/guests/hello/panel/index.html', 'oc_url_guest', { oc_ui: 'issue-page' })).toBe(
        'https://api.example/api/guests/hello/panel/index.html?oc_ui=issue-page&oc_url_token=oc_url_guest',
      );
    } finally {
      setRuntimeBearerToken(null);
    }
  });
});
