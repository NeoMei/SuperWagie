import { constants, lstatSync, mkdirSync, openSync, readSync, renameSync, closeSync, fstatSync, fsyncSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const native = createRequire(import.meta.url)('./native/secure-fs-native.node');

const noFollow = constants.O_NOFOLLOW ?? 0;
const directoryFlag = constants.O_DIRECTORY ?? 0;

function openAtSafe(directoryFd, leaf, flags, mode = 0) {
  try { return native.openAt(directoryFd, leaf, flags, mode); }
  catch (error) {
    if (/Too many levels of symbolic links|Not a directory/.test(error.message)) throw new Error('SYMLINK_FORBIDDEN');
    if (/File exists/.test(error.message)) throw new Error('EEXIST');
    throw error;
  }
}

function validateRelative(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || isAbsolute(relativePath)
    || normalize(relativePath) !== relativePath || relativePath.split(sep).includes('..')) throw new Error('RELATIVE_PATH_REQUIRED');
  return relativePath.split(sep);
}

function openDirectoryChain(root, relativeDirectory = '') {
  const descriptors = [];
  const rootFd = openSync(root, constants.O_RDONLY | directoryFlag | noFollow);
  descriptors.push(rootFd);
  let current = rootFd;
  try {
    if (relativeDirectory) {
      for (const part of validateRelative(relativeDirectory)) {
        const next = openAtSafe(current, part, constants.O_RDONLY | directoryFlag | noFollow, 0);
        descriptors.push(next);
        current = next;
      }
    }
    return { fd: current, close: () => { for (const fd of descriptors.reverse()) closeSync(fd); } };
  } catch (error) {
    for (const fd of descriptors.reverse()) closeSync(fd);
    if (error.code === 'ELOOP' || error.code === 'ENOTDIR') throw new Error('SYMLINK_FORBIDDEN');
    throw error;
  }
}

function openParent(root, relativePath) {
  validateRelative(relativePath);
  const parent = dirname(relativePath);
  const chain = openDirectoryChain(root, parent === '.' ? '' : parent);
  return { ...chain, leaf: basename(relativePath) };
}

export function privateDirectory(path) {
  mkdirSync(path, { recursive: false, mode: 0o700 });
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) throw new Error('PRIVATE_DIRECTORY_REQUIRED');
}

export function resolvePrivate(root, relativePath, { leafMayBeMissing = false } = {}) {
  validateRelative(relativePath);
  const target = join(root, relativePath);
  if (relative(root, target).startsWith('..') || isAbsolute(relative(root, target))) throw new Error('PATH_ESCAPES_ROOT');
  let current = root;
  const parts = relativePath.split(sep);
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]);
    try {
      const metadata = lstatSync(current);
      if (metadata.isSymbolicLink()) throw new Error('SYMLINK_FORBIDDEN');
      if (index < parts.length - 1 && !metadata.isDirectory()) throw new Error('NON_DIRECTORY_COMPONENT');
    } catch (error) {
      if (error.code === 'ENOENT' && leafMayBeMissing && index === parts.length - 1) break;
      throw error;
    }
  }
  return target;
}

export function secureMkdirs(root, relativePath) {
  const parts = validateRelative(relativePath);
  let chain = openDirectoryChain(root);
  try {
    for (const part of parts) {
      try { native.mkdirAt(chain.fd, part, 0o700); } catch (error) { if (!/File exists/.test(error.message)) throw error; }
      const next = openAtSafe(chain.fd, part, constants.O_RDONLY | directoryFlag | noFollow, 0);
      chain.close();
      chain = { fd: next, close: () => closeSync(next) };
    }
  } catch (error) {
    if (error.code === 'ELOOP' || error.code === 'ENOTDIR') throw new Error('SYMLINK_FORBIDDEN');
    throw error;
  } finally {
    chain.close();
  }
}

export function secureCopyByFd(sourceRoot, sourceRelative, destinationRoot, destinationRelative,
  { afterSourceOpen, afterDestinationDirectoryOpen } = {}) {
  const sourceParent = openParent(sourceRoot, sourceRelative);
  const destinationParent = openParent(destinationRoot, destinationRelative);
  const sourceFd = openAtSafe(sourceParent.fd, sourceParent.leaf, constants.O_RDONLY | noFollow, 0);
  let destinationFd;
  try {
    const before = fstatSync(sourceFd);
    if (!before.isFile()) throw new Error('REGULAR_SOURCE_REQUIRED');
    afterSourceOpen?.({ dev: before.dev, ino: before.ino, size: before.size });
    afterDestinationDirectoryOpen?.({ dev: fstatSync(destinationParent.fd).dev, ino: fstatSync(destinationParent.fd).ino });
    destinationFd = openAtSafe(destinationParent.fd, destinationParent.leaf,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes;
    while ((bytes = readSync(sourceFd, buffer, 0, buffer.length, null)) > 0) writeSync(destinationFd, buffer, 0, bytes);
    fsyncSync(destinationFd);
    const after = fstatSync(sourceFd);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('SOURCE_CHANGED_DURING_COPY');
  } finally {
    if (destinationFd !== undefined) closeSync(destinationFd);
    closeSync(sourceFd);
    sourceParent.close();
  }
  try { fsyncSync(destinationParent.fd); } finally { destinationParent.close(); }
}

export function secureReadByFd(root, relativePath, maxBytes = 16 * 1024 * 1024) {
  const parent = openParent(root, relativePath);
  const fd = openAtSafe(parent.fd, parent.leaf, constants.O_RDONLY | noFollow, 0);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > maxBytes) throw new Error('BOUNDED_REGULAR_FILE_REQUIRED');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(fd);
    if (offset !== before.size || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('SOURCE_CHANGED_DURING_READ');
    return bytes;
  } finally { closeSync(fd); parent.close(); }
}

export function secureAtomicWrite(root, relativePath, bytes, { afterDestinationDirectoryOpen } = {}) {
  const parent = openParent(root, relativePath);
  afterDestinationDirectoryOpen?.({ dev: fstatSync(parent.fd).dev, ino: fstatSync(parent.fd).ino });
  try {
    const existingFd = openAtSafe(parent.fd, parent.leaf, constants.O_RDONLY | noFollow, 0);
    try { if (!fstatSync(existingFd).isFile()) throw new Error('UNSAFE_DESTINATION'); } finally { closeSync(existingFd); }
  } catch (error) {
    if (!/No such file/.test(error.message)) { parent.close(); throw error; }
  }
  const temporaryLeaf = `.${parent.leaf}.stage-${randomBytes(12).toString('hex')}`;
  const fd = openAtSafe(parent.fd, temporaryLeaf,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
  try { writeSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  native.renameAt(parent.fd, temporaryLeaf, parent.fd, parent.leaf);
  try { fsyncSync(parent.fd); } finally { parent.close(); }
}
