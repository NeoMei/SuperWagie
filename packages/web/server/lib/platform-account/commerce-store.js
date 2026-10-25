import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';

const identifier = z.string().min(1).max(200);
const intentSchema = z.object({
  serviceId: identifier, actorId: identifier, accountId: identifier,
  idempotencyKey: z.string().uuid(), kind: z.enum(['recharge', 'purchase']),
  productId: z.enum(['superwagie', 'llmrouter']), amount: z.string().regex(/^(0|[1-9]\d*)$/),
  offerId: identifier.optional(), resourceId: identifier.optional(), operationId: identifier.optional(),
  status: z.enum(['PREPARED', 'UNKNOWN', 'PENDING', 'APPLIED', 'FAILED']),
  errorCode: z.string().regex(/^[a-z][a-z0-9_]{0,100}$/).optional(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict();
const documentSchema = z.object({ version: z.literal(1), intents: z.record(z.string(), intentSchema) }).strict();
const sizeLimit = 8 * 1024 * 1024;

/** Saves financial intent and object IDs, never credentials or authoritative balances. */
export const openCommerceStore = async (dataDir) => {
  const directory = path.join(dataDir, 'unihub-commerce');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await fs.lstat(directory)).isDirectory()) throw new Error('platform_commerce_store_unsafe');
  const lockPath = path.join(directory, 'writer.lock');
  const lockValue = `${process.pid}:${crypto.randomUUID()}`;
  try {
    const lock = await fs.open(lockPath, 'wx', 0o600);
    try { await lock.writeFile(lockValue); await lock.sync(); } finally { await lock.close(); }
  } catch { throw new Error('platform_commerce_store_busy'); }
  const release = async () => {
    if (await fs.readFile(lockPath, 'utf8').catch(() => '') === lockValue) await fs.unlink(lockPath);
  };
  const filename = path.join(directory, 'state.json');
  let state;
  try {
    const stat = await fs.lstat(filename).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat && (!stat.isFile() || stat.size > sizeLimit)) throw new Error('platform_commerce_store_unsafe');
    state = stat ? documentSchema.parse(JSON.parse(await fs.readFile(filename, 'utf8'))) : { version: 1, intents: {} };
  } catch (error) { await release(); throw error; }
  let tail = Promise.resolve();
  let closePromise;
  const mutate = (operation) => {
    if (closePromise) return Promise.reject(new Error('platform_commerce_store_closed'));
    const next = tail.then(async () => {
      const candidate = structuredClone(state);
      const result = operation(candidate.intents);
      documentSchema.parse(candidate);
      const serialized = JSON.stringify(candidate);
      if (Buffer.byteLength(serialized) > sizeLimit) throw new Error('platform_commerce_store_capacity');
      const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
      try {
        const handle = await fs.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(serialized); await handle.sync(); } finally { await handle.close(); }
        await fs.rename(temporary, filename);
        if (process.platform !== 'win32') {
          const folder = await fs.open(directory, 'r');
          try { await folder.sync(); } finally { await folder.close(); }
        }
        state = candidate;
      } finally { await fs.rm(temporary, { force: true }); }
      return result;
    });
    tail = next.catch(() => {});
    return next;
  };
  return {
    read: () => structuredClone(state.intents), mutate,
    close: () => { closePromise ??= tail.then(release); return closePromise; },
  };
};
