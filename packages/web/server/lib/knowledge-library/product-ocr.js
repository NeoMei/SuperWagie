import crypto from 'node:crypto';
import { z } from 'zod';
import { readBoundedResponse } from '../platform-model/native-media.js';
import { ocrDocumentSchema, OCR_MAX_RESULT_BYTES, PRODUCT_OCR_MODEL, productOcrRefusals, productOcrStatusSchema } from '../embedded-knowledge/ocr-contract.js';

const approvalTtl = 10 * 60 * 1000;
const maxApprovals = 128;
const hash = (source) => crypto.createHash('sha256').update(source).digest('hex');
const fail = (code, status) => { throw Object.assign(new Error(code), { code, status }); };
const noStore = /(?:^|,)\s*(?:private,\s*)?no-store\s*(?:,|$)/i;
const refusal = z.object({ error: z.object({ code: z.string(), stage: z.literal('pre_admission').optional() }) });
const receipt = z.object({
  call_id: z.string().min(1), idempotency_key: z.string(), status: z.enum(['SETTLED', 'PENDING', 'UNKNOWN', 'REJECTED', 'RELEASED']),
  credit_scope: z.literal('product_v1'), funding_product_id: z.literal('superwagie'), asset: z.literal('CREDIT/6'),
});

async function json(response, maxBytes = 8192) {
  if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== 'application/json') {
    await response.body?.cancel().catch(() => {});
    fail('knowledge_work_ocr_unavailable', 503);
  }
  return JSON.parse((await readBoundedResponse(response, maxBytes)).toString('utf8'));
}

async function submit(current) {
  const form = new FormData();
  form.set('model', PRODUCT_OCR_MODEL);
  // The private provider never needs the local name or path.
  form.set('file', new Blob([current.source], { type: 'application/pdf' }), 'document.pdf');
  let response;
  try { response = await current.send({ operation: 'ocr-submit', body: form }); }
  catch { return { state: 'pending' }; }
  if (response.ok) {
    await response.body?.cancel().catch(() => {});
    return { state: 'pending' };
  }
  const body = await readBoundedResponse(response, 8192)
    .then((bytes) => refusal.safeParse(JSON.parse(bytes.toString('utf8')))).catch(() => null);
  const code = body?.data?.error?.code;
  if (body?.data?.error?.stage === 'pre_admission' && productOcrRefusals.get(code) === response.status) {
    await current.recordRefusal(code);
    fail(code, response.status);
  }
  return { state: 'pending' };
}

export function createProductOcrWorkflow({ authorize, applyResult, now = Date.now }) {
  const approvals = new Map();
  const active = new Map();
  const same = (approval, current) => approval && approval.expiresAt > now()
    && approval.original === current.original && approval.documentId === current.documentId && approval.sourceHash === current.sourceHash
    && approval.actor.actingUserId === current.actor.actingUserId && approval.actor.authSession === current.actor.authSession
    && approval.actor.billingAccountId === current.actor.billingAccountId;
  const preview = async (document, execution) => {
    const current = await authorize(document, execution);
    if (current.exists) return { state: 'pending' };
    await current.ensureMaySubmit();
    if (approvals.size >= maxApprovals) approvals.delete(approvals.keys().next().value);
    const id = crypto.randomUUID();
    const expiresAt = Math.min(now() + approvalTtl, current.actor.expiresAt);
    const payer = typeof current.accountName === 'function' ? await current.accountName() : current.accountName;
    approvals.set(id, { original: current.original, documentId: current.documentId, sourceHash: current.sourceHash, actor: current.actor, expiresAt });
    return { state: 'confirmation', id, payer, expiresAt };
  };
  const recover = async (current, document, execution) => {
    let value;
    const response = await current.send({ operation: 'ocr-status' }).catch(() => null);
    if (!response || response.status === 404) return { state: 'pending' };
    try { value = productOcrStatusSchema.parse(await json(response)).data; }
    catch { fail('knowledge_work_ocr_unavailable', 503); }
    await current.assertCurrent();
    if (value.state === 'failed') return { state: 'failed' };
    if (value.state !== 'done') return { state: 'pending' };
    const settled = receipt.safeParse(await json(await current.send({ operation: 'receipt' })));
    if (!settled.success || settled.data.idempotency_key !== current.original || settled.data.call_id !== value.jobId) fail('knowledge_work_ocr_unavailable', 503);
    if (settled.data.status !== 'SETTLED') return { state: 'pending' };
    const artifact = await current.send({ operation: 'ocr-document' });
    const expectedHash = artifact.headers.get('x-content-sha256');
    if (!artifact.ok || artifact.headers.get('content-type')?.split(';')[0] !== 'application/json' || !noStore.test(artifact.headers.get('cache-control') ?? '')
      || artifact.headers.get('x-unihub-call-id') !== value.jobId || artifact.headers.get('x-unihub-idempotency-key') !== current.original
      || !/^[0-9a-f]{64}$/.test(expectedHash ?? '')) {
      await artifact.body?.cancel().catch(() => {});
      fail('knowledge_work_ocr_unavailable', 503);
    }
    const bytes = await readBoundedResponse(artifact, OCR_MAX_RESULT_BYTES);
    if (hash(bytes) !== expectedHash) fail('knowledge_work_ocr_unavailable', 503);
    const result = ocrDocumentSchema.parse(JSON.parse(bytes.toString('utf8')));
    if (result.id !== value.jobId) fail('knowledge_work_ocr_unavailable', 503);
    await current.assertCurrent();
    await applyResult({ document, execution, result, original: current.original, sourceHash: current.sourceHash, sourceBytes: current.source.length, assertCurrent: current.assertCurrent });
    await current.assertCurrent();
    return { state: 'processing' };
  };
  const resumeExisting = (current, document, execution) => {
    const pending = active.get(current.original);
    if (pending) return pending;
    const action = recover(current, document, execution).finally(() => { active.delete(current.original); });
    active.set(current.original, action);
    return action;
  };
  const confirm = async (document, execution, approvalId) => {
    const current = await authorize(document, execution);
    const approval = approvals.get(approvalId);
    if (!same(approval, current)) fail('knowledge_work_ocr_approval_required', 409);
    approvals.delete(approvalId);
    await current.assertCurrent();
    if (!await current.claim()) return resumeExisting(current, document, execution);
    await current.assertCurrent();
    return submit(current);
  };
  const resume = async (document, execution) => {
    const current = await authorize(document, execution);
    if (!current.exists) fail('knowledge_work_ocr_approval_required', 409);
    return resumeExisting(current, document, execution);
  };
  return { preview, confirm, resume };
}
