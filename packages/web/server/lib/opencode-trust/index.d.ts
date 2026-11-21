import type { promises } from 'node:fs';

export const OPENCODE_TRUST_ROUTE: '/api/opencode/trust';

export type FolderTrustItem = {
  kind: 'plugin' | 'package' | 'mcp' | 'lsp' | 'formatter' | 'shell' | 'config' | 'env' | 'file' | 'permission';
  name: string;
  detail: string;
  source: string;
};
export type FolderTrustAssessment = { directory: string; fingerprint: string | null; items: FolderTrustItem[]; trusted: boolean };
export type FolderTrustResponse = { status: number; body: FolderTrustAssessment | { error: string; code?: string; directory?: string } };

export type OpenCodeTrust = {
  inspect(directory: string): Promise<FolderTrustAssessment>;
  answer(directory: string, confirmed: string | null): Promise<{ ok: boolean; assessment: FolderTrustAssessment }>;
  isTrusted(directory: string): Promise<boolean>;
  refusalFor(request: {
    method?: string;
    path: string;
    headers?: HeadersInit;
    resolveSessionDirectory?: (sessionId: string) => Promise<string | null>;
    readBody?: () => Promise<string | null>;
    fallbackDirectory?: string;
    prepareDirectory?: (directory: string) => Promise<FolderTrustResponse | null>;
  }): Promise<FolderTrustResponse | null>;
  handleRoute(request: { method: string; query?: object; body?: unknown }): Promise<FolderTrustResponse>;
};

export function createOpenCodeTrust(options: {
  storePath: string;
  io?: typeof promises;
  homeDirectory?: string;
  globalConfigDirectories?: string[];
  getEnvironment?: () => NodeJS.ProcessEnv;
  allowDirectory?: (directory: string) => boolean;
}): OpenCodeTrust;
