import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { isEnterpriseMode } from '../enterprise-mode.js';
import { createAccountKeyStore } from '../model-configuration/account-key-store.js';
import { createModelBootstrapStore } from '../model-configuration/bootstrap-store.js';
import { createModelConfigurationRuntime } from '../model-configuration/runtime.js';
import { credentialDestinationAllowed } from '../model-configuration/credentials.js';

const ownershipSchema = z.object({ issuer: z.string().min(1), serviceId: z.string().min(1), actorId: z.string().min(1), accountId: z.string().min(1) }).strict();
const sha = (value) => createHash('sha256').update(value).digest('hex');
const fail = () => { throw new Error('transport_owner_rejected'); };
export const guardTransportEntry = (enterpriseOptions) => { if (isEnterpriseMode(enterpriseOptions)) throw new Error('enterprise_mode'); };

/** Reads persisted ownership only. The installed authenticated activation owns final session proof. */
export async function readTransportOwner({ dataDir, ownership: input, enterpriseOptions, env = process.env, now = Date.now(), allowExpired = false }) {
  guardTransportEntry(enterpriseOptions);
  const ownership = ownershipSchema.parse(input); const storageId = sha(JSON.stringify(ownership));
  const record = await createAccountKeyStore({ dataDir }).read(storageId);
  if (!record || Object.entries(ownership).some(([k, v]) => record[k] !== v) || !record.key || !record.secretRef || !record.keyFingerprint
    || !allowExpired && record.key.expiresAt && Date.parse(record.key.expiresAt) <= now) fail();
  const rawConfiguration = await fs.readFile(path.join(dataDir, 'model-configuration.json'));
  // The runtime owns full configuration validation, including duplicates and dangling bindings.
  const store = createModelBootstrapStore({ dataDir });
  const runtime = createModelConfigurationRuntime({ dataDir, enterpriseOptions, env, readModelBootstrapCredential: store.getSecret,
    fetchImpl: async () => { throw new Error('transport_network_forbidden'); } });
  await runtime.getPublicConfiguration();
  const configuration = JSON.parse(rawConfiguration.toString('utf8'));
  const connection = configuration.connections.find((c) => c.id === record.connectionId);
  if (!connection || connection.apiKey || connection.baseUrl !== record.baseUrl || connection.credentialSource?.type !== 'model-bootstrap'
    || connection.credentialSource.providerId !== 'llmrouter' || connection.credentialSource.ref !== record.secretRef
    || !credentialDestinationAllowed(connection, [], env) || new URL(connection.baseUrl).protocol !== 'https:') fail();
  const apiKey = await store.getSecret(record.secretRef);
  if (!apiKey || sha(apiKey) !== record.keyFingerprint || apiKey.slice(-4) !== record.key.last4) fail();
  if (!rawConfiguration.equals(await fs.readFile(path.join(dataDir, 'model-configuration.json')))) fail();
  return { storageId, record, rawConfiguration, configuration, connection,
    binding: { purpose: 'embedding', connectionId: connection.id, providerId: connection.providerId, protocol: connection.protocol,
      baseUrl: connection.baseUrl, model: 'text-embedding-v4', apiKey, parameters: { dimensions: 1024 }, revision: configuration.revision } };
}

/** Uses the normal writer on a private copy and returns its actual persisted bytes. */
export async function stageTransportBinding({ owner, stageDir, enterpriseOptions, env = process.env }) {
  guardTransportEntry(enterpriseOptions);
  const file = path.join(stageDir, 'model-configuration.json');
  await fs.writeFile(file, owner.rawConfiguration, { flag: 'wx', mode: 0o600 });
  let prepared = false;
  const runtime = createModelConfigurationRuntime({ dataDir: stageDir, enterpriseOptions, env,
    readModelBootstrapCredential: async (ref) => ref === owner.record.secretRef ? owner.binding.apiKey : null,
    fetchImpl: async () => { throw new Error('transport_network_forbidden'); },
    prepareBindingChange: async (purpose, next) => {
      if (purpose !== 'embedding' || !isDeepStrictEqual(next, { ...owner.binding, parameters: { region: owner.connection.region, workspaceId: owner.connection.workspaceId, dimensions: 1024 } })) fail();
      prepared = true;
    } });
  await runtime.saveBinding('embedding', { revision: owner.configuration.revision, binding: { connectionId: owner.connection.id, model: 'text-embedding-v4', parameters: { dimensions: 1024 } } });
  const bytes = await fs.readFile(file); const staged = JSON.parse(bytes.toString('utf8'));
  const binding = staged.bindings.find((b) => b.purpose === 'embedding');
  if (!prepared || !isDeepStrictEqual(binding?.verification, { status: 'untested' }) || staged.revision !== owner.configuration.revision + 1
    || !isDeepStrictEqual(staged.connections, owner.configuration.connections)
    || !isDeepStrictEqual(staged.bindings.filter((b) => b.purpose !== 'embedding'), owner.configuration.bindings.filter((b) => b.purpose !== 'embedding'))) fail();
  return bytes;
}
