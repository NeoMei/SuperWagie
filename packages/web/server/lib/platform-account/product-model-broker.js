import { createHash } from 'node:crypto';
import { z } from 'zod';
import { productWalletHeaders } from './product-wallet.js';

const modelName = z.string().regex(/^[A-Za-z0-9._:/-]{1,128}$/);
const accessKey = z.string().regex(/^uh_key_[A-Za-z0-9_-]{1,300}$/);
const issuedKey = z.object({
  token: accessKey, actor_id: z.string(), account_id: z.string(), origin_product_id: z.literal('superwagie'),
  model_scope: z.literal('llmrouter_available'), credit_scope: z.literal('product_v1'), funding_mode: z.literal('credits'), asset: z.literal('CREDIT/6'),
});
const proofSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9._~-]{1,4096}$/), expires_at: z.number().int().positive() });
const unavailable = () => Object.assign(new Error('platform_model_access_unavailable'), { code: 'platform_model_access_unavailable', status: 503 });

/** This broker runs in a trusted server. Callers supply a server-only vault and deployment credential. */
export const createProductModelBroker = ({ api, serviceCredential, vault, instanceId = 'default', fetchImpl = fetch, now = Date.now }) => {
  const url = new URL(api);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !/^[A-Za-z0-9._~-]{1,4096}$/.test(serviceCredential ?? '') || !vault?.getSecret || !vault?.putSecret || !/^[a-z][a-z0-9_-]{0,63}$/.test(instanceId)) throw unavailable();
  const pending = new Map();
  const keyFor = async ({ actorId, accountId, model, apiOrigin, clientId, request, recovery }) => {
    const ref = 'product-model-' + createHash('sha256').update(JSON.stringify([apiOrigin, clientId, actorId, accountId, instanceId])).digest('hex');
    const load = async () => {
      const token = accessKey.safeParse(await vault.getSecret(ref));
      if (token.success) return token.data;
      if (recovery) throw unavailable();
      const created = issuedKey.safeParse(await request(`/v1/accounts/${encodeURIComponent(accountId)}/api-keys`, productWalletHeaders({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'SuperWagie managed model', origin_product_id: 'superwagie', instance_id: instanceId, model_scope: 'llmrouter_available', models: [model], funding_mode: 'credits', credit_scope: 'product_v1' }),
      })));
      if (!created.success || created.data.actor_id !== actorId || created.data.account_id !== accountId) throw unavailable();
      await vault.putSecret(created.data.token, ref);
      return created.data.token;
    };
    if (recovery) return load();
    if (!pending.has(ref)) {
      const operation = load().finally(() => pending.delete(ref));
      pending.set(ref, operation);
    }
    return pending.get(ref);
  };
  return {
    async authorize(input) {
      if (input.apiOrigin !== url.origin || !modelName.safeParse(input.model).success) throw unavailable();
      const token = await keyFor(input);
      const response = await fetchImpl(new URL('/internal/v1/product-runtime/model-proofs', url), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${serviceCredential}`, 'X-UniHub-Actor-Authorization': `Bearer ${input.actorToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (!response.ok) { await response.body?.cancel(); throw unavailable(); }
      const proof = proofSchema.safeParse(await response.json());
      if (!proof.success || proof.data.expires_at * 1000 <= now()) throw unavailable();
      return { token, proof: proof.data.token };
    },
  };
};
