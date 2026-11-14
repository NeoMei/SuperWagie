import type { Kind } from './wizard.ts';

export type Inspection = { kind: Kind; stage: string; decisionId: string; artifactVersion: string };
export type ApprovalReceipt = { id: string; status: 'accepted' | 'completed' | 'unknown'; acceptedAt: number };
type ApprovalAnswer = { inspection: Inspection | null; receipt: ApprovalReceipt | null; availability: 'ready' | 'unavailable' | 'blocked' | 'original-session' };
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
const isRow = (value: Json | undefined): value is { [key: string]: Json } => value !== null && value !== undefined && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const row = (value: Json | undefined) => isRow(value) ? value : null;
const text = (value: Json | undefined): value is string => String(value) === value;

/** Parse the host's bounded JSON response before using its admission state. */
export const readApprovalAnswer = (body: string, kind: Kind): ApprovalAnswer => {
  const parsed: Json = JSON.parse(body);
  const value = row(parsed);
  if (!value) throw new Error('creation_approval_invalid');
  if (value.type === 'unavailable' || value.type === 'blocked') return { inspection: null, receipt: null, availability: value.reason === 'creation_original_session_required' ? 'original-session' : value.type };
  const data = row(value.inspection);
  let inspection: Inspection | null = null;
  if (data) {
    if (data.kind !== kind || !text(data.stage) || !text(data.decisionId) || !text(data.artifactVersion) || !/^[a-f0-9]{64}$/.test(data.artifactVersion)) throw new Error('creation_inspection_invalid');
    inspection = { kind, stage: data.stage, decisionId: data.decisionId, artifactVersion: data.artifactVersion };
  }
  const stored = row(value.receipt);
  let receipt: ApprovalReceipt | null = null;
  if (stored) {
    if (!text(stored.id) || !/^[a-f0-9]{64}$/.test(stored.id) || !['accepted', 'completed', 'unknown'].includes(String(stored.status)) || Number(stored.acceptedAt) !== stored.acceptedAt) throw new Error('creation_receipt_invalid');
    const status = stored.status === 'accepted' ? 'accepted' : stored.status === 'completed' ? 'completed' : 'unknown';
    receipt = { id: stored.id, status, acceptedAt: Number(stored.acceptedAt) };
  }
  if (!inspection && !receipt) throw new Error('creation_approval_invalid');
  return { inspection, receipt, availability: 'ready' };
};
