import { expect, test } from 'bun:test';
import { conversationMemoryI18n } from './conversation-memory.i18n';
import { dict as english } from './en';
import { dict as chinese } from './zh-CN';

test('conversation learning copy is translated and registered in every supported locale', () => {
  expect(Object.keys(conversationMemoryI18n.en).sort()).toEqual(Object.keys(conversationMemoryI18n['zh-CN']).sort());
  for (const [key, value] of Object.entries(conversationMemoryI18n.en)) {
    const translated = new Map(Object.entries(conversationMemoryI18n['zh-CN'])).get(key);
    expect(value.trim()).toBeTruthy();
    expect(translated?.trim()).toBeTruthy();
    expect(translated).not.toBe(value);
    expect(new Map(Object.entries(english)).get(key)).toBe(value);
    expect(new Map(Object.entries(chinese)).get(key)).toBe(translated);
  }
});
