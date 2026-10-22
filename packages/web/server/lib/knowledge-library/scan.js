/**
 * What belongs in a library, and how the tree is walked.
 *
 * The rules are deliberately conservative: only formats the backend parses
 * well, never a symlink, never a dependency or build directory, and never a
 * file over the backend's upload cap. A file outside the rules is still
 * reported by the scan flow as skipped, so the panel can explain it instead of
 * staying silent.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

export const MAX_FILE_BYTES = 50 * 1024 * 1024;

const ALLOWED_EXTENSIONS = new Set([
  'pdf',
  'doc',
  'docx',
  'ppt',
  'pptx',
  'xls',
  'xlsx',
  'odt',
  'odp',
  'ods',
  'rtf',
  'epub',
  'md',
  'markdown',
  'txt',
  'csv',
]);

const IGNORED_SEGMENTS = new Set(['node_modules', 'dist', 'build', 'target', 'vendor', '__pycache__', 'coverage']);

const extensionOf = (relPath) => {
  const name = relPath.slice(relPath.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
};

export function shouldIndex(relPath, { size } = {}) {
  const segments = relPath.split('/').filter(Boolean);
  if (segments.some((segment) => segment.startsWith('.') || IGNORED_SEGMENTS.has(segment))) {
    return { ok: false, code: 'ignored' };
  }
  const name = segments[segments.length - 1] ?? '';
  if (name.startsWith('~$')) return { ok: false, code: 'ignored' };
  if (!ALLOWED_EXTENSIONS.has(extensionOf(relPath))) return { ok: false, code: 'unsupported' };
  const parsedSize = z.number().safeParse(size);
  if (parsedSize.success && parsedSize.data > MAX_FILE_BYTES) return { ok: false, code: 'too_large' };
  return { ok: true };
}

export async function walkLibrary(root, { fsPromises = fsp } = {}) {
  const files = [];

  const walk = async (directory, prefix) => {
    const entries = await fsPromises.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || IGNORED_SEGMENTS.has(entry.name)) continue;
        await walk(absPath, relPath);
        continue;
      }
      if (!entry.isFile()) continue;

      const stat = await fsPromises.lstat(absPath);
      files.push({ relPath, absPath, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  };

  await walk(root, '');
  return files;
}
