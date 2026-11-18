import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import express from 'express';
import { z } from 'zod';
import { createProductModelBroker } from './product-model-broker.js';
import { readBoundedResponse } from '../platform-model/native-media.js';
import { productWalletHeaders } from './product-wallet.js';

const identifier = /^[A-Za-z0-9_-]{1,200}$/;
const modelName = z.string().regex(/^[A-Za-z0-9._:/-]{1,128}$/);
const chat = z.object({ model: modelName, stream: z.literal(true), messages: z.array(z.json()) });
const capability = z.object({ client_id: z.string().min(1), product_id: z.literal('superwagie'), product_credit_wallet: z.boolean().optional() });
const principal = z.object({ id: z.string().min(1).max(200) });
const responseError = z.object({ error: z.object({ code: z.string().regex(/^[a-z0-9_]{1,100}$/), stage: z.literal('pre_admission').optional() }) });

const httpsUrl = (value) => {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid product model URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Invalid product model URL');
  return url;
};

export const createProductModelProxyClient = (origin, fetchImpl = fetch) => {
  const base = httpsUrl(origin);
  if (base.pathname !== '/') throw new Error('Product model proxy URL must be an origin');
  return ({ actorToken, accountId, model, callId, body, signal }) => fetchImpl(new URL(body === undefined ? `/v1/product-model/calls/${encodeURIComponent(callId)}` : '/v1/product-model/chat', base), {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${actorToken}`, 'X-UniHub-Billing-Account': accountId, 'X-UniHub-Model': model,
      ...(body !== undefined && { 'Content-Type': 'application/json', 'Idempotency-Key': callId }),
    },
    body, signal, redirect: 'error',
  });
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
  const proxy = (recovery) => async (req, res) => {
    const accountId = req.get('X-UniHub-Billing-Account');
    const model = req.get('X-UniHub-Model');
    const callId = recovery ? req.params.callId : req.get('Idempotency-Key');
    const actorToken = /^Bearer ([A-Za-z0-9._~-]{1,4096})$/.exec(req.get('Authorization') ?? '')?.[1];
    if (!actorToken) { res.status(401).json({ error: { code: 'platform_session_expired', stage: 'pre_admission' } }); return; }
    if (!identifier.test(accountId ?? '') || !identifier.test(callId ?? '') || !models.has(model) || req.get('Origin')) {
      res.status(400).json({ error: { code: 'platform_request_invalid', stage: 'pre_admission' } }); return;
    }
    const body = recovery ? undefined : req.body?.toString('utf8');
    if (!recovery) {
      let parsed;
      try { parsed = chat.safeParse(JSON.parse(body)); } catch { /* Malformed request. */ }
      if (!parsed?.success || parsed.data.model !== model) { res.status(400).json({ error: { code: 'platform_request_invalid', stage: 'pre_admission' } }); return; }
    }
    const abort = new AbortController();
    res.once('close', () => { if (!res.writableEnded) abort.abort(); });
    const request = async (path, init) => {
      const response = await fetchImpl(new URL(path, apiUrl), {
        ...init, redirect: 'error', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
        headers: { ...init?.headers, Authorization: `Bearer ${actorToken}`, Accept: 'application/json' },
      });
      if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error('identity or capability unavailable'), { status: response.status }); }
      return response.json();
    };
    let gatewayStarted = false;
    try {
      const [user, flags] = await Promise.all([
        request('/v1/me').then((payload) => principal.parse(payload)),
        request('/v1/capabilities', productWalletHeaders()).then((payload) => capability.parse(payload)),
      ]);
      if (!recovery && flags.product_credit_wallet !== true) { res.status(403).json({ error: { code: 'platform_model_access_unavailable', stage: 'pre_admission' } }); return; }
      const grant = await broker.authorize({ actorId: user.id, actorToken, accountId, model, apiOrigin: apiUrl.origin, clientId: flags.client_id, recovery, request });
      const path = recovery ? `calls/${encodeURIComponent(callId)}` : 'chat/completions';
      gatewayStarted = true;
      const response = await fetchImpl(`${gatewayUrl.href}/${path}`, {
        method: recovery ? 'GET' : 'POST', redirect: 'error', body,
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(recovery ? 10_000 : 180_000)]),
        headers: {
          Authorization: `Bearer ${grant.token}`, 'X-UniHub-Product-Authorization': grant.proof,
          ...(!recovery && { 'Content-Type': 'application/json', 'Idempotency-Key': callId }),
        },
      });
      if (!response.ok) {
        const value = await readBoundedResponse(response, 4096).then((bytes) => JSON.parse(bytes.toString('utf8'))).catch(() => null);
        const parsed = responseError.safeParse(value);
        res.status(response.status).json(parsed.success ? parsed.data : { error: { code: 'platform_gateway_call_incomplete' } });
        return;
      }
      const contentType = response.headers.get('Content-Type')?.split(';', 1)[0];
      if (!response.body || contentType !== (recovery ? 'application/json' : 'text/event-stream')) throw new Error('invalid gateway response');
      res.status(response.status).type(contentType);
      await pipeline(Readable.fromWeb(response.body), res);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      if (res.destroyed) return;
      if (error?.status === 401) { res.status(401).json({ error: { code: 'platform_session_expired', stage: 'pre_admission' } }); return; }
      res.status(502).json({ error: { code: 'platform_gateway_call_incomplete', ...(!gatewayStarted && { stage: 'pre_admission' }) } });
    }
  };
  app.post('/v1/product-model/chat', express.raw({ type: 'application/json', limit: '1mb', inflate: false }), proxy(false));
  app.get('/v1/product-model/calls/:callId', proxy(true));
  app.use((error, _req, res, _next) => res.status(error.status === 413 ? 413 : 400).json({ error: { code: 'platform_request_invalid' } }));
  return app;
};
