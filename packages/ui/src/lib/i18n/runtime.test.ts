import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { DEFAULT_LOCALE, detectInitialLocale, getLocaleDirection, isRightToLeft, LOCALES, LOCALE_STORAGE_KEY, normalizeLocale } from './runtime';
import { readStoredLocaleForBootstrap } from './bootstrap';

describe('i18n runtime', () => {
  test('the application offers English and Simplified Chinese with left-to-right layouts', () => {
    expect(LOCALES).toEqual(['en', 'zh-CN']);
    for (const locale of LOCALES) {
      expect(getLocaleDirection(locale)).toBe('ltr');
    }
  });

  test('regional English and Chinese tags resolve to an offered language', () => {
    expect(normalizeLocale('en-GB')).toBe('en');
    expect(normalizeLocale('zh_Hans')).toBe('zh-CN');
    expect(normalizeLocale('zh-Hant-TW')).toBe('zh-CN');
  });

  test('retired and unknown languages resolve to the existing Chinese default', () => {
    for (const locale of ['ar', 'ar-EG', 'fr', 'de', 'uk', 'pt-BR', 'he-IL', 'iw', 'xx']) {
      expect(normalizeLocale(locale)).toBe(DEFAULT_LOCALE);
    }
  });

  test('startup and bootstrap migrate a retired persisted language consistently', () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const testWindow = new Window();
    Object.defineProperty(globalThis, 'window', { value: testWindow, configurable: true });
    try {
      testWindow.localStorage.setItem(LOCALE_STORAGE_KEY, JSON.stringify({ locale: 'ar' }));
      expect(detectInitialLocale()).toBe('zh-CN');
      expect(readStoredLocaleForBootstrap()).toBe('zh-CN');
      testWindow.localStorage.clear();
      Object.defineProperty(testWindow, '__OPENCHAMBER_HOST_LANGUAGE__', { value: 'en-US', configurable: true });
      expect(detectInitialLocale()).toBe('en');
      Object.defineProperty(testWindow, '__OPENCHAMBER_HOST_LANGUAGE__', { value: 'fr', configurable: true });
      expect(detectInitialLocale()).toBe('zh-CN');
    } finally {
      if (previous) Object.defineProperty(globalThis, 'window', previous);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });

  test('an element takes the direction of its nearest explicit dir', () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', { value: new Window().document, configurable: true });
    try {
      document.documentElement.setAttribute('dir', 'rtl');
      document.body.innerHTML = '<div id="row"><span id="title" dir="auto">x</span></div><pre dir="ltr"><code id="code">x</code></pre>';
      const element = (id: string) => {
        const found = document.getElementById(id);
        if (!found) throw new Error(`missing #${id}`);
        return found;
      };
      expect(isRightToLeft(element('row'))).toBe(true);
      expect(isRightToLeft(element('title'))).toBe(true);
      expect(isRightToLeft(element('code'))).toBe(false);
      document.documentElement.setAttribute('dir', 'ltr');
      expect(isRightToLeft(element('row'))).toBe(false);
    } finally {
      if (previous) Object.defineProperty(globalThis, 'document', previous);
      else Reflect.deleteProperty(globalThis, 'document');
    }
  });
});
