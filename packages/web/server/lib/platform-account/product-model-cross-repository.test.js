import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { expect, it } from 'vitest';
import { createModelBootstrapStore } from '../model-configuration/bootstrap-store.js';
import { createProductModelProxy } from './product-model-proxy.js';

const { PRODUCT_CREDIT_INTEGRATION_GATEWAY: gateway, PRODUCT_CREDIT_INTEGRATION_ORIGIN: uniHub,
  PRODUCT_CREDIT_INTEGRATION_ACCOUNT: account, PRODUCT_CREDIT_INTEGRATION_ACTOR_TOKEN: actorToken,
  PRODUCT_CREDIT_INTEGRATION_PRODUCT_TOKEN: serviceCredential } = process.env;

it.skipIf(!gateway)('streams and recovers a paid product call through the real UniHub and LLMRouter', async () => {
  const origins = new Map([
    ['https://hub.fixture.test', new URL(uniHub)],
    ['https://gateway.fixture.test', new URL(gateway)],
  ]);
  for (const url of origins.values()) {
    expect(url.protocol).toBe('http:');
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.pathname).toBe('/');
  }
  const vaultPath = await mkdtemp(join(tmpdir(), 'sw-credit-integration-'));
  try {
    const model = 'product-alias';
    const callId = `product-proxy-${randomUUID()}`;
    const app = createProductModelProxy({
      api: 'https://hub.fixture.test',
      gateway: 'https://gateway.fixture.test/platform/v1',
      allowedModels: [model],
      serviceCredential,
      vault: createModelBootstrapStore({ dataDir: vaultPath }),
      fetchImpl: (value, init) => {
        const url = new URL(value);
        const target = origins.get(url.origin);
        if (!target) throw new Error('Unexpected product proxy destination');
        return fetch(new URL(url.pathname + url.search, target), init);
      },
    });
    const headers = {
      Authorization: `Bearer ${actorToken}`,
      'X-UniHub-Billing-Account': account,
      'X-UniHub-Model': model,
      'Idempotency-Key': callId,
    };
    const chat = () => request(app).post('/v1/product-model/chat').set(headers)
      .send({ model, stream: true, messages: [{ role: 'user', content: 'fixture prompt' }] });
    const first = await chat().expect(200);
    expect(first.text).toContain('fixture product answer');
    expect(first.text).toContain('data: [DONE]');
    await chat().expect(409);
    const receipt = await request(app).get(`/v1/product-model/calls/${callId}`).set(headers).expect(200);
    expect(receipt.body).toMatchObject({
      idempotency_key: callId,
      status: 'SETTLED',
      credit_scope: 'product_v1',
      funding_product_id: 'superwagie',
      asset: 'CREDIT/6',
      charged: '10500',
    });
    expect(JSON.stringify(receipt.body)).not.toContain('uh_key_');
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
});
