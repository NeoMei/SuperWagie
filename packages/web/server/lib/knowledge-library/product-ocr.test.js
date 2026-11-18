import crypto from 'node:crypto';
import { expect, it } from 'vitest';
import { createProductOcrWorkflow } from './product-ocr.js';

const document = { id: 'document-one', absPath: '/library/scanned.pdf', relPath: 'scanned.pdf' };
const source = Buffer.from('%PDF-1.7\nfixture');
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const id = 'swocr_' + 'a'.repeat(60);
const actor = { actingUserId: 'owner', billingAccountId: 'first-payer', authSession: 'login-1', expiresAt: Date.now() + 60000 };
const execution = { identity: 'original' };

it('requires a confirmed immutable PDF and recovers the original settled call without a second paid submission', async () => {
  let admitted = false;
  let ready = false;
  let current = actor;
  let file = source;
  const operations = [];
  const indexed = [];
  const expected = { id: 'pc_fixture', pages: [{ text: 'original bytes', layout: [] }] };
  const workflow = createProductOcrWorkflow({
    authorize: async (candidate, request) => {
      if (request !== execution || current.expiresAt <= Date.now()) throw Object.assign(new Error('unauthorized'), { status: 403 });
      return { actor: current, accountName: 'Original payer', scope: 'workspace', scopeId: 'workspace',
        original: candidate.id === document.id && current.billingAccountId === actor.billingAccountId ? id : 'swocr_' + 'b'.repeat(60),
        documentId: candidate.id, source: file, sourceHash: sha(file), exists: admitted, ensureMaySubmit: async () => {}, claim: async () => admitted ? false : (admitted = true),
        assertCurrent: async () => { if (current !== actor || file !== source) throw new Error('changed'); },
        send: async ({ operation }) => {
          operations.push(operation);
          if (operation === 'ocr-submit') throw new Error('lost response');
          if (operation === 'ocr-status') return Response.json({ code: 0, msg: '', data: { jobId: expected.id, state: ready ? 'done' : 'running', extractProgress: { totalPages: 1, extractedPages: ready ? 1 : 0 } } });
          if (operation === 'receipt') return Response.json({ call_id: expected.id, idempotency_key: id, status: 'SETTLED', asset: 'CREDIT/6', credit_scope: 'product_v1', funding_product_id: 'superwagie' });
          const bytes = JSON.stringify(expected);
          return new Response(bytes, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store',
            'X-UniHub-Call-ID': expected.id, 'X-UniHub-Idempotency-Key': id, 'X-Content-SHA256': sha(bytes) } });
        },
      };
    },
    applyResult: async (input) => indexed.push(input),
  });
  await expect(workflow.resume(document, { identity: 'other' })).rejects.toMatchObject({ status: 403 });
  const approval = await workflow.preview(document, execution);
  current = { ...actor, billingAccountId: 'other-payer' };
  await expect(workflow.confirm(document, execution, approval.id)).rejects.toMatchObject({ code: 'knowledge_work_ocr_approval_required' });
  current = actor;
  file = Buffer.from('%PDF-1.7\nchanged');
  await expect(workflow.confirm(document, execution, approval.id)).rejects.toMatchObject({ code: 'knowledge_work_ocr_approval_required' });
  file = source;
  await expect(workflow.confirm({ ...document, id: 'other-document' }, execution, approval.id)).rejects.toMatchObject({ code: 'knowledge_work_ocr_approval_required' });
  expect(operations).toEqual([]);
  expect(await workflow.confirm(document, execution, approval.id)).toEqual({ state: 'pending' });
  expect(await workflow.resume(document, execution)).toEqual({ state: 'pending' });
  ready = true;
  expect(await workflow.resume(document, execution)).toEqual({ state: 'processing' });
  expect(indexed).toHaveLength(1);
  expect(indexed[0].result).toEqual(expected);
  expect(operations).toEqual(['ocr-submit', 'ocr-status', 'ocr-status', 'receipt', 'ocr-document']);
});

it.each([
  [403, 'product_membership_expired', 'pre_admission'],
  [402, 'platform_model_credits_required', 'pre_admission'],
  [400, 'invalid_ocr_document', 'pre_admission'],
  [402, 'platform_model_credits_required', undefined],
])('records only known pre-admission refusals before offering a new confirmation (%s %s %s)', async (status, code, stage) => {
  const refusals = [];
  let submitted = false;
  const workflow = createProductOcrWorkflow({
    authorize: async () => ({
      actor, original: id, documentId: document.id, source, sourceHash: sha(source), accountName: 'Payer', ensureMaySubmit: async () => {},
      assertCurrent: async () => {}, claim: async () => !submitted && (submitted = true),
      recordRefusal: async (value) => { refusals.push(value); },
      send: async () => Response.json({ error: { code, stage } }, { status }),
    }),
    applyResult: async () => { throw new Error('No result expected'); },
  });
  const approval = await workflow.preview(document, execution);
  const confirm = workflow.confirm(document, execution, approval.id);
  if (stage) {
    await expect(confirm).rejects.toMatchObject({ code, status });
    expect(refusals).toEqual([code]);
  } else {
    await expect(confirm).resolves.toEqual({ state: 'pending' });
    expect(refusals).toEqual([]);
  }
});
