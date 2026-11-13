import { z } from 'zod';
import type { GuestResultCard } from '@openchamber/sdk';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { runtimeFetch } from '@/lib/runtime-fetch';

const sourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task'), taskId: z.string() }),
  z.object({ kind: z.literal('artifact'), path: z.string() }),
]);
export const officialSelectionSchema = z.object({
  id: z.string().uuid(), projectId: z.string(), projectName: z.string(),
  extensionId: z.enum(['openchamber-builtin-workbench', 'openchamber-builtin-creation']), sessionId: z.string().nullable(),
  createdAt: z.number(), revision: z.string().regex(/^[a-f0-9]{64}$/), source: sourceSchema,
  card: z.object({ title: z.string(), text: z.string().optional(), version: z.string().optional(), path: z.string().optional() }),
  preview: z.object({ kind: z.enum(['image', 'text', 'unavailable']), contentType: z.string(), byteLength: z.number().int().nonnegative() }),
});
const listSchema = z.object({ state: z.literal('ready'), selections: z.array(officialSelectionSchema).max(32) });
export type OfficialSelection = z.infer<typeof officialSelectionSchema>;

export const readOfficialSelections = async (projectId: string, authority: 'full' | 'pilot' = 'full'): Promise<OfficialSelection[]> => {
  const response = await runtimeFetch(authority === 'pilot' ? '/api/mobile-official/reader' : '/api/mobile-official', { query: { projectId } });
  if (!response.ok) throw new Error('mobile_read_failed');
  return listSchema.parse(await response.json()).selections;
};
export type OfficialSelectionRequest = {
  extensionId: string; projectId: string; sessionId: string | null; title: string; version?: string;
  source: { kind: 'task'; taskId: string } | { kind: 'artifact'; path: string };
};
export const selectOfficialResult = async (request: { extensionId: string; projectId: string; sessionId: string | null; card: GuestResultCard }, signal?: AbortSignal): Promise<OfficialSelection> => {
  const { card, ...context } = request;
  const source: OfficialSelectionRequest['source'] | null = card.taskId ? { kind: 'task', taskId: card.taskId }
    : card.path ? { kind: 'artifact', path: card.path } : null;
  if (!source) throw new Error('mobile_source_unavailable');
  const api = getRegisteredRuntimeAPIs()?.officialSelections;
  if (!api) throw new Error('mobile_selector_unsupported');
  const selection: OfficialSelectionRequest = { ...context, title: card.title, source };
  if (card.version) selection.version = card.version;
  return api.select(selection, signal);
};
export const revokeOfficialSelection = async (id: string, signal?: AbortSignal): Promise<void> => {
  const api = getRegisteredRuntimeAPIs()?.officialSelections;
  if (!api) throw new Error('mobile_selector_unsupported');
  await api.revoke(id, signal);
};
export const readOfficialContent = async (selection: OfficialSelection, authority: 'full' | 'pilot' = 'full'): Promise<string> => {
  const response = await runtimeFetch(`/api/mobile-official${authority === 'pilot' ? '/reader' : ''}/${encodeURIComponent(selection.id)}/content`);
  if (!response.ok) throw new Error('mobile_read_failed');
  if (selection.preview.kind === 'text') return response.text();
  if (selection.preview.kind !== 'image') throw new Error('mobile_preview_unavailable');
  return URL.createObjectURL(await response.blob());
};


const pilotSessionSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('signed-in'), user: z.object({ id: z.string(), name: z.string(), email: z.string() }), expiresAt: z.string().datetime(),
    accounts: z.array(z.object({ id: z.string(), name: z.string() })).max(200), accountId: z.string().nullable() }),
  z.object({ status: z.enum(['signed-out', 'expired', 'unsupported', 'unconfigured']) }),
]);
export type MobileOfficialSession = z.infer<typeof pilotSessionSchema>;
export class MobileOfficialError extends Error { constructor(readonly status: number) { super('mobile_read_failed'); } }
const pilotRequest = async <T>(route: string, schema: z.ZodType<T>, body?: string): Promise<T> => {
  const response = await runtimeFetch(`/api/mobile-official${route}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'include',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body });
  if (!response.ok) throw new MobileOfficialError(response.status);
  return schema.parse(await response.json());
};
export const readMobileOfficialSession = () => pilotRequest('/auth/session', pilotSessionSchema);
export const loginMobileOfficial = (username: string, password: string) => pilotRequest('/auth/password-login', pilotSessionSchema, JSON.stringify({ username, password }));
export const selectMobileOfficialAccount = (accountId: string) => pilotRequest('/auth/account', pilotSessionSchema, JSON.stringify({ accountId }));
export const logoutMobileOfficial = () => pilotRequest('/auth/logout', pilotSessionSchema, '{}');
export const readMobileOfficialProjects = () => pilotRequest('/reader/projects', z.object({ projects: z.array(z.object({ id: z.string().min(1).max(200), name: z.string().max(200) })).max(32) }));
