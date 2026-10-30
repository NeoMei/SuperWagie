import { z } from 'zod';
import { isVSCodeRuntime } from '@/lib/desktop';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey } from '@/lib/runtime-switch';

const statusSchema = z.object({
  enabled: z.boolean(),
  state: z.enum(['off', 'ready', 'processing', 'unavailable']),
  pending: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(),
  entries: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  candidates: z.number().int().nonnegative().optional(),
  blocked: z.number().int().nonnegative().optional(),
  engine: z.object({
    name: z.literal('hy-memory'),
    state: z.enum(['stopped', 'starting', 'ready', 'unavailable']),
    error: z.string().nullable(),
    version: z.string().nullable().optional(),
  }).optional(),
});

const entrySchema = z.object({
  id: z.string(),
  kind: z.enum(['segment', 'experience', 'methodology']),
  title: z.string(),
  body: z.string(),
  status: z.enum(['candidate', 'active', 'superseded', 'forgotten']),
  indexState: z.enum(['pending', 'ready', 'failed']),
  verification: z.enum(['observed', 'unverified']),
  sessionId: z.string(),
  projectId: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  sourceMessageIds: z.array(z.string()),
  limitations: z.array(z.string()),
  error: z.string().nullable().optional(),
  supportingEntryIds: z.array(z.string()).optional(),
  sourceReferences: z.array(z.object({ sessionId: z.string(), messageId: z.string() })).optional(),
});

export type ConversationMemoryStatus = z.infer<typeof statusSchema>;
export type ConversationMemoryEntry = z.infer<typeof entrySchema>;

export class ConversationMemoryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ConversationMemoryError';
  }
}

const errorSchema = z.object({ error: z.string() });
const queuedSchema = z.object({ queued: z.boolean() });
const forgottenSchema = z.object({ forgotten: z.literal(true), pendingCleanup: z.boolean() });

async function request<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
  if (isVSCodeRuntime()) throw new ConversationMemoryError('unsupported');
  const runtimeKey = getRuntimeKey();
  const response = await runtimeFetch(path, init);
  const body = await response.json().catch(() => null);
  if (init.signal?.aborted) throw new DOMException('The request was aborted', 'AbortError');
  if (getRuntimeKey() !== runtimeKey) throw new ConversationMemoryError('runtime_changed');
  if (!response.ok) {
    const error = errorSchema.safeParse(body);
    throw new ConversationMemoryError(error.success ? error.data.error : `http_${response.status}`);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ConversationMemoryError('bad_response');
  return parsed.data;
}

const jsonRequest = (method: 'POST' | 'PUT', body: { enabled: boolean } | { sessionId: string; directory: string } | { id: string; directory: string } | { directory: string; entryIds: string[] }, signal?: AbortSignal): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
  signal,
});

export const readConversationMemoryStatus = (signal?: AbortSignal): Promise<ConversationMemoryStatus> =>
  request('/api/conversation-memory/status', statusSchema, { signal });

export const updateConversationMemorySettings = (enabled: boolean, signal?: AbortSignal): Promise<ConversationMemoryStatus> =>
  request('/api/conversation-memory/settings', statusSchema, jsonRequest('PUT', { enabled }, signal));

export const listConversationMemoryEntries = async ({ directory, query, signal }: { directory: string; query?: string; signal?: AbortSignal }): Promise<ConversationMemoryEntry[]> => {
  const params = new URLSearchParams({ directory });
  if (query?.trim()) params.set('query', query.trim());
  const result = await request(`/api/conversation-memory/entries?${params}`, z.object({ entries: z.array(entrySchema) }), { signal });
  return result.entries;
};

export const captureConversationMemory = ({ sessionId, directory, signal }: { sessionId: string; directory: string; signal?: AbortSignal }): Promise<{ queued: boolean }> =>
  request('/api/conversation-memory/capture', queuedSchema, jsonRequest('POST', { sessionId, directory }, signal));

export const retryConversationMemoryEntry = ({ id, directory, signal }: { id: string; directory: string; signal?: AbortSignal }): Promise<{ queued: boolean }> =>
  request('/api/conversation-memory/retry', queuedSchema, jsonRequest('POST', { id, directory }, signal));

export const forgetConversationMemoryEntry = ({ id, directory, signal }: { id: string; directory: string; signal?: AbortSignal }): Promise<{ forgotten: true; pendingCleanup: boolean }> =>
  request(`/api/conversation-memory/entries/${encodeURIComponent(id)}?${new URLSearchParams({ directory })}`, forgottenSchema, { method: 'DELETE', signal });

export const confirmConversationMemoryEntry = async ({ id, directory, signal }: { id: string; directory: string; signal?: AbortSignal }): Promise<ConversationMemoryEntry> => {
  const result = await request(`/api/conversation-memory/entries/${encodeURIComponent(id)}/confirm?${new URLSearchParams({ directory })}`, z.object({ entry: entrySchema }), { method: 'POST', signal });
  return result.entry;
};

export const consolidateConversationMemory = ({ directory, entryIds, signal }: { directory: string; entryIds: string[]; signal?: AbortSignal }): Promise<{ queued: true }> =>
  request('/api/conversation-memory/consolidate', z.object({ queued: z.literal(true) }), jsonRequest('POST', { directory, entryIds }, signal));
