import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCK_PATH = path.join(HERE, 'source-lock.json');
const RECEIPT_NAME = '.acquisition.json';

function fail(message) {
  throw new Error(`Frozen Core acquisition rejected: ${message}`);
}

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      encoding: options.encoding ?? 'utf8',
      cwd: options.cwd,
      input: options.input,
      maxBuffer: 16 * 1024 * 1024,
      stdio: options.stdio,
    });
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message;
    fail(`${command} ${args.join(' ')} failed: ${detail}`);
  }
}

function git(cwd, ...args) {
  return run('git', args, { cwd }).trim();
}

function symbolicHead(cwd) {
  try {
    return execFileSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  } catch (error) {
    if (error.status === 1) return '';
    const detail = error.stderr?.toString().trim() || error.message;
    fail(`git symbolic-ref -q HEAD failed: ${detail}`);
  }
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sha256File(file) {
  return sha256Bytes(readFileSync(file));
}

export function sourceLockBytes(sourceLock) {
  return Buffer.from(`${JSON.stringify(sourceLock, null, 2)}\n`, 'utf8');
}

export function validateSourceLock(sourceLock) {
  if (!sourceLock || typeof sourceLock !== 'object' || Array.isArray(sourceLock)) {
    fail('source lock must be a JSON object');
  }
  const expectedKeys = [
    'allowed_ref_kind',
    'commit',
    'schema_id',
    'source_tree_sha256',
    'upstream',
    'version',
  ];
  const actualKeys = Object.keys(sourceLock).sort();
  if (!isDeepStrictEqual(actualKeys, expectedKeys)) {
    fail(`source lock fields must be exactly: ${expectedKeys.join(', ')}`);
  }
  if (sourceLock.schema_id !== 'superwagie.viewer-source-lock.v1') {
    fail('source lock schema is not superwagie.viewer-source-lock.v1');
  }
  if (sourceLock.allowed_ref_kind !== 'commit-only') {
    fail('source lock must declare commit-only ref handling');
  }
  if (!/^[a-f0-9]{40}$/.test(sourceLock.commit ?? '')) {
    fail('commit-only acquisition requires an exact lowercase 40-character commit');
  }
  if (!/^[a-f0-9]{64}$/.test(sourceLock.source_tree_sha256 ?? '')) {
    fail('source tree archive SHA-256 must be 64 lowercase hexadecimal characters');
  }
  if (
    typeof sourceLock.version !== 'string'
    || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(sourceLock.version)
  ) {
    fail('version must be a semantic version and must not contain an absolute path');
  }
  if (typeof sourceLock.upstream !== 'string') fail('upstream must be an absolute URL');
  let upstream;
  try {
    upstream = new URL(sourceLock.upstream);
  } catch {
    fail('upstream must be an absolute URL');
  }
  if (!['https:', 'file:'].includes(upstream.protocol)) {
    fail('upstream URL must use HTTPS (or file: in local tests)');
  }
}

export function parseAuthoritativeSourceLock({ sourceLock, lockBytes } = {}) {
  const authoritativeBytes = lockBytes === undefined
    ? sourceLockBytes(sourceLock)
    : Buffer.from(lockBytes);
  let authoritativeLock;
  try {
    authoritativeLock = JSON.parse(authoritativeBytes.toString('utf8'));
  } catch (error) {
    fail(`authoritative source lock bytes are not valid JSON: ${error.message}`);
  }
  validateSourceLock(authoritativeLock);
  if (sourceLock !== undefined && !isDeepStrictEqual(sourceLock, authoritativeLock)) {
    fail('supplied source lock object differs from authoritative lock bytes');
  }
  return { sourceLock: authoritativeLock, lockBytes: authoritativeBytes };
}

function requireAbsolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    fail(`${label} must be an explicit absolute path`);
  }
  return path.resolve(value);
}

function listForbiddenGitEntries(sourceRoot, revision = 'HEAD') {
  const entries = git(sourceRoot, 'ls-tree', '-r', '-z', '--full-tree', revision).split('\0').filter(Boolean);
  const symlinks = [];
  const submodules = [];
  for (const entry of entries) {
    const match = /^(\d{6})\s+\S+\s+[a-f0-9]+\t([\s\S]+)$/.exec(entry);
    if (!match) fail('could not parse the locked Git tree');
    if (match[1] === '120000') symlinks.push(match[2]);
    if (match[1] === '160000') submodules.push(match[2]);
  }
  return { symlinks, submodules };
}

function verifyNoFilesystemLinks(root) {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (current === root && entry.name === '.git') continue;
      const fullPath = path.join(current, entry.name);
      const metadata = lstatSync(fullPath);
      if (metadata.isSymbolicLink()) fail(`symbolic link entry is forbidden: ${entry.name}`);
      if (metadata.isDirectory()) pending.push(fullPath);
      else if (!metadata.isFile()) fail(`special filesystem entry is forbidden: ${entry.name}`);
    }
  }
}

function tarString(bytes, offset, length) {
  const end = bytes.indexOf(0, offset);
  const boundedEnd = end === -1 || end > offset + length ? offset + length : end;
  return bytes.subarray(offset, boundedEnd).toString('utf8');
}

function tarSize(bytes, offset) {
  const field = bytes.subarray(offset + 124, offset + 136);
  if ((field[0] & 0x80) !== 0) fail('archive header uses unsupported base-256 size before extraction');
  const text = field.toString('ascii').replace(/\0.*$/, '').trim();
  if (!/^[0-7]*$/.test(text)) fail('archive header has an invalid size before extraction');
  const size = text === '' ? 0 : Number.parseInt(text, 8);
  if (!Number.isSafeInteger(size) || size < 0) fail('archive header size is unsafe before extraction');
  return size;
}

function verifyTarChecksum(bytes, offset) {
  const checksumText = bytes.subarray(offset + 148, offset + 156).toString('ascii').replace(/\0.*$/, '').trim();
  if (!/^[0-7]+$/.test(checksumText)) fail('archive header checksum is invalid before extraction');
  let actual = 0;
  for (let index = 0; index < 512; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : bytes[offset + index];
  }
  if (actual !== Number.parseInt(checksumText, 8)) fail('archive header checksum mismatch before extraction');
}

function parsePaxRecords(body) {
  const records = {};
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space === -1) fail('archive PAX header is malformed before extraction');
    const length = Number.parseInt(body.subarray(offset, space).toString('ascii'), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > body.length) {
      fail('archive PAX header length is malformed before extraction');
    }
    const record = body.subarray(space + 1, offset + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals <= 0) fail('archive PAX header record is malformed before extraction');
    records[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return records;
}

function validateArchiveEntryPath(entryPath) {
  if (!entryPath || path.posix.isAbsolute(entryPath) || path.win32.isAbsolute(entryPath)) {
    fail(`archive header contains an absolute path before extraction: ${entryPath || '<empty>'}`);
  }
  const parts = entryPath.replaceAll('\\', '/').split('/').filter(Boolean);
  if (parts.includes('..')) fail(`archive header contains path traversal before extraction: ${entryPath}`);
  if (parts.at(-1) === '.gitmodules') {
    fail(`archive header contains a Git submodule marker before extraction: ${entryPath}`);
  }
}

function inspectArchiveHeadersBeforeExtraction(archiveBytes) {
  let offset = 0;
  let pendingPax = {};
  while (offset + 512 <= archiveBytes.length) {
    const header = archiveBytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) return;
    verifyTarChecksum(archiveBytes, offset);
    const size = tarSize(archiveBytes, offset);
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > archiveBytes.length) fail('archive entry exceeds archive bytes before extraction');
    const type = String.fromCharCode(header[156] || 0x30);
    const name = tarString(archiveBytes, offset, 100);
    const prefix = tarString(archiveBytes, offset + 345, 155);
    const headerPath = prefix ? `${prefix}/${name}` : name;
    if (type === 'x' || type === 'g') {
      const records = parsePaxRecords(archiveBytes.subarray(bodyStart, bodyEnd));
      if (records.path) validateArchiveEntryPath(records.path);
      if (records.linkpath) fail('archive header contains a link path before extraction');
      if (type === 'x') pendingPax = records;
    } else {
      const entryPath = pendingPax.path ?? headerPath;
      validateArchiveEntryPath(entryPath);
      pendingPax = {};
      if (type === '1') fail(`archive header contains a hard link before extraction: ${entryPath}`);
      if (type === '2') fail(`archive header contains a symbolic link before extraction: ${entryPath}`);
      if (['3', '4', '6', '7'].includes(type)) {
        fail(`archive header contains a special entry before extraction: ${entryPath}`);
      }
      if (!['0', '5'].includes(type)) {
        fail(`archive header contains unsupported type ${JSON.stringify(type)} before extraction: ${entryPath}`);
      }
    }
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  fail('archive has no complete end marker before extraction');
}

function materializedTreeHash(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (current === root && entry.name === '.git') continue;
      const fullPath = path.join(current, entry.name);
      const relative = path.relative(root, fullPath).split(path.sep).join('/');
      const metadata = lstatSync(fullPath);
      if (metadata.isSymbolicLink()) fail(`symbolic link entry is forbidden: ${relative}`);
      if (metadata.isDirectory()) pending.push(fullPath);
      else if (metadata.isFile()) {
        files.push({ fullPath, relative, mode: metadata.mode & 0o111 ? '100755' : '100644' });
      }
      else fail(`special filesystem entry is forbidden: ${relative}`);
    }
  }
  const digest = createHash('sha256');
  for (const file of files.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0))) {
    digest.update(file.relative);
    digest.update('\0');
    digest.update(file.mode);
    digest.update('\0');
    digest.update(readFileSync(file.fullPath));
    digest.update('\0');
  }
  return digest.digest('hex');
}

function deterministicArchiveHash(sourceRoot, commit, archivePath) {
  run('git', ['archive', '--format=tar', '--output', archivePath, commit], { cwd: sourceRoot });
  return sha256File(archivePath);
}

function inspectGitCandidate(sourceRoot, sourceLock, archivePath) {
  const actualRemote = git(sourceRoot, 'remote', 'get-url', 'origin');
  if (actualRemote !== sourceLock.upstream) {
    fail(`remote URL differs from the source lock: ${actualRemote}`);
  }
  const head = git(sourceRoot, 'rev-parse', 'HEAD');
  if (head !== sourceLock.commit) fail(`HEAD ${head} is not locked commit ${sourceLock.commit}`);
  const headRef = symbolicHead(sourceRoot);
  if (headRef) fail(`checkout is not detached: ${headRef}`);
  const dirty = git(sourceRoot, 'status', '--porcelain=v1', '--untracked-files=all');
  if (dirty) fail(`dirty source tree detected: ${dirty.split('\n')[0]}`);
  const forbidden = listForbiddenGitEntries(sourceRoot);
  if (forbidden.symlinks.length > 0) fail(`symbolic link entry is forbidden: ${forbidden.symlinks[0]}`);
  if (forbidden.submodules.length > 0) fail(`unexpected Git submodule is forbidden: ${forbidden.submodules[0]}`);
  verifyNoFilesystemLinks(sourceRoot);
  const archiveSha256 = deterministicArchiveHash(sourceRoot, sourceLock.commit, archivePath);
  if (archiveSha256 !== sourceLock.source_tree_sha256) {
    fail(`archive SHA-256 ${archiveSha256} does not match lock ${sourceLock.source_tree_sha256}`);
  }
  return {
    commit: head,
    tree: git(sourceRoot, 'rev-parse', 'HEAD^{tree}'),
    archiveSha256,
    materializedTreeSha256: materializedTreeHash(sourceRoot),
  };
}

function readReceipt(receiptPath) {
  try {
    return JSON.parse(readFileSync(receiptPath, 'utf8'));
  } catch (error) {
    fail(`existing acquisition receipt is invalid: ${error.message}`);
  }
}

export function verifyAcquiredCandidate({ candidateRoot, sourceLock, lockBytes }) {
  const authority = parseAuthoritativeSourceLock({ sourceLock, lockBytes });
  sourceLock = authority.sourceLock;
  lockBytes = authority.lockBytes;
  const resolvedCandidate = requireAbsolute(candidateRoot, 'candidate root');
  const cacheRoot = path.dirname(resolvedCandidate);
  const receiptPath = path.join(cacheRoot, RECEIPT_NAME);
  if (!existsSync(resolvedCandidate) || !existsSync(receiptPath)) {
    fail('candidate source and acquisition receipt must both exist');
  }
  const receipt = readReceipt(receiptPath);
  const expectedLockHash = sha256Bytes(lockBytes);
  if (receipt.source_lock_sha256 !== expectedLockHash) fail('source lock changed after the first acquisition');
  if (receipt.commit !== sourceLock.commit || receipt.archive_sha256 !== sourceLock.source_tree_sha256) {
    fail('acquisition receipt does not match the current source lock');
  }

  if (receipt.acquisition_mode === 'network') {
    const archivePath = path.join(cacheRoot, `.verify-${randomUUID()}.tar`);
    try {
      const inspected = inspectGitCandidate(resolvedCandidate, sourceLock, archivePath);
      if (inspected.tree !== receipt.tree || inspected.materializedTreeSha256 !== receipt.materialized_tree_sha256) {
        fail('materialized candidate identity differs from its acquisition receipt');
      }
    } finally {
      rmSync(archivePath, { force: true });
    }
  } else if (receipt.acquisition_mode === 'offline-archive') {
    verifyNoFilesystemLinks(resolvedCandidate);
    if (materializedTreeHash(resolvedCandidate) !== receipt.materialized_tree_sha256) {
      fail('offline candidate contents changed after acquisition');
    }
  } else {
    fail(`unknown acquisition mode: ${receipt.acquisition_mode}`);
  }
  return receipt;
}

function acquireFromNetwork(stagingRoot, sourceLock, archivePath) {
  git(stagingRoot, 'init', '--quiet');
  git(stagingRoot, 'remote', 'add', 'origin', sourceLock.upstream);
  git(stagingRoot, 'fetch', '--quiet', '--no-tags', '--depth=1', 'origin', sourceLock.commit);
  git(stagingRoot, 'checkout', '--quiet', '--detach', 'FETCH_HEAD');
  return inspectGitCandidate(stagingRoot, sourceLock, archivePath);
}

function acquireFromOfflineArchive(stagingRoot, sourceLock, offlineArchive) {
  const archiveBytes = readFileSync(offlineArchive);
  const archiveSha256 = sha256Bytes(archiveBytes);
  if (archiveSha256 !== sourceLock.source_tree_sha256) {
    fail(`archive SHA-256 ${archiveSha256} does not match lock ${sourceLock.source_tree_sha256}`);
  }
  const embeddedCommit = run('git', ['get-tar-commit-id'], {
    input: archiveBytes,
  }).trim();
  if (embeddedCommit !== sourceLock.commit) {
    fail(`offline archive commit ${embeddedCommit || '<missing>'} is not locked commit ${sourceLock.commit}`);
  }
  inspectArchiveHeadersBeforeExtraction(archiveBytes);
  run('tar', ['-xf', offlineArchive, '-C', stagingRoot]);
  verifyNoFilesystemLinks(stagingRoot);

  const indexRoot = path.join(path.dirname(stagingRoot), `.index-${randomUUID()}`);
  try {
    mkdirSync(indexRoot);
    git(indexRoot, 'init', '--quiet', '--bare');
    run('git', [`--git-dir=${indexRoot}`, `--work-tree=${stagingRoot}`, 'add', '--all']);
    const tree = run('git', [`--git-dir=${indexRoot}`, 'write-tree']).trim();
    return {
      commit: sourceLock.commit,
      tree,
      archiveSha256,
      materializedTreeSha256: materializedTreeHash(stagingRoot),
    };
  } finally {
    rmSync(indexRoot, { recursive: true, force: true });
  }
}

export function acquireFrozenCore({ cacheRoot, offlineArchive, sourceLock, lockBytes } = {}) {
  const authority = parseAuthoritativeSourceLock({ sourceLock, lockBytes });
  sourceLock = authority.sourceLock;
  lockBytes = authority.lockBytes;
  const resolvedCacheRoot = requireAbsolute(cacheRoot, 'cache root');
  const resolvedOfflineArchive = offlineArchive === undefined
    ? undefined
    : requireAbsolute(offlineArchive, 'offline archive');
  if (resolvedOfflineArchive && (!existsSync(resolvedOfflineArchive) || !statSync(resolvedOfflineArchive).isFile())) {
    fail('offline archive does not exist or is not a regular file');
  }
  const actualLockBytes = lockBytes;
  const lockHash = sha256Bytes(actualLockBytes);
  const sourceRoot = path.join(resolvedCacheRoot, 'source');
  const receiptPath = path.join(resolvedCacheRoot, RECEIPT_NAME);

  if (existsSync(sourceRoot) || existsSync(receiptPath)) {
    return verifyAcquiredCandidate({ candidateRoot: sourceRoot, sourceLock, lockBytes: actualLockBytes });
  }

  mkdirSync(resolvedCacheRoot, { recursive: true });
  const unexpected = readdirSync(resolvedCacheRoot).filter((entry) => !entry.startsWith('.source-staging-'));
  if (unexpected.length > 0) fail(`cache root contains unexpected entry: ${unexpected[0]}`);

  const stagingRoot = path.join(resolvedCacheRoot, `.source-staging-${randomUUID()}`);
  const archivePath = path.join(resolvedCacheRoot, `.archive-${randomUUID()}.tar`);
  mkdirSync(stagingRoot);
  try {
    const inspected = resolvedOfflineArchive
      ? acquireFromOfflineArchive(stagingRoot, sourceLock, resolvedOfflineArchive)
      : acquireFromNetwork(stagingRoot, sourceLock, archivePath);
    const receipt = {
      schema_id: 'superwagie.viewer-source-acquisition.v1',
      acquisition_mode: resolvedOfflineArchive ? 'offline-archive' : 'network',
      upstream: sourceLock.upstream,
      version: sourceLock.version,
      commit: inspected.commit,
      tree: inspected.tree,
      archive_sha256: inspected.archiveSha256,
      source_lock_sha256: lockHash,
      materialized_tree_sha256: inspected.materializedTreeSha256,
    };
    renameSync(stagingRoot, sourceRoot);
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
    return receipt;
  } catch (error) {
    rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(archivePath, { force: true });
  }
}

export function parseAcquisitionArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name !== '--cache-root' && name !== '--offline-archive') {
      fail(`unsupported argument ${name}; source refs are commit-only and come from source-lock.json`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`${name} requires a value`);
    if (name === '--cache-root') options.cacheRoot = value;
    else options.offlineArchive = value;
    index += 1;
  }
  if (!options.cacheRoot) fail('--cache-root is required');
  return options;
}

function main() {
  const options = parseAcquisitionArgs(process.argv.slice(2));
  const lockBytes = readFileSync(LOCK_PATH);
  const sourceLock = JSON.parse(lockBytes.toString('utf8'));
  const receipt = acquireFrozenCore({ ...options, sourceLock, lockBytes });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
