import { describe, expect, test } from 'bun:test';

import { guestFileScope, isGuestFilePath } from './contract';

describe('guest file path scope', () => {
  test.each(['C:/Users/me/Documents/report.pdf', 'd:/work', 'C:/'])('requires filesystem authorization for %s', (path) => {
    expect(guestFileScope(path)).toBe('filesystem');
  });

  test.each(['/work/report.pdf', '~/Downloads/report.pdf', '~', '//server/share/report.pdf'])('keeps filesystem scope for %s', (path) => {
    expect(guestFileScope(path)).toBe('filesystem');
  });

  test.each(['.', 'delivery/report.pdf'])('keeps project scope for %s', (path) => {
    expect(guestFileScope(path)).toBe('project');
  });

  test('preserves the forward-slash wire contract for drive and UNC paths', () => {
    expect(isGuestFilePath('C:/work/report.pdf')).toBe(true);
    expect(isGuestFilePath('//server/share/report.pdf')).toBe(true);
    expect(isGuestFilePath('C:\\work\\report.pdf')).toBe(false);
    expect(isGuestFilePath('\\\\server\\share\\report.pdf')).toBe(false);
    expect(isGuestFilePath('C:/work/\0report.pdf')).toBe(false);
  });
});
