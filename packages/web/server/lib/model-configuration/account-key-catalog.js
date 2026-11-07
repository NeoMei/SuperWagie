import { z } from 'zod';
import { isEnterpriseMode } from '../enterprise-mode.js';
import { llmRouterInferenceApiUrl } from './bootstrap-endpoints.js';

const fail = (code, status = 502) => { throw Object.assign(new Error(code), { code, status }); };
const name = z.string().trim().min(1).max(512);
const operationSchema = z.object({
  id: name, protocol: name, endpoint: z.string().optional(), method: z.string().optional(),
  transports: z.array(name), available: z.boolean(), executable: z.boolean(),
  disabled_reason: name.optional(),
});
const modelSchema = z.object({
  id: name, name: name.optional(), operations: z.array(name).optional(),
  dimensions: z.number().int().min(1).max(65536).nullable().optional(), input_modalities: z.array(name).nullable().optional(),
  capability_metadata: z.object({
    id: name, name,
    capabilities: z.object({
      input_modalities: z.array(name).optional(),
      embedding_space: z.object({ dimensions: z.number().int().min(1).max(65536) }).optional(),
    }),
    operations: z.array(operationSchema),
  }).optional(),
}).refine((model) => !model.capability_metadata || model.id === model.capability_metadata.id);
const catalogSchema = z.object({ object: z.literal('list'), data: z.array(modelSchema).max(10000) })
  .refine(({ data }) => new Set(data.map((model) => model.id)).size === data.length);

// These are exact gateway contracts supported by the purpose adapters. A
// billing operation or a model name alone cannot authorize another protocol.
const supportedOperations = new Map([
  ['chat.completions.create', { name: 'chat', protocol: 'openai', endpoint: '/v1/chat/completions', transport: 'json' }],
  ['responses.create', { name: 'responses', protocol: 'openai', endpoint: '/v1/responses', transport: 'json' }],
  ['claude.messages.create', { name: 'claude', protocol: 'claude', endpoint: '/v1/messages', transport: 'json' }],
  ['gemini.generate', { name: 'gemini', protocol: 'gemini', endpoint: '/v1beta/models/{model}:generateContent', transport: 'json' }],
  ['embeddings.create', { name: 'embedding', protocol: 'openai', endpoint: '/v1/embeddings', transport: 'json' }],
  ['rerank.create', { name: 'rerank', protocol: 'openai', endpoint: '/v1/rerank', transport: 'json' }],
  ['images.generations.create', { name: 'image', protocol: 'openai', endpoint: '/v1/images/generations', transport: 'json' }],
  ['audio.speech.create', { name: 'speech', protocol: 'openai', endpoint: '/v1/audio/speech', transport: 'binary' }],
  ['bailian.audio.speech.create', { name: 'speech', protocol: 'bailian', endpoint: '/v1/native/bailian/audio/speech', transport: 'binary' }],
  ['audio.transcriptions.create', { name: 'transcription', protocol: 'openai', endpoint: '/v1/audio/transcriptions', transport: 'json' }],
  ['ocr.jobs.create', { name: 'ocr', protocol: 'paddleocr_jobs', endpoint: '/v1/ocr', transport: 'async_job' }],
]);

export const parseAccountKeyCatalog = (payload) => {
  const parsed = catalogSchema.safeParse(payload);
  if (!parsed.success) return fail('model_configuration_account_catalog_invalid');
  return parsed.data.data.map((model) => {
    const metadata = model.capability_metadata;
    const operations = new Set();
    let speechOperation;
    for (const operation of metadata?.operations ?? []) {
      const supported = supportedOperations.get(operation.id);
      if (supported && operation.available && (operation.executable || operation.disabled_reason === 'operation_authorization_unknown') && operation.protocol === supported.protocol
        && operation.endpoint === supported.endpoint.replace('{model}', model.id) && operation.method === 'POST' && operation.transports.includes(supported.transport)) {
        operations.add(supported.name);
        if (operation.id === 'bailian.audio.speech.create') speechOperation = operation.id;
      }
    }
    const result = { id: model.id, name: metadata?.name ?? model.name ?? model.id, capabilitiesKnown: Boolean(metadata), operations: metadata ? [...operations] : model.operations ?? [] };
    if (speechOperation) result.speechOperation = speechOperation;
    if (metadata?.capabilities.input_modalities) result.input_modalities = metadata.capabilities.input_modalities;
    if (metadata?.capabilities.embedding_space) result.dimensions = metadata.capabilities.embedding_space.dimensions;
    if (!metadata && model.input_modalities) result.input_modalities = model.input_modalities;
    if (!metadata && model.dimensions) result.dimensions = model.dimensions;
    return result;
  });
};

/** Read the current key's technical capabilities, with no inference call. */
export const readAccountKeyCatalog = async ({ apiKey, baseUrl, instanceId, assertCurrent, fetchImpl = fetch, env = process.env, enterpriseOptions } = {}) => {
  if (!(assertCurrent instanceof Function) || !name.safeParse(apiKey).success || !name.safeParse(instanceId).success) return fail('model_configuration_invalid_input', 400);
  if (baseUrl !== llmRouterInferenceApiUrl(env)) return fail('model_configuration_bootstrap_endpoint_invalid', 503);
  const check = async () => {
    if (isEnterpriseMode(enterpriseOptions)) return fail('enterprise_mode', 403);
    await assertCurrent();
  };
  await check();
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/models`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', 'X-UniHub-Product': 'superwagie', 'X-UniHub-Instance': instanceId },
    });
  } catch { return fail('model_configuration_account_catalog_unavailable', 503); }
  await check();
  if (!response.ok) return fail(`model_configuration_provider_http_${response.status}`);
  let payload;
  try { payload = await response.json(); }
  catch { return fail('model_configuration_account_catalog_invalid'); }
  await check();
  return parseAccountKeyCatalog(payload);
};
