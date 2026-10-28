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

const TEXT_EXTENSIONS = new Set(['md', 'markdown', 'txt', 'csv']);
const IMAGE_HEAVY_EXTENSIONS = new Set(['pdf', 'ppt', 'pptx']);

// The bundled backend uses 512-unit chunks with a 50-unit overlap. A preview
// cannot parse every format, so token ranges come from file size and format.
// Binary office and PDF files are compressed; their text density varies much
// more than plain Markdown or text.
const TEXT_BYTES_PER_TOKEN = { min: 6, max: 2.5 };
const BINARY_BYTES_PER_TOKEN = { min: 80, max: 4 };
const MIN_TOKENS_PER_FILE = { min: 50, max: 300 };
const CHUNK_OVERLAP_FACTOR = 1.12;
const INDEX_CONCURRENCY = 2;
const SECONDS_PER_FILE = { min: 1.5, max: 15 };
const TOKENS_PER_SECOND = { min: 20_000, max: 5_000 };

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

const fileExtension = (relPath) => extensionOf(relPath);

/**
 * What the add-folder confirmation can tell the user before any file is parsed.
 * These are deliberately broad ranges: the provider and parser determine the
 * exact token count, and scanned documents may add OCR or vision calls.
 */
export function summarizeLibrary(files) {
  let indexable = 0;
  let skipped = 0;
  let imageHeavyFiles = 0;
  let tokensMin = 0;
  let tokensMax = 0;

  for (const file of files) {
    if (!shouldIndex(file.relPath, { size: file.size }).ok) {
      skipped += 1;
      continue;
    }
    indexable += 1;
    const extension = fileExtension(file.relPath);
    const size = Number.isFinite(file.size) && file.size > 0 ? file.size : 0;
    const text = TEXT_EXTENSIONS.has(extension);
    const bytesPerToken = text ? TEXT_BYTES_PER_TOKEN : BINARY_BYTES_PER_TOKEN;
    tokensMin += Math.max(MIN_TOKENS_PER_FILE.min, Math.ceil(size / bytesPerToken.min));
    tokensMax += Math.max(MIN_TOKENS_PER_FILE.max, Math.ceil(size / bytesPerToken.max));
    if (IMAGE_HEAVY_EXTENSIONS.has(extension)) imageHeavyFiles += 1;
  }

  tokensMin = Math.ceil(tokensMin * CHUNK_OVERLAP_FACTOR);
  tokensMax = Math.ceil(Math.max(tokensMin, tokensMax * CHUNK_OVERLAP_FACTOR));
  const fileSecondsMin = (indexable * SECONDS_PER_FILE.min) / INDEX_CONCURRENCY;
  const fileSecondsMax = (indexable * SECONDS_PER_FILE.max) / INDEX_CONCURRENCY;
  const secondsMin = Math.ceil(Math.max(fileSecondsMin, tokensMin / TOKENS_PER_SECOND.min));
  const secondsMax = Math.ceil(Math.max(fileSecondsMax, tokensMax / TOKENS_PER_SECOND.max));

  return {
    total: files.length,
    indexable,
    skipped,
    estimate: {
      tokensMin,
      tokensMax,
      secondsMin,
      secondsMax,
      imageHeavyFiles,
    },
  };
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
