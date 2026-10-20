import { describe, expect, test } from 'bun:test';

import { loadTasks, saveTasks, type TaskFileHost } from './store.ts';

interface FakeFile {
  content: string;
}

const fakeHost = (initial: FakeFile | null) => {
  const files = new Map<string, FakeFile>();
  if (initial) files.set('~/.config/openchamber/tasks.md', { ...initial });
  const written: string[] = [];
  const host: TaskFileHost = {
    stat: async (path: string) => {
      const file = files.get(path);
      return file ? { kind: 'file', size: file.content.length, mtime: 1 } : { kind: 'missing', size: 0, mtime: 0 };
    },
    readFile: async (path: string) => {
      const file = files.get(path);
      if (!file) throw new Error('missing');
      return { content: file.content };
    },
    writeFile: async (path: string, content: string) => {
      files.set(path, { content });
      written.push(content);
      return { written: true as const };
    },
  };
  return { host, files, written };
};

describe('task file writes', () => {
  test('creates a missing global file on first write', async () => {
    const { host, files } = fakeHost(null);
    const loaded = await loadTasks(host, 'global');
    expect(loaded?.exists).toBe(false);
    const result = await saveTasks(host, loaded!, '- [ ] 第一条任务\n');
    expect(result.ok).toBe(true);
    expect(files.get('~/.config/openchamber/tasks.md')?.content).toBe('- [ ] 第一条任务\n');
  });

  test('refuses to overwrite a file changed elsewhere', async () => {
    const { host, files } = fakeHost({ content: '- [ ] 原任务\n' });
    const loaded = await loadTasks(host, 'global');
    files.set('~/.config/openchamber/tasks.md', { content: '- [ ] 别人改过的任务\n' });
    const result = await saveTasks(host, loaded!, '- [ ] 覆盖\n');
    expect(result).toEqual({ ok: false, reason: 'conflict' });
  });

  test('a project path without an open project reads as null', async () => {
    const host: TaskFileHost = {
      stat: async () => { throw new Error('NO_DIRECTORY'); },
      readFile: async () => { throw new Error('NO_DIRECTORY'); },
      writeFile: async () => ({ written: true as const }),
    };
    expect(await loadTasks(host, 'project')).toBeNull();
  });
});
