import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { loadSqliteOpener } from '../message-search/sqlite.js';

const id = z.string().min(1).max(200);
const task = z.object({ id, sessionID: id, actorID: id, accountID: id, owner: id, model: id });
const call = z.object({ id, sessionID: id, taskID: id, model: id, operation: z.string().min(1).max(64).optional(), permitID: id.optional(), digest: z.string(), status: z.enum(['PREPARED', 'DISPATCHED', 'DELIVERED', 'ASYNC_PENDING', 'UNKNOWN', 'SETTLED', 'RELEASED', 'REJECTED']), output: z.boolean(), charged: z.string().regex(/^\d+$/).optional() });
const schema = z.object({ version: z.literal(1), tasks: z.record(z.string(), task), calls: z.record(z.string(), call) });

export class PlatformStoreLockError extends Error {
  constructor(code) { super(code); this.code = code; }
}

/** A private, single-writer journal. No prompt, model credential or login token is stored. */
export const openModelStore = async (dataDir) => {
  const directory = path.join(dataDir, 'unihub-model');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await fs.lstat(directory)).isDirectory()) throw new Error('platform_store_unsafe');
  // SQLite's exclusive transaction is an OS-backed ownership fence, released
  // on process death. Keep the legacy lock file too, so older versions cannot
  // open the JSON journal concurrently with a newer version.
  const lockDatabase = path.join(directory, 'writer.sqlite');
  const lockStat = await fs.lstat(lockDatabase).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  if (lockStat && !lockStat.isFile()) throw new Error('platform_store_unsafe');
  const opener = loadSqliteOpener();
  if (!opener) throw new PlatformStoreLockError('platform_store_lock_unavailable');
  let fence;
  try {
    fence = opener(lockDatabase);
    fence.exec('PRAGMA busy_timeout=0');
    fence.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    try { fence?.close(); } catch { /* preserve failure */ }
    if (error?.code === 'SQLITE_BUSY' || error?.code === 'SQLITE_LOCKED' || (Number.isInteger(error?.errcode) && [5, 6].includes(error.errcode & 255))) throw new PlatformStoreLockError('platform_store_busy');
    throw error;
  }
  const lockPath = path.join(directory, 'writer.lock');
  const lockValue = `sqlite-v1:${crypto.randomUUID()}`;
  try {
    // Only files written by this fenced protocol can be reclaimed. Legacy or
    // incomplete locks may still belong to an older process and fail closed.
    const previous = await fs.readFile(lockPath, 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; });
    if (previous) {
      if (!/^sqlite-v1:[0-9a-f-]{36}$/.test(previous)) throw new PlatformStoreLockError('platform_store_busy');
      await fs.unlink(lockPath);
    }
    const lock = await fs.open(lockPath, 'wx', 0o600);
    try { await lock.writeFile(lockValue); await lock.sync(); } finally { await lock.close(); }
  } catch (error) {
    fence.close();
    if (error?.code === 'EEXIST') throw new PlatformStoreLockError('platform_store_busy');
    throw error;
  }
  const filename = path.join(directory, 'state.json');
  const release = async () => {
    try { if (await fs.readFile(lockPath, 'utf8').catch(() => '') === lockValue) await fs.unlink(lockPath); }
    finally { fence.close(); }
  };
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
