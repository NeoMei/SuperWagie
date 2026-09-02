import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left, right) {
  return sameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

function readExactSnapshot(fd, size, filePath) {
  const data = Buffer.alloc(Number(size));
  let offset = 0;
  while (offset < data.length) {
    const count = fs.readSync(fd, data, offset, data.length - offset, offset);
    if (count === 0) throw new Error('file truncated during read: ' + filePath);
    offset += count;
  }
  const overflowProbe = Buffer.alloc(1);
  if (fs.readSync(fd, overflowProbe, 0, 1, data.length) !== 0) {
    throw new Error('file grew during read: ' + filePath);
  }
  return data;
}

export function readStableRegularFileSync(filePath, maxBytes, options = {}) {
  const before = fs.lstatSync(filePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error('not a regular no-follow file: ' + filePath);
  }
  if (before.size > BigInt(maxBytes)) throw new Error('file exceeds size limit: ' + filePath);

  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameSnapshot(before, opened)) {
      throw new Error('file identity or metadata changed before read: ' + filePath);
    }
    if (opened.size > BigInt(maxBytes)) throw new Error('file exceeds size limit after open: ' + filePath);

    const firstBytes = readExactSnapshot(fd, opened.size, filePath);
    if (typeof options.afterFirstRead === 'function') options.afterFirstRead();
    const afterFirstRead = fs.fstatSync(fd, { bigint: true });
    const pathAfterFirstRead = fs.lstatSync(filePath, { bigint: true });
    if (!pathAfterFirstRead.isFile() || pathAfterFirstRead.isSymbolicLink() ||
        !sameSnapshot(opened, afterFirstRead) || !sameSnapshot(opened, pathAfterFirstRead)) {
      throw new Error('file identity, size, mtime, or ctime changed during read: ' + filePath);
    }

    const secondBytes = readExactSnapshot(fd, opened.size, filePath);
    const afterSecondRead = fs.fstatSync(fd, { bigint: true });
    const pathAfterSecondRead = fs.lstatSync(filePath, { bigint: true });
    if (!pathAfterSecondRead.isFile() || pathAfterSecondRead.isSymbolicLink() ||
        !sameSnapshot(afterFirstRead, afterSecondRead) || !sameSnapshot(afterFirstRead, pathAfterSecondRead) ||
        sha256(firstBytes) !== sha256(secondBytes)) {
      throw new Error('file bytes or metadata changed between stable reads: ' + filePath);
    }
    return firstBytes;
  } finally {
    fs.closeSync(fd);
  }
}

export function assertContainedDirectoryChainSync(root, segments) {
  const absoluteRoot = path.resolve(root);
  const rootStat = fs.lstatSync(absoluteRoot, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('containment root must be a real directory: ' + absoluteRoot);
  const realRoot = fs.realpathSync(absoluteRoot);

  let current = absoluteRoot;
  let expectedReal = realRoot;
  for (const segment of segments) {
    if (typeof segment !== 'string' || segment === '' || segment === '.' || segment === '..' ||
        segment.includes('/') || segment.includes('\\')) {
      throw new Error('invalid containment segment: ' + segment);
    }
    current = path.join(current, segment);
    expectedReal = path.join(expectedReal, segment);
    const currentStat = fs.lstatSync(current, { bigint: true });
    if (!currentStat.isDirectory() || currentStat.isSymbolicLink()) throw new Error('directory chain contains a symlink or non-directory: ' + current);
    if (fs.realpathSync(current) !== expectedReal) throw new Error('directory chain escapes containment root: ' + current);
  }
  return current;
}
