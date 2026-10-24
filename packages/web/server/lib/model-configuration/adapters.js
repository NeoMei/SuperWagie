import { z } from 'zod';
import { buildProbeRequest, createJevClient, isProbeAnswer } from '../routing/jev.js';
import { generateConfiguredSpeech } from './speech.js';
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
    'image-generation': 'images/generations', 'stt-file': 'audio/transcriptions', 'stt-short': 'audio/transcriptions',
  };
  if (!paths[operation]) return fail('model_configuration_unsupported_protocol');
  return append(binding.baseUrl, paths[operation]);
};
const vectorResponse = z.object({ data: z.array(z.object({ embedding: z.array(z.number().finite()).min(1) })).min(1) });
const chatResponse = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string().trim().min(1) }) })).min(1) });
const rankingResult = z.object({ index: z.number().int().min(0).max(1), relevance_score: z.number().finite() });
const rankingResponse = z.object({ results: z.array(rankingResult).min(1) });
const aliyunRankingResponse = z.object({ output: rankingResponse });
const imageResponse = z.object({ data: z.array(z.object({ url: z.string().url().optional(), b64_json: z.string().min(1).optional() }).refine((value) => value.url || value.b64_json)).min(1) });
const parse = (schema, value) => {
  const result = schema.safeParse(value);
  if (!result.success) return fail('model_configuration_invalid_provider_response');
  return result.data;
};
const sampleImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAZElEQVR4nO3PAQ2AMAADwUlBGtLnZGgghPyW3KcCemMd3qgPfA2gDqAOoA6gDqAOoA6g7jXguuevAwAAAAAAAAAAAAAAAAAAAAAAAAAAAADYD7BbAHUAdQB1AHUAdQB1AHXHAx4qbV5oZOqstQAAAABJRU5ErkJggg==';

/** Small server-side protocol probes; they do not certify every downstream skill. */
export const testModelBinding = async (binding, { fetchImpl = fetch } = {}) => {
  const { purpose, protocol, model, parameters, apiKey } = binding;
  if (purpose === 'tts' && protocol === 'minimax') {
    await generateConfiguredSpeech(binding, { text: 'Model configuration test.' }, { fetchImpl });
    return;
  }
  if (purpose === 'routing' && protocol === 'jev') {
    try {
      const client = createJevClient({ fetchImpl: (url, init) => fetchImpl(url, { ...init, redirect: 'error' }) });
      const { answers } = await client.ask(buildProbeRequest(), { url: binding.baseUrl, model, headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} });
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
  let body;
  if (purpose === 'embedding') {
    body = { model, input: ['SuperWagie model configuration test'] };
    if (parameters.dimensions) body.dimensions = parameters.dimensions;
  }
  if (purpose === 'vision') body = { model, messages: [{ role: 'user', content: [{ type: 'text', text: 'Describe this image in a few words.' }, { type: 'image_url', image_url: { url: sampleImage } }] }], max_tokens: 64 };
  if (purpose === 'rerank') body = protocol === 'aliyun'
    ? { model, input: { query: 'model configuration', documents: ['Model configuration API.', 'A weather forecast.'] }, parameters: { top_n: 2, return_documents: false } }
    : { model, query: 'model configuration', documents: ['Model configuration API.', 'A weather forecast.'], top_n: 2 };
  if (purpose === 'tts') body = { model, input: 'Model configuration test.', voice: parameters.voice ?? 'alloy', response_format: 'wav' };
  if (purpose === 'image-generation') {
    body = { model, prompt: 'A small blue circle on a plain white background.', size: '1024x1024', n: 1 };
    if (protocol === 'volcengine') body.watermark = false;
  }
  let response;
  try {
    response = await fetchImpl(modelEndpoint(binding, purpose), { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(purpose === 'image-generation' ? 600000 : 30000) });
  } catch { return fail('model_configuration_provider_unreachable'); }
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
