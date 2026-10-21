import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCreationProject } from './creation.js';

const setup = async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-creation-'));
  const activate = vi.fn(async (target) => ({ projectId: `id-${path.basename(target)}`, path: target }));
  return { home, activate };
};

describe('createCreationProject', () => {
  it('creates the category folder, writes the brief and activates it', async () => {
    const { home, activate } = await setup();
    const result = await createCreationProject({
      fsPromises: fs, homedir: () => home, activate,
      kind: 'deck', title: '季度汇报', brief: '# 季度汇报\n', now: new Date(2026, 9, 21),
    });
    expect(result.path).toBe(path.join(home, 'Documents', 'SuperWagie', 'PPT', '季度汇报 2026-10-21'));
    expect(await fs.readFile(path.join(result.path, '需求.md'), 'utf8')).toBe('# 季度汇报\n');
    expect(activate).toHaveBeenCalledWith(result.path);
    expect(result.projectId).toBe('id-季度汇报 2026-10-21');
  });

  it('suffixes a duplicate title on the same day', async () => {
    const { home, activate } = await setup();
    const base = { fsPromises: fs, homedir: () => home, activate, kind: 'doc', title: '方案', brief: 'x', now: new Date(2026, 9, 21) };
    const first = await createCreationProject(base);
    const second = await createCreationProject(base);
    expect(second.path).toBe(`${first.path}-2`);
  });

  it('sanitizes separators and refuses an unknown kind', async () => {
    const { home, activate } = await setup();
    const result = await createCreationProject({ ...{ fsPromises: fs, homedir: () => home, activate, brief: 'x', now: new Date(2026, 9, 21) }, kind: 'doc', title: 'a/b:c' });
    expect(path.basename(result.path)).toBe('a-b-c 2026-10-21');
    await expect(createCreationProject({ fsPromises: fs, homedir: () => home, activate, kind: 'zip', title: 'x', brief: 'x' })).rejects.toThrow('unknown-kind');
  });

  it('refuses prototype-chain kinds', async () => {
    const { home, activate } = await setup();
    await expect(createCreationProject({ fsPromises: fs, homedir: () => home, activate, kind: 'constructor', title: 'x', brief: 'x' })).rejects.toThrow('unknown-kind');
  });

  it('keeps a traversal title inside the category root', async () => {
    const { home, activate } = await setup();
    const result = await createCreationProject({ fsPromises: fs, homedir: () => home, activate, kind: 'doc', title: '../../x', brief: 'x', now: new Date(2026, 9, 21) });
    expect(path.dirname(result.path)).toBe(path.join(home, 'Documents', 'SuperWagie', '文档'));
  });

  it('falls back to 未命名 for a title that is only dots', async () => {
    const { home, activate } = await setup();
    const base = { fsPromises: fs, homedir: () => home, activate, kind: 'doc', brief: 'x', now: new Date(2026, 9, 21) };
    expect(path.basename((await createCreationProject({ ...base, title: '..' })).path)).toBe('未命名 2026-10-21');
    const dotted = path.basename((await createCreationProject({ ...base, title: '. . .' })).path);
    expect(dotted.startsWith('.')).toBe(false);
  });

  it('removes the new folder when activation fails', async () => {
    const { home } = await setup();
    const activate = vi.fn(async () => { throw new Error('activation failed'); });
    await expect(createCreationProject({ fsPromises: fs, homedir: () => home, activate, kind: 'video', title: '片', brief: 'x', now: new Date(2026, 9, 21) })).rejects.toThrow('activation failed');
    expect(await fs.readdir(path.join(home, 'Documents', 'SuperWagie', '视频'))).toEqual([]);
  });

  it('removes the new folder when writing the brief fails', async () => {
    const { home } = await setup();
    const failingFs = {
      mkdir: fs.mkdir,
      rm: fs.rm,
      writeFile: async () => { throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }); },
    };
    const activate = vi.fn();
    const error = await createCreationProject({ fsPromises: failingFs, homedir: () => home, activate, kind: 'doc', title: '方案', brief: 'x', now: new Date(2026, 9, 21) }).catch((caught) => caught);
    expect(error.message).toBe('create-failed');
    expect(error.statusCode).toBe(500);
    expect(activate).not.toHaveBeenCalled();
    expect(await fs.readdir(path.join(home, 'Documents', 'SuperWagie', '文档'))).toEqual([]);
  });
});
