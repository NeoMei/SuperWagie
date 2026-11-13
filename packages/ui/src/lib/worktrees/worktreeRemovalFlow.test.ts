import { describe, expect, test } from 'bun:test';

import type { Session } from '@/lib/opencode/model';
import { archiveSessionsThenRemoveWorktree, groupSessionTreesByFolder, moveSessionsThenRemoveWorktree, WorktreeKeepStoppedError } from './worktreeRemovalFlow';

describe('archiveSessionsThenRemoveWorktree', () => {
  test('archives linked sessions while the worktree still exists, then removes it', async () => {
    const calls: string[] = [];
    const result = await archiveSessionsThenRemoveWorktree({
      sessionIds: ['session-one', 'session-two'],
      archiveSessions: async (sessionIds) => {
        calls.push(`archive:${sessionIds.join(',')}`);
        return { archivedIds: ['session-one'], failedIds: ['session-two'] };
      },
      removeWorktree: async (archivedIds) => {
        calls.push(`remove:${archivedIds.join(',')}`);
        return true;
      },
      restoreSessions: async (sessionIds) => {
        calls.push(`restore:${sessionIds.join(',')}`);
        return { failedIds: [] };
      },
    });

    // An archive of the worktree records exactly the sessions that went.
    expect(calls).toEqual(['archive:session-one,session-two', 'remove:session-one']);
    expect(result).toEqual({ removed: true, archive: { archivedIds: ['session-one'], failedIds: ['session-two'] } });
  });

  test('restores the sessions it archived when the removal fails', async () => {
    const calls: string[] = [];
    const result = await archiveSessionsThenRemoveWorktree({
      sessionIds: ['session-one', 'session-two'],
      archiveSessions: async () => ({ archivedIds: ['session-one'], failedIds: ['session-two'] }),
      removeWorktree: async () => false,
      restoreSessions: async (sessionIds) => {
        calls.push(`restore:${sessionIds.join(',')}`);
        return { failedIds: [] };
      },
    });

    expect(calls).toEqual(['restore:session-one']);
    expect(result).toEqual({ removed: false, archive: { archivedIds: [], failedIds: [] } });
  });

  test('restores the sessions and passes the error on when the removal throws', async () => {
    const restored: string[] = [];
    await expect(archiveSessionsThenRemoveWorktree({
      sessionIds: ['session-one'],
      archiveSessions: async () => ({ archivedIds: ['session-one'], failedIds: [] }),
      removeWorktree: async () => { throw new Error('remote branch kept'); },
      restoreSessions: async (sessionIds) => {
        restored.push(...sessionIds);
        return { failedIds: [] };
      },
    })).rejects.toThrow('remote branch kept');
    expect(restored).toEqual(['session-one']);
  });

  test('removes a worktree with no sessions without archiving anything', async () => {
    let archived = false;
    const result = await archiveSessionsThenRemoveWorktree({
      sessionIds: [],
      archiveSessions: async () => {
        archived = true;
        return { archivedIds: [], failedIds: [] };
      },
      removeWorktree: async () => true,
      restoreSessions: async () => ({ failedIds: [] }),
    });

    expect(archived).toBe(false);
    expect(result.removed).toBe(true);
  });
});

const session = (id: string, directory = '/wt', parentID?: string): Session => ({
  id, directory, parentID, title: id, projectID: 'project', cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
});

type KeepOptions = Parameters<typeof moveSessionsThenRemoveWorktree>[0];
const fixture = (overrides: Partial<KeepOptions> = {}) => {
  let source = [session('parent'), session('child', '/wt', 'parent'), session('second', '/wt/sub')];
  const moved: string[] = [];
  let removed = false;
  const options: KeepOptions = {
    worktreePath: '/wt', readSessions: async () => source,
    readActivity: async () => 'idle', resolveDestination: async () => '/project',
    moveTree: async (tree) => {
      const ids = [...tree.descendants, tree.root].map((item) => item.id);
      moved.push(...ids);
      source = source.filter((item) => !ids.includes(item.id));
    },
    confirmMoves: async () => true, validatePaths: async () => {},
    removeWorktree: async () => { removed = true; return true; }, isCurrent: () => true,
    ...overrides,
  };
  return { options, moved, removed: () => removed };
};

describe('keep worktree sessions before removal', () => {
  test('moves children before parents and every subfolder group before deleting', async () => {
    const f = fixture();
    const result = await moveSessionsThenRemoveWorktree(f.options);
    expect(f.moved).toEqual(['child', 'parent', 'second']);
    expect(result).toEqual({ removed: true, movedIds: ['child', 'parent', 'second'] });
  });
  test('does not lose cross-folder children or accept cycles', () => {
    expect(groupSessionTreesByFolder([session('p'), session('c', '/wt/sub', 'p')]).map((tree) => tree.root.id)).toEqual(['p', 'c']);
    expect(() => groupSessionTreesByFolder([session('p', '/wt', 'c'), session('c', '/wt', 'p')])).toThrow();
  });
  for (const activity of ['active', 'unknown'] as const) {
    test(`keeps all sessions and checkout when status is ${activity}`, async () => {
      const f = fixture({ readActivity: async () => activity });
      await expect(moveSessionsThenRemoveWorktree(f.options)).rejects.toMatchObject({ reason: activity === 'active' ? 'busy' : 'unknown' });
      expect(f.moved).toEqual([]);
      expect(f.removed()).toBe(false);
    });
  }
  test('keeps completed groups visible after the second group fails', async () => {
    const f = fixture();
    const move = f.options.moveTree;
    f.options.moveTree = async (tree) => {
      if (tree.root.id === 'second') throw new Error('migration failed');
      await move(tree);
    };
    const error = await moveSessionsThenRemoveWorktree(f.options).catch((error: Error) => error);
    expect(error).toBeInstanceOf(WorktreeKeepStoppedError);
    expect(error).toMatchObject({ movedIds: ['child', 'parent'], reason: 'moveFailed' });
    expect(f.removed()).toBe(false);
  });
  test('new or missed session in final authoritative rescan blocks deletion', async () => {
    let reads = 0;
    const f = fixture({ readSessions: async () => ++reads === 1 ? [session('parent')] : [session('new')] });
    await expect(moveSessionsThenRemoveWorktree(f.options)).rejects.toMatchObject({ reason: 'added' });
    expect(f.removed()).toBe(false);
  });
  test('a failed complete initial list cannot act as empty success', async () => {
    const f = fixture({ readSessions: async () => { throw new Error('page 2 failed'); } });
    await expect(moveSessionsThenRemoveWorktree(f.options)).rejects.toThrow();
    expect(f.moved).toEqual([]);
    expect(f.removed()).toBe(false);
  });
  test('queued native moves must apply before deleting', async () => {
    const f = fixture({ confirmMoves: async () => false });
    await expect(moveSessionsThenRemoveWorktree(f.options)).rejects.toMatchObject({ reason: 'unconfirmed' });
    expect(f.removed()).toBe(false);
  });
  test('target inside checkout is rejected before the first move', async () => {
    const f = fixture({ resolveDestination: async () => '/wt/nested-project' });
    await expect(moveSessionsThenRemoveWorktree(f.options)).rejects.toMatchObject({ reason: 'destination' });
    expect(f.moved).toEqual([]);
  });
  test('a switched instance prevents later native calls and deletion', async () => {
    let current = true;
    const f = fixture({ isCurrent: () => current });
    const move = f.options.moveTree;
    f.options.moveTree = async (tree) => { await move(tree); current = false; };
    await expect(moveSessionsThenRemoveWorktree(f.options)).rejects.toMatchObject({ reason: 'switched' });
    expect(f.moved).toEqual(['child', 'parent']);
    expect(f.removed()).toBe(false);
  });
  test('external disk loss at final path check leaves checkout removal uncalled', async () => {
    const f = fixture({ validatePaths: async () => { throw new Error('volume unavailable'); } });
    await expect(moveSessionsThenRemoveWorktree(f.options)).rejects.toMatchObject({ movedIds: ['child', 'parent', 'second'] });
    expect(f.removed()).toBe(false);
  });
  test('a failed final deletion keeps sessions at their confirmed destination', async () => {
    const f = fixture({ removeWorktree: async () => false });
    expect(await moveSessionsThenRemoveWorktree(f.options)).toEqual({ removed: false, movedIds: ['child', 'parent', 'second'] });
    expect(f.moved).toEqual(['child', 'parent', 'second']);
  });
});
