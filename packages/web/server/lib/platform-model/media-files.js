import crypto from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const fileTypes = new Map([
  ['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp'],
  ['audio/wav', 'wav'], ['audio/mpeg', 'mp3'], ['audio/mp3', 'mp3'], ['video/mp4', 'mp4'],
]);
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const within = (root, target) => {
  const relative = path.relative(root, target);
  return Boolean(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
};

export async function mediaWorkspace(workspacePath) {
  if (typeof workspacePath !== 'string' || !path.isAbsolute(workspacePath)) throw new Error('media workspace unavailable');
  const root = await fs.realpath(workspacePath);
  if (root === path.parse(root).root || !(await fs.stat(root)).isDirectory()) throw new Error('media workspace unavailable');
  return root;
}

export async function readMediaWorkspaceFile(root, filename, limit) {
  const canonical = await fs.realpath(path.resolve(root, filename));
  if (!within(root, canonical)) throw new Error('media file outside workspace');
  const handle = await fs.open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !stat.size || stat.size > limit) throw new Error('invalid media file');
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw new Error('media file changed');
    return buffer.subarray(0, offset);
  } finally { await handle.close(); }
}

export async function publishMediaArtifact(root, callID, sessionID, bytes, contentType) {
  const extension = fileTypes.get(contentType);
  if (!extension || bytes.length === 0 || bytes.length > 64 * 1024 * 1024) throw new Error('invalid media artifact');
  if (await mediaWorkspace(root) !== root) throw new Error('media workspace changed');
  const basename = 'superwagie-media-' + sha256(JSON.stringify([sessionID, callID])).slice(0, 24) + '.' + extension;
  const target = path.join(root, basename);
  const digest = sha256(bytes);
  const temporary = path.join(root, '.superwagie-media-' + crypto.randomUUID() + '.tmp');
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    try { await fs.link(temporary, target); }
    catch (error) {
      if (error.code !== 'EEXIST' || (await fs.lstat(target)).isSymbolicLink()) throw error;
      const original = await readMediaWorkspaceFile(root, basename, bytes.length);
      if (sha256(original) !== digest) throw new Error('media artifact already exists with different bytes');
    }
  } finally { await fs.rm(temporary, { force: true }); }
  return { path: target, contentType, sha256: digest };
}
