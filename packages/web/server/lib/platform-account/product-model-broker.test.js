import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createModelBootstrapStore } from '../model-configuration/bootstrap-store.js';
import { createProductModelBroker } from './product-model-broker.js';

describe('trusted SuperWagie product model broker', () => {
  it('keeps the same scoped key across broker restarts and supplies a fresh proof', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'product-model-vault-'));
    try {
      let issued = 0; let proofs = 0;
      const api = 'https://accounts.test';
      const create = () => createProductModelBroker({
        api, serviceCredential: 'test-runtime-credential', vault: createModelBootstrapStore({ dataDir: dir }),
        fetchImpl: async (url, init) => {
          expect(url.href).toBe(api + '/internal/v1/product-runtime/model-proofs');
          expect(init.redirect).toBe('error');
          expect(init.headers).toMatchObject({ Authorization: 'Bearer test-runtime-credential', 'X-UniHub-Actor-Authorization': 'Bearer test-actor' });
          expect(JSON.parse(init.body)).toEqual({ token: 'uh_key_fixture' });
          return Response.json({ token: 'fresh-proof-' + ++proofs, expires_at: Math.floor(Date.now() / 1000) + 30 });
        },
      });
      const input = {
        actorId: 'actor-a', accountId: 'account-a', apiOrigin: api, actorToken: 'test-actor', model: 'fixture-model',
        request: async (route, init) => {
          issued += 1;
          expect(route).toBe('/v1/accounts/account-a/api-keys');
          expect(init.headers['X-UniHub-Product-Credit-Wallet']).toBe('product_v1');
          expect(JSON.parse(init.body)).toMatchObject({ credit_scope: 'product_v1', funding_mode: 'credits', model_scope: 'llmrouter_available', models: ['fixture-model'] });
          return { token: 'uh_key_fixture', actor_id: 'actor-a', account_id: 'account-a', origin_product_id: 'superwagie', credit_scope: 'product_v1', funding_mode: 'credits', asset: 'CREDIT/6', model_scope: 'llmrouter_available', models: [] };
        },
      };
      await expect(create().authorize(input)).resolves.toEqual({ token: 'uh_key_fixture', proof: 'fresh-proof-1' });
      await expect(create().authorize({ ...input, recovery: true })).resolves.toEqual({ token: 'uh_key_fixture', proof: 'fresh-proof-2' });
      await expect(create().authorize({ ...input, recovery: true, actorId: 'actor-b' })).rejects.toThrow('platform_model_access_unavailable');
      await expect(create().authorize({ ...input, apiOrigin: 'https://other.test' })).rejects.toThrow('platform_model_access_unavailable');
      expect(issued).toBe(1);
      const stored = await fs.readFile(path.join(dir, 'model-bootstrap/secrets.json'), 'utf8');
      expect(stored).not.toMatch(/uh_key_fixture|test-runtime-credential|fresh-proof-/);
      await fs.writeFile(path.join(dir, 'model-bootstrap/secrets.json'), '{', 'utf8');
      await expect(create().authorize(input)).rejects.toThrow();
      expect(issued).toBe(1);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});
