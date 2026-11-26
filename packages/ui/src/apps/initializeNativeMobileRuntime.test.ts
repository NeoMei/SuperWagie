import { expect, spyOn, test } from 'bun:test';
import * as persistence from '@/lib/persistence';
import { isRetiredPlatformProvider } from '@/lib/platformAccount';
import { getRuntimeApiBaseUrl, MOBILE_DISCONNECTED_RUNTIME_KEY, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { canSaveNativeMobileModelPreferences, initializeNativeMobileRuntime } from './initializeNativeMobileRuntime';

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
  const firstSettings = deferred<void>();
  const legacySettings = deferred<void>();
  const legacySettingsStarted = deferred<void>();
  let holdStandalone = true;
  const settings = spyOn(persistence, 'syncDesktopSettings').mockImplementation(async (options) => {
    if (getRuntimeApiBaseUrl() === legacyHost) {
      legacySettingsStarted.resolve();
      await legacySettings.promise;
    } else if (holdStandalone) {
      await firstSettings.promise;
    }
    options?.onApplied?.();
  });
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
    expect(canSaveNativeMobileModelPreferences()).toBe(false);

    switchRuntimeEndpoint({ apiBaseUrl: legacyHost, clientToken: 'device-fixture' });
    const legacyInitialization = initializeNativeMobileRuntime(initialize);
    await legacySettingsStarted.promise;
    expect(canSaveNativeMobileModelPreferences()).toBe(false);
    expect(initialSelections).toEqual([]);
    legacySettings.resolve();
    await legacyInitialization;
    expect(initialSelections).toEqual(['unihub']);
    expect(canSaveNativeMobileModelPreferences()).toBe(true);
    firstSettings.resolve();
    firstRequest.resolve(Response.json({ status: 'disabled' }));
    await staleInitialization;
    expect(initialSelections).toEqual(['unihub']);
    expect(retiredProviders.some(isRetiredPlatformProvider)).toBe(false);

    holdStandalone = false;
    switchRuntimeEndpoint({ apiBaseUrl: standaloneHost, clientToken: 'device-fixture' });
    expect(canSaveNativeMobileModelPreferences()).toBe(false);
    await initializeNativeMobileRuntime(initialize);
    expect(initialSelections).toEqual(['unihub', 'custom']);
    expect(canSaveNativeMobileModelPreferences()).toBe(true);
  } finally {
    switchRuntimeEndpoint({ apiBaseUrl: '', runtimeKey: MOBILE_DISCONNECTED_RUNTIME_KEY });
    fetch.mockRestore();
    settings.mockRestore();
  }
});
