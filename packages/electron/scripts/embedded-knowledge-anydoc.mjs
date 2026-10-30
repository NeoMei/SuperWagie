import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { assertNoKnowledgeSymlinks } from './embedded-knowledge-source.mjs';
import integrityPolicy from './embedded-knowledge-policy.cjs';

// Official crates.io sparse-index checksum; see vendor/README.md for provenance.
const { ANYDOC_SOURCE_POLICY, matchesAnyDocSourcePolicy } = integrityPolicy;
const { version, sourceSha256 } = ANYDOC_SOURCE_POLICY;
const archive = fileURLToPath(new URL(`./vendor/anydoc-${version}.crate`, import.meta.url));
const digest = (data) => crypto.createHash('sha256').update(data).digest('hex');

function verifiedPatchedFiles(archivePath) {
  const archiveInfo = fs.lstatSync(archivePath);
  if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink() || archiveInfo.nlink !== 1 || archiveInfo.size > 1024 * 1024) {
    throw new Error('AnyDoc archive must be an unlinked regular file within the reviewed size limit');
  }
  const compressed = fs.readFileSync(archivePath);
  if (digest(compressed) !== sourceSha256) throw new Error('AnyDoc archive checksum does not match the official fixed checksum');
  const tar = gunzipSync(compressed, { maxOutputLength: 2 * 1024 * 1024 });
  const files = new Map();
  let offset = 0;
  // Validate the complete archive before creating directories or writing files.
  // This published crate uses only regular ustar entries; no extension records,
  // links, devices, absolute paths, traversal or duplicate names are accepted.
  while (offset + 512 <= tar.length && tar.subarray(offset, offset + 512).some((byte) => byte !== 0)) {
    const header = tar.subarray(offset, offset + 512);
    const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const octal = (start, length) => {
      const value = field(start, length).trim();
      if (!/^[0-7]+$/.test(value)) throw new Error('AnyDoc archive contains an invalid numeric header');
      return Number.parseInt(value, 8);
    };
    let checksum = 0;
    for (let index = 0; index < 512; index += 1) checksum += index >= 148 && index < 156 ? 32 : header[index];
    const name = field(0, 100);
    const prefix = `anydoc-${version}/`;
    const relative = name.slice(prefix.length);
    const size = octal(124, 12);
    const mode = octal(100, 8);
    if (checksum !== octal(148, 8) || !name.startsWith(prefix)
      || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(relative)
      || relative.split('/').some((part) => part === '.' || part === '..')
      || header[156] !== 48 || field(157, 100) || field(345, 155)
      || mode !== 0o644 || files.has(relative) || offset + 512 + size > tar.length) {
      throw new Error(`AnyDoc archive contains an unsafe or unexpected entry: ${name}`);
    }
    files.set(relative, Buffer.from(tar.subarray(offset + 512, offset + 512 + size)));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (files.size !== 83 || tar.length - offset < 1024 || tar.subarray(offset).some((byte) => byte !== 0)) {
    throw new Error('AnyDoc archive has an unexpected entry count or trailer');
  }
  const original = files.get('src/lib.rs')?.toString('utf8');
  const importLine = /^use render::markdown::document_to_markdown;$/gm;
  if (!original || [...original.matchAll(importLine)].length !== 1) throw new Error('AnyDoc re-export patch no longer matches the reviewed source');
  files.set('src/lib.rs', Buffer.from(original.replace(importLine, 'pub use render::markdown::document_to_markdown;')));
  files.set('.weknora-patched', Buffer.from(`${version}\n`));
  return files;
}

function expectedAnyDocTree(archivePath) {
  const files = verifiedPatchedFiles(archivePath);
  const directories = new Set(['']);
  for (const name of files.keys()) {
    let parent = path.posix.dirname(name);
    while (parent !== '.') {
      if (files.has(parent)) throw new Error('AnyDoc archive has conflicting file and directory paths');
      directories.add(parent); parent = path.posix.dirname(parent);
    }
  }
  const hash = crypto.createHash('sha256');
  for (const name of [...directories].sort()) hash.update(`directory\x00${name}\x00755\x00`);
  for (const name of [...files.keys()].sort()) {
    const bytes = files.get(name);
    hash.update(`file\x00${name}\x00644\x00${bytes.length}\x00`).update(bytes);
  }
  const identity = { version, sourceSha256, patchedTreeSha256: hash.digest('hex') };
  if (!matchesAnyDocSourcePolicy(identity)) throw new Error('Derived AnyDoc tree does not match the reviewed source policy');
  return {
    files, directories,
    identity,
  };
}

function anyDocTree(sourceDir, archivePath) {
  const crateDir = path.join(sourceDir, 'third_party', 'anydoc-go');
  assertNoKnowledgeSymlinks(crateDir, sourceDir);
  const manifest = fs.readFileSync(path.join(crateDir, 'Cargo.toml'), 'utf8');
  if (!/^anydoc = "=0\.2\.4"\s*$/m.test(manifest)) throw new Error('AnyDoc dependency pin is outside the reviewed version policy');
  return { ...expectedAnyDocTree(archivePath), directory: path.join(crateDir, 'patched-anydoc') };
}

export function anyDocSourceIdentity() {
  return expectedAnyDocTree(archive).identity;
}

function verifyTree({ directory, files, directories }) {
  const pending = [''];
  let fileCount = 0;
  let directoryCount = 0;
  while (pending.length) {
    const relative = pending.pop();
    const absolute = path.join(directory, relative);
    const info = fs.lstatSync(absolute);
    if (info.isSymbolicLink()) throw new Error(`AnyDoc source integrity mismatch (symbolic link): ${absolute}; preserve it for review`);
    if (info.isDirectory()) {
      if (!directories.has(relative) || (process.platform !== 'win32' && (info.mode & 0o7777) !== 0o755)) {
        throw new Error(`AnyDoc source integrity mismatch (directory or mode): ${absolute}; preserve it for review`);
      }
      directoryCount += 1;
      for (const child of fs.readdirSync(absolute)) pending.push(relative ? `${relative}/${child}` : child);
    } else {
      const expected = files.get(relative);
      if (!info.isFile() || info.nlink !== 1 || !expected || info.size !== expected.length
        || (process.platform !== 'win32' && (info.mode & 0o7777) !== 0o644)
        || !fs.readFileSync(absolute).equals(expected)) {
        throw new Error(`AnyDoc source integrity mismatch (file, link, content or mode): ${absolute}; preserve it for review`);
      }
      fileCount += 1;
    }
  }
  if (fileCount !== files.size || directoryCount !== directories.size) {
    throw new Error('AnyDoc source integrity mismatch (missing entries); preserve it for review');
  }
}

// The upstream marker is only a control-flow switch, never proof of integrity.
// Unknown or partial cached trees are refused intact rather than overwritten.
export function prepareVerifiedAnyDocSource(sourceDir, { archivePath = archive } = {}) {
  const tree = anyDocTree(sourceDir, archivePath);
  let exists = true;
  try { fs.lstatSync(tree.directory); }
  catch (error) { if (error.code !== 'ENOENT') throw error; exists = false; }
  if (!exists) {
    fs.mkdirSync(tree.directory, { mode: 0o755 });
    for (const relative of [...tree.directories].filter(Boolean).sort()) fs.mkdirSync(path.join(tree.directory, relative), { mode: 0o755 });
    for (const relative of tree.directories) fs.chmodSync(path.join(tree.directory, relative), 0o755);
    for (const [relative, bytes] of tree.files) {
      const file = path.join(tree.directory, relative);
      fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o644 });
      fs.chmodSync(file, 0o644);
    }
  }
  verifyTree(tree);
  return tree.identity;
}

export function verifyAnyDocSource(sourceDir, { archivePath = archive } = {}) {
  const tree = anyDocTree(sourceDir, archivePath);
  verifyTree(tree);
  return tree.identity;
}
