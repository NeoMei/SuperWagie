import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { MAX_FILE_BYTES, shouldIndex, walkLibrary } from './scan.js';

describe('shouldIndex', () => {
  it('accepts the supported formats', () => {
    for (const name of ['a.pdf', 'b.DOCX', 'c.md', 'd.txt', 'e.csv', 'f.pptx']) {
      expect(shouldIndex(`docs/${name}`, { size: 10 })).toEqual({ ok: true });
    }
  });

  it('rejects dependency, build, hidden and temp paths', () => {
    for (const relPath of ['node_modules/a.md', 'docs/dist/a.md', 'docs/.hidden/a.md', 'docs/~$a.docx', 'a.exe']) {
      expect(shouldIndex(relPath, { size: 10 })).toMatchObject({ ok: false });
    }
  });

  it('distinguishes unsupported from too large', () => {
    expect(shouldIndex('a.exe', { size: 1 })).toEqual({ ok: false, code: 'unsupported' });
    expect(shouldIndex('a.pdf', { size: MAX_FILE_BYTES + 1 })).toEqual({ ok: false, code: 'too_large' });
    expect(shouldIndex('a.pdf', { size: MAX_FILE_BYTES })).toEqual({ ok: true });
  });
});

describe('walkLibrary', () => {
  it('walks files, skips ignored directories and never follows symlinks', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sw-scan-'));
    await fs.mkdir(path.join(root, 'sub'));
    await fs.mkdir(path.join(root, 'node_modules'));
    await fs.mkdir(path.join(root, '.hidden'));
    await fs.writeFile(path.join(root, 'a.md'), 'x');
    await fs.writeFile(path.join(root, 'sub', 'b.txt'), 'y');
    await fs.writeFile(path.join(root, 'node_modules', 'c.md'), 'z');
    await fs.writeFile(path.join(root, '.hidden', 'd.md'), 'z');
    await fs.symlink(path.join(root, 'a.md'), path.join(root, 'link.md'));

    const files = await walkLibrary(root);
    expect(files.map((file) => file.relPath)).toEqual(['a.md', 'sub/b.txt']);
    expect(files[0]).toMatchObject({ absPath: path.join(root, 'a.md'), size: 1 });
    expect(typeof files[0].mtimeMs).toBe('number');
  });
});
