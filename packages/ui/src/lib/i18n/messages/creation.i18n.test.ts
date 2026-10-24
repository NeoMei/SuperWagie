import { describe, expect, test } from 'bun:test';
import { creationI18n } from './creation.i18n';
import { CREATION_NEW_LABEL_KEY, CREATION_PROMPT_KEY, CREATION_TITLE_KEY, WORK_CATEGORY_LABEL_KEY } from '@/lib/creation';

describe('creation interface copy', () => {
  test('both languages cover every host entry and full message', () => {
    expect(Object.keys(creationI18n.en).sort()).toEqual(Object.keys(creationI18n['zh-CN']).sort());
    const chinese = new Map<string, string>(Object.entries(creationI18n['zh-CN']));
    for (const [key, text] of Object.entries(creationI18n.en)) {
      expect(text.trim()).toBeTruthy();
      expect(chinese.get(key)?.trim()).toBeTruthy();
      expect(text).not.toEqual(chinese.get(key));
    }
    for (const keys of [CREATION_NEW_LABEL_KEY, CREATION_TITLE_KEY, CREATION_PROMPT_KEY, WORK_CATEGORY_LABEL_KEY]) {
      for (const key of Object.values(keys)) expect(creationI18n.en[key]).toBeTruthy();
    }
  });

  test('English creation starts an English conversation while retaining the skill file contract', () => {
    for (const key of Object.values(CREATION_PROMPT_KEY)) {
      expect(creationI18n.en[key]).toContain('需求.md');
      expect(creationI18n.en[key]).toContain('Use English');
      expect(/\p{Script=Han}/u.test(creationI18n.en[key].replaceAll('需求.md', ''))).toBe(false);
    }
  });
});
