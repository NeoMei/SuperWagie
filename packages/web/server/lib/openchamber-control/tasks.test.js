import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTask } from './tasks.js';

let dir;
let taskFile;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-tasks-'));
  taskFile = path.join(dir, 'tasks.md');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const services = () => {
  const upsert = vi.fn(async () => ({ task: { id: 'sch_1' } }));
  const resolveProjectID = vi.fn(async () => 'project-1');
  return {
    upsert,
    resolveProjectID,
    scheduledTaskService: { upsert },
  };
};

describe('createTask', () => {
  it('adds a todo without a due time and schedules nothing', async () => {
    const { upsert, ...rest } = services();
    const result = await createTask({ taskFile, input: { taskTitle: '写周报' }, ...rest });
    expect(upsert).not.toHaveBeenCalled();
    expect(result.task.scheduleId).toBe('');
    const line = fs.readFileSync(taskFile, 'utf8');
    expect(line).toContain('- [ ] 写周报');
    expect(line).toContain('"origin":"agent"');
  });

  it('creates a one-off notification reminder when the due time has a time', async () => {
    const { upsert, resolveProjectID, ...rest } = services();
    const result = await createTask({ taskFile, input: { taskTitle: '交报告', taskDue: '2026-10-22T15:30' }, ...rest, resolveProjectID });
    expect(resolveProjectID).toHaveBeenCalledWith({ projectId: 'openchamber:chats' });
    expect(upsert).toHaveBeenCalledWith('project-1', expect.objectContaining({
      schedule: { kind: 'once', date: '2026-10-22', time: '15:30' },
      execution: expect.objectContaining({ kind: 'notify', prompt: '交报告' }),
    }));
    expect(result.task.scheduleId).toBe('sch_1');
    expect(fs.readFileSync(taskFile, 'utf8')).toContain('"schedule":"sch_1"');
  });

  it('schedules a 09:00 reminder when only a date is given', async () => {
    const { upsert, resolveProjectID } = services();
    const result = await createTask({ taskFile, input: { taskTitle: '吃饭', taskDue: '2026-10-22' }, resolveProjectID, scheduledTaskService: { upsert } });
    expect(upsert).toHaveBeenCalledWith('project-1', expect.objectContaining({
      schedule: { kind: 'once', date: '2026-10-22', time: '09:00' },
      execution: expect.objectContaining({ kind: 'notify' }),
    }));
    expect(result.task.dueTime).toBe('09:00');
    expect(fs.readFileSync(taskFile, 'utf8')).toContain('"dueTime":"09:00"');
  });

  it('falls back to the session directory when the chats scope is unavailable', async () => {
    const { upsert } = services();
    const resolveProjectID = vi.fn(async ({ projectId }) => {
      if (projectId === 'openchamber:chats') throw new Error('no chats scope');
      return 'project-2';
    });
    await createTask({
      taskFile,
      input: { taskTitle: '开会', taskDue: '2026-10-22T09:00' },
      directory: '/repo',
      resolveProjectID,
      scheduledTaskService: { upsert },
    });
    expect(resolveProjectID).toHaveBeenLastCalledWith({ directory: '/repo' });
    expect(upsert).toHaveBeenCalledWith('project-2', expect.anything());
  });

  it('rejects a malformed due value', async () => {
    const { ...rest } = services();
    await expect(createTask({ taskFile, input: { taskTitle: 'x', taskDue: 'tomorrow' }, ...rest }))
      .rejects.toThrow('taskDue');
  });
});
