import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { z } from 'zod';
import { createNativeMediaTransport, decodeInlineImage, readBoundedResponse } from './native-media.js';
import { sampleImage, sttProbeWav } from '../model-configuration/adapters.js';
import { knowledgeWireForModel } from '../platform-account/knowledge.js';
import { PRODUCT_OCR_MODEL, ocrDocumentSchema, productOcrStatusSchema } from '../embedded-knowledge/ocr-contract.js';

const managedMediaChecks = {
  'qwen3-tts-flash': ['tts', 'speech'],
  'qwen3-tts-instruct-flash': ['tts', 'speech'],
  'qwen3-asr-flash': ['stt-short', 'transcription'],
  'qwen-image-2.0': ['image-generation', 'image-generation'],
  'qwen-image-2.0-pro': ['image-generation', 'image-generation'],
  'wanx2.1-imageedit': ['image-editing', 'image-edit'],
  'wan2.6-t2v': ['video-generation', 'video'],
};

export const managedModelCheckPlan = ({ models = [], mediaModels = [] }) => [
  ...models.map(({ id }) => ({ modelId: id, purpose: 'agent', operation: 'chat' })),
  ...models.filter(({ id }) => id === 'deepseek-v4-flash-vision-exp').map(({ id }) => ({ modelId: id, purpose: 'vision', operation: 'vision' })),
  ...[...new Set(mediaModels)].map((modelId) => {
    const [purpose, operation] = Object.hasOwn(managedMediaChecks, modelId) ? managedMediaChecks[modelId] : ['agent', null];
    return { modelId, purpose, operation };
  }),
  { modelId: 'text-embedding-v4', purpose: 'embedding', operation: 'knowledge-embedding' },
  { modelId: 'qwen3-rerank', purpose: 'rerank', operation: 'knowledge-rerank' },
  { modelId: PRODUCT_OCR_MODEL, purpose: 'ocr', operation: 'ocr' },
].map((row) => ({ ...row, id: `${row.operation ?? 'unsupported-media'}:${row.modelId}` }));

export const managedCheckCallId = (operation) => {
  const id = randomUUID();
  const digest = createHash('sha256').update(id).digest('hex').slice(0, 60);
  return operation.startsWith('knowledge-') ? `wk_${digest}` : operation === 'ocr' ? `swocr_${digest}` : `model-check-${id}`;
};
const invalid = () => { throw new Error('model_configuration_test_invalid_response'); };
const unknown = () => { throw new Error('account_key_test_unknown'); };
const verify = (condition) => { if (!condition) invalid(); };
const safeCode = z.string().regex(/^[a-z0-9_]{1,100}$/);
const responseError = z.object({ error: z.object({ code: safeCode, stage: z.literal('pre_admission').optional() }) });
const receipt = z.object({
  call_id: z.string().min(1), idempotency_key: z.string().optional(),
  credit_scope: z.literal('product_v1'), funding_product_id: z.literal('superwagie'), asset: z.literal('CREDIT/6'),
  status: z.string(),
});
const json = async (response, limit = 1024 * 1024) => JSON.parse((await readBoundedResponse(response, limit)).toString('utf8'));
const requireResponse = async (response) => {
  if (response.ok) return response;
  const parsed = responseError.safeParse(await json(response, 8192).catch(() => null));
  const code = parsed.success && parsed.data.error.code;
  if (code && (parsed.data.error.stage === 'pre_admission' || response.status < 500)) throw new Error(code);
  return unknown();
};
const sendJSON = (send, operation, body, extra = {}) => send({
  operation, ...extra, ...(body !== undefined && { body: JSON.stringify(body) }),
});
const poll = async (check, signal) => {
  for (;;) {
    signal.throwIfAborted();
    const value = await check();
    if (value) return value;
    await wait(2000, undefined, { signal });
  }
};

function probePdf() {
  const stream = 'BT /F1 24 Tf 40 90 Td (SuperWagie connection test) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 180] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const entries = objects.map((object, index) => {
    const entry = String(pdf.length).padStart(10, '0') + ' 00000 n \n';
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return entry;
  });
  return pdf + `xref\n0 6\n0000000000 65535 f \n${entries.join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${pdf.length}\n%%EOF\n`;
}

const sseChunk = z.object({ choices: z.array(z.object({ delta: z.object({ content: z.string().nullish() }) })) });
async function chatProbe(send, model, vision) {
  const text = 'Reply with OK.';
  const prompt = { role: 'user', content: vision ? [{ type: 'text', text: 'Describe this image in one sentence.' }, { type: 'image_url', image_url: { url: sampleImage } }] : text };
  const response = await requireResponse(await sendJSON(send, 'chat', { model, messages: [prompt], max_tokens: 128, stream: true, stream_options: { include_usage: true } }));
  verify(response.headers.get('content-type')?.startsWith('text/event-stream'));
  const data = (await readBoundedResponse(response, 512 * 1024)).toString('utf8').split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim());
  verify(data.pop() === '[DONE]');
  const chunks = data.map((part) => sseChunk.parse(JSON.parse(part)));
  verify(chunks.some(({ choices }) => choices.some(({ delta }) => delta.content?.trim())));
}

const embedding = z.object({ data: z.tuple([z.object({ embedding: z.array(z.number().finite()).length(1024) })]) });
const score = z.object({ index: z.literal(0), relevance_score: z.number().finite() });
const rerank = z.union([z.object({ output: z.object({ results: z.tuple([score]) }) }), z.object({ results: z.tuple([score]) })]);
async function knowledgeProbe(send, model, operation, signal, callId, taskId) {
  const wire = knowledgeWireForModel(model);
  const route = z.object({ policy_digest: z.string().regex(/^[a-f0-9]{64}$/) }).parse(await json(await requireResponse(
    await sendJSON(send, 'knowledge-route', { model, wire_operation: wire }),
  )));
  const isEmbedding = operation === 'knowledge-embedding';
  const dispatch = await requireResponse(await sendJSON(send, operation, isEmbedding
    ? { model, input: 'Model connection test.', dimensions: 1024 }
    : { model, input: { query: 'connection test', documents: ['connection test'] }, parameters: { top_n: 1, return_documents: false } },
  { policyDigest: route.policy_digest }));
  await dispatch.body?.cancel();
  const result = await poll(() => readPendingResult(send, 'knowledge-result'), signal);
  const evidence = z.object({
    call_id: z.literal(callId), task_id: z.literal(taskId), model: z.literal(model), wire_operation: z.literal(wire),
    policy_digest: z.literal(route.policy_digest), status: z.literal('SETTLED'),
    content_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).parse(JSON.parse(Buffer.from(result.headers.get('x-unihub-knowledge-receipt') ?? '', 'base64url').toString('utf8')));
  const bytes = await readBoundedResponse(result, 1024 * 1024);
  verify(evidence.content_sha256 === createHash('sha256').update(bytes).digest('hex'));
  (isEmbedding ? embedding : rerank).parse(JSON.parse(bytes.toString('utf8')));
}
async function ocrProbe(send, model, signal, callId) {
  const form = new FormData();
  form.set('model', model);
  form.set('file', new Blob([probePdf()], { type: 'application/pdf' }), 'document.pdf');
  const submitted = await requireResponse(await send({ operation: 'ocr-submit', body: form }));
  await submitted.body?.cancel();
  const jobId = await poll(async () => {
    const response = await send({ operation: 'ocr-status' });
    if (response.status === 404) { await response.body?.cancel(); return null; }
    const state = productOcrStatusSchema.parse(await json(await requireResponse(response))).data;
    verify(state.state !== 'failed');
    return state.state === 'done' && state.jobId;
  }, signal);
  await waitForSettlement(send, signal, callId, jobId);
  const result = await poll(() => readPendingResult(send, 'ocr-document'), signal);
  if (result.headers.get('x-unihub-call-id') !== jobId || result.headers.get('x-unihub-idempotency-key') !== callId) {
    await result.body?.cancel();
    invalid();
  }
  const digest = result.headers.get('x-content-sha256');
  const bytes = await readBoundedResponse(result, 1024 * 1024);
  verify(digest === createHash('sha256').update(bytes).digest('hex'));
  const document = ocrDocumentSchema.parse(JSON.parse(bytes.toString('utf8')));
  verify(document.id === jobId && document.pages.some((page) => page.text.trim() || page.layout.some((item) => item.content.trim())));
}

async function mediaProbe(send, model, operation, signal, gateway, callId) {
  const transport = createNativeMediaTransport({
    gateway, fetchImpl: fetch, grantFor: () => { throw new Error('Model check requires the product proxy'); },
    requestOperation: ({ body }) => send({ operation, body }).then(requireResponse),
  });
  const input = { model, idempotencyKey: callId };
  if (operation === 'speech') {
    await transport.dispatchSpeech({ ...input, text: 'SuperWagie connection test.', voice: 'Cherry' });
  } else if (operation === 'transcription') {
    await transport.dispatchTranscription({ ...input, audioDataUri: `data:audio/wav;base64,${sttProbeWav(1).toString('base64')}` });
  } else if (operation === 'image-generation') {
    const result = await transport.dispatchImageGeneration({ ...input, prompt: 'A solid blue circle on white.', n: 1 });
    verify(result.images.length === 1);
  } else if (operation === 'image-edit') {
    const [source, mask] = await Promise.all([
      readFile(new URL('./model-check-image.png', import.meta.url)),
      readFile(new URL('./model-check-mask.png', import.meta.url)),
    ]);
    await transport.dispatchImageEdit({
      ...input, images: [`data:image/png;base64,${source.toString('base64')}`],
      mask: `data:image/png;base64,${mask.toString('base64')}`, prompt: 'Change the blue square to green.',
    });
    const response = await poll(() => readPendingResult(send, 'image-edit-status'), signal);
    const result = await json(response, 24 * 1024 * 1024);
    verify(result.data?.length === 1);
    decodeInlineImage(result.data[0].b64_json);
  } else {
    await transport.dispatchVideoSubmit({ ...input, prompt: 'A blue circle, static camera.', seconds: 5, size: '1280*720' });
    await poll(async () => {
      const response = await readPendingResult(send, 'video-status');
      if (!response) return false;
      const state = z.object({ id: z.string(), idempotency_key: z.string().optional(), status: z.enum(['NOT_START', 'SUBMITTED', 'QUEUED', 'IN_PROGRESS', 'SUCCESS', 'FAILURE', 'UNKNOWN']) }).parse(await json(response));
      verify((state.idempotency_key ?? state.id) === callId && state.status !== 'FAILURE');
      return state.status === 'SUCCESS';
    }, signal);
    await waitForSettlement(send, signal, callId);
    const result = await poll(() => readPendingResult(send, 'video-result'), signal);
    const bytes = await readBoundedResponse(result, 64 * 1024 * 1024);
    verify(bytes.length >= 12 && bytes.subarray(4, 8).toString() === 'ftyp' && result.headers.get('x-content-sha256') === createHash('sha256').update(bytes).digest('hex'));
  }
}

async function readPendingResult(send, operation) {
  const response = await send({ operation });
  if (response.status === 404 || response.status === 202) {
    await response.body?.cancel();
    return null;
  }
  return requireResponse(response);
}

const waitForSettlement = (send, signal, callId, canonicalId) => poll(async () => {
  const response = await readPendingResult(send, 'receipt');
  if (!response) return false;
  const value = receipt.parse(await json(response));
  verify((value.idempotency_key ?? value.call_id) === callId && (!canonicalId || value.call_id === canonicalId)
    && !['REJECTED', 'RELEASED'].includes(value.status));
  return value.status === 'SETTLED';
}, signal);

export async function probeManagedModel({ row, callId, taskId, send, gateway, signal }) {
  const { modelId: model, operation } = row;
  try {
    if (operation === 'chat' || operation === 'vision') await chatProbe(send, model, operation === 'vision');
    else if (operation.startsWith('knowledge-')) await knowledgeProbe(send, model, operation, signal, callId, taskId);
    else if (operation === 'ocr') await ocrProbe(send, model, signal, callId);
    else await mediaProbe(send, model, operation, signal, gateway, callId);
    if (operation !== 'video' && operation !== 'ocr') await waitForSettlement(send, signal, callId);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) invalid();
    throw error;
  }
}
