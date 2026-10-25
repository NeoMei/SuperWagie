import { describe, expect, test } from 'bun:test';
import { platformAccountI18n } from './platform-account.i18n';

describe('platform account translations', () => {
  test('ships the complete translated account flow in both locales', () => {
    const english: Record<string, string> = platformAccountI18n.en;
    const chinese: Record<string, string> = platformAccountI18n['zh-CN'];
    expect(Object.keys(chinese)).toEqual(Object.keys(english));
    for (const key of Object.keys(english)) {
      expect(chinese[key]).toBeTruthy();
      expect(chinese[key]).not.toBe(english[key]);
    }
  });
});
