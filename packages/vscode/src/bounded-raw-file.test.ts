import { afterEach, describe, expect, test } from 'bun:test';
import { appendFile, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRawFileByteLimit, RawFileSizeError, readBoundedRawFile } from './bounded-raw-file';

let directory = '';
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); directory = ''; });
const file = async (content: string) => {
  directory = await mkdtemp(join(tmpdir(), 'office-raw-'));
  const path = join(directory, 'sample.xlsx');
  await writeFile(path, content);
  return path;
};

describe('native preview byte bound', () => {
  test('validates an optional single positive decimal safe integer', () => {
    expect(parseRawFileByteLimit(new URLSearchParams())).toBeUndefined();
    expect(parseRawFileByteLimit(new URLSearchParams('maxBytes=31457280'))).toBe(31457280);
    for (const query of ['maxBytes=', 'maxBytes=0', 'maxBytes=-1', 'maxBytes=1.2', 'maxBytes=1e3', 'maxBytes=Infinity', 'maxBytes=9007199254740992', 'maxBytes=2&maxBytes=3']) {
      expect(() => parseRawFileByteLimit(new URLSearchParams(query))).toThrow();
    }
  });

  test('accepts exact bytes and rejects a file already over the limit', async () => {
    const path = await file('four');
    const handle = await open(path, 'r');
    try {
      expect((await readBoundedRawFile(handle, 4)).toString()).toBe('four');
      await expect(readBoundedRawFile(handle, 3)).rejects.toBeInstanceOf(RawFileSizeError);
    } finally { await handle.close(); }
  });

  test('rejects actual file growth after stat without returning bytes for base64', async () => {
    const path = await file('four');
    const handle = await open(path, 'r');
    try {
      const source = {
        stat: async () => { const stats = await handle.stat(); await appendFile(path, '!'); return stats; },
        read: handle.read.bind(handle),
      };
      await expect(readBoundedRawFile(source, 4)).rejects.toBeInstanceOf(RawFileSizeError);
    } finally { await handle.close(); }
  });
});
