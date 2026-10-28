import { describe, expect, test } from 'bun:test';

import { initialBrowseQuery } from './directoryExplorerStart';

describe('initialBrowseQuery', () => {
  const home = '/Users/me';

  test('starts at home when there is no project yet', () => {
    expect(initialBrowseQuery([], home)).toBe('~/');
  });

  test('starts in the folder of the most recently added project', () => {
    const projects = [
      { path: '/Users/me/work/old', addedAt: 1 },
      { path: '/Users/me/projects/newest', addedAt: 9 },
      { path: '/srv/repos/mid', addedAt: 5 },
    ];
    expect(initialBrowseQuery(projects, home)).toBe('~/projects/');
  });

  test('keeps a folder outside home absolute, and falls back to the last entry without dates', () => {
    expect(initialBrowseQuery([{ path: '/Users/me/a' }, { path: 'D:\\code\\repo\\' }], home)).toBe('D:/code/');
    expect(initialBrowseQuery([{ path: '/Users/me/repo' }], home)).toBe('~/');
  });

  test('shows drive-letter paths for a Windows filesystem home', () => {
    const windowsHome = 'C:\\Users\\me';
    expect(initialBrowseQuery([], windowsHome)).toBe('C:/Users/me/');
    expect(initialBrowseQuery([{ path: 'C:\\Users\\me\\repo' }], windowsHome)).toBe('C:/Users/me/');
    expect(initialBrowseQuery([{ path: 'C:\\Users\\me\\projects\\repo' }], windowsHome)).toBe('C:/Users/me/projects/');
    expect(initialBrowseQuery([], 'C:\\')).toBe('C:/');
  });

  test('keeps UNC filesystem homes readable without tilde shorthand', () => {
    const networkHome = '\\\\server\\users\\me';
    expect(initialBrowseQuery([], networkHome)).toBe('//server/users/me/');
    expect(initialBrowseQuery([{ path: '\\\\server\\users\\me\\projects\\repo' }], networkHome)).toBe('//server/users/me/projects/');
  });
});
