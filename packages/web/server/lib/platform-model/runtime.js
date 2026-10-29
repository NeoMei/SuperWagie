import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { z } from 'zod';
import { isEnterpriseMode } from '../enterprise-mode.js';
import { openModelStore } from './store.js';
import { createPluginSource } from './plugin.js';
import { decodeInlineImage, createNativeMediaTransport } from './native-media.js';

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
  'qwen-image-2.0', 'qwen-image-2.0-pro', 'wanx2.1-imageedit', 'wan2.6-t2v',
]);
const terminal = new Set(['SETTLED', 'RELEASED', 'REJECTED']);
// Only a validated async submission response makes a pending call independently
// recoverable. A dispatch with no response remains a blocking unknown outcome.
const blocksSession = (call) => !terminal.has(call.status) && !(call.status === 'ASYNC_PENDING' && ['video', 'image_edit'].includes(call.operation));
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
const readBody = async (req, maxBytes = 1_048_576) => {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > maxBytes) refuse('platform_request_too_large', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { refuse('platform_request_invalid', 400); }
};

/** Only managed primary Chat SSE reaches the gateway. Unknown attempts remain durable. */
export const createPlatformModelRuntime = async ({ dataDir, instanceDir, env = process.env, usePublicDefaults = env === process.env, getAccountRuntime, readExecution, isManaged = () => true, enterprise = isEnterpriseMode, fetchImpl = fetch }) => {
  const config = readConfig(env, usePublicDefaults);
  const identities = new Map();
  const permits = new Map();
  const grants = new Map();
  const inflight = new Map();
  const requests = new Set();
  let childScope = null;
  let childScopeInvalidated = false;
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
  // The process-wide child token is restricted to one authenticated runtime
  // identity, UniHub actor and payer. Switching any of them requires replacing
  // this runtime and its OpenCode child, which rotates the token.
  const candidateScope = (identity) => {
    const owner = ownerOf(identity);
    let current;
    try { current = actor(identity); } catch (error) { if (childScope?.owner === owner) childScopeInvalidated = true; throw error; }
    if (!current.actingUserId || !current.billingAccountId || typeof current.authSession !== 'string' || !current.authSession) refuse('platform_account_required', 403);
    return { owner, actorID: current.actingUserId, accountID: current.billingAccountId, authSession: current.authSession };
  };
  const scopeFor = (identity, claim = false) => {
    const scope = candidateScope(identity);
    if (!childScope && claim) childScope = scope;
    if (childScope?.owner === scope.owner && (childScope.actorID !== scope.actorID || childScope.accountID !== scope.accountID || childScope.authSession !== scope.authSession)) childScopeInvalidated = true;
    if (childScopeInvalidated || !childScope || childScope.owner !== scope.owner || childScope.actorID !== scope.actorID || childScope.accountID !== scope.accountID || childScope.authSession !== scope.authSession) refuse('platform_model_scope_restart_required', 403);
    return scope;
  };
  const taskFor = (identity, sessionID) => {
    check(); const task = store.read().tasks[sessionID];
    if (!task) refuse('platform_task_unbound', 403);
    const scope = candidateScope(identity);
    if (childScope) scopeFor(identity);
    if (task.owner !== scope.owner || task.actorID !== scope.actorID || task.accountID !== scope.accountID) refuse('platform_model_scope_restart_required', 403);
    scopeFor(identity, true);
    return task;
  };
  const credential = async (task, identity) => {
    const current = scopeFor(identity);
    if (current.actorID !== task.actorID || current.owner !== task.owner || current.accountID !== task.accountID) refuse('platform_model_scope_restart_required', 403);
    const cached = grants.get(task.id);
    if (cached && Date.parse(cached.expires_at) > Date.now() + 15_000) return cached;
    let value;
    try { value = grantSchema.parse(await getAccountRuntime().request(identity, `/v1/accounts/${encodeURIComponent(task.accountID)}/model-credentials`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ origin_product_id: 'superwagie', models: [task.model], task_id: task.id }) })); }
    catch { refuse('platform_model_access_unavailable', 403); }
    if (closed) refuse('platform_runtime_unsupported', 409);
    scopeFor(identity);
    if (value.actor_id !== task.actorID || value.account_id !== task.accountID || value.task_id !== task.id || !value.models.includes(task.model) || !(Date.parse(value.expires_at) > Date.now())) refuse('platform_model_access_invalid', 403);
    grants.set(task.id, value); return value;
  };
  // Media operations run under an admitted task with a different model than the
  // bound chat model (design: calls may use different models under one task).
  // Grants cache per task+model; minting still requires the original owner.
  const mediaCredential = async (task, identity, model) => {
    const current = scopeFor(identity);
    if (current.actorID !== task.actorID || current.owner !== task.owner || current.accountID !== task.accountID) refuse('platform_model_scope_restart_required', 403);
    const key = task.id + ':' + model;
    const cached = grants.get(key);
    if (cached && Date.parse(cached.expires_at) > Date.now() + 15_000) return cached;
    let value;
    try { value = grantSchema.parse(await getAccountRuntime().request(identity, '/v1/accounts/' + encodeURIComponent(task.accountID) + '/model-credentials', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ origin_product_id: 'superwagie', models: [model], task_id: task.id }) })); }
    catch { refuse('platform_model_access_unavailable', 403); }
    if (closed) refuse('platform_runtime_unsupported', 409);
    scopeFor(identity);
    if (value.actor_id !== task.actorID || value.account_id !== task.accountID || value.task_id !== task.id || !value.models.includes(model) || !(Date.parse(value.expires_at) > Date.now())) refuse('platform_model_access_invalid', 403);
    grants.set(key, value); return value;
  };
  const mediaCall = async ({ identity, sessionID, callID, model, operation, inputs, dispatch, validate }) => {
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
    let result; let upstreamStarted = false;
    try {
      const grant = await mediaCredential(task, identity, model);
      if (closed) refuse('platform_runtime_unsupported', 409);
      await store.mutate((state) => { const call = state.calls[idempotencyKey]; if (!call || call.digest !== digest) refuse('platform_call_digest_conflict'); call.status = 'DISPATCHED'; });
      check();
      scopeFor(identity);
      if (validate) await validate();
      check();
      scopeFor(identity);
      upstreamStarted = true;
      result = await dispatch({ grant, taskID: task.id, idempotencyKey });
    } catch (error) {
      await store.mutate((state) => {
        const call = state.calls[idempotencyKey];
        if (!call) return;
        if (error instanceof Error && error.local === true) delete state.calls[idempotencyKey];
        else if (!upstreamStarted && !terminal.has(call.status)) call.status = 'REJECTED';
        else if (call.status === 'PREPARED') call.status = 'DISPATCHED';
      });
      throw error;
    }
    await store.mutate((state) => { const call = state.calls[idempotencyKey]; if (call) call.status = (operation === 'video' && typeof result?.taskId === 'string' && result.taskId.trim()) || (operation === 'image_edit' && result?.callID === idempotencyKey && result.status === 'pending') ? 'ASYNC_PENDING' : 'DELIVERED'; });
    scopeFor(identity);
    return result;
  };
  let mediaTransport = null;
  const mediaSessions = new Map();
  const mediaDispatch = ({ identity, sessionID, callID, model, operation, inputs, validate }) => {
    check();
    if (!config.mediaModels.includes(model)) refuse('platform_media_model_not_allowed', 403);
    const mediaMethods = { speech: 'dispatchSpeech', transcription: 'dispatchTranscription', image_generation: 'dispatchImageGeneration', image_edit: 'dispatchImageEdit', video: 'dispatchVideoSubmit' };
    const method = mediaMethods[operation];
    if (!method) refuse('platform_media_operation_unknown', 400);
    mediaTransport ??= createNativeMediaTransport({
      gateway: config.gateway,
      fetchImpl,
      grantFor: async () => refuse('platform_media_grant_injected', 500),
      operationAllowlist: {},
    });
    return mediaCall({ identity, sessionID, callID, model, operation, inputs, validate, dispatch: (ctx) => mediaTransport[method]({ ...inputs, model, grant: ctx.grant, taskID: ctx.taskID, idempotencyKey: ctx.idempotencyKey }) });
  };
  const defaultMediaModel = () => (config && config.mediaModels && config.mediaModels.length ? config.mediaModels[0] : null);
  // The shared child token cannot authenticate a dedicated UI media task.
  // Skills must be tied to a live agent prompt; UI requests use the separately
  // authenticated mediaDispatch path.
  const selectSkillMedia = async (requested) => {
    const sessionID = await mediaVideoSession(requested);
    const permit = permits.get(sessionID);
    const validate = async () => {
      if (permits.get(sessionID) !== permit || await mediaVideoSession(requested) !== sessionID) refuse('platform_prompt_authorization_required', 403);
    };
    return { sessionID, validate };
  };
  const mediaSpeech = async (body) => {
    const input = z.object({ sessionID: identifier.optional(), model: identifier, text: z.string().min(1).max(256 * 1024), voice: z.string().min(1).max(120) }).strict().parse(body);
    const { sessionID, validate } = await selectSkillMedia(input.sessionID);
    const identity = identities.get(sessionID);
    if (!identity) refuse('platform_prompt_authorization_required', 401);
    return await mediaDispatch({ identity, sessionID, callID: 'media_' + crypto.randomUUID(), model: input.model, operation: 'speech', validate, inputs: { text: input.text, voice: input.voice } });
  };
  const mediaImage = async (body) => {
    const input = z.object({ sessionID: identifier.optional(), model: identifier, prompt: z.string().trim().min(1).max(64 * 1024), n: z.number().int().min(1).max(4).optional(), size: z.string().regex(/^\d+\*\d+$/).optional() }).strict().parse(body);
    const { sessionID, validate } = await selectSkillMedia(input.sessionID);
    const identity = identities.get(sessionID);
    if (!identity) refuse('platform_prompt_authorization_required', 401);
    const result = await mediaDispatch({ identity, sessionID, callID: 'media_' + crypto.randomUUID(), model: input.model, operation: 'image_generation', validate, inputs: { prompt: input.prompt, n: input.n, size: input.size } });
    if (!Array.isArray(result.images) || result.images.length < 1 || result.images.some((image) => !image?.data || !image?.mimeType)) refuse('platform_media_invalid_output', 502);
    return { images: result.images };
  };
  const mediaImageEdit = async (body) => {
    const input = z.object({ sessionID: identifier.optional(), callID: identifier, model: identifier,
      prompt: z.string().trim().min(1).max(64 * 1024),
      images: z.array(z.string().regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/)).length(1),
      mask: z.string().regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/), n: z.literal(1).optional(),
    }).strict().parse(body);
    const sessionID = await mediaVideoSession(input.sessionID);
    const identity = identities.get(sessionID);
    if (!identity) refuse('platform_prompt_authorization_required', 401);
    await mediaDispatch({ identity, sessionID, callID: input.callID, model: input.model, operation: 'image_edit', inputs: { prompt: input.prompt, images: input.images, mask: input.mask, n: 1 } });
    return { callID: input.callID, sessionID, status: 'pending' };
  };
  const mediaImageEditStatus = async (body) => {
    const input = z.object({ sessionID: identifier.optional(), callID: identifier }).strict().parse(body);
    const sessionID = await mediaVideoSession(input.sessionID, true);
    const identity = identities.get(sessionID);
    if (!identity) refuse('platform_prompt_authorization_required', 401);
    const task = taskFor(identity, sessionID); const call = store.read().calls[input.callID];
    if (!call || call.sessionID !== sessionID || call.operation !== 'image_edit') refuse('platform_image_edit_call_not_found', 404);
    if (call.status === 'PREPARED' || call.status === 'REJECTED') refuse('platform_image_edit_not_dispatched', 409);
    const grant = await mediaCredential(task, identity, call.model);
    let response;
    try { response = await fetchImpl(`${config.gateway}/images/edits/${encodeURIComponent(call.id)}`, { headers: { Authorization: `Bearer ${grant.token}`, 'X-UniHub-Task-ID': task.id }, redirect: 'error', signal: AbortSignal.timeout(120_000) }); }
    catch { refuse('platform_image_edit_unavailable', 502); }
    if (![200, 202].includes(response.status) || !response.body) refuse('platform_image_edit_unavailable', 502);
    const declared = response.headers.get('content-length');
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > 24 * 1024 * 1024)) refuse('platform_image_edit_invalid', 502);
    const reader = response.body.getReader(), chunks = []; let total = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break; total += part.value.byteLength; if (total > 24 * 1024 * 1024) refuse('platform_image_edit_invalid', 502); chunks.push(Buffer.from(part.value)); } }
    catch (error) { if (error instanceof PlatformModelError) throw error; refuse('platform_image_edit_unavailable', 502); }
    finally { await reader.cancel().catch(() => {}); }
    let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { refuse('platform_image_edit_invalid', 502); }
    scopeFor(identity);
    if (response.status === 202 && value?.id === call.id && value?.status === 'pending') return { callID: call.id, status: 'pending' };
    if (response.status === 200 && value?.id === call.id && value?.status === 'failed') return { callID: call.id, status: 'failed', settlement: (await receipt(task, call, identity)).status };
    if (response.status !== 200 || !Array.isArray(value?.data) || value.data.length !== 1) refuse('platform_image_edit_invalid', 502);
    let image; try { image = decodeInlineImage(value.data[0]?.b64_json); } catch { refuse('platform_image_edit_invalid', 502); }
    const settlement = (await receipt(task, call, identity)).status;
    if (settlement !== 'SETTLED') refuse('platform_image_edit_settlement_pending', 409);
    scopeFor(identity);
    return { callID: call.id, status: 'succeeded', settlement, images: [image] };
  };
  const mediaVideoSession = async (requested, allowHistorical = false) => {
    if (requested && allowHistorical) return requested;
    const live = [];
    for (const [sessionID, permit] of permits) {
      if (requested && requested !== sessionID) continue;
      const execution = await readExecution(sessionID).catch(() => null);
      const task = store.read().tasks[sessionID];
      if (identities.has(sessionID) && permits.get(sessionID) === permit && task && execution?.promptID === permit.promptID && (execution.idle ?? null) === permit.idle && !execution.parentID && execution.model?.providerID === PLATFORM_PROVIDER && execution.model?.id === task.model) live.push({ sessionID, permit });
    }
    if (requested && !live.length) refuse('platform_prompt_authorization_required', 403);
    if (live.length !== 1) refuse(live.length ? 'platform_media_session_ambiguous' : 'platform_media_session_missing', 409);
    const { sessionID, permit } = live[0];
    if (permits.get(sessionID) !== permit) refuse('platform_prompt_authorization_required', 403);
    const identity = identities.get(sessionID);
    if (!identity) refuse('platform_prompt_authorization_required', 401);
    taskFor(identity, sessionID);
    return sessionID;
  };
  const mediaVideo = async (body) => {
    const input = z.object({ sessionID: identifier.optional(), callID: identifier, model: identifier, prompt: z.string().trim().min(1).max(64 * 1024), seconds: z.number().int().min(1).max(10), size: z.enum(['1280*720', '1920*1080']) }).strict().parse(body);
    const sessionID = await mediaVideoSession(input.sessionID);
    const identity = identities.get(sessionID);
    if (!identity) refuse('platform_prompt_authorization_required', 401);
    await mediaDispatch({ identity, sessionID, callID: input.callID, model: input.model, operation: 'video', inputs: { prompt: input.prompt, seconds: input.seconds, size: input.size } });
    return { callID: input.callID, sessionID };
  };
  const receipt = async (task, call, identity) => {
    const grant = call.model === task.model ? await credential(task, identity) : await mediaCredential(task, identity, call.model);
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
  const mediaVideoStatus = async (body) => {
    const input = z.object({ sessionID: identifier.optional(), callID: identifier }).strict().parse(body);
    const sessionID = await mediaVideoSession(input.sessionID, true);
    const identity = identities.get(sessionID);
    if (!identity) refuse('platform_prompt_authorization_required', 401);
    const task = taskFor(identity, sessionID);
    const call = store.read().calls[input.callID];
    if (!call || call.sessionID !== sessionID || call.operation !== 'video') refuse('platform_video_call_not_found', 404);
    if (call.status === 'PREPARED' || call.status === 'REJECTED') refuse('platform_video_not_dispatched', 409);
    const grant = await mediaCredential(task, identity, call.model);
    let response;
    try { response = await fetchImpl(`${config.gateway}/videos/${encodeURIComponent(call.id)}`, { headers: { Authorization: `Bearer ${grant.token}`, 'X-UniHub-Task-ID': task.id }, redirect: 'error', signal: AbortSignal.timeout(10_000) }); }
    catch { refuse('platform_video_status_unavailable', 502); }
    if (!response.ok) refuse('platform_video_status_unavailable', 502);
    let value;
    try { value = z.object({ id: identifier, task_id: z.string().min(1).max(200), status: z.enum(['NOT_START', 'SUBMITTED', 'QUEUED', 'IN_PROGRESS', 'SUCCESS', 'FAILURE', 'UNKNOWN']), progress: z.string().max(40).optional() }).parse(await response.json()); }
    catch { refuse('platform_video_status_invalid', 502); }
    if (value.id !== call.id) refuse('platform_video_status_invalid', 502);
    const settlement = ['SUCCESS', 'FAILURE'].includes(value.status) ? (await receipt(task, call, identity)).status : undefined;
    scopeFor(identity);
    return { sessionID, task, call, identity, status: value.status, progress: value.progress, settlement };
  };
  const mediaVideoResult = async (body) => {
    const video = await mediaVideoStatus(body);
    if (video.status !== 'SUCCESS' || video.settlement !== 'SETTLED') refuse('platform_video_result_pending', 409);
    const grant = await mediaCredential(video.task, video.identity, video.call.model);
    let response;
    try { response = await fetchImpl(`${config.gateway}/videos/${encodeURIComponent(video.call.id)}/result`, { headers: { Authorization: `Bearer ${grant.token}`, 'X-UniHub-Task-ID': video.task.id }, redirect: 'error', signal: AbortSignal.timeout(120_000) }); }
    catch { refuse('platform_video_result_unavailable', 502); }
    const expectedHash = response.headers.get('x-content-sha256');
    const contentType = response.headers.get('content-type')?.split(';')[0].trim();
    const declared = response.headers.get('content-length');
    if (!response.ok || contentType !== 'video/mp4' || !/^[a-f0-9]{64}$/.test(expectedHash ?? '') || (declared && (!/^\d+$/.test(declared) || Number(declared) > 64 * 1024 * 1024)) || !response.body) refuse('platform_video_result_invalid', 502);
    const reader = response.body.getReader(); const chunks = []; let total = 0;
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        total += part.value.byteLength;
        if (total > 64 * 1024 * 1024) refuse('platform_video_result_invalid', 502);
        chunks.push(Buffer.from(part.value));
      }
    } catch (error) {
      if (error instanceof PlatformModelError) throw error;
      refuse('platform_video_result_unavailable', 502);
    } finally { await reader.cancel().catch(() => {}); }
    const buffer = Buffer.concat(chunks);
    if (buffer.length < 12 || buffer.subarray(4, 8).toString('ascii') !== 'ftyp' || hash(buffer) !== expectedHash || (declared && Number(declared) !== buffer.length)) refuse('platform_video_result_invalid', 502);
    scopeFor(video.identity);
    return { buffer, sha256: expectedHash };
  };
  const reconcile = async (identity, sessionID) => {
    const task = taskFor(identity, sessionID);
    for (const call of Object.values(store.read().calls).filter((call) => call.sessionID === sessionID && blocksSession(call))) {
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
    return { sessionID, taskID: task.id, actorID: task.actorID, accountID: task.accountID, model: task.model, blocked: calls.some(blocksSession), calls: calls.map(({ id, status, charged }) => ({ callID: id, status: status === 'ASYNC_PENDING' ? 'DELIVERED' : status, ...(charged !== undefined ? { charged } : {}) })) };
  };
  // Media tasks bind a durable owner/actor/account/model without an OpenCode
  // prompt permit; restart requires the original identity to re-authenticate.
  const admitMediaTask = async (identity, { model } = {}) => {
    if (model?.providerID !== PLATFORM_PROVIDER) return false;
    check();
    if (!(config.mediaModels ?? []).some((id) => id === model.id)) refuse('platform_media_model_not_allowed', 403);
    const scope = candidateScope(identity);
    if (childScope) scopeFor(identity);
    const owner = scope.owner;
    // One durable media task per owner+model: deterministic, restart-safe, no extra state.
    const sessionID = 'media_' + crypto.createHash('sha256').update(owner + ':' + model.id).digest('hex').slice(0, 32);
    const existing = store.read().tasks[sessionID];
    if (existing) {
      if (existing.owner !== owner || existing.actorID !== scope.actorID || existing.accountID !== scope.accountID) refuse('platform_model_scope_restart_required', 403);
      if (existing.model !== model.id) refuse('platform_task_model_locked');
      scopeFor(identity, true);
      identities.set(sessionID, identity);
      mediaSessions.set(sessionID, { owner, model: model.id });
      return { sessionID, taskID: existing.id, actorID: existing.actorID, accountID: existing.accountID, model: existing.model };
    }
    scopeFor(identity, true);
    const task = { id: 'uh_task_' + crypto.randomUUID(), sessionID, actorID: scope.actorID, accountID: scope.accountID, owner, model: model.id };
    await store.mutate((state) => { scopeFor(identity); state.tasks[sessionID] = task; });
    identities.set(sessionID, identity);
    mediaSessions.set(sessionID, { owner, model: model.id });
    return { sessionID, taskID: task.id, actorID: task.actorID, accountID: task.accountID, model: task.model };
  };
  const admit = async (identity, session, promptID) => {
    const model = session.model;
    if (model?.providerID !== PLATFORM_PROVIDER) return false;
    check(); identifier.parse(session.id);
    if (!/^msg_[A-Za-z0-9_-]{1,180}$/.test(promptID || '')) refuse('platform_prompt_id_required', 400);
    if (session.parentID) refuse('platform_child_unsupported', 403);
    if (!config.models.some((item) => item.id === model.id)) refuse('platform_model_not_allowed', 403);
    const scope = candidateScope(identity);
    if (childScope) scopeFor(identity);
    const owner = scope.owner;
    const existing = store.read().tasks[session.id];
    if (existing && (existing.owner !== owner || existing.actorID !== scope.actorID || existing.accountID !== scope.accountID)) refuse('platform_model_scope_restart_required', 403);
    if (existing && existing.model !== model.id) refuse('platform_task_model_locked');
    scopeFor(identity, true);
    // A newly requested prompt retires the previous stream before reconciliation.
    // Abort its reader, then wait for its journal transition before admitting
    // the next prompt; uncertain calls remain blocked until their receipt is known.
    permits.delete(session.id);
    const previousStream = inflight.get(session.id);
    if (previousStream) {
      previousStream.abort.abort();
      previousStream.response.destroy();
      await previousStream.finished.promise;
    }
    scopeFor(identity);
    const task = existing || { id: `uh_task_${crypto.randomUUID()}`, sessionID: session.id, actorID: scope.actorID, accountID: scope.accountID, owner, model: model.id };
    await credential(task, identity);
    if (!existing) await store.mutate((state) => {
      scopeFor(identity);
      if (state.tasks[session.id]) refuse('platform_task_conflict');
      state.tasks[session.id] = task;
    });
    identities.set(session.id, identity);
    if (existing) {
      await reconcile(identity, session.id);
      if (status(identity, session.id).blocked) refuse('platform_reconciliation_required');
    }
    permits.set(session.id, { id: crypto.randomUUID(), promptID, idle: session.time?.idle ?? null });
    return true;
  };
  const validatePromptPermit = async (sessionID, permit, task) => {
    if (!permit || permits.get(sessionID) !== permit) refuse('platform_prompt_authorization_required', 403);
    const execution = await readExecution(sessionID).catch(() => null);
    if (permits.get(sessionID) !== permit || execution?.promptID !== permit.promptID || (execution?.idle ?? null) !== permit.idle || execution?.parentID || execution?.model?.providerID !== PLATFORM_PROVIDER || execution?.model?.id !== task.model) refuse('platform_prompt_authorization_required', 403);
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
    await validatePromptPermit(input.sessionID, permit, task);
    if (inflight.has(input.sessionID)) refuse('platform_call_in_progress');
    if (input.model !== task.model) refuse('platform_task_model_locked');
    await credential(task, identity);
    // A clean response can finish before the gateway's settlement outbox. Query its receipt first.
    for (const call of Object.values(store.read().calls).filter((call) => call.sessionID === input.sessionID && call.status === 'DELIVERED')) await receipt(task, call, identity);
    await store.mutate((state) => {
      if (permits.get(input.sessionID) !== permit) refuse('platform_prompt_authorization_required', 403);
      scopeFor(identity);
      if (state.calls[input.callID]) refuse('platform_call_already_exists');
      if (Object.values(state.calls).some((call) => call.sessionID === input.sessionID && blocksSession(call))) refuse('platform_reconciliation_required');
      state.calls[input.callID] = { id: input.callID, sessionID: input.sessionID, taskID: task.id, model: task.model, permitID: permit.id, digest: '', status: 'PREPARED', output: false };
    });
    try { await validatePromptPermit(input.sessionID, permit, task); }
    catch (error) {
      await store.mutate((state) => { const call = state.calls[input.callID]; if (call?.status === 'PREPARED') call.status = 'REJECTED'; });
      throw error;
    }
    return { callID: input.callID, taskID: task.id, baseURL: `${base}/v1` };
  };
  const completion = async (req, res, body) => {
    check();
    const sessionID = identifier.parse(req.headers['x-unihub-session-id']);
    const callID = identifier.parse(req.headers['idempotency-key']);
    const identity = identities.get(sessionID);
    if (!identity) refuse('platform_prompt_authorization_required', 401);
    const task = taskFor(identity, sessionID);
    const permit = permits.get(sessionID);
    const assertPermit = () => { if (!permit || permits.get(sessionID) !== permit) refuse('platform_prompt_authorization_required', 403); };
    assertPermit();
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
    await validatePromptPermit(sessionID, permit, task);
    await store.mutate((state) => {
      scopeFor(identity);
      const call = state.calls[callID];
      if (!call || call.sessionID !== sessionID || call.taskID !== task.id) refuse('platform_call_unprepared', 403);
      assertPermit();
      if (call.permitID !== permit.id) refuse('platform_prompt_authorization_required', 403);
      if (call.digest && call.digest !== digest) refuse('platform_call_digest_conflict');
      if (call.status !== 'PREPARED') refuse('platform_call_already_submitted');
      call.digest = digest; call.status = 'DISPATCHED';
    });
    const stream = { abort, response: res, finished: Promise.withResolvers() };
    inflight.set(sessionID, stream);
    const markUnknown = () => store.mutate((state) => { if (!terminal.has(state.calls[callID].status)) state.calls[callID].status = 'UNKNOWN'; });
    let upstreamStarted = false;
    try {
      await validatePromptPermit(sessionID, permit, task);
      check();
      scopeFor(identity);
      assertPermit();
      if (res.destroyed || req.aborted) refuse('platform_runtime_unsupported', 409);
      upstreamStarted = true;
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
        scopeFor(identity);
        assertPermit();
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
        check();
        scopeFor(identity);
        assertPermit();
        if (!res.write(item.value)) await once(res, 'drain', { signal: abort.signal });
      }
      if (!done || buffer.trim()) throw new Error('platform_stream_incomplete');
      await store.mutate((state) => { state.calls[callID].status = 'DELIVERED'; });
      await receipt(task, store.read().calls[callID], identity).catch(() => {});
      res.end();
    } catch (error) {
      if (upstreamStarted) await markUnknown();
      else await store.mutate((state) => { if (!terminal.has(state.calls[callID].status)) state.calls[callID].status = 'REJECTED'; });
      if (res.headersSent) { res.destroy(); return; }
      if (error instanceof PlatformModelError) throw error;
      refuse('platform_reconciliation_required', 502);
    } finally { if (inflight.get(sessionID) === stream) inflight.delete(sessionID); stream.finished.resolve(); }
  };
  const listen = async () => {
    if (server || !config) return;
    const handleRequest = async (req, res) => {
      try {
        const provided = Buffer.from(req.headers.authorization || ''); const expected = Buffer.from(`Bearer ${token}`);
        if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) refuse('platform_internal_unauthorized', 401);
        if (req.method !== 'POST') refuse('platform_protocol_unsupported', 404);
        const body = await readBody(req, req.url === '/media/image-edit' ? 12 * 1024 * 1024 : 1_048_576);
        if (req.url === '/prepare') return json(res, 200, await prepare(body));
        if (req.url === '/media/speech') {
          const result = await mediaSpeech(body);
          res.writeHead(200, { 'content-type': result.contentType, 'cache-control': 'no-store' });
          res.end(result.buffer);
          return;
        }
        if (req.url === '/media/image') {
          const result = await mediaImage(body);
          return json(res, 200, result);
        }
        if (req.url === '/media/image-edit') {
          const result = await mediaImageEdit(body);
          return json(res, 200, result);
        }
        if (req.url === '/media/image-edit/status') return json(res, 200, await mediaImageEditStatus(body));
        if (req.url === '/media/session') {
          const input = z.object({ sessionID: identifier.optional() }).strict().parse(body);
          return json(res, 200, { sessionID: await mediaVideoSession(input.sessionID) });
        }
        if (req.url === '/media/video') {
          const result = await mediaVideo(body);
          return json(res, 200, result);
        }
        if (req.url === '/media/video/status') {
          const result = await mediaVideoStatus(body);
          return json(res, 200, { callID: result.call.id, status: result.status, ...(result.progress === undefined ? {} : { progress: result.progress }), ...(result.settlement === undefined ? {} : { settlement: result.settlement }) });
        }
        if (req.url === '/media/video/result') {
          const result = await mediaVideoResult(body);
          res.writeHead(200, { 'content-type': 'video/mp4', 'x-content-sha256': result.sha256, 'cache-control': 'no-store' });
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
