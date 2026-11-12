import { z } from 'zod';
import { APP_NAME_EN } from '@/lib/branding';
import { isDesktopShell } from '@/lib/desktop';
import { desktopHostsGet, desktopHostsSet, getDesktopHostApiUrl, normalizeHostUrl } from '@/lib/desktopHosts';
import { getRuntimeExtraHeadersSync } from '@/lib/runtime-auth';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { captureRuntimeInstance, getRuntimeApiBaseUrl, getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';

const LOCAL_DESKTOP_CLIENT_KIND = 'desktop-local';
const LOCAL_DESKTOP_CLIENT_DEDUPE_KEY = 'desktop-local';

const mintedClientTokenSchema = z.object({ token: z.string().trim().min(1) });

/** Identifies the runtime instance the credential was minted for. */
type CapturedDesktopRuntime = {
  apiBaseUrl: string;
  runtimeKey: string;
  isCurrent: () => boolean;
};

type DesktopClientAuthMetadata = {
  clientKind?: string;
  dedupeKey?: string;
};

const captureDesktopRuntime = (): CapturedDesktopRuntime => ({
  apiBaseUrl: getRuntimeApiBaseUrl(),
  runtimeKey: getRuntimeKey(),
  isCurrent: captureRuntimeInstance(),
});

const isCapturedDesktopRuntimeActive = (runtime: CapturedDesktopRuntime): boolean => (
  runtime.isCurrent()
  && runtime.apiBaseUrl === getRuntimeApiBaseUrl()
  && runtime.runtimeKey === getRuntimeKey()
);

const readLocalDesktopOrigin = (): string => {
  if (typeof window === 'undefined') return '';
  return window.__OPENCHAMBER_LOCAL_ORIGIN__?.trim() || '';
};

/** An SSH-forwarded server is a remote host reached through a local port. */
const isForwardedRuntime = (apiBaseUrl: string): boolean => {
  if (typeof window === 'undefined') return false;
  const forwarded = window.__OPENCHAMBER_SSH_FORWARD_API_URL__?.trim() || '';
  return forwarded.length > 0 && forwarded === apiBaseUrl;
};

const sameOrigin = (left: string, right: string): boolean => {
  const normalizedLeft = normalizeHostUrl(left);
  const normalizedRight = normalizeHostUrl(right);
  if (!normalizedLeft || !normalizedRight) return false;
  try {
    return new URL(normalizedLeft).origin === new URL(normalizedRight).origin;
  } catch {
    return false;
  }
};

const isLoopbackHostname = (hostname: string): boolean => {
  const clean = hostname.replace(/^\[|\]$/g, '');
  return clean === 'localhost' || clean === '127.0.0.1' || clean === '::1';
};

/** The packaged page talks to this machine's own server, whether or not the page is same-origin with it. */
export const isLocalDesktopRuntime = (): boolean => {
  if (!isDesktopShell()) return false;
  const localOrigin = readLocalDesktopOrigin();
  if (!localOrigin) return false;
  // An empty API base means same-origin requests against the page itself,
  // which on desktop IS the embedded local server. Requiring an exact origin
  // match here used to leave local client tokens untagged (no desktop-local
  // clientKind), and the server's client-create gate then 403'd them.
  const apiBaseUrl = getRuntimeApiBaseUrl();
  const effectiveTarget = apiBaseUrl || (typeof window !== 'undefined' ? window.location.origin : '');
  if (sameOrigin(localOrigin, effectiveTarget)) return true;
  // Loopback aliases (localhost vs 127.0.0.1) still address this machine's
  // own server.
  try {
    const normalized = normalizeHostUrl(effectiveTarget);
    return Boolean(normalized && isLoopbackHostname(new URL(normalized).hostname));
  } catch {
    return false;
  }
};

export const desktopClientAuthMetadata = (): DesktopClientAuthMetadata => {
  if (!isLocalDesktopRuntime()) return {};
  return {
    clientKind: LOCAL_DESKTOP_CLIENT_KIND,
    dedupeKey: LOCAL_DESKTOP_CLIENT_DEDUPE_KEY,
  };
};

/** Asks the connected server for a device credential; empty when it cannot mint one. */
export const issueDesktopClientToken = async (): Promise<string> => {
  const response = await runtimeFetch('/api/client-auth/clients', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ label: `${APP_NAME_EN} Desktop`, ...desktopClientAuthMetadata() }),
  }).catch(() => null);
  if (!response?.ok) {
    return '';
  }

  const parsed = mintedClientTokenSchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data.token : '';
};

const persistDesktopClientToken = async (runtime: CapturedDesktopRuntime, clientToken: string): Promise<boolean> => {
  if (!isDesktopShell() || !clientToken || !isCapturedDesktopRuntimeActive(runtime)) return false;
  const config = await desktopHostsGet().catch(() => null);
  if (!config || !isCapturedDesktopRuntimeActive(runtime)) return false;
  // An empty API base means the page's own origin, which on desktop is the
  // embedded server in this window's session. It and a loopback target are the
  // Local host; that host's credential lives in its own settings field, never
  // among the saved remote hosts.
  const targetsLocalServer = !isForwardedRuntime(runtime.apiBaseUrl)
    && (!runtime.apiBaseUrl || sameOrigin(config.localOrigin || '', runtime.apiBaseUrl) || isLocalDesktopRuntime());
  if (targetsLocalServer) {
    try {
      await desktopHostsSet({
        hosts: config.hosts,
        defaultHostId: config.defaultHostId,
        initialHostChoiceCompleted: config.initialHostChoiceCompleted,
        localClientToken: clientToken,
      });
    } catch {
      return false;
    }
    return isCapturedDesktopRuntimeActive(runtime);
  }
  let changed = false;
  const hosts = config.hosts.map((host) => {
    if (!sameOrigin(getDesktopHostApiUrl(host), runtime.apiBaseUrl)) {
      return host;
    }
    if (host.clientToken === clientToken) {
      return host;
    }
    changed = true;
    return { ...host, clientToken };
  });
  if (!changed) return true;
  if (!isCapturedDesktopRuntimeActive(runtime)) return false;
  try {
    await desktopHostsSet({
      hosts,
      defaultHostId: config.defaultHostId,
      initialHostChoiceCompleted: config.initialHostChoiceCompleted,
    });
  } catch {
    return false;
  }
  return isCapturedDesktopRuntimeActive(runtime);
};

/** Persists a device credential for this runtime and makes it the active bearer. */
export const applyDesktopClientToken = async (clientToken: string): Promise<boolean> => {
  const runtime = captureDesktopRuntime();
  if (!clientToken || !isCapturedDesktopRuntimeActive(runtime)) return false;
  if (!await persistDesktopClientToken(runtime, clientToken)) return false;
  if (!isCapturedDesktopRuntimeActive(runtime)) return false;
  const requestHeaders = getRuntimeExtraHeadersSync();
  switchRuntimeEndpoint({
    apiBaseUrl: runtime.apiBaseUrl,
    clientToken,
    requestHeaders: Object.keys(requestHeaders).length > 0 ? requestHeaders : null,
    runtimeKey: runtime.runtimeKey,
  });
  return true;
};

const pendingIdentities = new Map<string, Promise<boolean>>();

/**
 * Mints and installs this desktop's device credential for the active runtime.
 * A server whose client store lost the record (a truncated data file, a wiped
 * data directory) otherwise leaves the window holding a bearer it will refuse
 * for every request, including the account read the sign-in gate needs.
 */
export const ensureDesktopClientIdentity = async (): Promise<boolean> => {
  if (!isDesktopShell()) return false;
  const runtime = captureDesktopRuntime();
  const requestKey = `${runtime.runtimeKey}\u0000${runtime.apiBaseUrl}`;
  const pending = pendingIdentities.get(requestKey);
  if (pending) return pending;
  const request = (async () => {
    const clientToken = await issueDesktopClientToken();
    if (!clientToken || !isCapturedDesktopRuntimeActive(runtime)) return false;
    return applyDesktopClientToken(clientToken);
  })();
  pendingIdentities.set(requestKey, request);
  try {
    return await request;
  } finally {
    if (pendingIdentities.get(requestKey) === request) pendingIdentities.delete(requestKey);
  }
};
