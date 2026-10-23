import { describe, expect, test } from 'bun:test';

import { referencePickerI18n } from './reference-picker.i18n';

const locales = ['en', 'zh-CN'] as const;

describe('reference picker translations', () => {
  test('every locale has every key, translated', () => {
    const english = Object.entries(referencePickerI18n.en);
    for (const locale of locales) {
      const dictionary = new Map<string, string>(Object.entries(referencePickerI18n[locale]));
      expect([...dictionary.keys()].sort()).toEqual(english.map(([key]) => key).sort());
      for (const [key, englishText] of english) {
        expect(dictionary.get(key)?.trim()).toBeTruthy();
        if (locale !== 'en') {
          expect(`${locale} ${key}: ${dictionary.get(key)}`).not.toBe(`${locale} ${key}: ${englishText}`);
        }
      }
    }
  });

  test('placeholders survive translation', () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const locale of locales) {
      const dictionary = new Map<string, string>(Object.entries(referencePickerI18n[locale]));
      for (const [key, englishText] of Object.entries(referencePickerI18n.en)) {
        expect(`${locale} ${key} ${placeholders(dictionary.get(key) ?? '').join(',')}`)
          .toBe(`${locale} ${key} ${placeholders(englishText).join(',')}`);
      }
    }
  });
});
