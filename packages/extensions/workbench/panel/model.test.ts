import { describe, expect, test } from 'bun:test';

import {
  appendTask,
  contentHash,
  isDoneThisWeek,
  isDueThisWeek,
  isDueToday,
  isOverdue,
  newTaskId,
  parseTasks,
  patchTask,
  removeTask,
  type Task,
} from './model.ts';

const task = (overrides: Partial<Task> = {}): Task => ({
  id: 'tsk_test',
  title: '整理评审材料',
  note: '',
  state: 'planned',
  origin: 'user',
  priority: 'normal',
  due: '2026-10-24',
  dueTime: '',
  schedule: '',
  session: '',
  done: '',
  line: 1,
  raw: '',
  ...overrides,
});

describe('parseTasks', () => {
  test('reads a plain checkbox as an inbox task owned by me', () => {
    const { tasks, issues } = parseTasks('# 工作\n\n- [ ] 打电话给供应商\n');
    expect(issues).toEqual([]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: '打电话给供应商', state: 'planned', origin: 'user', due: '', line: 3 });
  });

  test('reads metadata and the checked box', () => {
    const line = '- [x] 发货 <!-- sw {"id":"tsk_1","state":"completed","origin":"agent","priority":"high","due":"2026-10-20"} -->';
    const [parsed] = parseTasks(line).tasks;
    expect(parsed).toMatchObject({ id: 'tsk_1', state: 'completed', origin: 'agent', priority: 'high', due: '2026-10-20' });
    expect(parsed.title).toBe('发货');
  });

  test('keeps a broken metadata block as an issue without dropping the task', () => {
    const { tasks, issues } = parseTasks('- [ ] 坏行 <!-- sw {not json} -->');
    expect(issues).toHaveLength(1);
    expect(tasks[0].title).toBe('坏行');
    expect(tasks[0].state).toBe('planned');
  });

  test('records the section above each task', () => {
    const { sections } = parseTasks('# 收件箱\n- [ ] a\n## 本周\n- [ ] b');
    expect(sections.get(2)).toBe('收件箱');
    expect(sections.get(4)).toBe('本周');
  });
});

describe('patchTask', () => {
  test('updates the checkbox from state and keeps unknown metadata', () => {
    const source = '- [ ] 发货 <!-- sw {"id":"tsk_1","state":"planned","origin":"user","custom":"keep"} -->';
    const result = patchTask(source, task({ id: 'tsk_1', title: '发货', state: 'completed' }));
    expect(result).toContain('- [x] 发货');
    expect(result).toContain('"custom":"keep"');
    expect(result).toContain('"state":"completed"');
  });

  test('leaves other lines untouched', () => {
    const source = '- [ ] 一\n\n说明文字  \n- [ ] 二';
    const result = patchTask(source, task({ id: 'tsk_2', title: '二', line: 4, state: 'in_progress' }));
    expect(result.split('\n')[0]).toBe('- [ ] 一');
    expect(result.split('\n')[1]).toBe('');
    expect(result.split('\n')[2]).toBe('说明文字  ');
    expect(result.split('\n')[3]).toContain('- [ ] 二');
    expect(result.split('\n')[3]).toContain('"state":"in_progress"');
  });

  test('keeps the original indent and bullet', () => {
    const source = '  * [ ] 子项';
    const result = patchTask(source, task({ id: 'tsk_3', title: '子项', state: 'blocked' }));
    expect(result.startsWith('  * [ ] 子项')).toBe(true);
  });

  test('clears due time and schedule metadata when the task no longer has a reminder', () => {
    const source = '- [ ] 任务 <!-- sw {"id":"tsk_6","state":"planned","origin":"user","due":"2026-10-30","dueTime":"09:00","schedule":"sch_1","keep":"yes"} -->';
    const result = patchTask(source, task({ id: 'tsk_6', title: '任务', due: '2026-10-30', dueTime: '', schedule: '', line: 1 }));
    expect(result).not.toContain('"schedule"');
    expect(result).not.toContain('"dueTime"');
    expect(result).toContain('"keep":"yes"');
  });

  test('preserves a line that already had no metadata', () => {
    const result = patchTask('- [ ] 简单任务', task({ id: 'tsk_4', title: '简单任务', state: 'planned', due: '', priority: 'normal' }));
    expect(result).toBe('- [ ] 简单任务 <!-- sw {"id":"tsk_4","state":"planned","origin":"user"} -->');
  });
});

describe('append and remove', () => {
  test('appends with a newline and leaves the rest alone', () => {
    const result = appendTask('# 工作', task({ id: 'tsk_5', title: '周报', due: '2026-10-25' }));
    expect(result.startsWith('# 工作\n')).toBe(true);
    expect(result).toContain('- [ ] 周报');
    expect(result.endsWith('\n')).toBe(true);
  });

  test('removes exactly one line', () => {
    expect(removeTask('a\n- [ ] b\nc', 2)).toBe('a\nc');
  });
});

describe('ids and hashes', () => {
  test('ids are prefixed and unique enough', () => {
    expect(newTaskId(1, () => 0.5)).toStartWith('tsk_');
    expect(newTaskId()).not.toBe(newTaskId());
  });

  test('hash changes with content', () => {
    expect(contentHash('a')).toBe(contentHash('a'));
    expect(contentHash('a')).not.toBe(contentHash('b'));
  });
});

describe('due predicates', () => {
  const today = '2026-10-20';

  test('overdue ignores done tasks', () => {
    expect(isOverdue(task({ due: '2026-10-19' }), today)).toBe(true);
    expect(isOverdue(task({ due: '2026-10-19', state: 'completed' }), today)).toBe(false);
  });

  test('completion counts inside the current Monday-to-Sunday week', () => {
    expect(isDoneThisWeek(task({ done: '2026-10-20', state: 'completed' }), today)).toBe(true);
    expect(isDoneThisWeek(task({ done: '2026-10-18', state: 'completed' }), today)).toBe(false);
    expect(isDoneThisWeek(task({ done: '', state: 'completed' }), today)).toBe(false);
  });

  test('today and this week use the local date', () => {
    expect(isDueToday(task({ due: today }), today)).toBe(true);
    expect(isDueThisWeek(task({ due: '2026-10-26' }), today)).toBe(true);
    expect(isDueThisWeek(task({ due: '2026-10-27' }), today)).toBe(false);
  });
});
