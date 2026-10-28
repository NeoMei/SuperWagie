import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { z } from 'zod';
import { isEnterpriseMode } from '../enterprise-mode.js';
import { openModelStore } from './store.js';
import { createPluginSource } from './plugin.js';
import { createNativeMediaTransport } from './native-media.js';

const PLATFORM_PROVIDER = 'unihub';
const PUBLIC_UNIHUB_MODEL_DEFAULTS = Object.freeze({
  gatewayUrl: 'https://llmrouter.quukk.com/platform/v1',
  models: Object.freeze([
    'glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-5.1', 'glm-5', 'glm-5-turbo',
    'glm-4.7', 'glm-4.6', 'glm-4.5', 'glm-4.5-air', 'deepseek-v4-pro',
    'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'DeepSeek-V4-Pro-A',
    'DeepSeek-V4-Flash-A', 'Doubao-Seed-2.0-Pro-A', 'MiniMax-M3-A',
    'Qwen3.7-Max-A', 'kimi-k2.7-code', 'Kimi-K2.6-A', 'k3', 'GLM-5.2-A',
  ]),
});
const PUBLIC_UNIHUB_MEDIA_MODEL_DEFAULTS = Object.freeze([
  'qwen3-tts-flash', 'qwen3-tts-instruct-flash', 'qwen3-asr-flash',
  'qwen-image-2.0', 'qwen-image-2.0-pro', 'wan2.6-t2v',
]);
const terminal = new Set(['SETTLED', 'RELEASED', 'REJECTED']);
const identifier = z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/).refine((value) => !['__proto__', 'constructor', 'prototype'].includes(value));
const modelSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9._:/-]{1,128}$/), name: z.string().min(1).max(120), context: z.number().int().positive().max(2_000_000), maxOutput: z.number().int().positive().max(100_000) }).strict();
const grantSchema = z.object({ token: z.string().min(1), actor_id: z.string(), account_id: z.string(), task_id: z.string(), origin_product_id: z.literal('superwagie'), models: z.array(z.string()), expires_at: z.string() });
const receiptSchema = z.object({ call_id: identifier, status: z.enum(['RESERVED', 'RESERVING', 'RESERVE_UNKNOWN', 'UNKNOWN', 'SETTLE_PENDING', 'RELEASE_PENDING', 'SETTLED', 'RELEASED', 'REJECTED']), charged: z.string().regex(/^\d+$/).optional() });
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
export class PlatformModelError extends Error {
  constructor(code, status = 409) { super(code); this.code = code; this.status = status; }
}
const refuse = (code, status) => { throw new PlatformModelError(code, status); };
const ownerOf = (identity) => {
  if (!identity || !['session', 'client'].includes(identity.type) || typeof identity.token !== 'string' || !identity.token) refuse('platform_runtime_auth_required', 401);
  return hash(`${identity.type}:${identity.token}`);
};
const readConfig = (env, usePublicDefaults) => {
  if (env.OPENCHAMBER_UNIHUB_DISABLED === '1' || env.OPENCHAMBER_UNIHUB_MODE === 'off') return null;
  const publicDefaults = usePublicDefaults && env.OPENCHAMBER_UNIHUB_DISABLED !== '1' && env.OPENCHAMBER_UNIHUB_MODE !== 'off';
  const gatewayValue = env.OPENCHAMBER_UNIHUB_GATEWAY_URL || (publicDefaults ? PUBLIC_UNIHUB_MODEL_DEFAULTS.gatewayUrl : '');
  const modelsValue = env.OPENCHAMBER_UNIHUB_MODELS || (publicDefaults ? JSON.stringify(PUBLIC_UNIHUB_MODEL_DEFAULTS.models.map((id) => ({ id, name: id, context: 65_536, maxOutput: 4_096 }))) : '');
  if (!gatewayValue || !modelsValue) return null;
  const gateway = new URL(gatewayValue);
  if (gateway.username || gateway.password || gateway.search || gateway.hash || gateway.pathname.replace(/\/$/, '') !== '/platform/v1' || (gateway.protocol !== 'https:' && !(gateway.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(gateway.hostname)))) refuse('platform_model_configuration_invalid', 503);
  const models = z.array(modelSchema).min(1).max(32).parse(JSON.parse(modelsValue));
  if (new Set(models.map((model) => model.id)).size !== models.length) refuse('platform_model_configuration_invalid', 503);
  const mediaModelsValue = env.OPENCHAMBER_UNIHUB_MEDIA_MODELS || (publicDefaults ? JSON.stringify(PUBLIC_UNIHUB_MEDIA_MODEL_DEFAULTS) : '');
  const mediaModels = mediaModelsValue ? z.array(z.string()).min(1).max(64).parse(JSON.parse(mediaModelsValue)) : [];
  return { gateway: gateway.toString().replace(/\/$/, ''), models, mediaModels };
};
const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
const readBody = async (req) => {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 1_048_576) refuse('platform_request_too_large', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { refuse('platform_request_invalid', 400); }
};

/** Only managed primary Chat SSE reaches the gateway. Unknown attempts remain durable. */
export const createPlatformModelRuntime = async ({ dataDir, instanceDir, env = process.env, usePublicDefaults = env === process.env, getAccountRuntime, readExecution, isManaged = () => true, enterprise = isEnterpriseMode, fetchImpl = fetch }) => {
  const config = readConfig(env, usePublicDefaults);
  const identities = new Map();
  const permits = new Map();
  const grants = new Map();
  const inflight = new Set();
  const requests = new Set();
  const token = crypto.randomBytes(32).toString('base64url');
  const store = config ? await openModelStore(dataDir) : null;
  let server; let base; let closed = false; let closePromise;
  const check = () => {
    if (enterprise()) refuse('enterprise_mode', 403);
    if (!config) refuse('platform_models_unconfigured', 503);
    if (!isManaged() || closed) refuse('platform_runtime_unsupported', 409);
  };
  const actor = (identity) => {
    try { return getAccountRuntime().actor(identity); } catch { refuse('platform_session_expired', 401); }
  };
  const taskFor = (identity, sessionID) => {
    check(); const task = store.read().tasks[sessionID];
    if (!task) refuse('platform_task_unbound', 403);
    if (task.owner !== ownerOf(identity) || task.actorID !== actor(identity).actingUserId) refuse('platform_task_owner_mismatch', 403);
    return task;
  };
  const credential = async (task, identity) => {
    const current = actor(identity);
    if (current.actingUserId !== task.actorID || ownerOf(identity) !== task.owner) refuse('platform_task_owner_mismatch', 403);
    const cached = grants.get(task.id);
    if (cached && Date.parse(cached.expires_at) > Date.now() + 15_000) return cached;
    let value;
    try { value = grantSchema.parse(await getAccountRuntime().request(identity, `/v1/accounts/${encodeURIComponent(task.accountID)}/model-credentials`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ origin_product_id: 'superwagie', models: [task.model], task_id: task.id }) })); }
    catch { refuse('platform_model_access_unavailable', 403); }
    if (closed) refuse('platform_runtime_unsupported', 409);
    if (value.actor_id !== task.actorID || value.account_id !== task.accountID || value.task_id !== task.id || !value.models.includes(task.model) || !(Date.parse(value.expires_at) > Date.now())) refuse('platform_model_access_invalid', 403);
    grants.set(task.id, value); return value;
  };
  // Media operations run under an admitted task with a different model than the
  // bound chat model (design: calls may use different models under one task).
  // Grants cache per task+model; minting still requires the original owner.
  const mediaCredential = async (task, identity, model) => {
    const current = actor(identity);
    if (current.actingUserId !== task.actorID || ownerOf(identity) !== task.owner) refuse('platform_task_owner_mismatch', 403);
    const key = task.id + ':' + model;
    const cached = grants.get(key);
    if (cached && Date.parse(cached.expires_at) > Date.now() + 15_000) return cached;
    let value;
    try { value = grantSchema.parse(await getAccountRuntime().request(identity, '/v1/accounts/' + encodeURIComponent(task.accountID) + '/model-credentials', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ origin_product_id: 'superwagie', models: [model], task_id: task.id }) })); }
    catch { refuse('platform_model_access_unavailable', 403); }
    if (closed) refuse('platform_runtime_unsupported', 409);
    if (value.actor_id !== task.actorID || value.account_id !== task.accountID || value.task_id !== task.id || !value.models.includes(model) || !(Date.parse(value.expires_at) > Date.now())) refuse('platform_model_access_invalid', 403);
    grants.set(key, value); return value;
  };
  const mediaCall = async ({ identity, sessionID, callID, model, operation, inputs, dispatch }) => {
    check();
    const task = taskFor(identity, sessionID);
    const idempotencyKey = identifier.parse(callID);
    await mediaCredential(task, identity, model);
    for (const call of Object.values(store.read().calls).filter((call) => call.sessionID === sessionID && call.status === 'DELIVERED')) await receipt(task, call, identity);
    const digest = hash(JSON.stringify({ model, operation, inputs }));
    await store.mutate((state) => {
      if (state.calls[idempotencyKey]) refuse('platform_call_already_exists');
      if (Object.values(state.calls).some((call) => call.sessionID === sessionID && !terminal.has(call.status))) refuse('platform_reconciliation_required');
      state.calls[idempotencyKey] = { id: idempotencyKey, sessionID, taskID: task.id, model, operation, digest, status: 'PREPARED', output: false };
    });
    let result;
    try {
      const grant = await mediaCredential(task, identity, model);
      if (closed) refuse('platform_runtime_unsupported', 409);
      await store.mutate((state) => { const call = state.calls[idempotencyKey]; if (!call || call.digest !== digest) refuse('platform_call_digest_conflict'); call.status = 'DISPATCHED'; });
      result = await dispatch({ grant, taskID: task.id, idempotencyKey });
    } catch (error) {
      await store.mutate((state) => {
        const call = state.calls[idempotencyKey];
        if (!call) return;
        if (error instanceof Error && error.local === true) delete state.calls[idempotencyKey];
        else if (call.status === 'PREPARED') call.status = 'DISPATCHED';
      });
      throw error;
    }
    await store.mutate((state) => { const call = state.calls[idempotencyKey]; if (call) call.status = 'DELIVERED'; });
    return result;
  };
  let mediaTransport = null;
  const mediaDispatch = ({ identity, sessionID, callID, model, operation, inputs }) => {
    check();
    const mediaMethods = { speech: 'dispatchSpeech', transcription: 'dispatchTranscription', image_generation: 'dispatchImageGeneration', video: 'dispatchVideoSubmit' };
    const method = mediaMethods[operation];
    if (!method) refuse('platform_media_operation_unknown', 400);
    mediaTransport ??= createNativeMediaTransport({
      gateway: config.gateway,
      fetchImpl,
      grantFor: async () => refuse('platform_media_grant_injected', 500),
      operationAllowlist: {},
    });
    return mediaCall({ identity, sessionID, callID, model, operation, inputs, dispatch: (ctx) => mediaTransport[method]({ ...inputs, model, grant: ctx.grant, taskID: ctx.taskID, idempotencyKey: ctx.idempotencyKey }) });
  };
  const defaultMediaModel = () => (config && config.mediaModels && config.mediaModels.length ? config.mediaModels[0] : null);
  const mediaSpeech = async (body) => {
    const input = z.object({ sessionID: identifier, model: identifier, text: z.string().min(1).max(256 * 1024), voice: z.string().min(1).max(120) }).strict().parse(body);
    const identity = identities.get(input.sessionID);
    if (!identity) refuse('platform_prompt_authorization_required', 401);
    return await mediaDispatch({ identity, sessionID: input.sessionID, callID: 'media_' + crypto.randomUUID(), model: input.model, operation: 'speech', inputs: { text: input.text, voice: input.voice } });
  };
  const receipt = async (task, call, identity) => {
    const grant = await credential(task, identity);
    let response;
    try { response = await fetchImpl(`${config.gateway}/calls/${encodeURIComponent(call.id)}`, { headers: { Authorization: `Bearer ${grant.token}`, 'X-UniHub-Task-ID': task.id }, redirect: 'error', signal: AbortSignal.timeout(10_000) }); }
    catch { refuse('platform_reconciliation_required'); }
    if (!response.ok) refuse('platform_reconciliation_required');
    let value;
    try { value = receiptSchema.parse(await response.json()); } catch { refuse('platform_reconciliation_required'); }
    if (value.call_id !== call.id) refuse('platform_reconciliation_required');
    if (terminal.has(value.status)) await store.mutate((state) => { const saved = state.calls[call.id]; saved.status = value.status; if (value.charged !== undefined) saved.charged = value.charged; });
    return value;
  };
  const reconcile = async (identity, sessionID) => {
    const task = taskFor(identity, sessionID);
    for (const call of Object.values(store.read().calls).filter((call) => call.sessionID === sessionID && !terminal.has(call.status))) {
      // PREPARED has never reached gateway IO, so a user reconciliation can abandon it.
      if (call.status === 'PREPARED') {
        const abandoned = await store.mutate((state) => {
          // Dispatch may have committed while this reconciliation waited for the writer.
          if (state.calls[call.id].status !== 'PREPARED') return false;
          state.calls[call.id].status = 'REJECTED';
          return true;
        });
        if (abandoned) continue;
      }
      await receipt(task, call, identity);
    }
    return status(identity, sessionID);
  };
  const status = (identity, sessionID) => {
    const task = taskFor(identity, sessionID);
    const calls = Object.values(store.read().calls).filter((call) => call.sessionID === sessionID);
    return { sessionID, taskID: task.id, actorID: task.actorID, accountID: task.accountID, model: task.model, blocked: calls.some((call) => !terminal.has(call.status)), calls: calls.map(({ id, status, charged }) => ({ callID: id, status, ...(charged !== undefined ? { charged } : {}) })) };
  };
  // Media tasks bind a durable owner/actor/account/model without an OpenCode
  // prompt permit; restart requires the original identity to re-authenticate.
  const admitMediaTask = async (identity, { model } = {}) => {
    if (model?.providerID !== PLATFORM_PROVIDER) return false;
    check();
    if (!(config.mediaModels ?? []).some((id) => id === model.id)) refuse('platform_media_model_not_allowed', 403);
    const current = actor(identity);
    const owner = ownerOf(identity);
    if (!current.billingAccountId) refuse('platform_account_required', 403);
    // One durable media task per owner+model: deterministic, restart-safe, no extra state.
    const sessionID = 'media_' + crypto.createHash('sha256').update(owner + ':' + model.id).digest('hex').slice(0, 32);
    const existing = store.read().tasks[sessionID];
    if (existing) {
      if (existing.owner !== owner || existing.actorID !== current.actingUserId) refuse('platform_task_owner_mismatch', 403);
      if (existing.model !== model.id) refuse('platform_task_model_locked');
      return { sessionID, taskID: existing.id, actorID: existing.actorID, accountID: existing.accountID, model: existing.model };
    }
    const task = { id: 'uh_task_' + crypto.randomUUID(), sessionID, actorID: current.actingUserId, accountID: current.billingAccountId, owner, model: model.id };
    await store.mutate((state) => { state.tasks[sessionID] = task; });
    return { sessionID, taskID: task.id, actorID: task.actorID, accountID: task.accountID, model: task.model };
  };
  const admit = async (identity, session, promptID) => {
    const model = session.model;
    if (model?.providerID !== PLATFORM_PROVIDER) return false;
    check(); identifier.parse(session.id);
    if (!/^msg_[A-Za-z0-9_-]{1,180}$/.test(promptID || '')) refuse('platform_prompt_id_required', 400);
    if (session.parentID) refuse('platform_child_unsupported', 403);
    if (!config.models.some((item) => item.id === model.id)) refuse('platform_model_not_allowed', 403);
    const current = actor(identity);
    const owner = ownerOf(identity);
    const existing = store.read().tasks[session.id];
    if (existing && (existing.owner !== owner || existing.actorID !== current.actingUserId)) refuse('platform_task_owner_mismatch', 403);
    if (existing && existing.model !== model.id) refuse('platform_task_model_locked');
    if (!existing && !current.billingAccountId) refuse('platform_account_required', 403);
    const task = existing || { id: `uh_task_${crypto.randomUUID()}`, sessionID: session.id, actorID: current.actingUserId, accountID: current.billingAccountId, owner, model: model.id };
    await credential(task, identity);
    if (!existing) await store.mutate((state) => {
      if (state.tasks[session.id]) refuse('platform_task_conflict');
      state.tasks[session.id] = task;
    });
    identities.set(session.id, identity);
    if (existing) {
      await reconcile(identity, session.id);
      if (status(identity, session.id).blocked) refuse('platform_reconciliation_required');
    }
    permits.set(session.id, { promptID, idle: session.time?.idle ?? null });
    return true;
  };
  const prepare = async (body) => {
    check();
    const input = z.object({ sessionID: identifier, callID: identifier, model: z.string(), kind: z.literal('primary') }).strict().parse(body);
    const task = store.read().tasks[input.sessionID];
    if (!task) refuse('platform_task_unbound', 403);
    const identity = identities.get(input.sessionID);
    if (!identity) refuse('platform_prompt_authorization_required', 401);
    taskFor(identity, input.sessionID);
    const permit = permits.get(input.sessionID);
    const execution = await readExecution(input.sessionID);
    if (!permit || execution.promptID !== permit.promptID || (execution.idle ?? null) !== permit.idle || execution.parentID || execution.model?.providerID !== PLATFORM_PROVIDER || execution.model?.id !== task.model) refuse('platform_prompt_authorization_required', 403);
    if (inflight.has(input.sessionID)) refuse('platform_call_in_progress');
    if (input.model !== task.model) refuse('platform_task_model_locked');
    await credential(task, identity);
    // A clean response can finish before the gateway's settlement outbox. Query its receipt first.
    for (const call of Object.values(store.read().calls).filter((call) => call.sessionID === input.sessionID && call.status === 'DELIVERED')) await receipt(task, call, identity);
    await store.mutate((state) => {
      if (state.calls[input.callID]) refuse('platform_call_already_exists');
      if (Object.values(state.calls).some((call) => call.sessionID === input.sessionID && !terminal.has(call.status))) refuse('platform_reconciliation_required');
      state.calls[input.callID] = { id: input.callID, sessionID: input.sessionID, taskID: task.id, model: task.model, digest: '', status: 'PREPARED', output: false };
    });
    return { callID: input.callID, taskID: task.id, baseURL: `${base}/v1` };
  };
  const completion = async (req, res, body) => {
    check();
    const sessionID = identifier.parse(req.headers['x-unihub-session-id']);
    const callID = identifier.parse(req.headers['idempotency-key']);
    const identity = identities.get(sessionID);
    if (!identity) refuse('platform_prompt_authorization_required', 401);
    const task = taskFor(identity, sessionID);
    const model = config.models.find((item) => item.id === task.model);
    if (body?.model !== task.model || body?.stream !== true || !Array.isArray(body?.messages)) refuse('platform_protocol_unsupported', 400);
    const maximum = body.max_completion_tokens ?? body.max_tokens ?? model.maxOutput;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > model.maxOutput) refuse('platform_output_limit_invalid', 400);
    const request = { ...body, max_tokens: maximum, stream_options: { include_usage: true } };
    delete request.max_completion_tokens;
    const payload = JSON.stringify(request); const digest = hash(payload);
    const abort = new AbortController();
    res.once('close', () => { if (!res.writableEnded) abort.abort(); });
    const grant = await credential(task, identity);
    if (closed || res.destroyed || req.aborted) refuse('platform_runtime_unsupported', 409);
    await store.mutate((state) => {
      const call = state.calls[callID];
      if (!call || call.sessionID !== sessionID || call.taskID !== task.id) refuse('platform_call_unprepared', 403);
      if (call.digest && call.digest !== digest) refuse('platform_call_digest_conflict');
      if (call.status !== 'PREPARED') refuse('platform_call_already_submitted');
      call.digest = digest; call.status = 'DISPATCHED';
    });
    inflight.add(sessionID);
    const markUnknown = () => store.mutate((state) => { if (!terminal.has(state.calls[callID].status)) state.calls[callID].status = 'UNKNOWN'; });
    try {
      const upstream = await fetchImpl(`${config.gateway}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${grant.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': callID, 'X-UniHub-Task-ID': task.id }, body: payload, redirect: 'error', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(180_000)]) });
      if (!upstream.ok || !upstream.headers.get('content-type')?.includes('text/event-stream') || !upstream.body) {
        await markUnknown();
        await upstream.body?.cancel();
        await receipt(task, store.read().calls[callID], identity).catch(() => {});
        refuse('platform_gateway_call_incomplete', 502);
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-UniHub-Call-ID': callID });
      const reader = upstream.body.getReader(); const decoder = new TextDecoder();
      let buffer = ''; let done = false; let output = false;
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        buffer += decoder.decode(item.value, { stream: true });
        if (buffer.length > 1_048_576) throw new Error('platform_stream_invalid');
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') { done = true; continue; }
          if (!data) continue;
          const event = JSON.parse(data);
          if (!output && event.choices?.some((choice) => choice.delta?.content || choice.delta?.reasoning_content || choice.delta?.tool_calls?.length)) {
            output = true;
            await store.mutate((state) => { state.calls[callID].output = true; });
          }
        }
        if (!res.write(item.value)) await once(res, 'drain', { signal: abort.signal });
      }
      if (!done || buffer.trim()) throw new Error('platform_stream_incomplete');
      await store.mutate((state) => { state.calls[callID].status = 'DELIVERED'; });
      await receipt(task, store.read().calls[callID], identity).catch(() => {});
      res.end();
    } catch (error) {
      await markUnknown();
      if (res.headersSent) { res.destroy(); return; }
      if (error instanceof PlatformModelError) throw error;
      refuse('platform_reconciliation_required', 502);
    } finally { inflight.delete(sessionID); }
  };
  const listen = async () => {
    if (server || !config) return;
    const handleRequest = async (req, res) => {
      try {
        const provided = Buffer.from(req.headers.authorization || ''); const expected = Buffer.from(`Bearer ${token}`);
        if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) refuse('platform_internal_unauthorized', 401);
        if (req.method !== 'POST') refuse('platform_protocol_unsupported', 404);
        const body = await readBody(req);
        if (req.url === '/prepare') return json(res, 200, await prepare(body));
        if (req.url === '/media/speech') {
          const result = await mediaSpeech(body);
          res.writeHead(200, { 'content-type': result.contentType, 'cache-control': 'no-store' });
          res.end(result.buffer);
          return;
        }
        if (req.url === '/v1/chat/completions') return await completion(req, res, body);
        refuse('platform_protocol_unsupported', 404);
      } catch (error) {
        if (res.headersSent) { res.destroy(); return; }
        json(res, error instanceof PlatformModelError ? error.status : 400, { error: { code: error instanceof PlatformModelError ? error.code : 'platform_request_invalid' } });
      }
    };
    server = http.createServer((req, res) => {
      const pending = handleRequest(req, res);
      requests.add(pending);
      void pending.then(() => requests.delete(pending), () => requests.delete(pending));
    });
    server.requestTimeout = 185_000; server.headersTimeout = 10_000;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  };
  const materializePlugin = async () => {
    check(); await listen();
    const directory = path.join(instanceDir, 'unihub-model-plugin');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'superwagie-unihub-model', version: '0.0.0', type: 'module', exports: { '.': './index.js' } }), { mode: 0o600 });
    await fs.writeFile(path.join(directory, 'index.js'), createPluginSource(), { mode: 0o600 });
    return directory;
  };
  return { admit, reconcile, status, materializePlugin,
    authorizeSession: (identity, sessionID) => { if (!store?.read().tasks[sessionID]) return false; taskFor(identity, sessionID); return true; },
    mediaCredential,
    mediaCall,
    mediaDispatch,
    defaultMediaModel,
    admitMediaTask,
    enabled: () => Boolean(config && isManaged() && !enterprise()),
    createChildEnv: () => config && base ? { OPENCHAMBER_UNIHUB_PROXY_URL: base, OPENCHAMBER_UNIHUB_PROXY_TOKEN: token } : {},
    providerConfig: () => config ? { unihub: { name: 'quukk', package: 'aisdk:@ai-sdk/openai-compatible', settings: { baseURL: 'http://127.0.0.1:1/unihub-managed-only', apiKey: 'requires-managed-session', transport: 'http' }, models: Object.fromEntries(config.models.map((model) => [model.id, { name: model.name, modelID: model.id, limit: { context: model.context, output: model.maxOutput }, capabilities: { tools: true, input: ['text'], output: ['text'] } }])) } } : {},
    close: () => {
      closePromise ??= (async () => {
        closed = true;
        if (server) await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
        await Promise.allSettled([...requests]);
        identities.clear(); permits.clear(); grants.clear();
        await store?.close();
      })();
      return closePromise;
    },
  };
};
