import { describe, expect, test } from 'bun:test';

import { projectActionsI18n } from './project-actions.i18n';

const locales = ['en', 'zh-CN'] as const;

describe('project actions translations', () => {
  test('every locale has every key, translated', () => {
    const english = Object.entries(projectActionsI18n.en);
    for (const locale of locales) {
      const dictionary = new Map<string, string>(Object.entries(projectActionsI18n[locale]));
      expect([...dictionary.keys()].sort()).toEqual(english.map(([key]) => key).sort());
      for (const [key, englishText] of english) {
        expect(dictionary.get(key)?.trim()).toBeTruthy();
        if (locale !== 'en') {
          expect(`${locale} ${key}: ${dictionary.get(key)}`).not.toBe(`${locale} ${key}: ${englishText}`);
        }
      }
    }
  });
});
