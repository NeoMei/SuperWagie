type SessionResolverOptions = {
  buildOpenCodeUrl(path: string, prefix?: string): string;
  getOpenCodeAuthHeaders(): HeadersInit;
  fetchImpl: typeof fetch;
};

export function createTrustSessionDirectoryResolver(options: SessionResolverOptions): (sessionId: string) => Promise<string | null>;
