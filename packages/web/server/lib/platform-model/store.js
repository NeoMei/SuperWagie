import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { acquireModelWriterLock } from './writer-lock.js';

const id = z.string().min(1).max(200);
const task = z.object({ id, sessionID: id, actorID: id, accountID: id, owner: id, model: id });
const call = z.object({ id, sessionID: id, taskID: id, model: id, digest: z.string(), status: z.enum(['PREPARED', 'DISPATCHED', 'DELIVERED', 'UNKNOWN', 'SETTLED', 'RELEASED', 'REJECTED']), output: z.boolean(), charged: z.string().regex(/^\d+$/).optional() });
const schema = z.object({ version: z.literal(1), tasks: z.record(z.string(), task), calls: z.record(z.string(), call) });

/** A private, single-writer journal. No prompt, model credential or login token is stored. */
export const openModelStore = async (dataDir) => {
  const directory = path.join(dataDir, 'unihub-model');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await fs.lstat(directory)).isDirectory()) throw new Error('platform_store_unsafe');
  const release = await acquireModelWriterLock(directory);
  const filename = path.join(directory, 'state.json');
  let state;
  try {
    const stat = await fs.lstat(filename).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat && (!stat.isFile() || stat.size > 32 * 1024 * 1024)) throw new Error('platform_store_unsafe');
    state = stat ? schema.parse(JSON.parse(await fs.readFile(filename, 'utf8'))) : { version: 1, tasks: {}, calls: {} };
  } catch (error) { await release(); throw error; }
  let tail = Promise.resolve();
  let closePromise;
  const mutate = (operation) => {
    if (closePromise) return Promise.reject(new Error('platform_store_closed'));
    const next = tail.then(async () => {
      const candidate = structuredClone(state);
      const result = await operation(candidate);
      schema.parse(candidate);
      const serialized = JSON.stringify(candidate);
      if (Buffer.byteLength(serialized) > 32 * 1024 * 1024) throw new Error('platform_store_capacity_reached');
      const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
      try {
        const handle = await fs.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(serialized); await handle.sync(); } finally { await handle.close(); }
        await fs.rename(temporary, filename);
        if (process.platform !== 'win32') { const folder = await fs.open(directory, 'r'); try { await folder.sync(); } finally { await folder.close(); } }
        state = candidate;
      } finally { await fs.rm(temporary, { force: true }); }
      return result;
    });
    tail = next.catch(() => {});
    return next;
  };
  return { read: () => structuredClone(state), mutate, close: () => {
    closePromise ??= tail.then(release);
    return closePromise;
  } };
};
