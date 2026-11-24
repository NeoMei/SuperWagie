import { expect, it } from 'vitest';
import { eligibleChatBackups, readProductManagedModels } from './product-managed-models.js';

it('reads only the bounded public SuperWagie product policy without any payer data', async () => {
  const policy = { product_id: 'superwagie', version: 7, managed_models: { chat: ['deepseek-flash', 'backup'], vision: [] } };
  const result = await readProductManagedModels({
    api: 'https://unihub.example',
    fetchImpl: async (url, init) => {
      expect(url.href).toBe('https://unihub.example/v1/products/superwagie/managed-models');
      expect(init.headers).toEqual({ Accept: 'application/json' });
      expect(init.redirect).toBe('error');
      return Response.json(policy);
    },
  });
  expect(result).toEqual(policy);
});

it('keeps an old UniHub response distinct from service failure or bad policy', async () => {
  const read = (response) => readProductManagedModels({ api: 'https://unihub.example', fetchImpl: async () => response });
  await expect(read(new Response(null, { status: 404 }))).resolves.toBeNull();
  await expect(read(new Response(null, { status: 503 }))).rejects.toThrow('platform_managed_model_policy_unavailable');
  await expect(read(Response.json({ product_id: 'other', version: 6, managed_models: { chat: ['other'] } }))).rejects.toThrow();
  await expect(read(Response.json({ product_id: 'superwagie', version: 6, managed_models: { chat: ['bad', 'bad'] } }))).rejects.toThrow();
});

it('retains product order while excluding incompatible or unpriced streaming backups', () => {
  const catalogEntry = (id, { context = 8192, maxOutput = 2048, asset = 'CREDIT/6', input = ['text'], available = true } = {}) => ({
    id, context, max_output: maxOutput, input_modalities: input,
    capability_metadata: { operations: [{
      id: 'chat.completions.create', executable: true, available, transports: ['sse'], public_tariff: { asset },
    }] },
  });
  const request = { model: 'primary', messages: [{ role: 'user', content: 'hello' }], max_tokens: 1000 };
  const catalog = { models: [
    catalogEntry('last'), catalogEntry('bad-funding', { asset: 'CNY/6' }), catalogEntry('short', { context: 1000 }),
    catalogEntry('disabled', { available: false }), catalogEntry('small-output', { maxOutput: 300 }), catalogEntry('first'),
    catalogEntry('outside-policy'), catalogEntry('image', { input: ['image'] }),
  ] };
  const ids = ['bad-funding', 'missing', 'short', 'disabled', 'small-output', 'first', 'last', 'image'];
  expect(eligibleChatBackups(ids, catalog, request, 'chat')).toEqual(['first', 'last']);
  expect(eligibleChatBackups(ids, catalog, request, 'vision')).toEqual(['image']);
});
