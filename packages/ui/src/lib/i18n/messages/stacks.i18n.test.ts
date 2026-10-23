import { describe, expect, test } from 'bun:test';

import { stacksI18n } from './stacks.i18n';

const locales = ['en', 'zh-CN'] as const;

describe('stacked pull request translations', () => {
  test('provides every key in every supported locale, translated', () => {
    const english: Record<string, string> = stacksI18n.en;
    const keys = Object.keys(english);
    expect(keys.length).toBeGreaterThan(0);
    for (const locale of locales) {
      const translated: Record<string, string> = stacksI18n[locale];
      expect(Object.keys(translated)).toEqual(keys);
      for (const key of keys) {
        const value = translated[key];
        expect(value).toBeTruthy();
        if (locale !== 'en') expect(value).not.toBe(english[key]);
        // Placeholders survive translation.
        for (const placeholder of english[key].match(/\{\w+\}/g) ?? []) expect(value).toContain(placeholder);
      }
    }
  });
});
