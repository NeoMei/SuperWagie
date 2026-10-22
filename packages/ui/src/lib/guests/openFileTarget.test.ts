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

  for (const { projectPath, filePath } of [
    { projectPath: 'C:/work', filePath: 'c:/work/report.pdf' },
    { projectPath: 'c:/Work', filePath: 'C:/WORK/Report.pdf' },
    { projectPath: '//SERVER/share/work', filePath: '//server/share/work/report.pdf' },
    { projectPath: '//server/Share/Work', filePath: '//SERVER/SHARE/WORK/Report.pdf' },
  ]) {
    test(`matches Windows owner case-insensitively without rewriting paths: ${filePath}`, () => {
      expect(resolveOpenFileTarget(filePath, [{ id: 'work', path: projectPath }])).toEqual({
        projectId: 'work', projectPath, filePath,
      });
    });
  }

  for (const root of ['C:/Work', '//SERVER/Share/Work']) {
    test(`keeps the deepest Windows owner across case differences: ${root}`, () => {
      const filePath = `${root.toLowerCase()}/delivery/Report.pdf`;
      expect(resolveOpenFileTarget(filePath, [
        { id: 'work', path: `${root}/` },
        { id: 'nested', path: `${root}/Delivery/` },
      ])).toEqual({ projectId: 'nested', projectPath: `${root}/Delivery`, filePath });
    });

    for (const suffix of ['-other/report.pdf', '/../secret.pdf', '/..\\secret.pdf', '/\0report.pdf']) {
      test(`refuses outside or malformed Windows paths across case differences: ${root}${suffix}`, () => {
        expect(resolveOpenFileTarget(`${root.toLowerCase()}${suffix}`, [{ id: 'work', path: root }])).toBeNull();
      });
    }
  }

  test('keeps POSIX owner comparison case-sensitive', () => {
    const roots = [{ id: 'work', path: '/home/Work' }];
    expect(resolveOpenFileTarget('/home/Work/report.pdf', roots)?.projectId).toBe('work');
    expect(resolveOpenFileTarget('/home/work/report.pdf', roots)).toBeNull();
    expect(resolveOpenFileTarget('/HOME/Work/report.pdf', roots)).toBeNull();
  });

  test('does not match a different Windows drive or UNC share after case folding', () => {
    expect(resolveOpenFileTarget('d:/work/report.pdf', [{ id: 'work', path: 'C:/Work' }])).toBeNull();
    expect(resolveOpenFileTarget('//server/other/work/report.pdf', [{ id: 'work', path: '//SERVER/share/Work' }])).toBeNull();
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
