import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const fail = (code) => { throw new Error(code); };
export const transportHash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export async function transportFileHash(file) {
  const stat = await fs.lstat(file); if (!stat.isFile() || stat.nlink !== 1) fail('transport_file_invalid');
  const hash = createHash('sha256'); for await (const bytes of createReadStream(file)) hash.update(bytes); return hash.digest('hex');
}
export async function readRawFile(file) {
  try {
    const stat = await fs.lstat(file); if (!stat.isFile() || stat.nlink !== 1) fail('transport_file_invalid');
    const bytes = await fs.readFile(file); return { exists: true, mode: stat.mode & 0o777, sha256: transportHash(bytes), bytes };
  } catch (error) { if (error.code === 'ENOENT') return { exists: false, mode: null, sha256: null, bytes: null }; throw error; }
}
export const rawFileMatches = (a, b) => a.exists === b.exists && a.mode === b.mode && a.sha256 === b.sha256;
export async function syncTransportDirectory(directory) {
  const handle = await fs.open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); }
}
export async function atomicTransportWrite(file, bytes, mode = 0o600, expected) {
  if (expected && !rawFileMatches(await readRawFile(file), expected)) fail('transport_file_conflict');
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', mode);
  try {
    await handle.chmod(mode); await handle.writeFile(bytes); await handle.sync(); await handle.close();
    if (expected && !rawFileMatches(await readRawFile(file), expected)) fail('transport_file_conflict');
    await fs.rename(temporary, file); await syncTransportDirectory(path.dirname(file));
  } finally { await handle.close().catch(() => {}); await fs.unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
}
export async function withTransportLock(file, task, executeLock) {
  const owner = `${process.pid}:${randomUUID()}`;
  await executeLock({ mode: 'lock-acquire', lockPath: file, lockOwner: owner });
  try { return await task({ lockPath: file, lockOwner: owner }); }
  finally { await executeLock({ mode: 'lock-release', lockPath: file, lockOwner: owner }); }
}

/** Maintenance is local and stopped. A caller boolean cannot attest no open database handles. */
export async function assertTransportQuiescent({ database, stoppedPids = [] }) {
  for (const pid of stoppedPids) {
    if (!Number.isSafeInteger(pid) || pid < 1) fail('transport_process_invalid');
    try { process.kill(pid, 0); fail('transport_process_running'); } catch (error) { if (error.code !== 'ESRCH') fail('transport_process_running'); }
  }
  const stat = await fs.lstat(database); if (!stat.isFile() || stat.nlink !== 1) fail('transport_database_invalid');
  const files = [database];
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try { const sidecar = await fs.lstat(database + suffix); if (!sidecar.isFile() || suffix !== '-shm' && sidecar.size) fail('transport_database_not_checkpointed'); files.push(database + suffix); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  try {
    const { stdout } = await exec('lsof', ['-t', '--', ...files], { timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true });
    if (stdout.trim()) fail('transport_database_open');
    // lsof's successful empty result is not a reliable absence signal.
    fail('transport_process_check_failed');
  } catch (error) {
    if (error.code !== 1 || String(error.stdout ?? '').trim() || String(error.stderr ?? '').trim()) {
      if (error.message === 'transport_database_open') throw error;
      fail('transport_process_check_failed');
    }
  }
  return { stopped: true, evidenceDigest: transportHash(JSON.stringify({ database: await fs.realpath(database), stoppedPids, openHandles: [], walEmpty: true })) };
}
