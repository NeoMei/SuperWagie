import { describe, expect, test } from 'bun:test';
import { formatMessage, type I18nKey } from '@/lib/i18n';
import { dict as en } from '@/lib/i18n/messages/en';
import { dict as zh } from '@/lib/i18n/messages/zh-CN';
import { guestActionLabel, localizeBuiltInGuest } from './built-in-copy';
import type { InstalledGuest } from './types';

const workbench: InstalledGuest = {
  id: 'openchamber-builtin-workbench', name: '今日', pageTitle: '工作台', icon: 'home', source: 'bundled',
  capabilities: { requested: [], granted: [] },
  actions: [{ id: 'save-task', label: '存为任务', icon: 'task', where: 'message' }],
};
const translate = (dictionary: Parameters<typeof formatMessage>[0]) => (key: I18nKey) => formatMessage(dictionary, key);

describe('app-owned extension navigation', () => {
  test('English and Chinese copy changes without mutating catalog metadata or action IDs', () => {
    const english = localizeBuiltInGuest(workbench, translate(en));
    expect(english).toMatchObject({ name: 'Today', pageTitle: 'Workbench', actions: workbench.actions });
    expect(localizeBuiltInGuest(english, translate(zh))).toMatchObject({ name: '今日', pageTitle: '工作台', actions: [{ id: 'save-task', label: '存为任务' }] });
    const action = english.actions?.[0];
    if (!action) throw new Error('Action missing');
    expect(action).toBe(workbench.actions?.[0]);
    expect(guestActionLabel(english, action, translate(en))).toBe('Save as task');
    expect(guestActionLabel(english, action, translate(zh))).toBe('存为任务');
    expect(workbench.name).toBe('今日');
    expect(workbench.actions?.[0].label).toBe('存为任务');
  });

  test('only app-owned known packages are translated', () => {
    const external: InstalledGuest = { ...workbench, source: 'path', name: '用户的插件' };
    expect(localizeBuiltInGuest(external, translate(en))).toBe(external);
    const other: InstalledGuest = { ...workbench, id: 'openchamber-builtin-other' };
    expect(localizeBuiltInGuest(other, translate(en))).toBe(other);
  });

  test('the creation title is localized without changing its route', () => {
    const creation: InstalledGuest = { ...workbench, id: 'openchamber-builtin-creation', name: '创作', pageTitle: '创作' };
    expect(localizeBuiltInGuest(creation, translate(en))).toMatchObject({ id: creation.id, name: 'Create', pageTitle: 'Create' });
  });
});
