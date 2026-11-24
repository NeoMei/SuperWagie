import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import express from 'express';
import { z } from 'zod';
import { assertProductMembershipRefusal, createProductModelBroker } from './product-model-broker.js';
import { readBoundedResponse } from '../platform-model/native-media.js';
import { managedChatOperation, readProductManagedModels } from '../platform-model/product-managed-models.js';
import { embeddingBodySchema, rerankBodySchema, knowledgeWireForModel } from './knowledge.js';
import { PRODUCT_OCR_MAX_FILE_BYTES, PRODUCT_OCR_MODEL, productOcrCallId } from '../embedded-knowledge/ocr-contract.js';
import { productWalletHeaders } from './product-wallet.js';

const identifier = /^[A-Za-z0-9_-]{1,200}$/;
const modelName = z.string().regex(/^[A-Za-z0-9._:/-]{1,128}$/);
const chat = z.object({ model: modelName, stream: z.literal(true), messages: z.array(z.json()) });
const video = z.object({ model: modelName, prompt: z.string().trim().min(1).max(64 * 1024), seconds: z.number().int().min(1).max(10), size: z.enum(['1280*720', '1920*1080']) }).strict();
const IMAGE_MIME = /^image\/(?:png|jpeg|webp)$/;
const json = 'application/json';
const multipart = 'multipart/form-data';
const knowledgeRoute = z.object({ model: modelName, wire_operation: z.enum(['embeddings.create', 'rerank.create']) }).strict();
const knowledgeTask = /^[A-Za-z0-9._:-]{1,128}$/;
const knowledgeCall = /^wk_[a-f0-9]{60}$/;
const knowledgePin = /^[a-f0-9]{64}$/;
const speech = z.object({
  model: modelName, input: z.object({ text: z.string().trim().min(1).max(256 * 1024), voice: z.string().trim().min(1).max(120), instructions: z.string().max(4096).optional(), language_type: z.string().max(32).optional() }).strict(),
}).strict();
const transcription = z.object({
  model: modelName, messages: z.tuple([z.object({ role: z.literal('user'), content: z.tuple([z.object({ type: z.literal('input_audio'), input_audio: z.object({ data: z.string().regex(/^data:audio\/[a-z0-9+.-]+(?:;[a-z0-9_-]+=[a-z0-9_-]+)*;base64,[A-Za-z0-9+/]+={0,2}$/i) }).strict() }).strict()]) }).strict()]),
}).strict();
const image = z.object({ model: modelName, prompt: z.string().trim().min(1).max(64 * 1024), n: z.number().int().min(1).max(4), size: z.string().max(30).optional(), response_format: z.literal('b64_json') }).strict();
const audioTypes = ['audio/mpeg', 'audio/mp3', 'audio/wav'];
const routes = {
  chat: { method: 'POST', path: '/chat', upstream: '/chat/completions', limit: '1mb', input: json, schema: chat, output: 'text/event-stream' },
  receipt: { method: 'GET', path: '/calls/:callId', upstream: '/calls/:callId', recovery: true, output: json },
  video: { method: 'POST', path: '/videos', upstream: '/videos', limit: '1mb', input: json, schema: video, output: json },
  'video-status': { method: 'GET', path: '/videos/:callId', upstream: '/videos/:callId', recovery: true, output: json },
  'video-result': { method: 'GET', path: '/videos/:callId/result', upstream: '/videos/:callId/result', recovery: true, output: 'video/mp4' },
  'image-edit': { method: 'POST', path: '/image-edit', upstream: '/images/edits', limit: '32mb', input: multipart, output: json },
  'image-edit-status': { method: 'GET', path: '/image-edit/:callId', upstream: '/images/edits/:callId', recovery: true, output: json },
  speech: { method: 'POST', path: '/speech', upstream: '/native/bailian/audio/speech', limit: '1mb', input: json, schema: speech, output: audioTypes },
  transcription: { method: 'POST', path: '/transcription', upstream: '/native/dashscope/audio/transcriptions', limit: '12mb', input: json, schema: transcription, output: json },
  'image-generation': { method: 'POST', path: '/image-generation', upstream: '/images/generations', limit: '1mb', input: json, schema: image, output: json },
  'media-result': { method: 'GET', path: '/media-results/:callId', upstream: '/calls/:callId/result', recovery: true, output: [...audioTypes, json], artifact: true },
  'ocr-submit': { method: 'POST', path: '/ocr', upstream: '/platform/api/v2/ocr/jobs', absolute: true, limit: '21mb', input: multipart, output: json, ocr: true },
  'ocr-status': { method: 'GET', path: '/ocr/:callId', upstream: '/platform/api/v2/ocr/jobs/:callId', absolute: true, recovery: true, output: json, ocr: true },
  'ocr-document': { method: 'GET', path: '/ocr/:callId/document', upstream: '/platform/api/v2/ocr/jobs/:callId/document', absolute: true, recovery: true, output: json, ocr: true, artifact: true },
  'knowledge-route': { method: 'POST', path: '/knowledge-route', upstream: '/knowledge/route', limit: '1kb', input: json, schema: knowledgeRoute, output: json, knowledge: 'route' },
  'knowledge-embedding': { method: 'POST', path: '/knowledge-embedding', upstream: '/embeddings', limit: '1mb', input: json, schema: embeddingBodySchema, output: json, knowledge: 'dispatch' },
  'knowledge-rerank': { method: 'POST', path: '/knowledge-rerank', upstream: '/platform/api/v1/services/rerank/text-rerank/text-rerank', absolute: true, limit: '1mb', input: json, schema: rerankBodySchema, output: json, knowledge: 'dispatch' },
  'knowledge-result': { method: 'POST', path: '/knowledge-results/:callId', upstream: '/knowledge/results/:callId', recovery: true, output: json, knowledge: 'result' },
};
const escapedPath = (path, callId) => path.replace(':callId', () => encodeURIComponent(callId));

const validatedInput = async (req, routeName, route, model) => {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) return;
  if (route.input === multipart) {
    try {
      const form = await new Response(req.body, { headers: { 'Content-Type': req.get('Content-Type') } }).formData();
      if (route.ocr) {
        const pdf = form.get('file');
        if ([...form.keys()].sort().join(',') !== 'file,model' || form.get('model') !== PRODUCT_OCR_MODEL
          || !(pdf instanceof File) || pdf.name !== 'document.pdf' || pdf.type !== 'application/pdf'
          || pdf.size < 8 || pdf.size > PRODUCT_OCR_MAX_FILE_BYTES || await pdf.slice(0, 5).text() !== '%PDF-') return;
        return { body: req.body, operation: 'ocr' };
      }
      if ([...form.keys()].sort().join(',') !== 'image,mask,model,n,prompt' || form.get('model') !== model || form.get('n') !== '1' ||
          !z.string().trim().min(1).max(64 * 1024).safeParse(form.get('prompt')).success) return;
      for (const name of ['image', 'mask']) {
        const part = form.get(name);
        if (!(part instanceof File) || !IMAGE_MIME.test(part.type) || part.size < 1 || part.size > 16 * 1024 * 1024) return;
      }
      return { body: req.body, operation: routeName };
    } catch { return; }
  }
  const body = req.body.toString('utf8');
  try {
    const parsed = route.schema.safeParse(JSON.parse(body));
    if (!parsed.success || parsed.data.model !== model) return;
    if (route.knowledge === 'route') {
      const wire = parsed.data.wire_operation;
      if (wire !== knowledgeWireForModel(model)) return;
      return { body, operation: wire === 'embeddings.create' ? 'knowledge-embedding' : 'knowledge-rerank' };
    }
    return { body, operation: routeName === 'chat' ? managedChatOperation(parsed.data) : routeName };
  } catch { /* Malformed JSON. */ }
};
const capability = z.object({ client_id: z.string().min(1), product_id: z.literal('superwagie'), product_credit_wallet: z.boolean().optional() });
const principal = z.object({ id: z.string().min(1).max(200) });
const responseError = z.object({ error: z.object({ code: z.string().regex(/^[a-z0-9_]{1,100}$/), stage: z.literal('pre_admission').optional() }) });
const invalidRequest = (res) => res.status(400).json({ error: { code: 'platform_request_invalid', stage: 'pre_admission' } });

const httpsUrl = (value) => {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid product model URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Invalid product model URL');
  return url;
};

export const createProductModelProxyClient = (origin, fetchImpl = fetch) => {
  const base = httpsUrl(origin);
  if (base.pathname !== '/') throw new Error('Product model proxy URL must be an origin');
  return ({ actorToken, accountId, model, callId, taskId, policyDigest, body, signal, operation = body === undefined ? 'receipt' : 'chat' }) => {
    if (!Object.hasOwn(routes, operation)) throw new Error('Unsupported product model operation');
    const route = routes[operation];
    return fetchImpl(new URL('/v1/product-model' + escapedPath(route.path, callId), base), {
      method: route.method,
      headers: {
        Authorization: `Bearer ${actorToken}`, 'X-UniHub-Billing-Account': accountId, 'X-UniHub-Model': model,
        ...(route.input && route.knowledge !== 'route' && { 'Idempotency-Key': callId }),
        ...(route.knowledge && { 'X-UniHub-Task-ID': taskId }),
        ...(route.knowledge === 'dispatch' && { 'X-UniHub-Knowledge-Policy': policyDigest }),
        ...(route.input === json && { 'Content-Type': json }),
      },
      body, signal, redirect: 'error',
    });
  };
};

/** Runs on the product operator's isolated service host. The app runtime receives only the model response. */
export const createProductModelProxy = ({ api, gateway, allowedModels, serviceCredential, vault, instanceId, fetchImpl = fetch }) => {
  const apiUrl = httpsUrl(api);
  const gatewayUrl = httpsUrl(gateway);
  if (apiUrl.pathname !== '/' || gatewayUrl.pathname !== '/platform/v1') throw new Error('Invalid product broker destination');
  const models = new Set(z.array(modelName).min(1).max(256).parse(allowedModels));
  const broker = createProductModelBroker({ api, serviceCredential, vault, instanceId, fetchImpl });
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const proxy = (routeName, route) => async (req, res) => {
    const recovery = route.recovery === true;
    const accountId = req.get('X-UniHub-Billing-Account');
    const model = req.get('X-UniHub-Model');
    const callId = recovery ? req.params.callId : req.get('Idempotency-Key');
    const taskId = req.get('X-UniHub-Task-ID');
    const policyDigest = req.get('X-UniHub-Knowledge-Policy');
    const actorToken = /^Bearer ([A-Za-z0-9._~-]{1,4096})$/.exec(req.get('Authorization') ?? '')?.[1];
    if (!actorToken) { res.status(401).json({ error: { code: 'platform_session_expired', stage: 'pre_admission' } }); return; }
    const validCall = route.knowledge === 'route' || (route.knowledge ? knowledgeCall : route.ocr ? productOcrCallId : identifier).test(callId ?? '');
    const validKnowledge = !route.knowledge || knowledgeTask.test(taskId ?? '') && Boolean(knowledgeWireForModel(model))
      && (route.knowledge !== 'dispatch' || knowledgePin.test(policyDigest ?? ''));
    if (!identifier.test(accountId ?? '') || !validCall || !validKnowledge || route.ocr && model !== PRODUCT_OCR_MODEL ||
        !modelName.safeParse(model).success || req.get('Origin')) {
      invalidRequest(res); return;
    }
    const input = route.input ? await validatedInput(req, routeName, route, model) : undefined;
    if (route.input && !input) { invalidRequest(res); return; }
    const abort = new AbortController();
    res.once('close', () => { if (!res.writableEnded) abort.abort(); });
    if (!recovery) {
      let policy;
      try {
        policy = await readProductManagedModels({ api, fetchImpl, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(4_000)]) });
      } catch {
        if (!res.destroyed) res.status(503).json({ error: { code: 'platform_gateway_call_incomplete', stage: 'pre_admission' } });
        return;
      }
      const configuredModels = policy?.managed_models?.[input.operation];
      const allowed = configuredModels === undefined ? models.has(model) : configuredModels.includes(model);
      if (!allowed) { invalidRequest(res); return; }
    }
    const request = async (path, init) => {
      const response = await fetchImpl(new URL(path, apiUrl), {
        ...init, redirect: 'error', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
        headers: { ...init?.headers, Authorization: `Bearer ${actorToken}`, Accept: 'application/json' },
      });
      if (!response.ok) {
        if (path.endsWith('/api-keys')) await assertProductMembershipRefusal(response);
        if (!response.bodyUsed) await response.body?.cancel();
        throw Object.assign(new Error('identity or capability unavailable'), { status: response.status });
      }
      return response.json();
    };
    let gatewayStarted = false;
    try {
      const [user, flags] = await Promise.all([
        request('/v1/me').then((payload) => principal.parse(payload)),
        recovery ? null : request('/v1/capabilities', productWalletHeaders()).then((payload) => capability.parse(payload)),
      ]);
      if (!recovery && flags?.product_credit_wallet !== true) { res.status(403).json({ error: { code: 'platform_model_access_unavailable', stage: 'pre_admission' } }); return; }
      const grant = await broker.authorize({ actorId: user.id, actorToken, accountId, model, apiOrigin: apiUrl.origin, recovery, request });
      const path = escapedPath(route.upstream, callId);
      gatewayStarted = true;
      const response = await fetchImpl(route.absolute ? new URL(path, gatewayUrl.origin) : gatewayUrl.href + path, {
        method: route.method, redirect: 'error', body: input?.body,
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(route.output === 'video/mp4' || route.artifact ? 120_000 : recovery ? 10_000 : 180_000)]),
        headers: {
          Authorization: `Bearer ${grant.token}`, 'X-UniHub-Product-Authorization': grant.proof,
          ...(route.input && { 'Content-Type': req.get('Content-Type') }),
          ...(route.input && route.knowledge !== 'route' && { 'Idempotency-Key': callId }),
          ...(route.knowledge && { 'X-UniHub-Task-ID': taskId, 'X-UniHub-Actor-Authorization': `Bearer ${actorToken}` }),
          ...(route.knowledge === 'dispatch' && { 'X-UniHub-Knowledge-Policy': policyDigest }),
        },
      });
      if (!response.ok) {
        const value = await readBoundedResponse(response, 4096).then((bytes) => JSON.parse(bytes.toString('utf8'))).catch(() => null);
        const parsed = responseError.safeParse(value);
        const error = parsed.success ? parsed.data.error : null;
        const gatewayAdmission = error?.stage === 'pre_admission' && response.headers.get('X-LLMRouter-Error-Origin') === 'gateway';
        const invalidRouteMarker = error?.code === 'platform_model_route_unavailable'
          && (routeName !== 'chat' || response.status !== 503 || !gatewayAdmission);
        const invalidPolicyMarker = error?.code === 'managed_model_not_allowed'
          && error.stage === 'pre_admission' && (recovery || response.status !== 403 || !gatewayAdmission);
        res.status(response.status).json({ error: error && !invalidRouteMarker && !invalidPolicyMarker ? error : { code: 'platform_gateway_call_incomplete' } });
        return;
      }
      const contentType = response.headers.get('Content-Type')?.split(';', 1)[0];
      const acceptedTypes = Array.isArray(route.output) ? route.output : [route.output];
      if (!response.body || !acceptedTypes.includes(contentType)) {
        await response.body?.cancel(); throw new Error('invalid gateway response');
      }
      if (route.output === 'video/mp4' || route.artifact) {
        const sha = response.headers.get('x-content-sha256');
        if (!/^[a-f0-9]{64}$/.test(sha ?? '')) throw new Error('invalid video digest');
        res.set('X-Content-SHA256', sha);
        if (route.artifact) {
          const canonicalId = response.headers.get('x-unihub-call-id');
          if (!identifier.test(canonicalId ?? '') || response.headers.get('x-unihub-idempotency-key') !== callId) throw new Error('invalid artifact binding');
          res.set('X-UniHub-Call-ID', canonicalId);
          res.set('X-UniHub-Idempotency-Key', callId);
        }
      }
      if (route.knowledge) {
        if (!/(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get('cache-control') ?? '')) throw new Error('invalid knowledge cache policy');
        if (route.knowledge === 'result') {
          const receipt = response.headers.get('X-UniHub-Knowledge-Receipt');
          if (!/^[A-Za-z0-9_-]{1,4096}$/.test(receipt ?? '')) throw new Error('invalid knowledge evidence');
          res.set('X-UniHub-Knowledge-Receipt', receipt);
        }
      }
      res.status(response.status).type(contentType);
      await pipeline(Readable.fromWeb(response.body), res);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      if (res.destroyed) return;
      if (!recovery && !gatewayStarted && error?.code === 'product_membership_expired') {
        res.status(403).json({ error: { code: 'product_membership_expired', stage: 'pre_admission' } }); return;
      }
      if (error?.status === 401) { res.status(401).json({ error: { code: 'platform_session_expired', stage: 'pre_admission' } }); return; }
      res.status(502).json({ error: { code: 'platform_gateway_call_incomplete', ...(!gatewayStarted && { stage: 'pre_admission' }) } });
    }
  };
  for (const [routeName, route] of Object.entries(routes)) {
    const path = '/v1/product-model' + route.path;
    const handler = proxy(routeName, route);
    if (route.input) app.post(path, express.raw({ type: route.input, limit: route.limit, inflate: false }), handler);
    else if (route.method === 'POST') app.post(path, handler);
    else app.get(path, handler);
  }
  app.use((error, _req, res, _next) => res.status(error.status === 413 ? 413 : 400).json({ error: { code: 'platform_request_invalid', stage: 'pre_admission' } }));
  return app;
};
