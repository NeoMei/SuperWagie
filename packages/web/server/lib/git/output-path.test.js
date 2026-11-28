import { describe, expect, it } from 'vitest';
import { normalizeGitOutputPath, resolveGitOutputPath } from './output-path.js';

describe('Git filesystem output paths', () => {
  it.each([
    ['/c/repos/project', 'C:/repos/project'],
    ['/D/repos/project', 'D:/repos/project'],
    ['/c', 'C:/'],
    ['/c/', 'C:/'],
    ['/c/repo space/\u4e2d\u6587', 'C:/repo space/\u4e2d\u6587'],
    ['C:/repo', 'C:/repo'],
    ['c:\\repo', 'c:\\repo'],
    ['//server/share/repo', '//server/share/repo'],
    ['\\\\server\\share\\repo', '\\\\server\\share\\repo'],
    ['\\\\?\\C:\\repo', '\\\\?\\C:\\repo'],
    ['../repo/.git', '../repo/.git'],
    ['.git/index.lock', '.git/index.lock'],
    ['/custom/mount', '/custom/mount'],
    ['/', '/'],
    ['', ''],
  ])('converts %j to %j on Windows', (input, expected) => {
    expect(normalizeGitOutputPath(input, 'win32')).toBe(expected);
  });

  it('resolves Git common directories before conflict checkout validation on Windows', () => {
    expect(resolveGitOutputPath('D:\\temp\\pick', '/c/repos/project/.git', 'win32')).toBe('C:\\repos\\project\\.git');
    expect(resolveGitOutputPath('C:\\repos\\project', '.git', 'win32')).toBe('C:\\repos\\project\\.git');
    expect(resolveGitOutputPath('D:\\temp\\pick', '//server/share/repo/.git', 'win32')).toBe('\\\\server\\share\\repo\\.git');
  });

  it.each(['linux', 'darwin'])('preserves POSIX paths on %s', (platform) => {
    for (const input of ['/c/repos/project', '/c', '/home/user/repo', '../repo', '//server/share']) {
      expect(normalizeGitOutputPath(input, platform)).toBe(input);
    }
  });
});
