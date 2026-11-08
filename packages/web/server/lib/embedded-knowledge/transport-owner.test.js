import { expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createModelBootstrapStore } from '../model-configuration/bootstrap-store.js';
import { createAccountKeyStore } from '../model-configuration/account-key-store.js';
import { readTransportOwner, stageTransportBinding } from './transport-owner.js';
const sha = (v) => createHash('sha256').update(v).digest('hex');

test('offline ownership reads durable secret without expired discovery cleanup; stages untested binding through owner', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'transport-owner-'));
  try {
    const ownership = { issuer: 'https://owner.example', serviceId: 'service', actorId: 'actor', accountId: 'account' };
    const key = 'test-transport-key-1234'; const secret = await createModelBootstrapStore({ dataDir: dir }).putSecret(key);
    const storageId = sha(JSON.stringify(ownership)); const now = new Date().toISOString();
    await createAccountKeyStore({ dataDir: dir }).write(storageId, { version: 1, operationId: '11111111-1111-4111-8111-111111111111', ...ownership, instanceId: 'instance', status: 'failed', stage: 'test', errorCode: null,
      key: { id: 'key', last4: '1234', createdAt: now, expiresAt: null }, secretRef: secret.ref, keyFingerprint: sha(key), baseUrl: 'https://llmrouter.quukk.com/v1', providerId: 'provider', connectionId: 'connection', modelId: 'chat', models: [{ id: 'chat', name: 'Chat' }], test: null, createdAt: now, updatedAt: now });
    const file = path.join(dir, 'model-configuration.json');
    const original = { version: 1, revision: 3, connections: [{ id: 'connection', name: 'Account', providerId: 'llmrouter', protocol: 'openai-compatible', baseUrl: 'https://llmrouter.quukk.com/v1', credentialSource: { type: 'model-bootstrap', providerId: 'llmrouter', ref: secret.ref } }], bindings: [] };
    await fs.writeFile(file, JSON.stringify(original));
    const options = { dataDir: dir, ownership, env: {}, enterpriseOptions: { env: {}, policyFilePaths: [] } };
    const owner = await readTransportOwner(options);
    expect(owner.binding.apiKey).toBe(key);
    const stage = path.join(dir, 'stage'); await fs.mkdir(stage);
    const staged = JSON.parse((await stageTransportBinding({ ...options, owner, stageDir: stage })).toString());
    expect(staged.bindings).toEqual([{ purpose: 'embedding', connectionId: 'connection', model: 'text-embedding-v4', parameters: { dimensions: 1024 }, verification: { status: 'untested' } }]);
    expect(staged.connections).toEqual(original.connections); expect(staged.revision).toBe(4);
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(original);
    await fs.writeFile(file, JSON.stringify({ ...original, connections: [{ ...original.connections[0], baseUrl: 'https://foreign.example/v1' }] }));
    await expect(readTransportOwner(options)).rejects.toThrow();
    await fs.writeFile(file, JSON.stringify(original));
    const receipt = await createAccountKeyStore({ dataDir: dir }).read(storageId);
    await createAccountKeyStore({ dataDir: dir }).write(storageId, { ...receipt, key: { ...receipt.key, expiresAt: '2000-01-01T00:00:00.000Z' } });
    await expect(readTransportOwner(options)).rejects.toThrow();
    expect((await readTransportOwner({ ...options, allowExpired: true })).binding.apiKey).toBe(key);
    await createAccountKeyStore({ dataDir: dir }).write(storageId, { ...receipt, keyFingerprint: 'a'.repeat(64) });
    await expect(readTransportOwner({ ...options, allowExpired: true })).rejects.toThrow();
    await createAccountKeyStore({ dataDir: dir }).write(storageId, receipt);
    await expect(readTransportOwner({ ...options, ownership: { ...ownership, actorId: 'other' } })).rejects.toThrow();
    await createModelBootstrapStore({ dataDir: dir }).deleteSecret(secret.ref);
    await expect(readTransportOwner(options)).rejects.toThrow();
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('enterprise refuses offline provider entry before opening stores', async () => {
  await expect(readTransportOwner({ dataDir: '/missing', ownership: {}, enterpriseOptions: { env: { OPENCHAMBER_ENTERPRISE_MODE: '1' }, policyFilePaths: [] } })).rejects.toThrow('enterprise_mode');
});
