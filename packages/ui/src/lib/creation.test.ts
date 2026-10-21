import { describe, expect, test } from 'bun:test';

import { categoryOfProjectPath } from './creation';

describe('categoryOfProjectPath', () => {
  const root = '/Users/ada/Documents/SuperWagie';

  test('files each work under its folder', () => {
    expect(categoryOfProjectPath(`${root}/文档/季度汇报 2026-10-21`)).toBe('doc');
    expect(categoryOfProjectPath(`${root}/PPT/季度汇报 2026-10-21`)).toBe('deck');
    expect(categoryOfProjectPath(`${root}/视频/季度汇报 2026-10-21`)).toBe('video');
    expect(categoryOfProjectPath(`${root}/网页/季度汇报 2026-10-21`)).toBe('page');
  });

  test('anything outside the creation root is chat', () => {
    expect(categoryOfProjectPath('/Users/ada/projects/lingxi-rebrand')).toBe('chat');
    expect(categoryOfProjectPath('/Users/ada/Documents/Other/文档/x')).toBe('chat');
    expect(categoryOfProjectPath(`${root}/文档备份/x`)).toBe('chat');
  });

  test('reads a Windows path', () => {
    expect(categoryOfProjectPath(String.raw`C:\Users\ada\Documents\SuperWagie\PPT\deck`)).toBe('deck');
  });
});
