import { describe, expect, test } from 'bun:test';

import { resolveOpenFileTarget } from './openFileTarget';

const projects = [
  { id: 'work', path: '/Users/me/Documents/SuperWagie/PPT/work' },
  { id: 'nested', path: '/Users/me/Documents/SuperWagie/PPT/work/delivery' },
  { id: 'sibling', path: '/Users/me/Documents/SuperWagie/PPT/work-two' },
];

describe('resolveOpenFileTarget', () => {
  test('uses the deepest project that owns the file', () => {
    expect(resolveOpenFileTarget('/Users/me/Documents/SuperWagie/PPT/work/delivery/final.pptx', projects)).toEqual({
      projectId: 'nested',
      projectPath: '/Users/me/Documents/SuperWagie/PPT/work/delivery',
      filePath: '/Users/me/Documents/SuperWagie/PPT/work/delivery/final.pptx',
    });
  });

  test('does not confuse a sibling with a shared prefix', () => {
    expect(resolveOpenFileTarget('/Users/me/Documents/SuperWagie/PPT/work-two/a.pdf', projects)?.projectId).toBe('sibling');
    expect(resolveOpenFileTarget('/Users/me/Documents/SuperWagie/PPT/work-other/a.pdf', projects)).toBeNull();
  });

  test('rejects paths outside every project and traversal', () => {
    expect(resolveOpenFileTarget('/Users/me/Downloads/a.pdf', projects)).toBeNull();
    expect(resolveOpenFileTarget('/Users/me/Documents/SuperWagie/PPT/work/../secret.pdf', projects)).toBeNull();
    expect(resolveOpenFileTarget('relative/a.pdf', projects)).toBeNull();
  });

  test('opens a normalized Windows file in its deepest registered project', () => {
    expect(resolveOpenFileTarget('C:/work/delivery/方案.pdf', [
      { id: 'work', path: 'C:/work/' },
      { id: 'nested', path: 'C:/work/delivery/' },
    ])).toEqual({ projectId: 'nested', projectPath: 'C:/work/delivery', filePath: 'C:/work/delivery/方案.pdf' });
  });

  test('opens a normalized UNC file only within its registered share directory', () => {
    const shares = [{ id: 'share', path: '//server/share/work/' }];
    expect(resolveOpenFileTarget('//server/share/work/report.pdf', shares)).toEqual({
      projectId: 'share', projectPath: '//server/share/work', filePath: '//server/share/work/report.pdf',
    });
    expect(resolveOpenFileTarget('//server/other/work/report.pdf', shares)).toBeNull();
    expect(resolveOpenFileTarget('//server/share/work-other/report.pdf', shares)).toBeNull();
    expect(resolveOpenFileTarget('//server/share/work/../report.pdf', shares)).toBeNull();
  });

  for (const path of [
    'D:/work/report.pdf', 'C:/work-other/report.pdf', 'C:/work/../secret.pdf',
    'C:/work/..\\secret.pdf', 'C:/work/\0report.pdf', 'C:work/report.pdf',
  ]) {
    test(`refuses an outside or malformed Windows target: ${path}`, () => {
      expect(resolveOpenFileTarget(path, [{ id: 'work', path: 'C:/work' }])).toBeNull();
    });
  }
});
