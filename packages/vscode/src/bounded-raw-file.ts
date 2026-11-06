import type { FileHandle } from 'node:fs/promises';

export class RawFileSizeError extends Error {
  constructor() { super('File exceeds the preview byte limit'); this.name = 'RawFileSizeError'; }
}

export const parseRawFileByteLimit = (params: URLSearchParams): number | undefined => {
  const values = params.getAll('maxBytes');
  if (values.length === 0) return undefined;
  const value = values[0];
  if (values.length !== 1 || !value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
    throw new Error('maxBytes must be a single positive safe integer');
  }
  return Number(value);
};

/** The caller owns this handle. The read counts actual bytes even if stat becomes stale. */
export const readBoundedRawFile = async (file: Pick<FileHandle, 'stat' | 'read'>, maxBytes: number): Promise<Buffer> => {
  const stats = await file.stat();
  if (stats.size > maxBytes) throw new RawFileSizeError();
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    // Read at most one extra byte to detect a file growing beyond the bound.
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes - size + 1));
    const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    size += bytesRead;
    if (size > maxBytes) throw new RawFileSizeError();
    chunks.push(chunk.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, size);
};
