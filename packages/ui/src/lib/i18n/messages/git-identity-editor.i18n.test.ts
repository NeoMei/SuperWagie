import { describe, expect, test } from 'bun:test';

import { gitIdentityEditorI18n } from './git-identity-editor.i18n';

const locales = ['en', 'zh-CN'] as const;

describe('Git identity editor translations', () => {
  test('every locale has every key, translated', () => {
    const english = Object.entries(gitIdentityEditorI18n.en);
    for (const locale of locales) {
      const dictionary = new Map<string, string>(Object.entries(gitIdentityEditorI18n[locale]));
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
