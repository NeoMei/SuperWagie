import { expect, spyOn, test } from 'bun:test';
import { isRetiredPlatformProvider } from '@/lib/platformAccount';
import { MOBILE_DISCONNECTED_RUNTIME_KEY, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { initializeNativeMobileRuntime } from './initializeNativeMobileRuntime';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

test('native model initialization waits for the connected server and discards a retired instance response', async () => {
  const standaloneHost = 'https://standalone.example.test';
  const legacyHost = 'https://legacy.example.test';
  const retiredProviders = ['unihub', 'llmrouter', 'superwagie-account-stored'];
  const availableProviders = [...retiredProviders, 'custom'];
  const initialSelections: string[] = [];
  const initialize = async () => {
    const eligible = availableProviders.filter((id) => !isRetiredPlatformProvider(id));
    initialSelections.push(eligible[0]);
  };
  const firstRequest = deferred<Response>();
  const requestStarted = deferred<void>();
  let holdStandalone = true;
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname === '/api/client-auth/url-token') return new Response(null, { status: 404 });
    expect(url.pathname).toBe('/api/platform-account/session');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer device-fixture');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    if (url.origin === legacyHost) return Response.json({ status: 'signed-out' });
    if (!holdStandalone) return Response.json({ status: 'disabled' });
    requestStarted.resolve();
    return firstRequest.promise;
  });
  try {
    await initializeNativeMobileRuntime(initialize);
    expect(initialSelections).toEqual([]);

    switchRuntimeEndpoint({ apiBaseUrl: standaloneHost, clientToken: 'device-fixture' });
    const staleInitialization = initializeNativeMobileRuntime(initialize);
    await requestStarted.promise;
    expect(initialSelections).toEqual([]);

    switchRuntimeEndpoint({ apiBaseUrl: legacyHost, clientToken: 'device-fixture' });
    await initializeNativeMobileRuntime(initialize);
    expect(initialSelections).toEqual(['unihub']);
    firstRequest.resolve(Response.json({ status: 'disabled' }));
    await staleInitialization;
    expect(initialSelections).toEqual(['unihub']);
    expect(retiredProviders.some(isRetiredPlatformProvider)).toBe(false);

    holdStandalone = false;
    switchRuntimeEndpoint({ apiBaseUrl: standaloneHost, clientToken: 'device-fixture' });
    await initializeNativeMobileRuntime(initialize);
    expect(initialSelections).toEqual(['unihub', 'custom']);
  } finally {
    switchRuntimeEndpoint({ apiBaseUrl: '', runtimeKey: MOBILE_DISCONNECTED_RUNTIME_KEY });
    fetch.mockRestore();
  }
});
