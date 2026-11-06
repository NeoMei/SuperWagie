import { describe, expect, test } from 'bun:test';
import { createRuntimeOpencodeClient } from '@/lib/opencode/client';
import { addRuntimeProxyHeaders, buildRuntimeFetchUrl, isLatin1Safe, installRuntimeFetchBridge, runtimeFetch, sanitizeHeadersForBrowser } from './runtime-fetch';
import { clearRuntimeAuthCredentialProvider, setRuntimeAuthCredentialProvider, setRuntimeBearerToken } from './runtime-auth';
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from './runtime-url';

import { getRuntimeApiBaseUrl, getRuntimeKey, switchRuntimeEndpoint } from './runtime-switch';

const originalFetch = globalThis.fetch;

describe('buildRuntimeFetchUrl', () => {
  test('preserves same-origin paths by default', () => {
    expect(buildRuntimeFetchUrl('/api/config/settings')).toBe('/api/config/settings');
    expect(buildRuntimeFetchUrl('/auth/session')).toBe('/auth/session');
    expect(buildRuntimeFetchUrl('/health')).toBe('/health');
  });

  test('resolves API/auth/health through configured runtime URL resolver', () => {
    const previous = getRuntimeUrlResolver();
    try {
      configureRuntimeUrlResolver({ apiBaseUrl: 'https://api.example' });

      expect(buildRuntimeFetchUrl('/api/config/settings')).toBe('https://api.example/api/config/settings');
      expect(buildRuntimeFetchUrl('/auth/session')).toBe('https://api.example/auth/session');
      expect(buildRuntimeFetchUrl('/health')).toBe('https://api.example/health');
      expect(buildRuntimeFetchUrl('/api/find/file', { query: 'x' })).toBe('https://api.example/api/find/file?query=x');
    } finally {
      setRuntimeUrlResolver(previous);
    }
  });

  test('rewrites current-origin absolute API URLs only', () => {
    const previous = getRuntimeUrlResolver();
    const originalWindow = globalThis.window;
    try {
      configureRuntimeUrlResolver({ apiBaseUrl: 'https://api.example' });
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { location: { origin: 'openchamber-ui://app', href: 'openchamber-ui://app/index.html' } },
      });

      expect(buildRuntimeFetchUrl('openchamber-ui://app/api/config/settings')).toBe('https://api.example/api/config/settings');
      expect(buildRuntimeFetchUrl('https://external.example/api/config/settings')).toBe('https://external.example/api/config/settings');
    } finally {
      setRuntimeUrlResolver(previous);
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
      globalThis.fetch = originalFetch;
      clearRuntimeAuthCredentialProvider();
    }
  });
});

describe('addRuntimeProxyHeaders', () => {
  test('bypasses the ngrok browser interstitial for official ngrok hosts', () => {
    const headers = addRuntimeProxyHeaders('https://demo.ngrok-free.app/health', new Headers());

    expect(headers.get('ngrok-skip-browser-warning')).toBe('openchamber');
  });

  test('does not add proxy headers to non-ngrok or lookalike hosts', () => {
    expect(addRuntimeProxyHeaders('https://runtime.example/health', new Headers()).has('ngrok-skip-browser-warning')).toBe(false);
    expect(addRuntimeProxyHeaders('https://ngrok-free.app.evil.example/health', new Headers()).has('ngrok-skip-browser-warning')).toBe(false);
  });
});

describe('runtimeFetch transport contract', () => {
  test('adds the ngrok bypass header to runtime requests', async () => {
    const previous = getRuntimeUrlResolver();
    let capturedHeaders = new Headers();
    try {
      configureRuntimeUrlResolver({ apiBaseUrl: 'https://demo.ngrok-free.app' });
      globalThis.fetch = async (_input, init) => {
        capturedHeaders = new Headers(init?.headers);
        return new Response(null, { status: 204 });
      };

      await runtimeFetch('/health');

      expect(capturedHeaders.get('ngrok-skip-browser-warning')).toBe('openchamber');
    } finally {
      setRuntimeUrlResolver(previous);
      globalThis.fetch = originalFetch;
    }
  });

  test('preserves bodies from actual SDK mutation requests on same-origin runtimes', async () => {
    const previous = getRuntimeUrlResolver();
    const originalWindow = globalThis.window;
    const calls: Array<{ url: string; method: string; body: string; headers: Headers }> = [];

    try {
      configureRuntimeUrlResolver({});
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { location: { origin: 'https://app.example', href: 'https://app.example/' } },
      });

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        calls.push({
          url: request.url,
          method: request.method,
          body: await request.clone().text(),
          headers: request.headers,
        });
        // The generated client checks each route's declared success status:
        // staging a revert answers 200 with a body, the other mutations 204.
        if (request.url.endsWith('/revert/stage')) {
          return new Response(JSON.stringify({ ok: true, id: 'ses_1', time: { created: 1 } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(null, { status: 204 });
      }) as typeof fetch;

      const client = createRuntimeOpencodeClient({ baseUrl: 'https://app.example/api', directory: '/repo' });

      await client.session.revert.stage({ sessionID: 'ses_1', messageID: 'msg_1' });
      await client.session.shell({ sessionID: 'ses_1', command: 'ls' });
      await client.session.update({ sessionID: 'ses_1', title: 'Renamed' });
      await client.permission.reply({ sessionID: 'ses_1', requestID: 'perm_1', decision: 'once' });
      await client.session.form.reply({ sessionID: 'ses_1', formID: 'form_1', answer: { confirm: true } });

      expect(calls.map((call) => call.url)).toEqual([
        'https://app.example/api/session/ses_1/revert/stage',
        'https://app.example/api/session/ses_1/shell',
        'https://app.example/api/session/ses_1',
        'https://app.example/api/session/ses_1/permission/perm_1/reply',
        'https://app.example/api/session/ses_1/form/form_1/reply',
      ]);
      expect(calls.map((call) => call.method)).toEqual(['POST', 'POST', 'PATCH', 'POST', 'POST']);
      expect(calls.map((call) => call.headers.get('content-type'))).toEqual([
        'application/json',
        'application/json',
        'application/json',
        'application/json',
        'application/json',
      ]);
      // Every request carries the directory as a header, not a query parameter.
      expect(new Set(calls.map((call) => call.headers.get('x-opencode-directory')))).toEqual(new Set(['%2Frepo']));
      expect(calls.map((call) => JSON.parse(call.body))).toEqual([
        { messageID: 'msg_1' },
        { command: 'ls' },
        { title: 'Renamed' },
        { decision: 'once' },
        { answer: { confirm: true } },
      ]);
    } finally {
      setRuntimeUrlResolver(previous);
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
      globalThis.fetch = originalFetch;
      clearRuntimeAuthCredentialProvider();
    }
  });

  test('preserves SDK-style Request method, JSON body, signal, path, query, and merges auth headers', async () => {
    const previous = getRuntimeUrlResolver();
    const originalWindow = globalThis.window;
    const controller = new AbortController();
    const calls: Array<{ input: Request; body: string }> = [];

    try {
      configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime.example/base' });
      setRuntimeBearerToken('runtime-token');
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { location: { origin: 'https://app.example', href: 'https://app.example/app' } },
      });

      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const request = input instanceof Request ? input : new Request(input);
        calls.push({ input: request, body: await request.clone().text() });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as typeof fetch;

      const request = new Request('https://app.example/api/session/abc/prompt_async?directory=%2Frepo&workspace=main', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-sdk-header': 'kept',
        },
        body: JSON.stringify({ parts: [{ type: 'text', text: 'hello' }] }),
        signal: controller.signal,
      });

      await runtimeFetch(request, { headers: { 'x-init-header': 'merged' } });

      expect(calls).toHaveLength(1);
      const captured = calls[0].input;
      expect(captured.url).toBe('https://runtime.example/base/api/session/abc/prompt_async?directory=%2Frepo&workspace=main');
      expect(captured.method).toBe('POST');
      expect(captured.signal).toBe(controller.signal);
      expect(captured.headers.get('content-type')).toBe('application/json');
      expect(captured.headers.get('x-sdk-header')).toBe('kept');
      expect(captured.headers.get('x-init-header')).toBe('merged');
      expect(captured.headers.get('authorization')).toBe('Bearer runtime-token');
      expect(calls[0].body).toBe(JSON.stringify({ parts: [{ type: 'text', text: 'hello' }] }));
    } finally {
      setRuntimeUrlResolver(previous);
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    }
  });

  test('attaches runtime auth to a request already addressed under a sub-path host', async () => {
    const previous = getRuntimeUrlResolver();
    const originalWindow = globalThis.window;
    const calls: Request[] = [];

    try {
      configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime.example/base' });
      setRuntimeBearerToken('runtime-token');
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { location: { origin: 'https://app.example', href: 'https://app.example/app' } },
      });

      globalThis.fetch = (async (input: RequestInfo | URL) => {
        calls.push(input instanceof Request ? input : new Request(input));
        return new Response('{}', { status: 200 });
      }) as typeof fetch;

      await runtimeFetch(new Request('https://runtime.example/base/api/config/settings'));
      await runtimeFetch(new Request('https://runtime.example/other/api/config/settings'));

      expect(calls[0].url).toBe('https://runtime.example/base/api/config/settings');
      expect(calls[0].headers.get('authorization')).toBe('Bearer runtime-token');
      expect(calls[1].headers.get('authorization')).toBeNull();
    } finally {
      setRuntimeUrlResolver(previous);
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    }
  });

  test('does not replace an existing Authorization header', async () => {
    const previous = getRuntimeUrlResolver();
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];

    try {
      configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime.example' });
      setRuntimeBearerToken('runtime-token');

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init });
        return new Response(null, { status: 204 });
      }) as typeof fetch;

      await runtimeFetch('/api/path', {
        headers: { Authorization: 'Bearer sdk-token' },
      });

      expect(new Headers(calls[0].init?.headers).get('authorization')).toBe('Bearer sdk-token');
    } finally {
      setRuntimeUrlResolver(previous);
      globalThis.fetch = originalFetch;
      clearRuntimeAuthCredentialProvider();
    }
  });

  test('resolves URLSearchParams query and auth for runtime asset fetches', async () => {
    const previous = getRuntimeUrlResolver();
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];

    try {
      configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime.example' });
      setRuntimeBearerToken('runtime-token');

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init });
        return new Response(new Blob(['icon']), { status: 200 });
      }) as typeof fetch;

      await runtimeFetch('/api/projects/project-1/icon', {
        method: 'GET',
        headers: { Accept: 'image/*' },
        query: new URLSearchParams({ v: '123', theme: 'dark', iconColor: '#fff' }),
      });

      expect(String(calls[0].input)).toBe('https://runtime.example/api/projects/project-1/icon?v=123&theme=dark&iconColor=%23fff');
      const headers = new Headers(calls[0].init?.headers);
      expect(headers.get('accept')).toBe('image/*');
      expect(headers.get('authorization')).toBe('Bearer runtime-token');
    } finally {
      setRuntimeUrlResolver(previous);
      globalThis.fetch = originalFetch;
      clearRuntimeAuthCredentialProvider();
    }
  });

  test('does not attach runtime auth to non-runtime absolute URLs', async () => {
    const previous = getRuntimeUrlResolver();
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];

    try {
      configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime.example' });
      setRuntimeBearerToken('runtime-token');

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init });
        return new Response(null, { status: 204 });
      }) as typeof fetch;

      await runtimeFetch('https://old-runtime.example/api/config/settings');

      expect(String(calls[0].input)).toBe('https://old-runtime.example/api/config/settings');
      expect(new Headers(calls[0].init?.headers).has('authorization')).toBe(false);
    } finally {
      setRuntimeUrlResolver(previous);
      globalThis.fetch = originalFetch;
      clearRuntimeAuthCredentialProvider();
    }
  });

  test('attaches runtime auth to active runtime auth URLs', async () => {
    const previous = getRuntimeUrlResolver();
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];

    try {
      configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime.example' });
      setRuntimeBearerToken('runtime-token');

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init });
        return new Response(JSON.stringify({ authenticated: true }), { status: 200 });
      }) as typeof fetch;

      await runtimeFetch('https://runtime.example/auth/session');

      expect(String(calls[0].input)).toBe('https://runtime.example/auth/session');
      expect(new Headers(calls[0].init?.headers).get('authorization')).toBe('Bearer runtime-token');
    } finally {
      setRuntimeUrlResolver(previous);
      globalThis.fetch = originalFetch;
      clearRuntimeAuthCredentialProvider();
    }
  });
});

describe('runtimeFetch read coalescing', () => {
  test('coalesces concurrent identical GET reads into one fetch', async () => {
    const previous = getRuntimeUrlResolver();
    let calls = 0;
    try {
      configureRuntimeUrlResolver({ apiBaseUrl: 'https://api.example' });
      globalThis.fetch = (async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 20));
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;

      const [a, b] = await Promise.all([
        runtimeFetch('/api/config/providers'),
        runtimeFetch('/api/config/providers'),
      ]);

      expect(calls).toBe(1);
      // Each caller gets an independently-readable clone.
      expect(await a.json()).toEqual({ ok: true });
      expect(await b.json()).toEqual({ ok: true });

      // After settle the entry is gone — a later call re-fetches.
      await runtimeFetch('/api/config/providers');
      expect(calls).toBe(2);
    } finally {
      setRuntimeUrlResolver(previous);
      globalThis.fetch = originalFetch;
      clearRuntimeAuthCredentialProvider();
    }
  });

  test('keeps reads for different directories apart', async () => {
    const previous = getRuntimeUrlResolver();
    const seen: string[] = [];
    try {
      configureRuntimeUrlResolver({ apiBaseUrl: 'https://api.example' });
      globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        const directory = new Headers(init?.headers).get('x-opencode-directory') ?? '';
        seen.push(directory);
        await new Promise((r) => setTimeout(r, 20));
        return new Response(JSON.stringify({ directory }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;

      const [a, b] = await Promise.all([
        runtimeFetch('/api/config', { headers: { 'x-opencode-directory': encodeURIComponent('/repo/a') } }),
        runtimeFetch('/api/config', { headers: { 'x-opencode-directory': encodeURIComponent('/repo/b') } }),
      ]);

      expect(seen).toHaveLength(2);
      expect(await a.json()).toEqual({ directory: encodeURIComponent('/repo/a') });
      expect(await b.json()).toEqual({ directory: encodeURIComponent('/repo/b') });
    } finally {
      setRuntimeUrlResolver(previous);
      globalThis.fetch = originalFetch;
      clearRuntimeAuthCredentialProvider();
    }
  });

  test('does not coalesce non-GET, non-allowlisted, or signal-bearing requests', async () => {
    const previous = getRuntimeUrlResolver();
    let calls = 0;
    try {
      configureRuntimeUrlResolver({ apiBaseUrl: 'https://api.example' });
      globalThis.fetch = (async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 10));
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;

      // POST to an allowlisted path → not coalesced.
      await Promise.all([
        runtimeFetch('/api/config/providers', { method: 'POST' }),
        runtimeFetch('/api/config/providers', { method: 'POST' }),
      ]);
      expect(calls).toBe(2);

      calls = 0;
      // GET to a non-allowlisted path → not coalesced.
      await Promise.all([
        runtimeFetch('/api/session'),
        runtimeFetch('/api/session'),
      ]);
      expect(calls).toBe(2);

      calls = 0;
      // GET to an allowlisted path but carrying an AbortSignal → not coalesced.
      await Promise.all([
        runtimeFetch('/api/config/providers', { signal: AbortSignal.timeout(1000) }),
        runtimeFetch('/api/config/providers', { signal: AbortSignal.timeout(1000) }),
      ]);
      expect(calls).toBe(2);
    } finally {
      setRuntimeUrlResolver(previous);
      globalThis.fetch = originalFetch;
      clearRuntimeAuthCredentialProvider();
    }
  });
});

describe('runtimeFetch header sanitization', () => {
  test('isLatin1Safe returns true for Latin-1 strings', () => {
    expect(isLatin1Safe('hello')).toBe(true);
    expect(isLatin1Safe('/path/to/file.txt')).toBe(true);
    expect(isLatin1Safe('')).toBe(true);
    expect(isLatin1Safe('\u00FF')).toBe(true);
  });

  test('isLatin1Safe returns false for strings with characters above U+00FF', () => {
    expect(isLatin1Safe('你好')).toBe(false);
    expect(isLatin1Safe('D:\\文件')).toBe(false);
    expect(isLatin1Safe('\u0100')).toBe(false);
  });

  test('sanitizeHeadersForBrowser encodes non-Latin-1 values in object form', () => {
    const result = sanitizeHeadersForBrowser({ 'x-test': '你好' });
    expect(result).toBeTruthy();
    expect(result![0][0]).toBe('x-test');
    expect(result![0][1]).toBe(encodeURIComponent('你好'));
  });

  test('sanitizeHeadersForBrowser encodes non-Latin-1 values in array form', () => {
    const result = sanitizeHeadersForBrowser([['x-test', 'こんにちは']]);
    expect(result).toBeTruthy();
    expect(result![0][0]).toBe('x-test');
    expect(result![0][1]).toBe(encodeURIComponent('こんにちは'));
  });

  test('sanitizeHeadersForBrowser returns undefined when no encoding needed', () => {
    const result = sanitizeHeadersForBrowser({ 'x-test': 'hello', accept: 'application/json' });
    expect(result).toBeFalsy();
  });

  test('sanitizeHeadersForBrowser leaves Latin-1 directory hints unchanged', () => {
    const path = 'C:\\work\\foo%20bar';
    const result = sanitizeHeadersForBrowser({ 'x-opencode-directory': path });
    expect(result).toBeFalsy();
  });

  test('sanitizeHeadersForBrowser encodes non-Latin-1 directory hints with marker', () => {
    const path = 'D:\\文件夹';
    const result = sanitizeHeadersForBrowser({ 'x-opencode-directory': path });
    expect(result).toBeTruthy();
    const encoded = Object.fromEntries(result!);
    expect(encoded['x-opencode-directory']).toBe(encodeURIComponent(path));
    expect(encoded['x-opencode-directory-encoding']).toBe('uri');
  });

  test('sanitizeHeadersForBrowser returns undefined for empty/undefined input', () => {
    expect(sanitizeHeadersForBrowser(undefined)).toBeFalsy();
    expect(sanitizeHeadersForBrowser({})).toBeFalsy();
  });

  test('sanitizeHeadersForBrowser only encodes non-Latin-1 values, leaves Latin-1 unchanged', () => {
    const result = sanitizeHeadersForBrowser({
      accept: 'application/json',
      'x-chinese': '文件',
      'content-type': 'text/plain',
    });
    expect(result).toBeTruthy();
    const encoded = Object.fromEntries(result!);
    expect(encoded.accept).toBe('application/json');
    expect(encoded['content-type']).toBe('text/plain');
    expect(encoded['x-chinese']).toBe(encodeURIComponent('文件'));
  });

  test('runtimeFetch encodes directory request headers with marker', async () => {
    const previous = getRuntimeUrlResolver();
    const originalWindow = globalThis.window;
    const calls: Array<{ headers: Headers }> = [];

    try {
      configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime.example' });
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { location: { origin: 'https://app.example', href: 'https://app.example/' } },
      });

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ headers: new Headers(init?.headers) });
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;

      await runtimeFetch('/api/config/providers', {
        headers: { 'x-opencode-directory': 'D:\\文件夹' },
      });

      expect(calls).toHaveLength(1);
      const encoded = calls[0].headers.get('x-opencode-directory');
      expect(encoded).not.toBe('D:\\文件夹');
      // decodeURIComponent round-trips back to original
      expect(decodeURIComponent(encoded!)).toBe('D:\\文件夹');
      expect(calls[0].headers.get('x-opencode-directory-encoding')).toBe('uri');
    } finally {
      setRuntimeUrlResolver(previous);
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
      globalThis.fetch = originalFetch;
      clearRuntimeAuthCredentialProvider();
    }
  });
});

describe('runtimeFetch addresses isolated spaces', () => {
  const SPACE = 'a1b2c3d4e5f6';
  const REPO = `/spaces/${SPACE}/repo`;
  type Seen = { url: string; directory: string | null; encoding: string | null };
  let lastHeaders = new Headers();
  const capture = async (input: string | URL | Request, init?: Parameters<typeof runtimeFetch>[1]): Promise<Seen> => {
    let seen: Seen = { url: '', directory: null, encoding: null };
    globalThis.fetch = (async (target: string | URL | Request, requestInit?: RequestInit) => {
      const request = new Request(target instanceof Request ? target : new URL(target.toString(), 'http://localhost:3000'), requestInit);
      lastHeaders = request.headers;
      seen = {
        url: target instanceof Request ? target.url : target.toString(),
        directory: request.headers.get('x-opencode-directory'),
        encoding: request.headers.get('x-opencode-directory-encoding'),
      };
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    try {
      await runtimeFetch(input, init);
    } finally {
      globalThis.fetch = originalFetch;
    }
    return seen;
  };

  test('leaves the path of a request that names a space directory as it is: the server reads the directory', async () => {
    const query = `/api/git/status?directory=${encodeURIComponent(REPO)}`;
    expect(await capture(query)).toEqual({ url: query, directory: null, encoding: null });
    expect((await capture('/api/fs/list', { headers: { 'x-opencode-directory': REPO } })).url).toBe('/api/fs/list');
    expect((await capture('/api/fs/raw', { query: { path: '/x', directory: REPO } })).url)
      .toBe(`/api/fs/raw?path=%2Fx&directory=${encodeURIComponent(REPO)}`);
  });

  test('sends the caller directory option of a space as the directory header, and nothing for a host directory', async () => {
    expect(await capture('/api/terminal/create', { method: 'POST', body: '{}', directory: REPO }))
      .toEqual({ url: '/api/terminal/create', directory: encodeURIComponent(REPO), encoding: 'uri' });
    expect(await capture('/api/terminal/create', { method: 'POST', body: '{}', directory: '/home/me/repo' }))
      .toEqual({ url: '/api/terminal/create', directory: null, encoding: null });
    // A caller's own headers stay beside it, in any shape.
    await capture('/api/terminal/create', { method: 'POST', headers: [['Content-Type', 'application/json']], body: '{}', directory: REPO });
    expect(lastHeaders.get('content-type')).toBe('application/json');
    expect(lastHeaders.get('x-opencode-directory')).toBe(encodeURIComponent(REPO));
  });

  test('leaves a directory header the caller set itself, so a request naming two directories reaches the server as it is', async () => {
    expect(await capture('/api/fs/list', { headers: { 'x-opencode-directory': '/home/me/repo' }, directory: REPO }))
      .toEqual({ url: '/api/fs/list', directory: '/home/me/repo', encoding: null });
    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { origin: 'http://localhost:3000', href: 'http://localhost:3000/index.html' } },
    });
    try {
      // The SDK builds a Request on the page's own origin, with its header URI-encoded.
      const sdk = new Request('http://localhost:3000/api/session', { headers: { 'x-opencode-directory': encodeURIComponent(REPO) } });
      expect(await capture(sdk, { directory: `/spaces/${SPACE}/other` }))
        .toEqual({ url: 'http://localhost:3000/api/session', directory: encodeURIComponent(REPO), encoding: null });
    } finally {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    }
  });

  test('never rewrites a path, the older prefixed form included', async () => {
    const prefixed = `/api/spaces/${SPACE}/session?directory=${encodeURIComponent(REPO)}`;
    expect((await capture(prefixed)).url).toBe(prefixed);
    expect((await capture('/health', { directory: REPO })).url).toBe('/health');
  });
});

describe('runtimeFetch coalescing ownership', () => {
  test('A-to-B-to-A reads use fresh authority and old settlement cannot untrack the new read', async () => {
    const previous = { apiBaseUrl: getRuntimeApiBaseUrl(), runtimeKey: getRuntimeKey() };
    let finishOld!: (response: Response) => void;
    let finishNew!: (response: Response) => void;
    const old = new Promise<Response>((resolve) => { finishOld = resolve; });
    const current = new Promise<Response>((resolve) => { finishNew = resolve; });
    let calls = 0;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      if (!String(input instanceof Request ? input.url : input).includes('/api/config/mcp')) return new Response(null, { status: 404 });
      calls += 1;
      return calls === 1 ? old : current;
    };
    const options = { headers: { 'x-opencode-directory': '/same' } };
    try {
      switchRuntimeEndpoint({ apiBaseUrl: 'https://coalesce-a.example', runtimeKey: 'coalesce-a' });
      const retired = runtimeFetch('/api/config/mcp', options);
      await new Promise((resolve) => setTimeout(resolve, 0));
      switchRuntimeEndpoint({ apiBaseUrl: 'https://coalesce-b.example', runtimeKey: 'coalesce-b' });
      switchRuntimeEndpoint({ apiBaseUrl: 'https://coalesce-a.example', runtimeKey: 'coalesce-a' });
      const fresh = runtimeFetch('/api/config/mcp', options);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(calls).toBe(2);
      finishOld(Response.json({ source: 'old' }));
      expect(await (await retired).json()).toEqual({ source: 'old' });
      // Same-instance credentials preserve this runtime's pending request.
      switchRuntimeEndpoint({ apiBaseUrl: 'https://coalesce-a.example', runtimeKey: 'coalesce-a', clientToken: 'fixture-token' });
      const joined = runtimeFetch('/api/config/mcp', options);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(calls).toBe(2);
      finishNew(Response.json({ source: 'current' }));
      expect(await (await fresh).json()).toEqual({ source: 'current' });
      expect(await (await joined).json()).toEqual({ source: 'current' });
    } finally {
      finishOld(Response.json({})); finishNew(Response.json({}));
      switchRuntimeEndpoint(previous); globalThis.fetch = originalFetch; clearRuntimeAuthCredentialProvider();
    }
  });

  test('a read retired during async header preparation cannot replace current coalescing authority', async () => {
    const previous = { apiBaseUrl: getRuntimeApiBaseUrl(), runtimeKey: getRuntimeKey() };
    let releaseHeaders!: () => void;
    const headers = new Promise<void>((resolve) => { releaseHeaders = resolve; });
    let finishCurrent!: (response: Response) => void;
    const current = new Promise<Response>((resolve) => { finishCurrent = resolve; });
    let calls = 0;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      if (!String(input instanceof Request ? input.url : input).includes('/api/config/mcp')) return new Response(null, { status: 404 });
      calls += 1;
      return calls === 1 ? current : Response.json({ source: 'retired' });
    };
    try {
      switchRuntimeEndpoint({ apiBaseUrl: 'https://headers-a.example', runtimeKey: 'headers-a' });
      setRuntimeAuthCredentialProvider(async () => { await headers; return null; });
      const retired = runtimeFetch('/api/config/mcp');
      switchRuntimeEndpoint({ apiBaseUrl: 'https://headers-b.example', runtimeKey: 'headers-b' });
      switchRuntimeEndpoint({ apiBaseUrl: 'https://headers-a.example', runtimeKey: 'headers-a' });
      clearRuntimeAuthCredentialProvider();
      const fresh = runtimeFetch('/api/config/mcp');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(calls).toBe(1);
      releaseHeaders();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(calls).toBe(2);
      expect(await (await retired).json()).toEqual({ source: 'retired' });
      const joined = runtimeFetch('/api/config/mcp');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(calls).toBe(2);
      finishCurrent(Response.json({ source: 'current' }));
      expect(await (await fresh).json()).toEqual({ source: 'current' });
      expect(await (await joined).json()).toEqual({ source: 'current' });
    } finally {
      releaseHeaders(); finishCurrent(Response.json({}));
      switchRuntimeEndpoint(previous); globalThis.fetch = originalFetch; clearRuntimeAuthCredentialProvider();
    }
  });
});

test('the installed bridge dispatches mutations with the destination and credentials captured before a switch', async () => {
  const previous = { apiBaseUrl: getRuntimeApiBaseUrl(), runtimeKey: getRuntimeKey() };
  const keys = ['window', 'location', 'addEventListener', 'removeEventListener', 'dispatchEvent'] as const;
  const descriptors = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const events = new EventTarget();
  const calls: Request[] = [];
  const bodies: string[] = [];
  const nativeFetch: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(new URL(String(input), 'https://window-a.example'), init);
    if (new URL(request.url).pathname === '/auth/url-token') return Response.json({ token: 'dummy-url-token', expiresAt: Date.now() + 60_000 });
    calls.push(request);
    bodies.push(await request.clone().text());
    return Response.json({ success: true });
  };
  try {
    Object.defineProperties(globalThis, {
      window: { configurable: true, value: globalThis },
      location: { configurable: true, value: new URL('https://window-a.example/') },
      addEventListener: { configurable: true, value: events.addEventListener.bind(events) },
      removeEventListener: { configurable: true, value: events.removeEventListener.bind(events) },
      dispatchEvent: { configurable: true, value: events.dispatchEvent.bind(events) },
    });
    globalThis.fetch = nativeFetch;
    installRuntimeFetchBridge();
    const bridge = globalThis.fetch;
    installRuntimeFetchBridge();
    expect(globalThis.fetch).toBe(bridge);
    const fixtures = [
      { bridge: false, kind: 'string', base: '', url: 'https://window-a.example/api/fs/write?before=1&after=2' },
      { bridge: false, kind: 'URL', base: '', url: 'https://window-a.example/api/fs/write?before=1&after=2' },
      { bridge: false, kind: 'Request', base: '', url: 'https://window-a.example/api/fs/write?before=1&after=2' },
      { bridge: true, kind: 'string', base: '', url: 'https://window-a.example/api/fs/write?before=1' },
      { bridge: true, kind: 'URL', base: '', url: 'https://window-a.example/api/fs/write?before=1' },
      { bridge: true, kind: 'Request', base: '', url: 'https://window-a.example/api/fs/write?before=1' },
      { bridge: false, kind: 'Stream', base: '', url: 'https://window-a.example/api/fs/write?before=1&after=2' },
      { bridge: true, kind: 'Stream', base: '', url: 'https://window-a.example/api/fs/write?before=1' },
      { bridge: false, kind: 'string', base: 'https://window-a.example', url: 'https://window-a.example/api/fs/write?before=1&after=2' },
      { bridge: true, kind: 'Request', base: 'https://demo.ngrok-free.app/base', url: 'https://demo.ngrok-free.app/base/api/fs/write?before=1' },
    ];
    for (const fixture of fixtures) {
      switchRuntimeEndpoint({ apiBaseUrl: fixture.base, runtimeKey: 'dispatch-A', clientToken: 'dummy-A', requestHeaders: { 'x-dummy-owner': 'A' } });
      await new Promise((resolve) => setTimeout(resolve, 0));
      calls.length = 0;
      bodies.length = 0;
      const controller = new AbortController();
      const path = '/api/fs/write?before=1';
      const init = { method: 'POST', body: 'dummy-A-body', signal: controller.signal, headers: { 'x-caller': 'kept' } };
      const body = fixture.kind === 'Stream' ? new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode('dummy-A-body')); stream.close(); } }) : init.body;
      const input = fixture.kind === 'string' ? path : fixture.kind === 'URL' ? new URL(path, 'https://window-a.example') : new Request(new URL(path, 'https://window-a.example'), { ...init, body });
      const options = input instanceof Request ? { headers: { 'x-init': 'kept' } } : init;
      const pending = fixture.bridge ? window.fetch(input, options) : runtimeFetch(input, { ...options, query: { after: 2 }, directory: '/spaces/a1b2c3d4e5f6/repo' });
      queueMicrotask(() => switchRuntimeEndpoint({ apiBaseUrl: 'https://runtime-b.example', runtimeKey: 'dispatch-B', clientToken: 'dummy-B', requestHeaders: { 'x-dummy-owner': 'B' } }));
      await pending;
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(fixture.url);
      expect(calls[0].method).toBe('POST');
      expect(bodies).toEqual(['dummy-A-body']);
      expect(calls[0].headers.get('authorization')).toBe('Bearer dummy-A');
      expect(calls[0].headers.get('x-dummy-owner')).toBe('A');
      expect(calls[0].headers.get('x-caller')).toBe('kept');
      expect(calls[0].headers.get('x-opencode-directory')).toBe(fixture.bridge ? null : '%2Fspaces%2Fa1b2c3d4e5f6%2Frepo');
      expect(calls[0].headers.get('ngrok-skip-browser-warning')).toBe(fixture.base.includes('ngrok') ? 'openchamber' : null);
      controller.abort();
      expect(calls[0].signal.aborted).toBe(true);
    }

    for (const dispatch of [window.fetch, runtimeFetch]) {
      calls.length = 0;
      await dispatch('https://external.example/api/fs/write', { method: 'POST', body: 'external-body' });
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('https://external.example/api/fs/write');
      expect(calls[0].headers.has('authorization')).toBe(false);
      expect(calls[0].headers.has('x-dummy-owner')).toBe(false);
    }
    let adapterCalls = 0;
    globalThis.fetch = async () => { adapterCalls += 1; return Response.json({ adapter: 'current' }); };
    expect(await (await runtimeFetch('/api/fs/write', { method: 'POST', body: 'adapter-body' })).json()).toEqual({ adapter: 'current' });
    expect(adapterCalls).toBe(1);
  } finally {
    switchRuntimeEndpoint(previous);
    globalThis.fetch = originalFetch;
    clearRuntimeAuthCredentialProvider();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
