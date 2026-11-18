import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import request from 'supertest';
import { expect, it } from 'vitest';
import { PRODUCT_OCR_MODEL } from '../embedded-knowledge/ocr-contract.js';
import { createProductOcrWorkflow } from '../knowledge-library/product-ocr.js';
import { createModelBootstrapStore } from '../model-configuration/bootstrap-store.js';
import { createProductModelProxy } from './product-model-proxy.js';

const { PRODUCT_CREDIT_INTEGRATION_GATEWAY: gateway, PRODUCT_CREDIT_INTEGRATION_ORIGIN: uniHub,
  PRODUCT_CREDIT_INTEGRATION_ACCOUNT: account, PRODUCT_CREDIT_INTEGRATION_ACTOR_TOKEN: actorToken,
  PRODUCT_CREDIT_INTEGRATION_PRODUCT_TOKEN: serviceCredential, PRODUCT_CREDIT_INTEGRATION_OCR_PDF: fixture } = process.env;

it.skipIf(!fixture)('settles and recovers a confirmed PDF through the actual product broker, UniHub and LLMRouter', async () => {
  const origins = new Map([
    ['https://hub.fixture.test', new URL(uniHub)],
    ['https://gateway.fixture.test', new URL(gateway)],
  ]);
  for (const url of origins.values()) {
    expect(url.protocol).toBe('http:');
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.pathname).toBe('/');
  }
  const vaultPath = await mkdtemp(join(tmpdir(), 'sw-product-ocr-integration-'));
  try {
    const original = 'swocr_' + randomBytes(30).toString('hex');
    const doc = { id: 'fixture-document' };
    const source = await readFile(fixture);
    const sourceHash = createHash('sha256').update(source).digest('hex');
    const app = createProductModelProxy({
      api: 'https://hub.fixture.test', gateway: 'https://gateway.fixture.test/platform/v1', allowedModels: [PRODUCT_OCR_MODEL], serviceCredential,
      vault: createModelBootstrapStore({ dataDir: vaultPath }),
      fetchImpl: (value, init) => {
        const url = new URL(value);
        const target = origins.get(url.origin);
        if (!target) throw new Error('Unexpected product proxy destination');
        return fetch(new URL(url.pathname + url.search, target), init);
      },
    });
    const headers = { Authorization: `Bearer ${actorToken}`, 'X-UniHub-Billing-Account': account, 'X-UniHub-Model': PRODUCT_OCR_MODEL, 'Idempotency-Key': original };
    const reads = { 'ocr-status': `/ocr/${original}`, 'ocr-document': `/ocr/${original}/document`, receipt: `/calls/${original}` };
    const send = async ({ operation, body }) => {
      const path = '/v1/product-model';
      const binary = new Response(body);
      const response = operation === 'ocr-submit'
        ? await request(app).post(path + '/ocr').set(headers).set('Content-Type', binary.headers.get('content-type')).send(Buffer.from(await binary.arrayBuffer()))
        : await request(app).get(path + reads[operation]).set(headers);
      return new Response(response.text, { status: response.status, headers: response.header });
    };
    let exists = false;
    let submits = 0;
    let result;
    const workflow = createProductOcrWorkflow({
      authorize: async () => ({ actor: { actingUserId: 'fixture-actor', authSession: 'fixture-session', billingAccountId: account, expiresAt: Date.now() + 60_000 },
        original, documentId: doc.id, source, sourceHash, exists, accountName: 'Fixture payer', ensureMaySubmit: async () => {}, assertCurrent: async () => {},
        claim: async () => { if (exists) return false; exists = true; return true; },
        send: async (input) => {
          const response = await send(input);
          if (input.operation !== 'ocr-submit') return response;
          submits += 1;
          expect(response.status).toBe(200);
          // Simulate losing the submit response after the provider accepted it.
          await response.body.cancel();
          throw new Error('lost response');
        },
      }),
      applyResult: async (applied) => { result = applied.result; },
    });
    const approval = await workflow.preview(doc, {});
    expect(approval).toMatchObject({ state: 'confirmation', payer: 'Fixture payer' });
    expect(await workflow.confirm(doc, {}, approval.id)).toEqual({ state: 'pending' });
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const recovered = await workflow.resume(doc, {});
      if (recovered.state === 'processing') break;
      expect(recovered.state).toBe('pending');
      await wait(250);
    }
    expect(result.pages).toHaveLength(1);
    expect(submits).toBe(1);
    const receipt = await request(app).get('/v1/product-model' + reads.receipt).set(headers).expect(200);
    expect(receipt.body).toMatchObject({ call_id: result.id, idempotency_key: original,
      status: 'SETTLED', asset: 'CREDIT/6', credit_scope: 'product_v1', funding_product_id: 'superwagie', charged: '100000' });
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
}, 35_000);
