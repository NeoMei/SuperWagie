import { describe, expect, test } from 'bun:test';

import { formatUpdateError } from './updateError';
import { useI18nStore } from '@/lib/i18n/store';
import { dict as enDict } from '@/lib/i18n/messages/en';
import { dict as zhDict } from '@/lib/i18n/messages/zh-CN';

// setLocale loads the dictionary asynchronously; tests set it directly.
const useDictionary = (locale: 'en' | 'zh-CN') => {
  useI18nStore.setState({ locale, dictionary: locale === 'zh-CN' ? zhDict : enDict });
};

describe('formatUpdateError', () => {
  test('translates a coded failure into the interface language', () => {
    useDictionary('zh-CN');
    expect(formatUpdateError(new Error('E_UPDATE:checksum:'))).toContain('校验');

    useDictionary('en');
    expect(formatUpdateError(new Error('E_UPDATE:checksum:'))).toContain('checksum');
  });

  test('keeps the detail the main process attached', () => {
    useDictionary('en');
    expect(formatUpdateError(new Error('E_UPDATE:downloadFailed:HTTP 404'))).toContain('HTTP 404');
  });

  test('passes untagged errors through unchanged', () => {
    expect(formatUpdateError(new Error('something broke'))).toBe('something broke');
    expect(formatUpdateError(new Error('E_UPDATE:unknownCode:x'))).toBe('E_UPDATE:unknownCode:x');
  });
});
