import { afterEach, describe, expect, test } from 'bun:test';

import { categoryLabel, setWorkbenchLocale, t, weatherLabel, weekdayLabels } from './i18n.ts';
import { formatDate, relativeDay } from './shared.ts';

afterEach(() => setWorkbenchLocale('zh-CN'));

describe('workbench language', () => {
  test('switches creation entries, task states, dates and weather together', () => {
    setWorkbenchLocale('en');
    expect(t('creation.doc')).toBe('Write a document');
    expect(t('creation.deck')).toBe('Create a presentation');
    expect(t('state.inProgress')).toBe('In progress');
    expect(relativeDay('2026-10-24', '2026-10-24')).toBe('Today');
    expect(relativeDay('2026-10-25', '2026-10-24')).toBe('Tomorrow');
    expect(formatDate('2026-10-24')).toBe('Oct 24');
    expect(weekdayLabels()).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    expect(weatherLabel('多云')).toBe('Cloudy');
    expect(categoryLabel('文档')).toBe('Documents');
    expect(categoryLabel('客户资料')).toBe('客户资料');
    setWorkbenchLocale('zh-CN');
    expect(t('creation.doc')).toBe('写文档');
    expect(t('state.inProgress')).toBe('进行中');
    expect(relativeDay('2026-10-24', '2026-10-24')).toBe('今天');
    expect(weatherLabel('多云')).toBe('多云');
  });

  test('localizes task instructions while leaving user content and tool contracts intact', () => {
    setWorkbenchLocale('en');
    const text = 'Prepare 客户资料 for Friday';
    expect(t('taskPrompt', { text })).toContain(text);
    expect(t('taskPrompt', { text })).toContain('openchamber tool’s task.create');
    expect(t('taskPrompt', { text })).toContain('YYYY-MM-DDTHH:mm');
    expect(t('taskPrompt', { text })).toContain('09:00');
    expect(t('fileCount', { count: 7 })).toBe('7 files');
    expect(t('greeting.heading', { salute: 'Good morning', fact: 'No tasks due today.' })).toBe('Good morning. No tasks due today.');
  });
});
