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
});
