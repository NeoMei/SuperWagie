// Native media transport for the managed quukk provider.
//
// Dispatches certified native media operations to the llmrouter platform
// routes using the same admitted task grants as the chat proxy. This module
// owns request shaping and response transport only; durable journaling,
// receipt reconciliation and payer binding stay in platform-model/runtime.
// Operations stay unavailable to product flows until the host integration
// wires grants, journal and consumer bindings (media-native-wire v1).
import { Buffer } from 'node:buffer';
import { z } from 'zod';

const MAX_JSON_BODY_BYTES = 12 * 1024 * 1024;
const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_RESPONSE_BYTES = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 * 4 + 1024 * 1024;
const MAX_METADATA_RESPONSE_BYTES = 1024 * 1024;
// Qwen ASR's native gateway accepts upstream response bodies up to 4 MiB.
const MAX_TRANSCRIPTION_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120000;

const AUDIO_OPERATIONS = {
  speech: { path: '/native/bailian/audio/speech' },
  transcription: { path: '/native/dashscope/audio/transcriptions' },
};
const IMAGE_PATH = '/images/generations';
const IMAGE_EDIT_PATH = '/images/edits';
const VIDEO_PATH = '/videos';

export const decodeInlineImage = (value) => {
  if (!z.string().min(1).max(MAX_IMAGE_BYTES * 2).safeParse(value).success) throw new NativeMediaError('image response returned invalid inline output', { code: 'native_media_invalid_response' });
  let bytes;
  try { bytes = Buffer.from(value, 'base64'); } catch { throw new NativeMediaError('image response returned invalid inline output', { code: 'native_media_invalid_response' }); }
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== value) throw new NativeMediaError('image response returned invalid inline output', { code: 'native_media_invalid_response' });
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
  const webp = bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!png && !jpeg && !webp) throw new NativeMediaError('image response returned an unsupported inline format', { code: 'native_media_invalid_response' });
  return { data: value, mimeType: png ? 'image/png' : jpeg ? 'image/jpeg' : 'image/webp' };
};

const validateImageDataUri = (value, label = 'image') => {
  if (!z.string().max(MAX_IMAGE_BYTES * 2).regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/).safeParse(value).success) {
    throw new NativeMediaError(`${label} must be a bounded base64 image data URI`, { code: 'invalid_media_request', status: 400, local: true });
  }
  const [, encoded] = value.split(',');
  let decoded;
  try { decoded = decodeInlineImage(encoded); }
  catch { throw new NativeMediaError(`${label} contains invalid image bytes`, { code: 'invalid_media_request', status: 400, local: true }); }
  const mimeType = value.slice(5, value.indexOf(';'));
  if (decoded.mimeType !== mimeType) throw new NativeMediaError(`${label} has a mismatched image type`, { code: 'invalid_media_request', status: 400, local: true });
  return value;
};
const imagePart = (value, label) => {
  validateImageDataUri(value, label);
  const comma = value.indexOf(',');
  const mimeType = value.slice(5, value.indexOf(';'));
  return { mimeType, bytes: Buffer.from(value.slice(comma + 1), 'base64') };
};

export class NativeMediaError extends Error {
  constructor(message, { status, code, upstream, local = false } = {}) {
    super(message);
    this.name = 'NativeMediaError';
    this.status = status ?? 0;
    this.code = code ?? 'native_media_failed';
    this.upstream = upstream ?? null;
    this.local = local;
  }
}

const textNotAllowed = (value) => !z.string().trim().min(1).safeParse(value).success;

// Read from the response stream instead of calling arrayBuffer/json/text first:
// those methods allocate the entire body before any size check can run.
export async function readBoundedResponse(response, limit, truncate = false) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  let complete = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { complete = true; break; }
      if (size + value.byteLength > limit) {
        if (!truncate) throw new NativeMediaError('gateway response exceeds local body limit', { code: 'native_media_invalid_response' });
        chunks.push(Buffer.from(value.subarray(0, limit - size)));
        size = limit;
        break;
      }
      chunks.push(Buffer.from(value));
      size += value.byteLength;
      if (truncate && size === limit) break;
    }
    return Buffer.concat(chunks, size);
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function readJSONResponse(response, limit, message) {
  try { return JSON.parse((await readBoundedResponse(response, limit)).toString('utf8')); }
  catch (error) {
    if (error instanceof NativeMediaError) throw error;
    throw new NativeMediaError(message, { code: 'native_media_invalid_response' });
  }
}

export function createNativeMediaTransport({
  gateway,
  fetchImpl,
  grantFor,
  operationAllowlist,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  // HTTPS always; loopback HTTP mirrors the platform-model development gateway rule.
  if (!z.string().min(1).safeParse(gateway).success) {
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
  if (!z.function().safeParse(fetchImpl).success || !z.function().safeParse(grantFor).success) {
    throw new Error('native media transport requires fetchImpl and grantFor');
  }
  const allowlist = operationAllowlist ?? {};
  const base = gateway.replace(/[/]+$/, '');
  const allowed = (operation, model) => allowlist[operation]?.includes(model);

  async function send(path, body, grant, taskID, idempotencyKey, accept) {
    const payload = JSON.stringify(body);
    if (Buffer.byteLength(payload) > MAX_JSON_BODY_BYTES) {
      throw new NativeMediaError('native media request exceeds local body limit', { code: 'native_media_too_large', status: 400, local: true });
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

  async function sendMultipart(path, form, grant, taskID, idempotencyKey) {
    let response;
    try {
      response = await fetchImpl(base + path, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + grant.token,
          'Idempotency-Key': idempotencyKey,
          'X-UniHub-Task-ID': taskID,
        },
        body: form,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new NativeMediaError('native media transport failed before a terminal result', { code: 'native_media_unresolved', upstream: error });
    }
    return response;
  }

  async function readError(response) {
    let detail = '';
    try {
      detail = (await readBoundedResponse(response, 512, true)).toString('utf8');
    } catch { /* body already consumed or empty */ }
    return new NativeMediaError('gateway refused native media call (HTTP ' + response.status + ')', {
      status: response.status,
      code: response.status === 400 ? 'invalid_media_request' : 'gateway_media_refused',
      upstream: detail,
    });
  }

  async function resolveGrant(operation, model, taskID, idempotencyKey) {
    if (!allowed(operation, model)) {
      throw new NativeMediaError('model ' + model + ' is not admitted for ' + operation, { code: 'native_media_model_not_admitted', status: 400, local: true });
    }
    if (textNotAllowed(taskID) || textNotAllowed(idempotencyKey)) {
      throw new NativeMediaError('native media requires task and idempotency identity', { code: 'native_media_identity_missing', status: 400, local: true });
    }
    return grantFor(model, taskID);
  }

  return {
    async dispatchSpeech({ model, text, voice, instructions, languageType, grant, taskID, idempotencyKey }) {
      if (textNotAllowed(text) || textNotAllowed(voice)) {
        throw new NativeMediaError('speech requires text and voice', { code: 'invalid_media_request', status: 400, local: true });
      }
      if (Buffer.byteLength(text, 'utf8') > MAX_JSON_BODY_BYTES) {
        throw new NativeMediaError('speech text exceeds body limit', { code: 'native_media_too_large', status: 400, local: true });
      }
      const resolved = grant ?? (await resolveGrant('speech', model, taskID, idempotencyKey));
      const body = { model, input: { text, voice, ...(instructions ? { instructions } : {}), ...(languageType ? { language_type: languageType } : {}) } };
      const response = await send(AUDIO_OPERATIONS.speech.path, body, resolved, taskID, idempotencyKey, 'audio/mpeg, audio/wav');
      if (!response.ok) throw await readError(response);
      const contentType = response.headers.get('content-type') ?? 'audio/mpeg';
      if (!new RegExp('^audio/(mpeg|mp3|wav)(;|$)').test(contentType)) {
        await response.body?.cancel().catch(() => {});
        throw new NativeMediaError('gateway returned a non-audio speech response', { code: 'native_media_invalid_response' });
      }
      const buffer = await readBoundedResponse(response, MAX_AUDIO_BYTES);
      if (buffer.length === 0) {
        throw new NativeMediaError('speech audio missing or exceeds bound', { code: 'native_media_invalid_response' });
      }
      return { buffer, contentType };
    },

    async dispatchTranscription({ model, audioDataUri, grant, taskID, idempotencyKey }) {
      if (!z.string().startsWith('data:audio/').includes(';base64,').safeParse(audioDataUri).success) {
        throw new NativeMediaError('transcription requires a base64 audio data URI', { code: 'invalid_media_request', status: 400, local: true });
      }
      if (audioDataUri.length > MAX_JSON_BODY_BYTES) {
        throw new NativeMediaError('transcription audio exceeds body limit', { code: 'native_media_too_large', status: 400, local: true });
      }
      const resolved = grant ?? (await resolveGrant('transcription', model, taskID, idempotencyKey));
      const body = { model, messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: audioDataUri } }] }] };
      const response = await send(AUDIO_OPERATIONS.transcription.path, body, resolved, taskID, idempotencyKey);
      if (!response.ok) throw await readError(response);
      const parsed = await readJSONResponse(response, MAX_TRANSCRIPTION_RESPONSE_BYTES, 'transcription response is not JSON');
      const choice = parsed?.choices?.[0]?.message?.content;
      const seconds = parsed?.usage?.seconds;
      if (!z.string().safeParse(choice).success || !z.number().finite().nonnegative().safeParse(seconds).success) {
        throw new NativeMediaError('transcription response missing transcript or seconds', { code: 'native_media_invalid_response' });
      }
      return { transcript: choice, seconds };
    },

    async dispatchImageGeneration({ model, prompt, n = 1, size, grant, taskID, idempotencyKey }) {
      if (textNotAllowed(prompt)) {
        throw new NativeMediaError('image generation requires a prompt', { code: 'invalid_media_request', status: 400, local: true });
      }
      if (!Number.isInteger(n) || n < 1 || n > 4) {
        throw new NativeMediaError('image count out of bounds', { code: 'invalid_media_request', status: 400, local: true });
      }
      const resolved = grant ?? (await resolveGrant('image_generation', model, taskID, idempotencyKey));
      const body = { model, prompt, n, ...(size ? { size } : {}), response_format: 'url' };
      const response = await send(IMAGE_PATH, body, resolved, taskID, idempotencyKey);
      if (!response.ok) throw await readError(response);
      const parsed = await readJSONResponse(response, MAX_IMAGE_RESPONSE_BYTES, 'image response is not JSON');
      const images = [];
      const urls = [];
      for (const item of parsed?.data ?? []) {
        if (z.string().safeParse(item?.b64_json).success) images.push(decodeInlineImage(item.b64_json));
        else if (z.string().startsWith('https://').safeParse(item?.url).success) urls.push(item.url);
      }
      if (images.length < 1 && urls.length < 1) {
        throw new NativeMediaError('image response returned no usable output', { code: 'native_media_invalid_response' });
      }
      return { urls, images };
    },

    async dispatchImageEdit({ model, prompt, images, mask, n = 1, size, grant, taskID, idempotencyKey }) {
      if (textNotAllowed(prompt) || !Array.isArray(images) || images.length !== 1) {
        throw new NativeMediaError('image edit requires exactly one source image', { code: 'invalid_media_request', status: 400, local: true });
      }
      if (!Number.isInteger(n) || n < 1 || n > 4) throw new NativeMediaError('image count out of bounds', { code: 'invalid_media_request', status: 400, local: true });
      images = images.map((value, index) => validateImageDataUri(value, `image[${index}]`));
      if (!mask || size !== undefined || n !== 1) throw new NativeMediaError('image edit requires one mask and no size', { code: 'invalid_media_request', status: 400, local: true });
      mask = validateImageDataUri(mask, 'mask');
      const resolved = grant ?? (await resolveGrant('image_edit', model, taskID, idempotencyKey));
      const form = new FormData();
      form.set('model', model);
      form.set('prompt', prompt);
      form.set('n', String(n));
      if (size) form.set('size', size);
      const source = imagePart(images[0], 'image');
      form.set('image', new Blob([source.bytes], { type: source.mimeType }), 'source.' + source.mimeType.slice(6));
      if (mask) {
        const maskPart = imagePart(mask, 'mask');
        form.set('mask', new Blob([maskPart.bytes], { type: maskPart.mimeType }), 'mask.' + maskPart.mimeType.slice(6));
      }
      const response = await sendMultipart(IMAGE_EDIT_PATH, form, resolved, taskID, idempotencyKey);
      if (!response.ok) throw await readError(response);
      const parsed = await readJSONResponse(response, MAX_METADATA_RESPONSE_BYTES, 'image edit response is not JSON');
      if (response.status !== 202 || parsed?.id !== idempotencyKey || parsed?.status !== 'pending') throw new NativeMediaError('image edit submission response is invalid', { code: 'native_media_invalid_response' });
      return { callID: idempotencyKey, status: 'pending' };
    },

    async dispatchVideoSubmit({ model, prompt, seconds, size, grant, taskID, idempotencyKey }) {
      if (textNotAllowed(prompt)) {
        throw new NativeMediaError('video generation requires a prompt', { code: 'invalid_media_request', status: 400, local: true });
      }
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 10) {
        throw new NativeMediaError('video seconds out of certified bounds', { code: 'invalid_media_request', status: 400, local: true });
      }
      if (size !== '1280*720' && size !== '1920*1080') {
        throw new NativeMediaError('video requires a certified resolution', { code: 'invalid_media_request', status: 400, local: true });
      }
      const resolved = grant ?? (await resolveGrant('video', model, taskID, idempotencyKey));
      const body = { model, prompt, seconds, size };
      const response = await send(VIDEO_PATH, body, resolved, taskID, idempotencyKey);
      if (!response.ok) throw await readError(response);
      const parsed = await readJSONResponse(response, MAX_METADATA_RESPONSE_BYTES, 'video submit response is not JSON');
      const taskOut = parsed?.task_id ?? parsed?.output?.task_id ?? parsed?.id;
      if (!z.string().trim().min(1).safeParse(taskOut).success) {
        throw new NativeMediaError('video submit response missing task id', { code: 'native_media_invalid_response' });
      }
      return { taskId: taskOut, raw: parsed };
    },
  };
}
