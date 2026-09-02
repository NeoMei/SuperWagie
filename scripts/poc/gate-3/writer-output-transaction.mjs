import { randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

const TRANSACTION_MARKER = '.writer-transaction.json';

function syncDirectory(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    fsyncSync(fd);
  } catch (error) {
    if (process.platform !== 'win32' || !['EINVAL', 'ENOTSUP', 'EPERM'].includes(error?.code)) throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function syncRegularFile(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Writer publication contains a non-regular file: ${path}`);
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function syncTree(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Writer publication tree is not a real directory: ${path}`);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Writer publication contains a symlink: ${child}`);
    if (entry.isDirectory()) syncTree(child);
    else syncRegularFile(child);
  }
  syncDirectory(path);
}

function crashAt(point) {
  if (process.env.SUPERWAGIE_TEST_CRASH_POINT === point) process.kill(process.pid, 'SIGKILL');
}

function stalePid(path) {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) return false;
    const pid = Number(readFileSync(path, 'utf8').trim());
    if (!Number.isInteger(pid) || pid < 1) return false;
    try { process.kill(pid, 0); return false; } catch (error) { return error?.code === 'ESRCH'; }
  } catch { return false; }
}

function reclaimStaleLock(path) {
  if (!existsSync(path) || !stalePid(path)) return;
  unlinkSync(path);
  syncDirectory(dirname(path));
}

function openLock(path) {
  reclaimStaleLock(path);
  try {
    const fd = openSync(path, 'wx', 0o600);
    writeFileSync(fd, `${process.pid}\n`);
    fsyncSync(fd);
    syncDirectory(dirname(path));
    return fd;
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`Writer output is already reserved or immutable: ${path}`);
    throw error;
  }
}

function closeAndUnlink(fd, path) {
  try { closeSync(fd); } catch {}
  try { unlinkSync(path); syncDirectory(dirname(path)); } catch {}
}

function atomicWriteExclusive(path, bytes) {
  const temporary = resolve(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    linkSync(temporary, path);
    syncDirectory(dirname(path));
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`Writer result is immutable and already exists: ${path}`);
    throw error;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
    try { unlinkSync(temporary); syncDirectory(dirname(path)); } catch {}
  }
}

function assertEmptyRealDirectory(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Writer artifacts destination must be a real directory: ${path}`);
  if (readdirSync(path).length !== 0) throw new Error(`Writer artifacts destination is immutable and not empty: ${path}`);
}

function markerDocument(resultsPath, artifactsPath, transactionId = '') {
  return {
    schema_id: 'superwagie.writer-output-transaction.v1', schema_version: 1,
    transaction_id: transactionId, results_basename: basename(resultsPath), artifacts_basename: basename(artifactsPath),
  };
}

function writeMarker(directory, marker) {
  const markerPath = resolve(directory, TRANSACTION_MARKER);
  writeFileSync(markerPath, `${JSON.stringify(marker)}\n`, { flag: 'wx', mode: 0o600 });
  syncRegularFile(markerPath);
  syncDirectory(directory);
}

function ownsOrphan(directory, expectedMarker) {
  try {
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    const markerPath = resolve(directory, TRANSACTION_MARKER);
    const markerStat = lstatSync(markerPath);
    if (markerStat.isSymbolicLink() || !markerStat.isFile()) return false;
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    return marker.schema_id === expectedMarker.schema_id && marker.schema_version === 1
      && marker.results_basename === expectedMarker.results_basename
      && marker.artifacts_basename === expectedMarker.artifacts_basename;
  } catch { return false; }
}

function recoverUncommittedOutputs(resultsPath, artifactsPath, expectedMarker) {
  if (existsSync(resultsPath)) return;
  const parent = dirname(artifactsPath);
  if (existsSync(artifactsPath)) {
    const stat = lstatSync(artifactsPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Writer artifacts destination must be a real directory: ${artifactsPath}`);
    const entries = readdirSync(artifactsPath);
    if (entries.length === 0) rmdirSync(artifactsPath);
    else if (ownsOrphan(artifactsPath, expectedMarker)) rmSync(artifactsPath, { recursive: true, force: true });
    else throw new Error(`Writer artifacts destination is immutable and not empty: ${artifactsPath}`);
    syncDirectory(parent);
  }
  const prefix = `${basename(artifactsPath)}.staging-`;
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    if (!entry.name.startsWith(prefix) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const candidate = resolve(parent, entry.name);
    if (ownsOrphan(candidate, expectedMarker)) rmSync(candidate, { recursive: true, force: true });
  }
  syncDirectory(parent);
}

export function reserveWriterOutputs(resultsPath, artifactsPath) {
  mkdirSync(dirname(resultsPath), { recursive: true });
  mkdirSync(dirname(artifactsPath), { recursive: true });
  syncDirectory(dirname(resultsPath));
  if (dirname(artifactsPath) !== dirname(resultsPath)) syncDirectory(dirname(artifactsPath));
  const resultLockPath = `${resultsPath}.writer-lock`;
  const artifactLockPath = `${artifactsPath}.writer-lock`;
  let resultLock; let artifactLock;
  const transactionId = randomUUID();
  const marker = markerDocument(resultsPath, artifactsPath, transactionId);
  try {
    resultLock = openLock(resultLockPath);
    artifactLock = openLock(artifactLockPath);
    if (existsSync(resultsPath)) throw new Error(`Writer result is immutable and already exists: ${resultsPath}`);
    recoverUncommittedOutputs(resultsPath, artifactsPath, marker);
    if (existsSync(artifactsPath)) {
      assertEmptyRealDirectory(artifactsPath);
      rmdirSync(artifactsPath);
    }
    const stagingPath = `${artifactsPath}.staging-${process.pid}-${transactionId}`;
    mkdirSync(stagingPath, { mode: 0o700 });
    writeMarker(stagingPath, marker);
    syncDirectory(dirname(stagingPath));
    let finished = false;

    const publish = (result) => {
      if (finished) throw new Error('Writer output transaction is already finished');
      const resultBytes = Buffer.from(`${JSON.stringify(result, null, 2)}\n`);
      try {
        syncTree(stagingPath);
        syncDirectory(dirname(stagingPath));
        crashAt('before-artifact-rename');
        renameSync(stagingPath, artifactsPath);
        syncDirectory(dirname(artifactsPath));
        crashAt('after-artifact-rename');
        try {
          atomicWriteExclusive(resultsPath, resultBytes);
          crashAt('after-result-commit');
        } catch (error) {
          rmSync(artifactsPath, { recursive: true, force: true });
          syncDirectory(dirname(artifactsPath));
          throw error;
        }
        finished = true;
      } finally {
        closeAndUnlink(artifactLock, artifactLockPath);
        closeAndUnlink(resultLock, resultLockPath);
      }
    };

    const discardStagedArtifacts = () => {
      if (finished) return;
      rmSync(stagingPath, { recursive: true, force: true });
      mkdirSync(stagingPath, { mode: 0o700 });
      writeMarker(stagingPath, marker);
      syncDirectory(dirname(stagingPath));
    };

    const abandon = () => {
      if (finished) return;
      finished = true;
      rmSync(stagingPath, { recursive: true, force: true });
      syncDirectory(dirname(stagingPath));
      closeAndUnlink(artifactLock, artifactLockPath);
      closeAndUnlink(resultLock, resultLockPath);
    };

    return { artifactsPath: stagingPath, publish, discardStagedArtifacts, abandon };
  } catch (error) {
    if (artifactLock !== undefined) closeAndUnlink(artifactLock, artifactLockPath);
    if (resultLock !== undefined) closeAndUnlink(resultLock, resultLockPath);
    throw error;
  }
}
