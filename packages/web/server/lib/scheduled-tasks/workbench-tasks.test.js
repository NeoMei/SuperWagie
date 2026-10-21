import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { removeWorkbenchTasksForSchedule } from './workbench-tasks.js';

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-workbench-tasks-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('removeWorkbenchTasksForSchedule', () => {
  it('drops the todo line that links to the deleted schedule', async () => {
    fs.writeFileSync(
      path.join(dir, 'tasks.md'),
      [
        '- [ ] 吃饭 <!-- sw {"id":"a","schedule":"sch_1"} -->',
        '- [ ] 做饭 <!-- sw {"id":"b","schedule":"sch_2"} -->',
        '',
      ].join('\n'),
    );
    const removed = await removeWorkbenchTasksForSchedule('sch_1', '', { dataDir: dir });
    expect(removed).toBe(1);
    const text = fs.readFileSync(path.join(dir, 'tasks.md'), 'utf8');
    expect(text).toContain('做饭');
    expect(text).not.toContain('吃饭');
  });

  it('also checks the project task file and ignores missing files', async () => {
    const project = path.join(dir, 'repo');
    fs.mkdirSync(project);
    fs.writeFileSync(
      path.join(project, '任务.md'),
      '- [ ] 项目任务 <!-- sw {"id":"c","schedule":"sch_3"} -->\n',
    );
    const removed = await removeWorkbenchTasksForSchedule('sch_3', project, { dataDir: dir });
    expect(removed).toBe(1);
    expect(fs.readFileSync(path.join(project, '任务.md'), 'utf8')).not.toContain('项目任务');
  });
});
