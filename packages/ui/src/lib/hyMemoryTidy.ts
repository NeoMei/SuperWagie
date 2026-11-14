import { z } from 'zod';
import { isVSCodeRuntime } from '@/lib/desktop';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { captureRuntimeInstance } from '@/lib/runtime-switch';
import { isSpaceDirectory } from '@/lib/spaces/space-route';
import { ConversationMemoryError } from '@/lib/conversationMemory';

const contentSchema = z.object({ title: z.string(), body: z.string() });
const itemSchema = z.object({
  id: z.string(), kind: z.enum(['manual', 'inference']), type: z.enum(['fact', 'preference', 'reference', 'segment', 'experience', 'methodology']),
  version: z.string(), sourceVersion: z.string(), sourceSessionIds: z.array(z.string()),
  sourceHash: z.string().nullable(), sourceReferences: z.array(z.object({ sessionId: z.string(), messageId: z.string() })), verification: z.enum(['observed', 'unverified']),
  before: contentSchema, after: contentSchema, reasons: z.array(z.enum(['whitespace', 'repeated_paragraph'])),
});
const previewSchema = z.object({ previewId: z.string(), items: z.array(itemSchema), unavailable: z.number(), truncated: z.boolean() });
const revisionsSchema = z.object({ revisions: z.array(itemSchema.extend({ revisionId: z.string() })), unavailable: z.number().int().nonnegative() });
const applySchema = z.object({ results: z.array(z.object({ id: z.string(), kind: z.enum(['manual', 'inference']), state: z.enum(['applied', 'conflict', 'source_changed']), revisionId: z.string().optional() })) });
const undoSchema = z.object({ results: z.array(z.object({ revisionId: z.string(), state: z.enum(['undone', 'conflict', 'source_changed']) })) });
const exportSchema = z.object({ exportId: z.string(), target: z.string(), before: z.string(), after: z.string() });
const errorSchema = z.object({ error: z.string() });
export type HyTidyItem = z.infer<typeof itemSchema>;
export type HyTidyPreview = z.infer<typeof previewSchema>;
export type HyTidyRevision = z.infer<typeof revisionsSchema>['revisions'][number];
export type HyTidyExport = z.infer<typeof exportSchema>;

type TidyRequest = { directory: string } | { directory: string; previewId: string; selectedIds: string[] }
  | { directory: string; revisionIds: string[] } | { directory: string; items: Pick<HyTidyItem, 'id' | 'kind'>[] }
  | { directory: string; exportId: string; confirmed: true };

async function request<T>(route: string, schema: z.ZodType<T>, input: TidyRequest | null, signal: AbortSignal): Promise<T> {
  if (isVSCodeRuntime()) throw new ConversationMemoryError('runtime_unsupported');
  if (input && isSpaceDirectory(input.directory)) throw new ConversationMemoryError('hy_tidy_isolated_unsupported');
  const isCurrentRuntime = captureRuntimeInstance();
  const response = await runtimeFetch(`/api/conversation-memory/tidy/${route}`, input === null ? { signal } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal,
  });
  const body = await response.json().catch(() => null);
  if (signal.aborted) throw new DOMException('The request was aborted', 'AbortError');
  if (!isCurrentRuntime()) throw new ConversationMemoryError('runtime_changed');
  if (!response.ok) {
    const error = errorSchema.safeParse(body);
    throw new ConversationMemoryError(error.success ? error.data.error : `http_${response.status}`);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ConversationMemoryError('bad_response');
  return parsed.data;
}
export const previewHyMemoryTidy = (directory: string, signal: AbortSignal) => request('preview', previewSchema, { directory }, signal);
export const readHyMemoryRevisions = (directory: string, signal: AbortSignal) => request(`revisions?${new URLSearchParams({ directory })}`, revisionsSchema, null, signal);
export const applyHyMemoryTidy = (directory: string, previewId: string, selectedIds: string[], signal: AbortSignal) => request('apply', applySchema, { directory, previewId, selectedIds }, signal);
export const undoHyMemoryTidy = (directory: string, revisionIds: string[], signal: AbortSignal) => request('undo', undoSchema, { directory, revisionIds }, signal);
export const previewHyMemoryExport = (directory: string, items: Pick<HyTidyItem, 'id' | 'kind'>[], signal: AbortSignal) => request('export/preview', exportSchema, { directory, items }, signal);
export const confirmHyMemoryExport = (directory: string, exportId: string, signal: AbortSignal) => request('export/confirm', z.object({ written: z.literal(true), target: z.string() }), { directory, exportId, confirmed: true }, signal);
