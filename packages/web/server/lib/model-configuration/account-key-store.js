import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { ModelConfigurationError } from './runtime.js';
import { PURPOSE_IDS } from './catalog.js';
import { accountModelSchema } from './account-key-models.js';

const id = z.string().min(1).max(200);
const date = z.string().datetime({ offset: true });
const recordSchema = z.object({
  version: z.literal(1), operationId: z.string().uuid(),
  issuer: id, serviceId: id, actorId: id, accountId: id, instanceId: id,
  status: z.enum(['issuing', 'configuring', 'testing', 'ready', 'failed', 'unknown', 'interrupted']),
  stage: z.enum(['issue', 'configure', 'test']), errorCode: id.nullable(),
  key: z.object({ id, last4: z.string().length(4), createdAt: date, expiresAt: date.nullable() }).strict().nullable(),
  secretRef: id.nullable(), keyFingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable(), baseUrl: z.string().url(),
  providerId: id, connectionId: id, modelId: id,
  modelScope: z.enum(['selected', 'llmrouter_available']).default('selected'),
  pricingSource: z.literal('llmrouter_native').optional(), credentialVersion: z.number().int().positive().optional(),
  // Bounded catalog snapshots support configuration recovery, not authorization.
  models: z.array(z.object({ id, name: id }).strict()).min(1).max(1000),
  chatModels: z.array(accountModelSchema).min(1).max(1000).optional(),
  previousChatModels: z.array(accountModelSchema).min(1).max(1000).optional(),
  purposeModels: z.array(z.object({ purpose: z.enum(PURPOSE_IDS), modelId: id.nullable(), parameters: z.object({ dimensions: z.number().int().min(1).max(65536).optional(), voice: id.optional(), language: id.optional(), speechOperation: z.literal('bailian.audio.speech.create').optional() }).strict(), errorCode: id.nullable() }).strict()).max(PURPOSE_IDS.length).default([]),
  testRunId: z.string().uuid().nullable().default(null),
  tests: z.array(z.object({ id, purpose: z.enum(PURPOSE_IDS), modelId: z.string().min(1).max(256).nullable(), status: z.enum(['queued', 'testing', 'verified', 'failed', 'unknown', 'skipped']), testedAt: date.nullable(), errorCode: id.nullable(), applied: z.boolean().default(false), applicationError: z.object({ status: z.enum(['failed', 'unknown']), errorCode: id }).strict().optional() }).strict().refine((row) => !row.applicationError || row.status === 'verified' && !row.applied)).max(PURPOSE_IDS.length + 1).default([]),
  test: z.object({ status: z.enum(['verified', 'failed', 'unknown']), testedAt: date.nullable(), errorCode: id.nullable() }).strict().nullable(),
  createdAt: date, updatedAt: date,
}).strict().refine((record) => record.modelScope !== 'llmrouter_available' || record.pricingSource === 'llmrouter_native' && record.credentialVersion !== undefined);
const fail = (code, status = 500) => { throw new ModelConfigurationError(code, status); };

/** Durable private receipts. Secret values remain in the bootstrap secret store. */
export const createAccountKeyStore = ({ dataDir }) => {
  const directory = path.join(dataDir, 'account-key-activation');
  const file = (key) => {
    if (!/^[a-f0-9]{64}$/.test(key)) fail('account_key_store_invalid');
    return path.join(directory, `${key}.json`);
  };
  const ensure = async () => {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if (!(await fs.lstat(directory)).isDirectory()) fail('account_key_store_invalid');
    if (process.platform !== 'win32') await fs.chmod(directory, 0o700);
  };
  const read = async (key) => {
    try {
      const filename = file(key);
      const stat = await fs.lstat(filename);
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024) fail('account_key_store_invalid');
      return recordSchema.parse(JSON.parse(await fs.readFile(filename, 'utf8')));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      fail('account_key_store_invalid');
    }
  };
  const write = async (key, record) => {
    const value = recordSchema.parse(record);
    await ensure();
    const filename = file(key);
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, filename);
      if (process.platform !== 'win32') {
        const folder = await fs.open(directory, 'r');
        try { await folder.sync(); } finally { await folder.close(); }
      }
    } catch { fail('account_key_store_write_failed'); }
    finally { await fs.unlink(temporary).catch(() => {}); }
    return value;
  };
  const withLock = async (key, task) => {
    await ensure();
    const lockPath = `${file(key)}.lock`;
    const token = `${process.pid}:${randomUUID()}`;
    let handle;
    try { handle = await fs.open(lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') fail('account_key_store_write_failed');
      // Only one process may replace a dead writer's lock. A second recovery
      // must never unlink the fresh lock that the first recovery just claimed.
      const recoveryPath = `${lockPath}.recovery`;
      let recovery;
      try { recovery = await fs.open(recoveryPath, 'wx', 0o600); }
      catch { fail('account_key_busy', 409); }
      try {
        const previous = await fs.readFile(lockPath, 'utf8').catch(() => '');
        const pid = Number(previous.split(':')[0]);
        if (!Number.isSafeInteger(pid) || pid < 1) fail('account_key_busy', 409);
        try { process.kill(pid, 0); fail('account_key_busy', 409); }
        catch (checkError) { if (checkError.code !== 'ESRCH') fail('account_key_busy', 409); }
        if (await fs.readFile(lockPath, 'utf8').catch(() => '') !== previous) fail('account_key_busy', 409);
        await fs.unlink(lockPath);
        try { handle = await fs.open(lockPath, 'wx', 0o600); }
        catch { fail('account_key_busy', 409); }
      } finally {
        await recovery.close();
        await fs.unlink(recoveryPath);
      }
    }
    try {
      await handle.writeFile(token); await handle.sync();
      return await task();
    } finally {
      await handle.close();
      if (await fs.readFile(lockPath, 'utf8').catch(() => '') === token) await fs.unlink(lockPath);
    }
  };
  return { read, write, withLock };
};
