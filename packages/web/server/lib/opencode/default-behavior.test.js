import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { BEHAVIOR_FILE_NAME, DEFAULT_BEHAVIOR, ensureDefaultBehavior } from './default-behavior.js';

const roots = [];

const configDir = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-behavior-'));
  roots.push(root);
  return path.join(root, 'opencode');
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('ensureDefaultBehavior', () => {
  it('writes the Chinese default and creates the config directory', async () => {
    const dir = await configDir();
    const result = await ensureDefaultBehavior({ fsPromises: fs, configDir: dir });

    expect(result).toEqual({ written: true, path: path.join(dir, BEHAVIOR_FILE_NAME) });
    expect(await fs.readFile(result.path, 'utf8')).toBe(DEFAULT_BEHAVIOR);
    expect(DEFAULT_BEHAVIOR).toContain('始终使用简体中文回答');
    expect(DEFAULT_BEHAVIOR).toContain('代码、命令、文件路径、标识符保持原样');
  });

  it('leaves an existing behavior file untouched', async () => {
    const dir = await configDir();
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, BEHAVIOR_FILE_NAME);
    await fs.writeFile(file, '用户自己的规则\n', 'utf8');

    const result = await ensureDefaultBehavior({ fsPromises: fs, configDir: dir });

    expect(result.written).toBe(false);
    expect(await fs.readFile(file, 'utf8')).toBe('用户自己的规则\n');
  });

  it('treats an empty existing file as a user choice, not an absence', async () => {
    const dir = await configDir();
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, BEHAVIOR_FILE_NAME);
    await fs.writeFile(file, '', 'utf8');

    expect((await ensureDefaultBehavior({ fsPromises: fs, configDir: dir })).written).toBe(false);
    expect(await fs.readFile(file, 'utf8')).toBe('');
  });

  it('is idempotent', async () => {
    const dir = await configDir();
    await ensureDefaultBehavior({ fsPromises: fs, configDir: dir });
    expect((await ensureDefaultBehavior({ fsPromises: fs, configDir: dir })).written).toBe(false);
  });
});
