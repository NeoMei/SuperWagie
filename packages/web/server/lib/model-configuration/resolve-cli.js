import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

import { createModelConfigurationRuntime } from './runtime.js';
import { openCodeCredentialSource, projectCredentialEntries } from '../opencode/auth.js';
import { generateConfiguredSpeech } from './speech.js';

const privateCredentialReader = (environment) => {
  if (!environment.SUPERWAGIE_MODEL_OPENCODE_URL) return undefined;
  let baseUrl;
  try {
    const url = new URL(environment.SUPERWAGIE_MODEL_OPENCODE_URL);
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') return undefined;
    baseUrl = url.origin;
  } catch { return undefined; }
  const source = openCodeCredentialSource({
    buildOpenCodeUrl: () => baseUrl,
    getOpenCodeAuthHeaders: () => {
      const password = (environment.OPENCODE_PASSWORD || environment.OPENCODE_SERVER_PASSWORD || '').trim();
      return password ? { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` } : {};
    },
    getLaunchEnvironment: () => environment,
    getDefaultDirectory: () => process.cwd(),
  });
  return async () => {
    const [stored, environmentKeys] = await Promise.all([source.list(), source.listEnvironmentKeys()]);
    return { ...Object.fromEntries(Object.entries(environmentKeys).map(([providerId, key]) => [providerId, { type: 'api', key }])), ...projectCredentialEntries(stored) };
  };
};

/** For bundled child processes only. Never forward its stdout to a browser or log. */
export const resolveModelBindingFromDisk = (purpose, { dataDir, supportedProtocols, environment = process.env } = {}) => {
  const directory = dataDir ?? (environment.OPENCHAMBER_DATA_DIR ? path.resolve(environment.OPENCHAMBER_DATA_DIR) : path.join(os.homedir(), '.config', 'openchamber'));
  return createModelConfigurationRuntime({ dataDir: directory, readOpenCodeCredentials: privateCredentialReader(environment) }).resolveBinding(purpose, { supportedProtocols });
};
const speechInput = z.object({ sessionID: z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/).optional(),
  text: z.string().trim().min(1).max(9999), speed: z.number().finite().min(0.5).max(2).optional(),
  expectedModel: z.string().trim().min(1).max(256).optional(), expectedVoice: z.string().trim().min(1).max(256).optional(),
}).strict();
const speechFailure = (code) => Object.assign(new Error(code), { code });
const brokerFailure = async (response, fallback) => {
  if ([403, 409].includes(response.status) && response.body) {
    const reader = response.body.getReader(), chunks = []; let size = 0;
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 2_000); });
    try {
      for (;;) {
        const part = await Promise.race([reader.read(), deadline]);
        if (part.done) break;
        size += part.value.byteLength; if (size > 8192) break; chunks.push(Buffer.from(part.value));
      }
      if (size <= 8192) {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (body?.error?.code === 'platform_model_scope_restart_required') throw speechFailure('platform_model_scope_restart_required');
        if (['platform_media_session_missing', 'platform_media_session_ambiguous', 'platform_prompt_authorization_required'].includes(body?.error?.code)) throw speechFailure('model_configuration_agent_session_required');
      }
    } catch (error) { if (['platform_model_scope_restart_required', 'model_configuration_agent_session_required'].includes(error.code)) throw error; }
    finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
  }
  throw speechFailure(fallback);
};
const imageInput = z.object({ sessionID: z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/).optional(), prompt: z.string().trim().min(1).max(64 * 1024), n: z.number().int().min(1).max(4).optional(), size: z.string().regex(/^\d+\*\d+$/).optional(), expectedModel: z.string().trim().min(1).max(256).optional() }).strict();
const imageEditInput = z.object({ sessionID: z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/).optional(), callID: z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/), prompt: z.string().trim().min(1).max(64 * 1024), images: z.array(z.string().regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/)).length(1), mask: z.string().regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/), expectedModel: z.string().trim().min(1).max(256).optional() }).strict();
const videoCallID = z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/).refine((value) => !['__proto__', 'constructor', 'prototype'].includes(value));
const videoInput = z.object({ sessionID: videoCallID.optional(), callID: videoCallID, prompt: z.string().trim().min(1).max(64 * 1024), seconds: z.number().int().min(1).max(10), size: z.enum(['1280*720', '1920*1080']), expectedModel: z.string().trim().min(1).max(256).optional() }).strict();
const videoReadInput = z.object({ sessionID: videoCallID.optional(), callID: videoCallID }).strict();
export const selectManagedMediaSession = async (input, { environment = process.env } = {}) => {
  const parsed = z.object({ sessionID: videoCallID.optional() }).strict().safeParse(input);
  if (!parsed.success) throw speechFailure('model_configuration_invalid_input');
  const proxyURL = environment.OPENCHAMBER_UNIHUB_PROXY_URL, proxyToken = environment.OPENCHAMBER_UNIHUB_PROXY_TOKEN;
  if (!proxyURL || !proxyToken) throw speechFailure('model_configuration_unavailable');
  let response;
  try { response = await fetch(proxyURL.replace(/[/]+$/, '') + '/media/session', {method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers: {'content-type': 'application/json', authorization: 'Bearer ' + proxyToken}, body: JSON.stringify(parsed.data)}); }
  catch { throw speechFailure('model_configuration_unavailable'); }
  if (!response.ok) await brokerFailure(response, 'model_configuration_unavailable');
  let value; try { value = await response.json(); } catch { throw speechFailure('model_configuration_invalid_provider_response'); }
  if (!videoCallID.safeParse(value?.sessionID).success || (parsed.data.sessionID && parsed.data.sessionID !== value.sessionID)) throw speechFailure('model_configuration_invalid_provider_response');
  return {sessionID: value.sessionID};
};
export const generateConfiguredImageFromDisk = async (input, options = {}) => {
  const parsed = imageInput.safeParse(input);
  if (!parsed.success) throw speechFailure('model_configuration_invalid_input');
  const binding = await resolveModelBindingFromDisk('image-generation', { ...options, supportedProtocols: ['managed-media'] });
  if (!binding) throw speechFailure('model_configuration_binding_missing');
  if (parsed.data.expectedModel && parsed.data.expectedModel !== binding.model) throw speechFailure('model_configuration_model_mismatch');
  const environment = options.environment ?? process.env;
  const proxyURL = environment.OPENCHAMBER_UNIHUB_PROXY_URL;
  const proxyToken = environment.OPENCHAMBER_UNIHUB_PROXY_TOKEN;
  if (!proxyURL || !proxyToken) throw speechFailure('model_configuration_unavailable');
  let response;
  try {
    response = await fetch(proxyURL.replace(/[/]+$/, '') + '/media/image', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120000), headers: { 'content-type': 'application/json', authorization: 'Bearer ' + proxyToken }, body: JSON.stringify({ sessionID: parsed.data.sessionID, model: binding.model, prompt: parsed.data.prompt, n: parsed.data.n, size: parsed.data.size }) });
  } catch { throw speechFailure('model_configuration_unavailable'); }
  if (!response.ok) await brokerFailure(response, 'model_configuration_image_failed');
  let value;
  try { value = await response.json(); } catch { throw speechFailure('model_configuration_invalid_provider_response'); }
  if (!Array.isArray(value?.images) || value.images.length < 1 || value.images.some((image) => typeof image?.data !== 'string' || !image.mimeType?.startsWith('image/'))) throw speechFailure('model_configuration_invalid_provider_response');
  return { images: value.images };
};
export const editConfiguredImageFromDisk = async (input, options = {}) => {
  const parsed = imageEditInput.safeParse(input);
  if (!parsed.success) throw speechFailure('model_configuration_invalid_input');
  const binding = await resolveModelBindingFromDisk('image-editing', { ...options, supportedProtocols: ['managed-media'] });
  if (!binding) throw speechFailure('model_configuration_binding_missing');
  if (parsed.data.expectedModel && parsed.data.expectedModel !== binding.model) throw speechFailure('model_configuration_model_mismatch');
  const environment = options.environment ?? process.env;
  const proxyURL = environment.OPENCHAMBER_UNIHUB_PROXY_URL, proxyToken = environment.OPENCHAMBER_UNIHUB_PROXY_TOKEN;
  if (!proxyURL || !proxyToken) throw speechFailure('model_configuration_unavailable');
  let response;
  try { response = await fetch(proxyURL.replace(/[/]+$/, '') + '/media/image-edit', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120000), headers: { 'content-type': 'application/json', authorization: 'Bearer ' + proxyToken }, body: JSON.stringify({ sessionID: parsed.data.sessionID, callID: parsed.data.callID, model: binding.model, prompt: parsed.data.prompt, images: parsed.data.images, mask: parsed.data.mask }) }); }
  catch { throw speechFailure('model_configuration_unavailable'); }
  if (!response.ok) await brokerFailure(response, 'model_configuration_image_edit_failed');
  let value; try { value = await response.json(); } catch { throw speechFailure('model_configuration_invalid_provider_response'); }
  if (value?.callID !== parsed.data.callID || value?.status !== 'pending' || typeof value.sessionID !== 'string' || (parsed.data.sessionID && parsed.data.sessionID !== value.sessionID)) throw speechFailure('model_configuration_invalid_provider_response');
  return value;
};
export const readConfiguredImageEditFromDisk = async (input, options = {}) => {
  const parsed = videoReadInput.safeParse(input);
  if (!parsed.success) throw speechFailure('model_configuration_invalid_input');
  const environment = options.environment ?? process.env;
  const proxyURL = environment.OPENCHAMBER_UNIHUB_PROXY_URL, proxyToken = environment.OPENCHAMBER_UNIHUB_PROXY_TOKEN;
  if (!proxyURL || !proxyToken) throw speechFailure('model_configuration_unavailable');
  let response; try { response = await fetch(proxyURL.replace(/[/]+$/, '') + '/media/image-edit/status', {method: 'POST', redirect: 'error', signal: AbortSignal.timeout(130000), headers: {'content-type': 'application/json', authorization: 'Bearer ' + proxyToken}, body: JSON.stringify(parsed.data)}); }
  catch { throw speechFailure('model_configuration_unavailable'); }
  if (!response.ok) await brokerFailure(response, 'model_configuration_image_edit_failed');
  const declared = response.headers.get('content-length'); if (declared && Number(declared) > 24 * 1024 * 1024) throw speechFailure('model_configuration_invalid_provider_response');
  const reader = response.body?.getReader(); if (!reader) throw speechFailure('model_configuration_invalid_provider_response');
  let total = 0; const chunks = [];
  try { for (;;) { const part = await reader.read(); if (part.done) break; total += part.value.byteLength; if (total > 24 * 1024 * 1024) throw speechFailure('model_configuration_invalid_provider_response'); chunks.push(Buffer.from(part.value)); } }
  finally { await reader.cancel().catch(() => {}); }
  let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw speechFailure('model_configuration_invalid_provider_response'); }
  if (value?.callID !== parsed.data.callID || !['pending', 'failed', 'succeeded'].includes(value.status)) throw speechFailure('model_configuration_invalid_provider_response');
  if (value.status === 'succeeded' && (value.settlement !== 'SETTLED' || !Array.isArray(value.images) || value.images.length !== 1 || typeof value.images[0]?.data !== 'string' || !value.images[0]?.mimeType?.startsWith('image/'))) throw speechFailure('model_configuration_invalid_provider_response');
  return value;
};
export const submitConfiguredVideoFromDisk = async (input, options = {}) => {
  const parsed = videoInput.safeParse(input);
  if (!parsed.success) throw speechFailure('model_configuration_invalid_input');
  const binding = await resolveModelBindingFromDisk('video-generation', { ...options, supportedProtocols: ['managed-media'] });
  if (!binding) throw speechFailure('model_configuration_binding_missing');
  if (parsed.data.expectedModel && parsed.data.expectedModel !== binding.model) throw speechFailure('model_configuration_model_mismatch');
  const environment = options.environment ?? process.env;
  const proxyURL = environment.OPENCHAMBER_UNIHUB_PROXY_URL;
  const proxyToken = environment.OPENCHAMBER_UNIHUB_PROXY_TOKEN;
  if (!proxyURL || !proxyToken) throw speechFailure('model_configuration_unavailable');
  let response;
  try {
    response = await fetch(proxyURL.replace(/[/]+$/, '') + '/media/video', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120000), headers: { 'content-type': 'application/json', authorization: 'Bearer ' + proxyToken }, body: JSON.stringify({ sessionID: parsed.data.sessionID, callID: parsed.data.callID, model: binding.model, prompt: parsed.data.prompt, seconds: parsed.data.seconds, size: parsed.data.size }) });
  } catch { throw speechFailure('model_configuration_unavailable'); }
  if (!response.ok) await brokerFailure(response, 'model_configuration_video_failed');
  let value;
  try { value = await response.json(); } catch { throw speechFailure('model_configuration_invalid_provider_response'); }
  if (value?.callID !== parsed.data.callID || !videoCallID.safeParse(value.sessionID).success || (parsed.data.sessionID && parsed.data.sessionID !== value.sessionID)) throw speechFailure('model_configuration_invalid_provider_response');
  return { callID: value.callID, sessionID: value.sessionID };
};
export const readConfiguredVideoFromDisk = async (input, { environment = process.env, result = false } = {}) => {
  const parsed = videoReadInput.safeParse(input);
  if (!parsed.success) throw speechFailure('model_configuration_invalid_input');
  const proxyURL = environment.OPENCHAMBER_UNIHUB_PROXY_URL;
  const proxyToken = environment.OPENCHAMBER_UNIHUB_PROXY_TOKEN;
  if (!proxyURL || !proxyToken) throw speechFailure('model_configuration_unavailable');
  let response;
  try {
    response = await fetch(proxyURL.replace(/[/]+$/, '') + (result ? '/media/video/result' : '/media/video/status'), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(result ? 120000 : 15000), headers: { 'content-type': 'application/json', authorization: 'Bearer ' + proxyToken }, body: JSON.stringify(parsed.data) });
  } catch { throw speechFailure('model_configuration_unavailable'); }
  if (!response.ok) await brokerFailure(response, response.status === 409 ? 'model_configuration_video_pending' : 'model_configuration_video_failed');
  if (!result) {
    let value; try { value = await response.json(); } catch { throw speechFailure('model_configuration_invalid_provider_response'); }
    const parsedResult = z.object({ callID: videoCallID, status: z.enum(['NOT_START', 'SUBMITTED', 'QUEUED', 'IN_PROGRESS', 'SUCCESS', 'FAILURE', 'UNKNOWN']), progress: z.string().max(40).optional(), settlement: z.string().max(40).optional() }).strict().safeParse(value);
    if (!parsedResult.success || parsedResult.data.callID !== parsed.data.callID) throw speechFailure('model_configuration_invalid_provider_response');
    return parsedResult.data;
  }
  const expectedHash = response.headers.get('x-content-sha256');
  if (response.headers.get('content-type')?.split(';')[0] !== 'video/mp4' || !/^[a-f0-9]{64}$/.test(expectedHash ?? '') || !response.body) throw speechFailure('model_configuration_invalid_provider_response');
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > 64 * 1024 * 1024) throw speechFailure('model_configuration_invalid_provider_response');
      chunks.push(Buffer.from(part.value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  const video = Buffer.concat(chunks);
  if (video.length < 12 || video.subarray(4, 8).toString('ascii') !== 'ftyp' || createHash('sha256').update(video).digest('hex') !== expectedHash) throw speechFailure('model_configuration_invalid_provider_response');
  return { video: video.toString('base64'), contentType: 'video/mp4', sha256: expectedHash };
};

/** Returns audio only; resolved keys stay inside this private helper process. */
export const synthesizeConfiguredSpeechFromDisk = async (input, options = {}) => {
  const parsed = speechInput.safeParse(input);
  if (!parsed.success) throw speechFailure('model_configuration_invalid_input');
  const binding = await resolveModelBindingFromDisk('tts', { ...options, supportedProtocols: ['minimax', 'managed-media'] });
  if (!binding) throw speechFailure('model_configuration_binding_missing');
  if (parsed.data.expectedModel && parsed.data.expectedModel !== binding.model || parsed.data.expectedVoice && parsed.data.expectedVoice !== (binding.parameters.voice || 'male-qn-qingse')) throw speechFailure('model_configuration_voice_mismatch');
  if (binding.protocol === 'managed-media') {
    const environment = options.environment ?? process.env;
    const proxyURL = environment.OPENCHAMBER_UNIHUB_PROXY_URL;
    const proxyToken = environment.OPENCHAMBER_UNIHUB_PROXY_TOKEN;
    if (!proxyURL || !proxyToken) throw speechFailure('model_configuration_unavailable');
    const voice = parsed.data.expectedVoice || binding.parameters.voice || 'Cherry';
    let response;
    try {
      response = await fetch(proxyURL.replace(/[/]+$/, '') + '/media/speech', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120000),
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + proxyToken },
        body: JSON.stringify({ sessionID: parsed.data.sessionID, model: binding.model, text: parsed.data.text, voice }),
      });
    } catch { throw speechFailure('model_configuration_unavailable'); }
    if (!response.ok) await brokerFailure(response, 'model_configuration_synthesis_failed');
    if (!(response.headers.get('content-type') ?? '').startsWith('audio/')) throw speechFailure('model_configuration_invalid_provider_response');
    const audio = Buffer.from(await response.arrayBuffer());
    if (!audio.length) throw speechFailure('model_configuration_invalid_provider_response');
    return { audio: audio.toString('base64'), contentType: response.headers.get('content-type') ?? 'audio/mpeg' };
  }
  const speech = { text: parsed.data.text };
  if (parsed.data.speed !== undefined) speech.speed = parsed.data.speed;
  const result = await generateConfiguredSpeech(binding, speech);
  return { audio: result.buffer.toString('base64'), contentType: result.contentType };
};

const readSpeechInput = async (maxBytes = 128 * 1024) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > maxBytes) throw speechFailure('model_configuration_invalid_input');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw speechFailure('model_configuration_invalid_input'); }
};
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [purpose, ...supportedProtocols] = process.argv.slice(2);
  try {
    const result = purpose === '--synthesize-tts'
      ? await synthesizeConfiguredSpeechFromDisk(await readSpeechInput())
      : purpose === '--generate-image'
        ? await generateConfiguredImageFromDisk(await readSpeechInput())
      : purpose === '--edit-image'
        ? await editConfiguredImageFromDisk(await readSpeechInput(12 * 1024 * 1024))
      : purpose === '--image-edit-status'
        ? await readConfiguredImageEditFromDisk(await readSpeechInput())
      : purpose === '--media-session'
        ? await selectManagedMediaSession(await readSpeechInput())
      : purpose === '--generate-video'
        ? await submitConfiguredVideoFromDisk(await readSpeechInput())
      : purpose === '--video-status'
        ? await readConfiguredVideoFromDisk(await readSpeechInput())
      : purpose === '--video-result'
        ? await readConfiguredVideoFromDisk(await readSpeechInput(), { result: true })
      : await resolveModelBindingFromDisk(purpose, { supportedProtocols });
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    process.stderr.write(/^(?:model_configuration_[a-z0-9_]+|enterprise_mode|platform_model_scope_restart_required)$/.test(error.code) ? error.code : 'model_configuration_failed');
    process.exitCode = 1;
  }
}
