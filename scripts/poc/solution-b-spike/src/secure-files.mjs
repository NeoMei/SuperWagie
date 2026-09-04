import { constants, lstatSync, mkdirSync, openSync, readSync, renameSync, closeSync, fstatSync, fsyncSync, writeSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const native = createRequire(import.meta.url)(process.platform === 'win32'
  ? `./native/secure-fs-native-${process.versions.electron ? 'electron' : 'node'}.node`
  : './native/secure-fs-native.node');

const noFollow = constants.O_NOFOLLOW ?? 0;
const directoryFlag = constants.O_DIRECTORY ?? (process.platform === 'win32' ? 0x40000000 : 0);

function syncDirectory(fd) {
  try { fsyncSync(fd); }
  catch (error) {
    // Windows does not expose a supported directory-flush operation through
    // libuv. File bytes are flushed before the handle-relative rename; the
    // Windows native rename remains atomic inside the already-open directory.
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
  }
}

function openAtSafe(directoryFd, leaf, flags, mode = 0) {
  try { return native.openAt(directoryFd, leaf, flags, mode); }
  catch (error) {
    if (error.code === 'SYMLINK_FORBIDDEN' || /Too many levels of symbolic links|Not a directory/.test(error.message)) throw new Error('SYMLINK_FORBIDDEN');
    if (error.code === 'EEXIST' || /File exists/.test(error.message)) throw new Error('EEXIST');
    throw error;
  }
}

function validateRelative(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\0') || isAbsolute(relativePath)) {
    throw new Error('RELATIVE_PATH_REQUIRED');
  }
  const logical = process.platform === 'win32' ? relativePath.replaceAll('\\', '/') : relativePath;
  const parts = logical.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..') || parts.join('/') !== logical) throw new Error('RELATIVE_PATH_REQUIRED');
  return parts;
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
    let closed = false;
    return { fd: current, close: () => {
      if (closed) return;
      closed = true;
      for (let index = descriptors.length - 1; index >= 0; index -= 1) closeSync(descriptors[index]);
    } };
  } catch (error) {
    for (const fd of descriptors.reverse()) closeSync(fd);
    if (error.code === 'ELOOP' || error.code === 'ENOTDIR') throw new Error('SYMLINK_FORBIDDEN');
    throw error;
  }
}

function openParent(root, relativePath) {
  const parts = validateRelative(relativePath);
  const leaf = parts.at(-1);
  const chain = openDirectoryChain(root, parts.slice(0, -1).join(sep));
  return { ...chain, leaf };
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
  const parts = validateRelative(relativePath);
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
      try { native.mkdirAt(chain.fd, part, 0o700); } catch (error) { if (error.code !== 'EEXIST' && !/File exists/.test(error.message)) throw error; }
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
  let sourceParent;
  let destinationParent;
  let sourceFd;
  let destinationFd;
  try {
    sourceParent = openParent(sourceRoot, sourceRelative);
    destinationParent = openParent(destinationRoot, destinationRelative);
    sourceFd = openAtSafe(sourceParent.fd, sourceParent.leaf, constants.O_RDONLY | noFollow, 0);
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
    syncDirectory(destinationParent.fd);
  } finally {
    if (destinationFd !== undefined) closeSync(destinationFd);
    if (sourceFd !== undefined) closeSync(sourceFd);
    destinationParent?.close();
    sourceParent?.close();
  }
}

export function secureReadByFd(root, relativePath, maxBytes = 16 * 1024 * 1024) {
  const parent = openParent(root, relativePath);
  let fd;
  try {
    fd = openAtSafe(parent.fd, parent.leaf, constants.O_RDONLY | noFollow, 0);
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
  } finally {
    if (fd !== undefined) closeSync(fd);
    parent.close();
  }
}

export function secureAtomicWrite(root, relativePath, bytes, { afterDestinationDirectoryOpen } = {}) {
  const parent = openParent(root, relativePath);
  try {
    afterDestinationDirectoryOpen?.({ dev: fstatSync(parent.fd).dev, ino: fstatSync(parent.fd).ino });
    try {
      const existingFd = openAtSafe(parent.fd, parent.leaf, constants.O_RDONLY | noFollow, 0);
      try { if (!fstatSync(existingFd).isFile()) throw new Error('UNSAFE_DESTINATION'); } finally { closeSync(existingFd); }
    } catch (error) {
      if (error.code !== 'ENOENT' && !/No such file/.test(error.message)) throw error;
    }
    const temporaryLeaf = `.${parent.leaf}.stage-${randomBytes(12).toString('hex')}`;
    const fd = openAtSafe(parent.fd, temporaryLeaf,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
    try { writeSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    native.renameAt(parent.fd, temporaryLeaf, parent.fd, parent.leaf);
    syncDirectory(parent.fd);
  } finally { parent.close(); }
}
