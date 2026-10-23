import { expect, test } from 'bun:test';
import { dict as en } from './en';
import { dict as zhCN } from './zh-CN';

const keys = [
  'sessions.scheduledTasks.dialog.description',
  'sessions.scheduledTasks.dialog.status.queued',
  'sessions.scheduledTasks.dialog.status.sent',
  'sessions.scheduledTasks.dialog.status.skipped',
  'sessions.scheduledTasks.dialog.status.cancelled',
  'sessions.scheduledTasks.editor.description',
  'sessions.scheduledTasks.editor.sessionMode',
  'sessions.scheduledTasks.editor.newSession',
  'sessions.scheduledTasks.editor.existingSession',
  'sessions.scheduledTasks.editor.targetSession',
  'sessions.scheduledTasks.editor.targetHint',
  'sessions.scheduledTasks.editor.targetRequired',
  'sessions.scheduledTasks.dialog.loopFile.enableOnThisComputer',
  'sessions.scheduledTasks.dialog.loopFile.changedSinceEnabled',
] as const;

test('scheduled task session choices and outcomes are translated in every catalog', () => {
  for (const catalog of [zhCN]) {
    for (const key of keys) {
      expect(catalog[key]).toBeTruthy();
      expect(catalog[key]).not.toBe(en[key]);
    }
  }
});

test('scheduled queue outcomes sit beside the legacy status keys', () => {
  const statuses = ['success', 'error', 'running', 'idle', 'queued', 'sent', 'skipped', 'cancelled'];
  for (const catalog of [en, zhCN]) {
    const catalogKeys = Object.keys(catalog);
    const start = catalogKeys.indexOf('sessions.scheduledTasks.dialog.status.success');
    expect(catalogKeys.slice(start, start + statuses.length)).toEqual(statuses.map((status) => `sessions.scheduledTasks.dialog.status.${status}`));
  }
});
