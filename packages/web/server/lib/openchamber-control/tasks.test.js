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
  return {
    upsert,
    scheduledTaskService: { upsert },
    resolveProjectID: async () => 'project-1',
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
    const { upsert, ...rest } = services();
    const result = await createTask({ taskFile, input: { taskTitle: '交报告', taskDue: '2026-10-22T15:30' }, ...rest });
    expect(upsert).toHaveBeenCalledWith('project-1', expect.objectContaining({
      schedule: { kind: 'once', date: '2026-10-22', time: '15:30' },
      execution: expect.objectContaining({ kind: 'notify', prompt: '交报告' }),
    }));
    expect(result.task.scheduleId).toBe('sch_1');
    expect(fs.readFileSync(taskFile, 'utf8')).toContain('"schedule":"sch_1"');
  });

  it('rejects a malformed due value', async () => {
    const { ...rest } = services();
    await expect(createTask({ taskFile, input: { taskTitle: 'x', taskDue: 'tomorrow' }, ...rest }))
      .rejects.toThrow('taskDue');
  });
});
