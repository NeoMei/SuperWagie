import { expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createModelBootstrapStore } from '../model-configuration/bootstrap-store.js';
import { createAccountKeyStore } from '../model-configuration/account-key-store.js';
import { planHyTransportRebind } from '../hy-memory/transport-rebind.js';
import { memoryNamespace } from '../hy-memory/organizer.js';
import { createTransportCoordinator } from './transport-coordinator.js';
const sha = (v) => createHash('sha256').update(v).digest('hex');
const fixture = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'transport-coordinate-')); const dataDir = path.join(dir, 'data');
  await fs.mkdir(path.join(dataDir, 'embedded-knowledge'), { recursive: true });
  const database = path.join(dataDir, 'embedded-knowledge', 'embedded-knowledge.db'); await fs.writeFile(database, 'before-db');
  await fs.writeFile(path.join(dataDir, 'embedded-knowledge', 'secrets.json'), JSON.stringify({ systemAesKey: '1'.repeat(32), jwtSecret: 'jwt' }));
  const ownership = { issuer: 'issuer', serviceId: 'service', actorId: 'actor', accountId: 'account' };
  const secret = await createModelBootstrapStore({ dataDir }).putSecret('fixture-key-1234'); const now = new Date().toISOString();
  await createAccountKeyStore({ dataDir }).write(sha(JSON.stringify(ownership)), { version: 1, operationId: '11111111-1111-4111-8111-111111111111', ...ownership, instanceId: 'instance', status: 'failed', stage: 'test', errorCode: null, key: { id: 'key', last4: '1234', createdAt: now, expiresAt: null }, secretRef: secret.ref, keyFingerprint: sha('fixture-key-1234'), baseUrl: 'https://llmrouter.quukk.com/v1', providerId: 'provider', connectionId: 'connection', modelId: 'chat', models: [{ id: 'chat', name: 'Chat' }], test: null, createdAt: now, updatedAt: now });
  const pristine = path.join(dir, 'pristine.db'); await fs.copyFile(database, pristine);
  const configuration = { version: 1, revision: 5, connections: [{ id: 'connection', name: 'Account', providerId: 'llmrouter', protocol: 'openai-compatible', baseUrl: 'https://llmrouter.quukk.com/v1', credentialSource: { type: 'model-bootstrap', providerId: 'llmrouter', ref: secret.ref } }], bindings: [] };
  const config = path.join(dataDir, 'model-configuration.json'); await fs.writeFile(config, JSON.stringify(configuration));
  const entry = { id: 'm', scope: 'global', type: 'fact', title: 'T', body: 'B' }; const sourceHash = sha(JSON.stringify(['m', 'global', 'fact', 'T', 'B']));
  const row = (collection, value) => ({ collection: 'entry', id: `hy:${sha(JSON.stringify(['global', collection, 'm']))}`, valueRaw: JSON.stringify({ projectId: 'global', collection, id: 'm', value }) });
  const snapshot = { model: { parameters: { base_url: 'https://old.example/v1', provider: 'aliyun', embedding_parameters: { dimension: 1024 }, api_key: '' } }, rawLedger: { namespace: 'superwagie:memory', revision: 7, records: [
    { collection: 'meta', id: 'control', valueRaw: JSON.stringify({ version: 1, enabled: true, enabledAt: 1, pending: [], tombstones: [], lastError: null }) }, row('manual', entry), row('manual-index', { version: 1, sourceHash, state: 'ready', spaceId: 'old', configurationId: 'old-config', dimensions: 1024 })] },
    scopedNodes: [{ namespace: `${memoryNamespace('global')}:manual`, spaceId: 'old', id: 'm', content: 'T\n\nB', payloadRaw: JSON.stringify({ entry_id: 'm', project_id: 'global', scope: 'global', manual_type: 'fact', title: 'T', representation: 'manual', source_hash: sourceHash, verification: 'unverified' }), active: true, dimensions: 1024, vectorFloat32LE: Buffer.alloc(4096).toString('base64') }] };
  const current = { configurationId: 'old-config', spaceId: 'old', dimensions: 1024 }; const target = { configurationId: 'new-config', spaceId: 'new', dimensions: 1024 };
  const plan = planHyTransportRebind({ ...snapshot, tenantId: 1, kbId: 'kb', oldIdentity: current, targetIdentity: target });
  const preview = { current, target, ledgerRevision: 7, ledgerDigest: plan.expectedLedgerDigest, sourceNodesDigest: plan.expectedSourceNodesDigest, knowledgeDigest: sha('knowledge'), retainedDigest: sha('retained'), modelSpaceDigest: sha('model'), catalogDigest: sha('catalog'), targetCredentialFingerprint: sha('credential'), nodeCount: 1, inactiveCount: 0, recordCount: 3, digest: sha('baseline'), databaseIdentity: sha(database) };
  let committedRequest; let failure; let blocked = false; let phaseAction;
  const native = async ({ request }) => {
    const body = { ...request }; delete body.mode;
    if (request.mode === 'apply') {
      if (committedRequest && JSON.stringify(body) !== committedRequest) throw new Error('changed replay');
      if (!committedRequest) { committedRequest = JSON.stringify(body); await fs.writeFile(database, 'after-db'); }
      return { status: 'applied', preview: { ...preview, digest: sha('post') }, copied: 1, revision: 8 };
    }
    if (request.mode === 'verify') {
      if (JSON.stringify(body) !== committedRequest || await fs.readFile(database, 'utf8') !== 'after-db') throw new Error('native post drift');
      return { status: 'verified', preview: { ...preview, digest: sha('post') }, copied: 1, revision: 8 };
    }
    return { status: 'private-snapshot', snapshot, preview: { ...preview, databaseIdentity: sha(request.database), digest: request.database === database ? preview.digest : sha('restore-preview') } };
  };
  const options = { dataDir, database, configDir: dir, operationDir: path.join(dir, 'operation'), binary: path.join(dir, 'operator'), binarySha256: sha('binary'), ownership,
    tenantId: 1, kbId: 'kb', ownerId: 'owner', modelId: 'model', operationId: 'transport-test', compatibilityReceipt: sha('accepted-evidence'), stoppedPids: [], isolatedCopy: { sourceDatabase: pristine, sourceSha256: sha('before-db') }, env: {}, enterpriseOptions: { env: {}, policyFilePaths: [] } };
  const dependencies = { native, checkpoint: async (phase) => { phaseAction?.(phase); if (phase === failure) { failure = null; throw new Error('interrupted'); } },
    guardEntry: () => { if (blocked) throw new Error('enterprise_mode'); } };
  return { dir, config, database, options, configuration, create: () => createTransportCoordinator(options, dependencies), fail: (phase) => { failure = phase; }, block: () => { blocked = true; }, atPhase: (action) => { phaseAction = action; } };
};

for (const phase of ['after_database_commit', 'before_configuration_rename', 'after_configuration_rename']) test(`resumes ${phase} from durable exact request and keeps original backups`, async () => {
  const f = await fixture();
  try {
    const preview = await f.create().preview(); expect(await fs.readdir(f.dir)).not.toContain('operation');
    await f.create().prepare({ expectedDigest: preview.digest }); f.fail(phase);
    await expect(f.create().resume()).rejects.toThrow('interrupted');
    expect((await f.create().resume()).phase).toBe('verified');
    const saved = JSON.parse(await fs.readFile(f.config, 'utf8')); expect(saved.revision).toBe(6); expect(saved.bindings[0].verification.status).toBe('untested');
    expect((await f.create().resume()).phase).toBe('verified');
    expect((await f.create().rollback()).phase).toBe('rolled_back');
    expect(await fs.readFile(f.database, 'utf8')).toBe('before-db'); expect(JSON.parse(await fs.readFile(f.config, 'utf8'))).toEqual(f.configuration);
  } finally { await fs.rm(f.dir, { recursive: true, force: true }); }
});
test('configuration drift and enterprise activation refuse before native commit; rollback refuses new writes', async () => {
  const f = await fixture();
  try {
    await f.create().prepare({ expectedDigest: (await f.create().preview()).digest });
    await fs.writeFile(f.config, 'changed'); await expect(f.create().resume()).rejects.toThrow(); expect(await fs.readFile(f.database, 'utf8')).toBe('before-db');
    await fs.writeFile(f.config, JSON.stringify(f.configuration)); f.block(); await expect(f.create().resume()).rejects.toThrow('enterprise_mode');
  } finally { await fs.rm(f.dir, { recursive: true, force: true }); }
  const g = await fixture();
  try {
    await g.create().prepare({ expectedDigest: (await g.create().preview()).digest }); await g.create().resume();
    await fs.appendFile(g.database, 'new-write'); await expect(g.create().rollback()).rejects.toThrow();
    expect(await fs.readFile(g.database, 'utf8')).toBe('after-dbnew-write');
  } finally { await fs.rm(g.dir, { recursive: true, force: true }); }
});

test('enterprise policy changing after database commit prevents configuration publication', async () => {
  const f = await fixture();
  try {
    await f.create().prepare({ expectedDigest: (await f.create().preview()).digest });
    f.atPhase((phase) => { if (phase === 'before_configuration_rename') f.block(); });
    await expect(f.create().resume()).rejects.toThrow('enterprise_mode');
    expect(await fs.readFile(f.database, 'utf8')).toBe('after-db');
    expect(JSON.parse(await fs.readFile(f.config, 'utf8'))).toEqual(f.configuration);
    expect(JSON.parse(await fs.readFile(path.join(f.options.operationDir, 'journal.json'), 'utf8')).phase).toBe('database_committed');
  } finally { await fs.rm(f.dir, { recursive: true, force: true }); }
});
