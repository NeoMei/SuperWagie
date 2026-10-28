// Native media transport for the managed quukk provider.
//
// Dispatches certified native media operations to the llmrouter platform
// routes using the same admitted task grants as the chat proxy. This module
// owns request shaping and response transport only; durable journaling,
// receipt reconciliation and payer binding stay in platform-model/runtime.
// Operations stay unavailable to product flows until the host integration
// wires grants, journal and consumer bindings (media-native-wire v1).
import { Buffer } from 'node:buffer';

const MAX_JSON_BODY_BYTES = 12 * 1024 * 1024;
const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120000;

const AUDIO_OPERATIONS = {
  speech: { path: '/native/bailian/audio/speech' },
  transcription: { path: '/native/dashscope/audio/transcriptions' },
};
const IMAGE_PATH = '/images/generations';
const VIDEO_PATH = '/videos';

export class NativeMediaError extends Error {
  constructor(message, { status, code, upstream } = {}) {
    super(message);
    this.name = 'NativeMediaError';
    this.status = status ?? 0;
    this.code = code ?? 'native_media_failed';
    this.upstream = upstream ?? null;
  }
}

const textNotAllowed = (value) => typeof value !== 'string' || !value.trim();

export function createNativeMediaTransport({
  gateway,
  fetchImpl,
  grantFor,
  operationAllowlist,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  // HTTPS always; loopback HTTP mirrors the platform-model development gateway rule.
  if (!gateway || typeof gateway !== 'string') {
    throw new Error('native media transport requires a gateway base URL');
  }
  let parsedGateway;
  try { parsedGateway = new URL(gateway); } catch {
    throw new Error('native media transport gateway is not a URL');
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(parsedGateway.hostname);
  if (parsedGateway.protocol !== 'https:' && !(parsedGateway.protocol === 'http:' && loopback)) {
    throw new Error('native media transport requires an https gateway (loopback http allowed for development)');
  }
  if (typeof fetchImpl !== 'function' || typeof grantFor !== 'function') {
    throw new Error('native media transport requires fetchImpl and grantFor');
  }
  const allowlist = operationAllowlist ?? {};
  const base = gateway.replace(/[/]+$/, '');
  const allowed = (operation, model) => allowlist[operation]?.includes(model);

  async function send(path, body, grant, taskID, idempotencyKey, accept) {
    const payload = JSON.stringify(body);
    if (Buffer.byteLength(payload) > MAX_JSON_BODY_BYTES) {
      throw new NativeMediaError('native media request exceeds local body limit', { code: 'native_media_too_large' });
    }
    let response;
    try {
      response = await fetchImpl(base + path, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + grant.token,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
          'X-UniHub-Task-ID': taskID,
          ...(accept ? { Accept: accept } : {}),
        },
        body: payload,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new NativeMediaError('native media transport failed before a terminal result', {
        code: 'native_media_unresolved',
        upstream: error,
      });
    }
    return response;
  }

  async function readError(response) {
    let detail = '';
    try {
      detail = (await response.text()).slice(0, 512);
    } catch { /* body already consumed or empty */ }
    return new NativeMediaError('gateway refused native media call (HTTP ' + response.status + ')', {
      status: response.status,
      code: response.status === 400 ? 'invalid_media_request' : 'gateway_media_refused',
      upstream: detail,
    });
  }

  async function resolveGrant(operation, model, taskID, idempotencyKey) {
    if (!allowed(operation, model)) {
      throw new NativeMediaError('model ' + model + ' is not admitted for ' + operation, { code: 'native_media_model_not_admitted', status: 400 });
    }
    if (textNotAllowed(taskID) || textNotAllowed(idempotencyKey)) {
      throw new NativeMediaError('native media requires task and idempotency identity', { code: 'native_media_identity_missing', status: 400 });
    }
    return grantFor(model, taskID);
  }

  return {
    async dispatchSpeech({ model, text, voice, instructions, languageType, grant, taskID, idempotencyKey }) {
      if (textNotAllowed(text) || textNotAllowed(voice)) {
        throw new NativeMediaError('speech requires text and voice', { code: 'invalid_media_request', status: 400 });
      }
      if (Buffer.byteLength(text, 'utf8') > MAX_JSON_BODY_BYTES) {
        throw new NativeMediaError('speech text exceeds body limit', { code: 'native_media_too_large', status: 400 });
      }
      const resolved = grant ?? (await resolveGrant('speech', model, taskID, idempotencyKey));
      const body = { model, input: { text, voice, ...(instructions ? { instructions } : {}), ...(languageType ? { language_type: languageType } : {}) } };
      const response = await send(AUDIO_OPERATIONS.speech.path, body, resolved, taskID, idempotencyKey, 'audio/mpeg, audio/wav');
      if (!response.ok) throw await readError(response);
      const contentType = response.headers.get('content-type') ?? 'audio/mpeg';
      if (!new RegExp('^audio/(mpeg|mp3|wav)(;|$)').test(contentType)) {
        throw new NativeMediaError('gateway returned a non-audio speech response', { code: 'native_media_invalid_response' });
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0 || buffer.length > MAX_AUDIO_BYTES) {
        throw new NativeMediaError('speech audio missing or exceeds bound', { code: 'native_media_invalid_response' });
      }
      return { buffer, contentType };
    },

    async dispatchTranscription({ model, audioDataUri, grant, taskID, idempotencyKey }) {
      if (typeof audioDataUri !== 'string' || !audioDataUri.startsWith('data:audio/') || !audioDataUri.includes(';base64,')) {
        throw new NativeMediaError('transcription requires a base64 audio data URI', { code: 'invalid_media_request', status: 400 });
      }
      if (audioDataUri.length > MAX_JSON_BODY_BYTES) {
        throw new NativeMediaError('transcription audio exceeds body limit', { code: 'native_media_too_large', status: 400 });
      }
      const resolved = grant ?? (await resolveGrant('transcription', model, taskID, idempotencyKey));
      const body = { model, messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: audioDataUri } }] }] };
      const response = await send(AUDIO_OPERATIONS.transcription.path, body, resolved, taskID, idempotencyKey);
      if (!response.ok) throw await readError(response);
      let parsed;
      try { parsed = await response.json(); } catch {
        throw new NativeMediaError('transcription response is not JSON', { code: 'native_media_invalid_response' });
      }
      const choice = parsed?.choices?.[0]?.message?.content;
      const seconds = parsed?.usage?.seconds;
      if (typeof choice !== 'string' || typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
        throw new NativeMediaError('transcription response missing transcript or seconds', { code: 'native_media_invalid_response' });
      }
      return { transcript: choice, seconds };
    },

    async dispatchImageGeneration({ model, prompt, n = 1, size, grant, taskID, idempotencyKey }) {
      if (textNotAllowed(prompt)) {
        throw new NativeMediaError('image generation requires a prompt', { code: 'invalid_media_request', status: 400 });
      }
      if (!Number.isInteger(n) || n < 1 || n > 4) {
        throw new NativeMediaError('image count out of bounds', { code: 'invalid_media_request', status: 400 });
      }
      const resolved = grant ?? (await resolveGrant('image_generation', model, taskID, idempotencyKey));
      const body = { model, prompt, n, ...(size ? { size } : {}), response_format: 'url' };
      const response = await send(IMAGE_PATH, body, resolved, taskID, idempotencyKey);
      if (!response.ok) throw await readError(response);
      let parsed;
      try { parsed = await response.json(); } catch {
        throw new NativeMediaError('image response is not JSON', { code: 'native_media_invalid_response' });
      }
      const urls = (parsed?.data ?? []).map((item) => item?.url).filter((url) => typeof url === 'string' && url.startsWith('https://'));
      if (urls.length < 1) {
        throw new NativeMediaError('image response returned no usable output', { code: 'native_media_invalid_response' });
      }
      return { urls };
    },

    async dispatchVideoSubmit({ model, prompt, seconds, size, grant, taskID, idempotencyKey }) {
      if (textNotAllowed(prompt)) {
        throw new NativeMediaError('video generation requires a prompt', { code: 'invalid_media_request', status: 400 });
      }
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 10) {
        throw new NativeMediaError('video seconds out of certified bounds', { code: 'invalid_media_request', status: 400 });
      }
      if (size !== '1280*720' && size !== '1920*1080') {
        throw new NativeMediaError('video requires a certified resolution', { code: 'invalid_media_request', status: 400 });
      }
      const resolved = grant ?? (await resolveGrant('video', model, taskID, idempotencyKey));
      const body = { model, prompt, seconds, size };
      const response = await send(VIDEO_PATH, body, resolved, taskID, idempotencyKey);
      if (!response.ok) throw await readError(response);
      let parsed;
      try { parsed = await response.json(); } catch {
        throw new NativeMediaError('video submit response is not JSON', { code: 'native_media_invalid_response' });
      }
      const taskOut = parsed?.task_id ?? parsed?.output?.task_id ?? parsed?.id;
      if (typeof taskOut !== 'string' || !taskOut.trim()) {
        throw new NativeMediaError('video submit response missing task id', { code: 'native_media_invalid_response' });
      }
      return { taskId: taskOut, raw: parsed };
    },
  };
}
