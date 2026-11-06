import { expect } from 'bun:test';
import { refreshRuntimeUrlAuthToken } from './runtime-auth';
import { switchRuntimeEndpoint } from './runtime-switch';

/** Own the unrelated URL-token mint started by real runtime switches in tests. */
export const createRuntimeUrlAuthFixture = (apiBases: readonly string[]) => {
  const allowedRequests = new Set(apiBases.map((base) => `POST ${base ? new URL('/auth/url-token', base).href : '/auth/url-token'}`));
  const requests: string[] = [];
  const pending: Array<Promise<PromiseSettledResult<string>[]>> = [];
  let previousFetch: PropertyDescriptor | undefined;
  let installed = false;
  const fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = `${init?.method ?? (input instanceof Request ? input.method : 'GET')} ${input instanceof Request ? input.url : String(input)}`;
    requests.push(request);
    if (!allowedRequests.has(request)) throw new Error(`Unexpected URL-token fixture request: ${request}`);
    return new Response(null, { status: 404 });
  }, { preconnect: () => {} });

  return {
    switchEndpoint: (options: Parameters<typeof switchRuntimeEndpoint>[0]) => {
      if (!installed) {
        previousFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
        Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: fetch });
        installed = true;
      }
      switchRuntimeEndpoint(options);
      // Join synchronously, before a failed mint can settle or a later switch
      // can replace it. Preserve the caller's synchronous switch ordering.
      pending.push(Promise.allSettled([refreshRuntimeUrlAuthToken(options.apiBaseUrl)]));
    },
    restore: async () => {
      if (!installed) return;
      try {
        const outcomes = (await Promise.all(pending)).flat();
        let failedMints = 0;
        for (const outcome of outcomes) {
          expect(outcome.status).toBe('rejected');
          if (outcome.status !== 'rejected' || !(outcome.reason instanceof Error)) throw new Error('Expected a controlled URL-token mint failure');
          expect(['Failed to mint runtime URL auth token (404)', 'Runtime URL auth token response is stale']).toContain(outcome.reason.message);
          if (outcome.reason.message === 'Failed to mint runtime URL auth token (404)') failedMints += 1;
        }
        expect(requests.every((request) => allowedRequests.has(request))).toBe(true);
        expect(requests).toHaveLength(failedMints);
      } finally {
        if (previousFetch) Object.defineProperty(globalThis, 'fetch', previousFetch);
        else Reflect.deleteProperty(globalThis, 'fetch');
        installed = false;
        requests.length = 0;
        pending.length = 0;
      }
    },
  };
};
