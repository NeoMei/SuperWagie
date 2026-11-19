import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createPlatformModelRuntime } from './runtime.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it('recovers the original speech output after response loss without another paid dispatch', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sw-product-speech-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const audio = Buffer.from('audio-fixture');
  const digest = crypto.createHash('sha256').update(audio).digest('hex');
  const identity = { type: 'client', token: 'speech-owner' };
  const model = 'qwen3-tts-flash';
  const calls = [];
  let admission = true;
  const account = {
    actor: () => ({ actingUserId: 'alice', billingAccountId: 'personal', authSession: 'login-fixture' }),
    usesProductCreditWallet: async () => { if (!admission) throw new Error('temporary capability outage'); return true; },
    request: async () => { throw new Error('legacy authority is unavailable for this model'); },
    proxyProductModel: async (_identity, request) => {
      calls.push(request);
      expect(request.callId).toBe('speech_a');
      if (request.operation === 'speech') throw new Error('connection lost after provider admission');
      if (request.operation === 'receipt') return Response.json({ call_id: 'pc_speech', idempotency_key: 'speech_a', status: 'SETTLED', asset: 'CREDIT/6', credit_scope: 'product_v1', funding_product_id: 'superwagie' });
      if (request.operation === 'media-result') return new Response(audio, { headers: { 'Content-Type': 'audio/mpeg', 'X-UniHub-Idempotency-Key': 'speech_a', 'X-UniHub-Call-ID': 'pc_speech', 'X-Content-SHA256': digest } });
      throw new Error('Unexpected operation');
    },
  };
  const runtime = await createPlatformModelRuntime({
    dataDir: dir, instanceDir: path.join(dir, 'run'), env: {
      OPENCHAMBER_UNIHUB_GATEWAY_URL: 'https://gateway.test/platform/v1',
      OPENCHAMBER_UNIHUB_MODELS: JSON.stringify([{ id: 'agent', name: 'Agent', context: 8192, maxOutput: 100 }]),
      OPENCHAMBER_UNIHUB_MEDIA_MODELS: JSON.stringify([model]),
    },
    getAccountRuntime: () => account, isProductModelConfigured: () => true, readExecution: async () => null, isManaged: () => true, enterprise: () => false,
  });
  cleanups.push(() => runtime.close());
  const admitted = await runtime.admitMediaTask(identity, { model: { providerID: 'unihub', id: model } });
  const input = { identity, sessionID: admitted.sessionID, callID: 'speech_a', model, operation: 'speech', inputs: { text: 'fixture', voice: 'Cherry' } };
  expect(runtime.isMediaOperationConfigured(model, 'speech')).toBe(true);
  await expect(runtime.mediaDispatch(input)).rejects.toMatchObject({ code: 'native_media_unresolved' });
  admission = false;
  await expect(runtime.mediaDispatch(input)).resolves.toMatchObject({ buffer: audio, contentType: 'audio/mpeg' });
  await expect(runtime.mediaDispatch({ ...input, inputs: { ...input.inputs, text: 'different data' } })).rejects.toMatchObject({ code: 'platform_call_digest_conflict' });
  expect(calls.map(({ operation }) => operation)).toEqual(['speech', 'receipt', 'media-result']);
});
