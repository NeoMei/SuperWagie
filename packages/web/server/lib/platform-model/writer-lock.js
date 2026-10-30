import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const ownerPattern = /^([1-9][0-9]{0,9}):[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const failure = (code, cause) => Object.assign(new Error(code, { cause }), { code });
const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino;
const isBusy = (error) => [5, 6].includes(error?.errcode) || [5, 6].includes(error?.errno)
  || error?.code === 'SQLITE_BUSY' || error?.code === 'SQLITE_LOCKED';

async function openGuard(directory) {
  const filename = path.join(directory, 'writer-guard.sqlite');
  try {
    const created = await fs.open(filename, 'wx', 0o600);
    await created.close();
  } catch (error) {
    if (error.code !== 'EEXIST') throw failure('platform_store_unavailable', error);
  }
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw failure('platform_store_unsafe');
  let database;
  try {
    // Keep this import inside feature startup so an unsupported runtime can
    // leave platform models unavailable while the rest of the app starts.
    const { DatabaseSync } = await import('node:sqlite');
    database = new DatabaseSync(filename, { timeout: 0 });
    database.exec('PRAGMA busy_timeout=0');
    if (database.prepare('PRAGMA journal_mode').get().journal_mode !== 'delete') throw failure('platform_store_unsafe');
    database.exec('BEGIN EXCLUSIVE');
    return database;
  } catch (error) {
    try { database?.close(); } catch { /* The failed connection owns no journal writes. */ }
    if (error.code === 'platform_store_unsafe') throw error;
    throw failure(isBusy(error) ? 'platform_store_busy' : 'platform_store_unavailable', error);
  }
}

async function reclaimDeadOwner(filename) {
  let handle;
  try {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.size > 128) throw failure('platform_store_busy');
    handle = await fs.open(filename, 'r');
    const owned = await handle.stat({ bigint: true });
    const match = ownerPattern.exec(await handle.readFile('utf8'));
    if (!match) throw failure('platform_store_busy');
    try { process.kill(Number(match[1]), 0); }
    catch (error) {
      if (error.code !== 'ESRCH') throw failure('platform_store_busy', error);
      const current = await fs.lstat(filename, { bigint: true });
      if (!current.isFile() || !sameFile(owned, current)) throw failure('platform_store_busy');
      await fs.unlink(filename);
      return;
    }
    throw failure('platform_store_busy');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  } finally {
    await handle?.close();
  }
}

/** The kernel releases this guard after a crash; the legacy file still excludes older writers. */
export async function acquireModelWriterLock(folder) {
  const directory = await fs.realpath(folder);
  const database = await openGuard(directory);
  const filename = path.join(directory, 'writer.lock');
  const owner = `${process.pid}:${randomUUID()}`;
  const temporary = path.join(directory, `writer-${randomUUID()}.tmp`);
  const closeGuard = () => { try { database.exec('ROLLBACK'); } finally { database.close(); } };
  try {
    await reclaimDeadOwner(filename);
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(owner); await handle.sync(); } finally { await handle.close(); }
    // Linking a complete, synced record cannot leave an empty owner file if
    // the process dies, and cannot replace a legacy writer that won the race.
    await fs.link(temporary, filename);
  } catch (error) {
    closeGuard();
    if (error.code?.startsWith('platform_store_')) throw error;
    throw failure(error.code === 'EEXIST' ? 'platform_store_busy' : 'platform_store_unavailable', error);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
  let releasePromise;
  return () => {
    releasePromise ??= (async () => {
      try {
        if (await fs.readFile(filename, 'utf8').catch(() => '') === owner) await fs.unlink(filename);
      } finally { closeGuard(); }
    })();
    return releasePromise;
  };
}
