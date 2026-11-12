import { z } from 'zod';
import { buildProbeRequest, createJevClient, isProbeAnswer } from '../routing/jev.js';
import { generateConfiguredSpeech, isBailianSpeechBinding } from './speech.js';
import { MODEL_PROBE_PROTOCOLS } from './catalog.js';

class ModelProbeError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = (code) => { throw new ModelProbeError(code); };
const append = (baseUrl, suffix) => `${baseUrl.replace(/\/+$/, '')}/${suffix}`;
/** A provider-family connection shares a key while each purpose owns its API path. */
const modelEndpoint = (binding, operation) => {
  if (binding.protocol === 'aliyun') {
    const baseUrl = binding.baseUrl.replace(/\/(?:compatible-mode\/v1|api\/v1)(?:\/.*)?$/, '');
    const paths = {
      embedding: 'compatible-mode/v1/embeddings', vision: 'compatible-mode/v1/chat/completions',
      rerank: 'api/v1/services/rerank/text-rerank/text-rerank',
      'image-generation': 'compatible-mode/v1/images/generations',
    };
    if (!paths[operation]) return fail('model_configuration_unsupported_protocol');
    return append(baseUrl, paths[operation]);
  }
  const paths = {
    embedding: 'embeddings', vision: 'chat/completions', rerank: 'rerank', tts: 'audio/speech',
    'image-generation': 'images/generations', 'stt-file': 'audio/transcriptions', 'stt-short': 'audio/transcriptions', 'stt-realtime': 'audio/transcriptions',
  };
  if (!paths[operation]) return fail('model_configuration_unsupported_protocol');
  return append(binding.baseUrl, paths[operation]);
};
const vectorResponse = z.object({ data: z.array(z.object({ embedding: z.array(z.number().finite()).min(1) })).min(1) });
const chatResponse = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string().trim().min(1) }) })).min(1) });
const rankingResult = z.object({ index: z.literal(0), relevance_score: z.number().finite() });
const rankingResponse = z.object({ results: z.array(rankingResult).length(1) });
const aliyunRankingResponse = z.object({ output: rankingResponse });
const transcriptionResponse = z.object({ text: z.string() });
const imageResponse = z.object({
  data: z.array(z.object({
    url: z.string().url().or(z.literal('')).optional(),
    b64_json: z.string().trim().optional(),
  }).refine((value) => value.url || value.b64_json)).min(1),
});
const parse = (schema, value) => {
  const result = schema.safeParse(value);
  if (!result.success) return fail('model_configuration_invalid_provider_response');
  return result.data;
};
const sampleImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAZElEQVR4nO3PAQ2AMAADwUlBGtLnZGgghPyW3KcCemMd3qgPfA2gDqAOoA6gDqAOoA6g7jXguuevAwAAAAAAAAAAAAAAAAAAAAAAAAAAAADYD7BbAHUAdQB1AHUAdQB1AHXHAx4qbV5oZOqstQAAAABJRU5ErkJggg==';

// A 200 x 80 grayscale PNG with the word TEST, generated locally from a bitmap.
const ocrSample = 'iVBORw0KGgoAAAANSUhEUgAAAMgAAABQCAAAAAB5BmVsAAAAtElEQVR4nO3PQQ7CMBAEQf//03COhJIdixWLVX2N7Umt1yGtX//AtwKZFsi0QKYFMi2QaYFM62zIei4+Wbiw+yYICAjIKZCP2/G33ZN790CyGRCQ8CmQciDZUyDlQLKnQMqBZE+tm+oXQEBAQED2IM+PtC+AZDP9CyDZTP8CSDbTvwCSzfQvgGQz/Qsg2Uz/Asjl212Fk7vrICAgIEdD/iOQaYFMC2RaINMCmRbItECmdQzkDZDoyAWTgCxHAAAAAElFTkSuQmCC';
const taskIdentifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const ocrTask = z.object({ id: taskIdentifier, job_id: taskIdentifier, state: z.enum(['pending', 'running', 'done', 'failed']) });
const ocrProgress = ocrTask.extend({ progress: z.object({ totalPages: z.number().int().nonnegative(), extractedPages: z.number().int().nonnegative() }) });

const ocrDocument = z.object({ id: taskIdentifier, pages: z.array(z.object({ text: z.string().trim().min(1) })).length(1) });

// LLMRouter's strict ASR validator accepts only model, response_format and a
// PCM WAV file. A tiny 1 kHz sine is a valid positive-duration WAV, and the
// probe checks only that the endpoint returns a transcript-shaped response.
const sttProbeWav = () => {
  const sampleRate = 16000;
  const samples = sampleRate / 10;
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) pcm.writeInt16LE(Math.round(Math.sin((i / sampleRate) * 1000 * 2 * Math.PI) * 2000), i * 2);
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  return wav;
};

const testTranscription = async (binding, { fetchImpl, idempotencyKey, assertCurrent }) => {
  const headers = {};
  if (binding.apiKey) headers.Authorization = `Bearer ${binding.apiKey}`;
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const form = new FormData();
  form.set('model', binding.model);
  form.set('file', new Blob([sttProbeWav()], { type: 'audio/wav' }), 'connection-test.wav');
  form.set('response_format', 'json');
  await assertCurrent();
  let response;
  try {
    response = await fetchImpl(modelEndpoint(binding, binding.purpose), {
      method: 'POST', headers, body: form, redirect: 'error', signal: AbortSignal.timeout(30000),
    });
  } catch { return fail('model_configuration_provider_unreachable'); }
  await assertCurrent();
  if (!response.ok) return fail(`model_configuration_provider_http_${response.status}`);
  let json;
  try { json = await response.json(); } catch { return fail('model_configuration_invalid_provider_response'); }
  await assertCurrent();
  parse(transcriptionResponse, json);
};

const testOcr = async (binding, { fetchImpl, idempotencyKey, assertCurrent }) => {
  const headers = { Authorization: `Bearer ${binding.apiKey}`, 'X-Should-Retry': 'false' };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const signal = AbortSignal.timeout(120000);
  const request = async (url, init) => {
    await assertCurrent();
    if (signal.aborted) return fail('model_configuration_provider_unreachable');
    let response;
    try { response = await fetchImpl(url, { ...init, headers, redirect: 'error', signal }); }
    catch { return fail('model_configuration_provider_unreachable'); }
    await assertCurrent();
    if (signal.aborted) return fail('model_configuration_provider_unreachable');
    if (!response.ok) return fail(`model_configuration_provider_http_${response.status}`);
    let json;
    try { json = await response.json(); } catch { return fail('model_configuration_invalid_provider_response'); }
    await assertCurrent();
    return json;
  };
  const body = new FormData();
  body.set('model', binding.model);
  body.set('file', new Blob([Buffer.from(ocrSample, 'base64')], { type: 'image/png' }), 'connection-test.png');
  const created = parse(ocrTask, await request(append(binding.baseUrl, 'ocr'), { method: 'POST', body }));
  if (created.state === 'failed') return fail('model_configuration_provider_rejected');
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = parse(ocrProgress, await request(append(binding.baseUrl, `ocr/${encodeURIComponent(created.id)}`), { method: 'GET' }));
    if (result.id !== created.id || result.job_id !== created.job_id || result.progress.extractedPages > result.progress.totalPages) return fail('model_configuration_invalid_provider_response');
    if (result.state === 'failed') return fail('model_configuration_provider_rejected');
    if (result.state === 'done') {
      if (result.progress.totalPages !== 1 || result.progress.extractedPages !== 1) return fail('model_configuration_invalid_provider_response');
      const document = parse(ocrDocument, await request(append(binding.baseUrl, `ocr/${encodeURIComponent(created.id)}/document`), { method: 'GET' }));
      if (document.id !== created.id) return fail('model_configuration_invalid_provider_response');
      return;
    }
    if (attempt < 59) await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return fail('model_configuration_provider_unreachable');
};

/** Small server-side protocol probes; they do not certify every downstream skill. */
export const testModelBinding = async (binding, { fetchImpl = fetch, idempotencyKey, assertCurrent = () => {} } = {}) => {
  const { purpose, protocol, model, parameters, apiKey } = binding;
  await assertCurrent();
  if (purpose === 'ocr' && protocol === 'openai-compatible') return testOcr(binding, { fetchImpl, idempotencyKey, assertCurrent });
  if (['stt-short', 'stt-realtime'].includes(purpose) && protocol === 'openai-compatible') return testTranscription(binding, { fetchImpl, idempotencyKey, assertCurrent });
  if (purpose === 'tts' && (protocol === 'minimax' || isBailianSpeechBinding(binding))) {
    await generateConfiguredSpeech(binding, { text: 'Model configuration test.' }, { fetchImpl, idempotencyKey });
    return;
  }
  if (purpose === 'routing' && protocol === 'jev') {
    try {
      const client = createJevClient({ fetchImpl: (url, init) => fetchImpl(url, { ...init, redirect: 'error' }) });
      const headers = {};
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
      const { answers } = await client.ask(buildProbeRequest(), { url: binding.baseUrl, model, headers });
      if (!isProbeAnswer(answers.probe)) return fail('model_configuration_invalid_provider_response');
      return;
    } catch (error) {
      if (error instanceof ModelProbeError) throw error;
      if (error.status) return fail(`model_configuration_provider_http_${error.status}`);
      return fail('model_configuration_provider_unreachable');
    }
  }
  if (!MODEL_PROBE_PROTOCOLS[purpose]?.includes(protocol)) return fail('model_configuration_unsupported_protocol');
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  let body;
  if (purpose === 'embedding') {
    body = { model, input: ['SuperWagie model configuration test'] };
    if (parameters.dimensions) body.dimensions = parameters.dimensions;
  }
  if (purpose === 'vision') body = { model, messages: [{ role: 'user', content: [{ type: 'text', text: 'Describe this image in a few words.' }, { type: 'image_url', image_url: { url: sampleImage } }] }], max_tokens: 64 };
  if (purpose === 'rerank') body = protocol === 'aliyun'
    ? { model, input: { query: 'model configuration', documents: ['Model configuration API.'] }, parameters: { top_n: 1, return_documents: false } }
    : { model, query: 'model configuration', documents: ['Model configuration API.'], top_n: 1 };
  if (purpose === 'tts') body = { model, input: 'Model configuration test.', voice: parameters.voice ?? 'alloy', response_format: 'wav' };
  if (purpose === 'image-generation') {
    body = { model, prompt: 'A small blue circle on a plain white background.', size: '1024x1024', n: 1 };
    if (protocol === 'volcengine') body.watermark = false;
  }
  let response;
  try {
    response = await fetchImpl(modelEndpoint(binding, purpose), { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(purpose === 'image-generation' ? 600000 : 30000) });
  } catch { return fail('model_configuration_provider_unreachable'); }
  await assertCurrent();
  if (!response.ok) return fail(`model_configuration_provider_http_${response.status}`);
  if (purpose === 'tts') {
    const bytes = new Uint8Array(await response.arrayBuffer());
    const magic = new TextDecoder('ascii').decode(bytes.slice(0, 4));
    if (bytes.length < 44 || !['RIFF', 'OggS', 'ID3\u0004', 'ID3\u0003'].includes(magic) && !(bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return fail('model_configuration_invalid_provider_response');
    return;
  }
  let json;
  try { json = await response.json(); } catch { return fail('model_configuration_invalid_provider_response'); }
  if (purpose === 'embedding') {
    const result = parse(vectorResponse, json);
    if (parameters.dimensions && result.data[0].embedding.length !== parameters.dimensions) return fail('model_configuration_dimension_mismatch');
  }
  if (purpose === 'vision') parse(chatResponse, json);
  if (purpose === 'rerank') parse(protocol === 'aliyun' ? aliyunRankingResponse : rankingResponse, json);
  if (purpose === 'image-generation') parse(imageResponse, json);
};
