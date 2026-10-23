import { describe, expect, test } from 'bun:test';

import { sourceBoardI18n } from './source-board.i18n';

const locales = ['en', 'zh-CN'] as const;

describe('issues and PRs board translations', () => {
  test('provides every key in every supported locale, translated', () => {
    const english: Record<string, string> = sourceBoardI18n.en;
    const keys = Object.keys(english);
    expect(keys.length).toBeGreaterThan(0);
    for (const locale of locales) {
      const translated: Record<string, string> = sourceBoardI18n[locale];
      expect(Object.keys(translated)).toEqual(keys);
      for (const key of keys) {
        const value = translated[key];
        expect(value).toBeTruthy();
        if (locale !== 'en') expect(value).not.toBe(english[key]);
      }
    }
  });
});
