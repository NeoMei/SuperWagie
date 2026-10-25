import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { AuthSessionState } from '@/lib/runtime-auth-expiry';

type ComponentFn<P extends Record<string, unknown> = Record<string, unknown>> = (props: P) => unknown;

type HookRecord = {
  values: unknown[];
  deps: Array<unknown[] | undefined>;
};

type HookEffect = () => void | (() => void);
type HookCallback = (...args: unknown[]) => unknown;
type JSXProps = Record<string, unknown> & { children?: unknown };
type JSXElementType<P extends Record<string, unknown> = Record<string, unknown>> = ComponentFn<P> | string | symbol;

const hookRecords = new Map<unknown, HookRecord>();
let currentRecord: HookRecord | null = null;
let hookIndex = 0;
let pendingEffects: Array<() => void> = [];
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

afterEach(() => {
  if (originalWindow) {
    Object.defineProperty(globalThis, 'window', originalWindow);
  } else {
    Reflect.deleteProperty(globalThis, 'window');
  }
});

const resetHarness = () => {
  hookRecords.clear();
  currentRecord = null;
  hookIndex = 0;
  pendingEffects = [];
  runtimeApiBaseUrl = '';
  runtimeKey = 'local';
  runtimeEndpointChangedListener = null;
  desktopInvoke = async () => null;
  desktopHostsGetCalls = 0;
  desktopHostsSetCalls = 0;
  runtimeSwitchCalls = 0;
  runtimeBearerToken = '';
  clientTokenAvailable = true;
  clientTokenRequests = 0;
  sessionStatusOk = false;
  homeReady = true;
  ensureHomeCalls = 0;
  homeResolutionHangs = false;
  finishHomeResolution = () => undefined;
  authSessionState = 'ok';
  markAuthenticatedCalls = 0;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      isSecureContext: false,
      localStorage: {
        getItem: () => null,
        setItem: () => undefined,
      },
      setTimeout: (callback: () => void) => {
        queueMicrotask(callback);
        return 0;
      },
      clearTimeout: () => undefined,
    },
  });
};

/** Timers the gate starts never fire, as when the test outruns them. */
const holdTimers = () => {
  Object.assign(window, { setTimeout: () => 0 });
};

const shallowEqualDeps = (left?: unknown[], right?: unknown[]): boolean => {
  if (!left || !right) return false;
  if (left.length !== right.length) return false;
  return left.every((value, index) => Object.is(value, right[index]));
};

const getRecord = (component: unknown): HookRecord => {
  const existing = hookRecords.get(component);
  if (existing) return existing;
  const record: HookRecord = { values: [], deps: [] };
  hookRecords.set(component, record);
  return record;
};

const getHookRecord = (): HookRecord => {
  if (!currentRecord) {
    throw new Error('Hooks can only run during a render pass');
  }
  return currentRecord;
};

const renderComponent = <P extends Record<string, unknown>>(component: ComponentFn<P>, props: P): unknown => {
  const previousRecord = currentRecord;
  const previousHookIndex = hookIndex;
  currentRecord = getRecord(component);
  hookIndex = 0;

  try {
    return component(props);
  } finally {
    currentRecord = previousRecord;
    hookIndex = previousHookIndex;
  }
};

function useCallback<T extends HookCallback>(callback: T, deps?: unknown[]): T {
  const record = getHookRecord();
  const index = hookIndex++;
  const previousDeps = record.deps[index];
  if (!shallowEqualDeps(previousDeps, deps)) {
    record.values[index] = callback;
    record.deps[index] = deps;
  }
  return record.values[index] as T;
}

function useEffect(effect: HookEffect, deps?: unknown[]): void {
  const record = getHookRecord();
  const index = hookIndex++;
  const previousDeps = record.deps[index];
  if (!shallowEqualDeps(previousDeps, deps)) {
    record.deps[index] = deps;
    pendingEffects.push(() => {
      effect();
    });
  }
}

function useMemo<T>(factory: () => T, deps?: unknown[]): T {
  const record = getHookRecord();
  const index = hookIndex++;
  const previousDeps = record.deps[index];
  if (!shallowEqualDeps(previousDeps, deps)) {
    record.values[index] = factory();
    record.deps[index] = deps;
  }
  return record.values[index] as T;
}

function useRef<T>(initialValue: T): { current: T } {
  const record = getHookRecord();
  const index = hookIndex++;
  if (record.values[index] === undefined) {
    record.values[index] = { current: initialValue };
  }
  return record.values[index] as { current: T };
}

function useState<T>(initialValue: T | (() => T)): readonly [T, (next: T | ((prev: T) => T)) => void] {
  const record = getHookRecord();
  const index = hookIndex++;
  if (record.values[index] === undefined) {
    record.values[index] = typeof initialValue === 'function'
      ? (initialValue as () => T)()
      : initialValue;
  }

  const setState = (next: T | ((prev: T) => T)) => {
    record.values[index] = typeof next === 'function'
      ? (next as (prev: T) => T)(record.values[index] as T)
      : next;
  };

  return [record.values[index] as T, setState] as const;
}

function jsx<P extends Record<string, unknown>>(type: JSXElementType<P>, props: JSXProps & P): unknown {
  if (type === reactJsxRuntime.Fragment) {
    return props.children ?? null;
  }

  if (typeof type === 'function') {
    return renderComponent(type, props as P);
  }

  return { type, props };
}

const ReactMock = {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
};

const reactJsxRuntime = {
  Fragment: Symbol('Fragment'),
  jsx,
  jsxs: jsx,
  jsxDEV: jsx,
};

let desktopShell = false;
let runtimeFetchRejects = true;
let sessionStatusOk = false;
let homeReady = true;
let ensureHomeCalls = 0;
let homeResolutionHangs = false;
let finishHomeResolution: () => void = () => undefined;
let runtimeApiBaseUrl = '';
let runtimeKey = 'local';
let runtimeEndpointChangedListener: (() => void) | null = null;
let desktopInvoke: () => Promise<unknown> = async () => null;
let desktopHostsGetCalls = 0;
let desktopHostsSetCalls = 0;
let runtimeSwitchCalls = 0;
let runtimeBearerToken = '';
let clientTokenAvailable = true;
let clientTokenRequests = 0;

mock.module('react/jsx-runtime', () => reactJsxRuntime);
mock.module('react/jsx-dev-runtime', () => reactJsxRuntime);

mock.module('react', () => ({
  __esModule: true,
  default: ReactMock,
  ...ReactMock,
}));

mock.module('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: mock(() => false),
}));

mock.module('@/components/ui/button', () => ({
  Button: ({ children }: { children?: unknown }) => children ?? null,
}));

mock.module('@/components/ui/checkbox', () => ({
  Checkbox: () => null,
}));

mock.module('@/components/ui/input', () => ({
  Input: (props: JSXProps) => ({ type: 'input', props }),
}));

mock.module('@/components/ui', () => ({
  toast: {
    success: mock(() => undefined),
    error: mock(() => undefined),
    message: mock(() => undefined),
  },
}));

mock.module('@/components/ui/OpenChamberLogo', () => ({
  OpenChamberLogo: () => 'logo',
}));

mock.module('@/components/icon/Icon', () => ({
  Icon: () => null,
}));

mock.module('@/components/desktop/DesktopHostSwitcher', () => ({
  DesktopHostSwitcherInline: () => 'host-switcher',
}));

mock.module('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

mock.module('@/lib/desktop', () => ({
  invokeDesktop: () => desktopInvoke(),
  isDesktopShell: mock(() => desktopShell),
  isVSCodeRuntime: mock(() => false),
}));

mock.module('@/lib/persistence', () => ({
  initializeAppearancePreferences: mock(() => Promise.resolve()),
  syncDesktopSettings: mock(() => Promise.resolve()),
}));

mock.module('@/lib/directoryPersistence', () => ({
  applyPersistedDirectoryPreferences: mock(() => Promise.resolve()),
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async (path: string) => {
    if (path === '/api/client-auth/clients') {
      clientTokenRequests += 1;
      return new Response(JSON.stringify(clientTokenAvailable ? { token: 'desktop-fixture-token' } : {}), { status: clientTokenAvailable ? 201 : 503 });
    }
    if (runtimeFetchRejects) {
      throw new Error('offline');
    }

    return new Response(JSON.stringify({ authenticated: sessionStatusOk }), {
      status: sessionStatusOk ? 200 : 401,
      headers: { 'content-type': 'application/json' },
    });
  }),
}));

mock.module('@/stores/useDirectoryStore', () => ({
  ensureHomeDirectoryResolved: () => {
    ensureHomeCalls += 1;
    if (homeReady && !homeResolutionHangs) return Promise.resolve();
    return new Promise<void>((resolve) => {
      finishHomeResolution = () => {
        homeReady = true;
        resolve();
      };
    });
  },
  useDirectoryStore: { getState: () => ({ isHomeReady: homeReady }) },
}));

mock.module('@/lib/runtime-auth', () => ({
  getRuntimeExtraHeadersSync: mock(() => ({})),
  getRuntimeBearerTokenSync: () => runtimeBearerToken,
}));

mock.module('@/lib/runtime-switch', () => ({
  getRuntimeApiBaseUrl: () => runtimeApiBaseUrl,
  getRuntimeKey: () => runtimeKey,
  subscribeRuntimeEndpointChanged: (listener: () => void) => {
    runtimeEndpointChangedListener = listener;
    return () => {
      if (runtimeEndpointChangedListener === listener) runtimeEndpointChangedListener = null;
    };
  },
  switchRuntimeEndpoint: (options: { clientToken?: string }) => { runtimeSwitchCalls += 1; runtimeBearerToken = options.clientToken ?? ''; },
}));

mock.module('@/lib/desktopHosts', () => ({
  desktopHostsGet: () => {
    desktopHostsGetCalls += 1;
    return Promise.resolve({ hosts: [], localOrigin: runtimeApiBaseUrl, defaultHostId: null });
  },
  desktopHostsSet: () => {
    desktopHostsSetCalls += 1;
    return Promise.resolve();
  },
  getDesktopHostApiUrl: mock(() => ''),
  normalizeHostUrl: (url: string) => url,
}));

mock.module('@/lib/passkeys', () => ({
  authenticateWithPasskey: mock(() => Promise.resolve(null)),
  cancelPasskeyCeremony: mock(() => undefined),
  defaultPasskeyStatus: { enabled: false, hasPasskeys: false, passkeyCount: 0, rpID: null },
  fetchPasskeyStatus: mock(() => Promise.resolve({ enabled: false, hasPasskeys: false, passkeyCount: 0, rpID: null })),
  isPasskeyCeremonyAbort: mock(() => false),
  registerCurrentDevicePasskey: mock(() => Promise.resolve(null)),
}));

let authSessionState: AuthSessionState = 'ok';
let markAuthenticatedCalls = 0;
const authSessionStore = {
  get state() {
    return authSessionState;
  },
  markAuthenticated: () => {
    markAuthenticatedCalls += 1;
    authSessionState = 'ok';
  },
};

mock.module('@/lib/runtime-auth-expiry', () => ({
  installAuthSessionFocusWatch: mock(() => undefined),
  useAuthSessionStore: Object.assign(
    (selector: (store: typeof authSessionStore) => unknown) => selector(authSessionStore),
    { getState: () => authSessionStore },
  ),
}));

const { SessionAuthGate } = await import('./SessionAuthGate');

const flushEffects = async () => {
  while (pendingEffects.length > 0) {
    const effects = pendingEffects;
    pendingEffects = [];
    for (const effect of effects) {
      effect();
    }
    await Promise.resolve();
  }
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
};

const renderGate = async (deferRuntimeBootstrap = false) => {
  const firstPass = renderComponent(SessionAuthGate, { children: 'child', deferRuntimeBootstrap });
  await flushEffects();
  const secondPass = renderComponent(SessionAuthGate, { children: 'child', deferRuntimeBootstrap });
  await flushEffects();
  return secondPass ?? firstPass;
};

const collectText = (node: unknown): string => {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map((child) => collectText(child)).join(' ');
  if (typeof node === 'object') {
    const element = node as { props?: { children?: unknown } };
    return collectText(element.props?.children);
  }
  return '';
};

const findElement = (node: unknown, type: string): { type: string; props: JSXProps } | null => {
  if (!node || typeof node !== 'object') return null;
  const element = node as { type?: unknown; props?: JSXProps };
  if (element.type === type && element.props) return { type, props: element.props };
  const children = element.props?.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      const match = findElement(child, type);
      if (match) return match;
    }
    return null;
  }
  return findElement(children, type);
};

describe('SessionAuthGate status-check failure behavior', () => {
  test('establishes a desktop bearer before mounting the UniHub login gate', async () => {
    resetHarness();
    desktopShell = true;
    runtimeFetchRejects = false;
    sessionStatusOk = true;
    runtimeApiBaseUrl = 'http://127.0.0.1:4000';

    expect(collectText(await renderGate(true))).toContain('child');
    expect(clientTokenRequests).toBe(1);
    expect(runtimeBearerToken).toBe('desktop-fixture-token');
    expect(desktopHostsSetCalls).toBe(1);
  });

  test('holds back desktop product login when client-token creation fails', async () => {
    resetHarness();
    desktopShell = true;
    runtimeFetchRejects = false;
    sessionStatusOk = true;
    clientTokenAvailable = false;

    expect(collectText(await renderGate(true))).not.toContain('child');
    expect(clientTokenRequests).toBe(1);
    expect(runtimeSwitchCalls).toBe(0);
  });

  test('keeps an existing desktop bearer rather than replacing its product identity', async () => {
    resetHarness();
    desktopShell = true;
    runtimeFetchRejects = false;
    sessionStatusOk = true;
    runtimeBearerToken = 'existing-fixture-token';

    expect(collectText(await renderGate(true))).toContain('child');
    expect(clientTokenRequests).toBe(0);
  });

  test('keeps non-desktop status-check rejection on the error screen', async () => {
    resetHarness();
    desktopShell = false;
    runtimeFetchRejects = true;

    const tree = await renderGate();
    const text = collectText(tree);

    expect(text).toContain('sessionAuth.error.networkTitle');
    expect(text).not.toContain('sessionAuth.locked.unlockTitle');
  });

  test('keeps desktop-shell status-check rejection on the error screen, never a guessed password prompt', async () => {
    resetHarness();
    desktopShell = true;
    runtimeFetchRejects = true;

    const tree = await renderGate();
    const text = collectText(tree);

    expect(text).toContain('sessionAuth.error.networkTitle');
    expect(text).not.toContain('sessionAuth.locked.unlockTitle');
    // A network failure says nothing about the server, so the desktop error
    // screen keeps its real escape hatches: retry and the host switcher.
    expect(text).toContain('host-switcher');
  });

  test('a login that finds the session alive releases the expired state', async () => {
    // The user logged in from another tab, then pressed "Log in" on this tab's banner.
    resetHarness();
    desktopShell = false;
    runtimeFetchRejects = false;
    sessionStatusOk = true;

    expect(collectText(await renderGate())).toContain('child');
    expect(markAuthenticatedCalls).toBe(0);

    authSessionState = 'reauthenticating';
    expect(collectText(await renderGate())).toContain('child');

    expect(markAuthenticatedCalls).toBe(1);
    expect(authSessionState).toBe('ok');
  });

  test('keeps the app unmounted until the home directory is known after login', async () => {
    // First visit to a password-protected server: the page-load attempt could
    // not read the home directory, so it is still unknown at login.
    resetHarness();
    desktopShell = false;
    runtimeFetchRejects = false;
    sessionStatusOk = true;
    homeReady = false;
    holdTimers();

    expect(collectText(await renderGate())).not.toContain('child');
    expect(ensureHomeCalls).toBe(1);

    finishHomeResolution();
    await flushEffects();
    expect(collectText(await renderGate())).toContain('child');
    expect(ensureHomeCalls).toBe(1);
  });

  test('defers workspace reads so the UniHub gate can render before user sign-in', async () => {
    resetHarness();
    desktopShell = false;
    runtimeFetchRejects = false;
    sessionStatusOk = true;
    homeReady = false;
    holdTimers();

    expect(collectText(await renderGate(true))).toContain('child');
    expect(ensureHomeCalls).toBe(0);
  });

  test('a home resolution that never settles holds the app back only until the wait runs out', async () => {
    resetHarness();
    desktopShell = false;
    runtimeFetchRejects = false;
    sessionStatusOk = true;
    homeReady = false;
    homeResolutionHangs = true;

    await renderGate();
    // The harness fires timers at once, so the wait has already run out.
    await flushEffects();
    expect(collectText(renderComponent(SessionAuthGate, { children: 'child' }))).toContain('child');
    expect(ensureHomeCalls).toBe(1);
  });

  test('shows the app at once when the home directory is already known', async () => {
    resetHarness();
    desktopShell = false;
    runtimeFetchRejects = false;
    sessionStatusOk = true;
    // Even a resolution that never settles must not hold back a known home.
    homeResolutionHangs = true;

    expect(collectText(await renderGate())).toContain('child');
  });

  test('discards a password completion after switching to another host', async () => {
    resetHarness();
    desktopShell = true;
    runtimeFetchRejects = false;
    runtimeApiBaseUrl = 'https://host-a.example';
    runtimeKey = 'host:a';
    let resolveLogin: (value: unknown) => void = () => {
      throw new Error('Password login did not start');
    };
    desktopInvoke = () => new Promise((resolve) => { resolveLogin = resolve; });

    const lockedTree = await renderGate();
    const input = findElement(lockedTree, 'input');
    expect(input).not.toBeNull();
    (input?.props.onChange as ((event: { target: { value: string } }) => void) | undefined)?.({ target: { value: 'password-a' } });

    const passwordTree = await renderGate();
    const form = findElement(passwordTree, 'form');
    expect(form).not.toBeNull();
    const pending = (form?.props.onSubmit as ((event: { preventDefault: () => void }) => Promise<void>) | undefined)?.({ preventDefault: () => undefined });
    await Promise.resolve();

    runtimeApiBaseUrl = 'https://host-b.example';
    runtimeKey = 'host:b';
    runtimeEndpointChangedListener?.();
    resolveLogin({ token: 'token-a' });
    await pending;

    expect(desktopHostsGetCalls).toBe(0);
    expect(desktopHostsSetCalls).toBe(0);
    expect(runtimeSwitchCalls).toBe(0);
  });
});
