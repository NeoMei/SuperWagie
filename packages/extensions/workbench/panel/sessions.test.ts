import { describe, expect, test } from 'bun:test';

import type { GuestProject, GuestSessionRecord } from '@openchamber/sdk';

import { creationProjectIds, isCreationProject, mergeSessions } from './sessions.ts';

const project = (id: string, directory: string): GuestProject => ({ id, name: id, directory });

const session = (id: string, updatedAt: number): GuestSessionRecord => ({
  id,
  title: id,
  projectId: 'p',
  directory: '/tmp',
  parentId: null,
  createdAt: updatedAt,
  updatedAt,
  archivedAt: null,
  worktree: null,
  activity: 'idle',
  outcome: null,
  items: [],
});

describe('creation projects', () => {
  test('recognizes works under the fixed root on both separators', () => {
    expect(isCreationProject(project('a', '/Users/me/Documents/SuperWagie/文档/新文档 2026-10-21'))).toBe(true);
    expect(isCreationProject(project('b', 'C:\\Users\\me\\Documents\\SuperWagie\\PPT\\季度汇报 2026-10-21'))).toBe(true);
    expect(isCreationProject(project('c', '/Users/me/code/app'))).toBe(false);
  });

  test('lists only creation project ids', () => {
    expect(creationProjectIds([
      project('doc', '/Users/me/Documents/SuperWagie/文档/方案 2026-10-21'),
      project('app', '/Users/me/code/app'),
      project('deck', '/Users/me/Documents/SuperWagie/PPT/汇报 2026-10-21'),
    ])).toEqual(['doc', 'deck']);
  });
});

describe('mergeSessions', () => {
  test('deduplicates by id and orders the newest first', () => {
    expect(mergeSessions(
      [session('live', 10), session('same', 5)],
      [session('same', 8), session('creation', 20)],
    ).map((entry) => entry.id)).toEqual(['creation', 'live', 'same']);
  });

  test('keeps the live copy of a session present in both lists', () => {
    const live = session('same', 1);
    const creation = session('same', 9);
    expect(mergeSessions([live], [creation])[0]).toBe(live);
  });
});
