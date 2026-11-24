import { z } from 'zod';
import { readBoundedResponse } from './native-media.js';

const modelId = z.string().regex(/^[A-Za-z0-9._:/-]{1,128}$/);
const modelIds = z.array(modelId).max(32).refine((ids) => new Set(ids).size === ids.length);
const operations = z.enum(['chat', 'vision', 'speech', 'transcription', 'image-generation', 'image-edit', 'video', 'knowledge-embedding', 'knowledge-rerank', 'ocr']);
const policy = z.object({
  product_id: z.literal('superwagie'),
  version: z.number().int().nonnegative(),
  managed_models: z.partialRecord(operations, modelIds).nullable(),
});

export async function readProductManagedModels({ api, fetchImpl = fetch, signal = AbortSignal.timeout(4_000) }) {
  const response = await fetchImpl(new URL('/v1/products/superwagie/managed-models', api), {
    headers: { Accept: 'application/json' }, redirect: 'error', signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 404) return null;
    throw new Error('platform_managed_model_policy_unavailable');
  }
  return policy.parse(JSON.parse((await readBoundedResponse(response, 64 * 1024)).toString('utf8')));
}

export function managedChatOperation({ messages }) {
  return messages.some((message) => Array.isArray(message?.content)
    && message.content.some((part) => part?.type === 'image_url')) ? 'vision' : 'chat';
}

const catalogModel = z.object({
  id: modelId,
  context: z.number().int().positive(),
  max_output: z.number().int().positive(),
  input_modalities: z.array(z.string()),
  capability_metadata: z.object({
    operations: z.array(z.object({
      id: z.string(),
      executable: z.boolean(),
      available: z.boolean(),
      transports: z.array(z.string()),
      public_tariff: z.object({ asset: z.string() }).optional(),
    })),
  }),
});

export function eligibleChatBackups(candidates, catalog, request, operation) {
  // Require room for input, serialization overhead and the full requested output.
  const minimumContext = Buffer.byteLength(JSON.stringify(request)) + request.messages.length * 32 + request.max_tokens;
  if (!Array.isArray(catalog?.models)) return [];
  const viable = new Set();
  for (const entry of catalog.models) {
    const parsed = catalogModel.safeParse(entry);
    if (!parsed.success) continue;
    const model = parsed.data;
    if (model.context < minimumContext || model.max_output < request.max_tokens
      || !model.input_modalities.includes(operation === 'vision' ? 'image' : 'text')) continue;
    if (model.capability_metadata.operations.some((item) => item.id === 'chat.completions.create'
      && item.available && item.executable && item.transports.includes('sse') && item.public_tariff?.asset === 'CREDIT/6')) {
      viable.add(model.id);
    }
  }
  return candidates.filter((id) => viable.has(id));
}
