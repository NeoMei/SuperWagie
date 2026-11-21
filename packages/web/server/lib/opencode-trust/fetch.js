import { z } from 'zod';

const sessionDirectory = z.object({ location: z.object({ directory: z.string().min(1) }) });
const sessionPayload = z.union([sessionDirectory, z.object({ data: sessionDirectory }).transform((response) => response.data)]);

export const createTrustSessionDirectoryResolver = ({ buildOpenCodeUrl, getOpenCodeAuthHeaders, fetchImpl }) => async (sessionId) => {
  const response = await fetchImpl(buildOpenCodeUrl('/api/session/' + encodeURIComponent(sessionId), ''), {
    headers: getOpenCodeAuthHeaders(),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('OpenCode session location unavailable');
  return sessionPayload.parse(await response.json()).location.directory;
};

const originOf = (buildOpenCodeUrl) => {
  try { return new URL(buildOpenCodeUrl('/', '')).origin; } catch { return null; }
};
const asResponse = ({ status, body }) => Response.json(body, { status });
const registryKey = Symbol.for('openchamber.opencode-trust.fetch-registry');
const requestUrl = (input) => {
  try { return new URL(input instanceof Request ? input.url : input); } catch { return null; }
};

export const createOpenCodeTrustFetch = ({ openCodeTrust, buildOpenCodeUrl, getOpenCodeAuthHeaders, fallbackDirectory, prepareDirectory, fetchImpl }) => {
  const resolveSessionDirectory = createTrustSessionDirectoryResolver({ buildOpenCodeUrl, getOpenCodeAuthHeaders, fetchImpl });
  return async (input, init) => {
    const url = requestUrl(input);
    const origin = originOf(buildOpenCodeUrl);
    if (!url || url.origin !== origin || !url.pathname.startsWith('/api/')) return fetchImpl(input, init);
    const request = input instanceof Request ? input : null;
    const method = init?.method ?? request?.method ?? 'GET';
    const headers = new Headers(init?.headers ?? request?.headers);
    const readBody = async () => {
      if (init?.body instanceof ReadableStream) throw new Error('An OpenCode location requires a JSON body');
      if (init?.body !== undefined && init.body !== null) return new Response(init.body).text();
      return request?.clone().text() ?? null;
    };
    const refusal = await openCodeTrust.refusalFor({
      method, path: url.pathname + url.search, headers, readBody, resolveSessionDirectory,
      fallbackDirectory: fallbackDirectory?.(), prepareDirectory,
    });
    if (refusal) return asResponse(refusal);
    if (originOf(buildOpenCodeUrl) !== origin) {
      return asResponse({ status: 503, body: { error: 'The OpenCode endpoint changed during the folder check' } });
    }
    return fetchImpl(input, init);
  };
};

const createFetchRegistry = (fetchImpl) => {
  const owners = new Map();
  const dispatch = (input, init) => {
    const url = requestUrl(input);
    if (!url?.pathname.startsWith('/api/')) return fetchImpl(input, init);
    const matches = [...owners.values()].filter(({ active, buildOpenCodeUrl }) => active() && originOf(buildOpenCodeUrl) === url.origin);
    if (matches.length === 0) return fetchImpl(input, init);
    if (matches.length === 1) return matches[0].fetch(input, init);
    return Promise.resolve(asResponse({ status: 503, body: { error: 'More than one runtime owns this OpenCode endpoint' } }));
  };
  const registry = {
    dispatch,
    install: (scope, active, options) => owners.set(scope, {
      active,
      buildOpenCodeUrl: options.buildOpenCodeUrl,
      fetch: createOpenCodeTrustFetch({ ...options, fetchImpl }),
    }),
  };
  Object.defineProperty(dispatch, registryKey, { value: registry });
  return registry;
};

export const installOpenCodeTrustFetch = ({ scope, active, ...options }) => {
  const registry = globalThis.fetch[registryKey] ?? createFetchRegistry(globalThis.fetch);
  registry.install(scope, active, options);
  globalThis.fetch = registry.dispatch;
};
