import { z } from 'zod';
import type { GuestRequest, PromptResult } from '@openchamber/sdk';

const key = z.string().min(1).max(200);
const creationKindSchema = z.enum(['deck', 'doc', 'video', 'page']);
export const creationInspectionSchema = z.object({ kind: creationKindSchema, stage: key, decisionId: key, artifactVersion: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const receiptSchema = creationInspectionSchema.extend({ id: z.string().regex(/^[a-f0-9]{64}$/), status: z.enum(['accepted', 'completed', 'unknown']), acceptedAt: z.number(), dispatch: z.enum(['confirmed', 'unknown']) }).strict();
export const creationApprovalResultSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('inspection'), inspection: creationInspectionSchema, receipt: receiptSchema.nullable() }),
  z.object({ type: z.literal('claim'), dispatch: z.boolean(), receipt: receiptSchema }),
  z.object({ type: z.literal('receipt'), receipt: receiptSchema }),
]);
const contextSchema = z.object({ directory: z.string().min(1), sessionId: key });
const inspectSchema = z.object({ action: z.literal('inspect'), kind: creationKindSchema, state: z.string().max(5 * 1024 * 1024), observed: z.object({ plan: z.string().nullable(), prompts: z.string().nullable(), directions: z.string().nullable(), artifact: z.string().nullable(), result: z.string().nullable() }).strict() }).strict();
const submitSchema = z.object({ action: z.literal('submit'), inspection: creationInspectionSchema, text: z.string().min(1).max(100_000) }).strict();
const readSchema = z.object({ action: z.literal('read'), id: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const requestSchema = z.discriminatedUnion('action', [inspectSchema, submitSchema, readSchema]);
export type CreationApprovalOperation = z.infer<typeof contextSchema> & (
  z.infer<typeof inspectSchema> | { action: 'claim'; kind: z.infer<typeof creationInspectionSchema>['kind']; inspection: z.infer<typeof creationInspectionSchema>; text: string }
  | { action: 'settle'; id: string; outcome: 'accepted' | 'unknown' }
  | z.infer<typeof readSchema>
);
export type CreationApprovalResult = z.infer<typeof creationApprovalResultSchema>;
export type CreationApprovalsAPI = { perform(input: CreationApprovalOperation): Promise<CreationApprovalResult> };

/** The host stamps context and owns dispatch. No guest receives a dispatch capability. */
export const runCreationApprovalRequest = async ({ request, api, directory, sessionId, assertCurrent, send }: {
  request: GuestRequest;
  api: CreationApprovalsAPI | undefined;
  directory: string | null;
  sessionId: string | null;
  assertCurrent: () => void;
  send: (text: string) => Promise<PromptResult>;
}): Promise<{ status: number; body: string }> => {
  const reply = (status: number, body: CreationApprovalResult | { type: 'unavailable' | 'blocked'; reason: string }) => ({ status, body: JSON.stringify(body) });
  const input = requestSchema.parse(JSON.parse(request.body ?? '{}'));
  assertCurrent();
  if (!api || !directory || !sessionId) return reply(501, { type: 'unavailable', reason: 'creation_coordination_unavailable' });
  const context = { directory, sessionId };
  if (input.action === 'read') return reply(200, await api.perform({ ...context, ...input }));
  if (input.action === 'inspect') {
    try { return reply(200, await api.perform({ ...context, ...input })); }
    catch (error) {
      const message = error instanceof Error ? error.message : '';
      const unavailable = /creation_coordination_unavailable|mobile_account_|mobile_local_desktop_required|mobile_project_forbidden|creation_source_too_large/.test(message);
      return reply(unavailable ? 503 : 409, { type: unavailable ? 'unavailable' : 'blocked', reason: unavailable ? 'creation_coordination_unavailable' : /creation_original_session_required/.test(message) ? 'creation_original_session_required' : 'creation_source_changed' });
    }
  }
  let claim: CreationApprovalResult;
  try {
    claim = await api.perform({ ...context, action: 'claim', kind: input.inspection.kind, inspection: input.inspection, text: input.text });
    assertCurrent();
  }
  catch (error) {
    if (error instanceof Error && /creation_original_session_required/.test(error.message)) return reply(409, { type: 'blocked', reason: 'creation_original_session_required' });
    throw error;
  }
  if (claim.type !== 'claim') throw new Error('creation_claim_invalid');
  if (!claim.dispatch) return reply(200, { type: 'receipt', receipt: claim.receipt });
  // The durable record already says unknown. A lost response or crash never replays.
  try {
    assertCurrent();
    const result = await send(input.text);
    const settled = await api.perform({ ...context, action: 'settle', id: claim.receipt.id, outcome: result.sent === 'sent' ? 'accepted' : 'unknown' });
    return reply(200, settled);
  } catch {
    return reply(200, { type: 'receipt', receipt: claim.receipt });
  }
};
