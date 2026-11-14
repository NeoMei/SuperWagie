import type { Session } from '@/lib/opencode/model';
import { normalizePath } from '@/lib/pathNormalization';
import { checkoutHoldsDirectory } from './worktreePaths';

export type SessionArchiveResult = {
  archivedIds: string[];
  failedIds: string[];
};

/**
 * Archives a worktree's sessions, then removes (or archives) the worktree. The sessions go
 * first because OpenCode can change a session only while its directory exists:
 * archived after the removal, each one would have to move to the project's
 * main folder first and carry a "moved" note in its transcript. A removal that
 * fails or throws restores the sessions it archived, so no archived session
 * stays attached to a worktree still on disk; a throw is passed on after that.
 */
export async function archiveSessionsThenRemoveWorktree(options: {
  sessionIds: string[];
  /** Gets the sessions it archived: an archive of the worktree records them. */
  removeWorktree: (archivedIds: string[]) => Promise<boolean>;
  archiveSessions: (sessionIds: string[]) => Promise<SessionArchiveResult>;
  restoreSessions: (sessionIds: string[]) => Promise<{ failedIds: string[] }>;
}): Promise<{ removed: boolean; archive: SessionArchiveResult }> {
  const archive = options.sessionIds.length > 0
    ? await options.archiveSessions(options.sessionIds)
    : { archivedIds: [], failedIds: [] };
  const restore = async () => {
    if (archive.archivedIds.length === 0) return;
    const { failedIds } = await options.restoreSessions(archive.archivedIds)
      .catch(() => ({ failedIds: archive.archivedIds }));
    if (failedIds.length > 0) {
      console.warn(`[worktrees] ${failedIds.length} session(s) stay archived after the worktree removal failed`);
    }
  };

  let removed: boolean;
  try {
    removed = await options.removeWorktree(archive.archivedIds);
  } catch (error) {
    await restore();
    throw error;
  }
  if (removed) return { removed, archive };
  await restore();
  return { removed, archive: { archivedIds: [], failedIds: [] } };
}

export type WorktreeKeepStop = 'busy' | 'unknown' | 'added' | 'unconfirmed' | 'switched' | 'destination' | 'source' | 'moveFailed' | 'removeFailed';

/** Earlier completed groups remain in their projects when a later step stops. */
export class WorktreeKeepStoppedError extends Error {
  constructor(readonly reason: WorktreeKeepStop, readonly movedIds: readonly string[] = [], options?: ErrorOptions) {
    super(`Worktree retention stopped: ${reason}`, options);
    this.name = 'WorktreeKeepStoppedError';
  }
}

export type SessionTreeInFolder = {
  root: Session;
  /** Children move before parents. */
  descendants: Session[];
  sourceDirectory: string;
};

export const groupSessionTreesByFolder = (sessions: readonly Session[]): SessionTreeInFolder[] => {
  const byFolder = new Map<string, Session[]>();
  const ids = new Set<string>();
  for (const session of sessions) {
    const folder = normalizePath(session.directory);
    if (!folder || ids.has(session.id)) throw new WorktreeKeepStoppedError('source');
    ids.add(session.id);
    const members = byFolder.get(folder) ?? [];
    members.push(session);
    byFolder.set(folder, members);
  }
  return [...byFolder.entries()].flatMap(([sourceDirectory, members]) => {
    const membersById = new Map(members.map((session) => [session.id, session]));
    const visited = new Set<string>();
    const descendantsOf = (id: string): Session[] => members
      .filter((session) => session.parentID === id)
      .flatMap((child) => {
        if (visited.has(child.id)) throw new WorktreeKeepStoppedError('source');
        visited.add(child.id);
        return [...descendantsOf(child.id), child];
      });
    const trees = members.filter((session) => !session.parentID || !membersById.has(session.parentID)).map((root) => {
      visited.add(root.id);
      return { root, descendants: descendantsOf(root.id), sourceDirectory };
    });
    if (visited.size !== members.length) throw new WorktreeKeepStoppedError('source');
    return trees;
  });
};

/** All reads are complete authoritative snapshots. A failed read preserves the checkout. */
export async function moveSessionsThenRemoveWorktree(options: {
  worktreePath: string;
  readSessions: () => Promise<readonly Session[]>;
  readActivity: (sessions: readonly Session[]) => Promise<'active' | 'idle' | 'unknown'>;
  resolveDestination: (directory: string) => Promise<string>;
  moveTree: (tree: SessionTreeInFolder & { projectDirectory: string }) => Promise<void>;
  confirmMoves: (moves: readonly (SessionTreeInFolder & { projectDirectory: string })[]) => Promise<boolean>;
  /** Rechecks actual source/target paths immediately before removal. */
  validatePaths: () => Promise<void>;
  removeWorktree: () => Promise<boolean>;
  isCurrent: () => boolean;
}): Promise<{ removed: boolean; movedIds: readonly string[] }> {
  const movedIds: string[] = [];
  let removing = false;
  const assertCurrent = () => {
    if (!options.isCurrent()) throw new WorktreeKeepStoppedError('switched');
  };
  const assertIdle = async (sessions: readonly Session[]) => {
    assertCurrent();
    if (sessions.length === 0) return;
    const activity = await options.readActivity(sessions);
    assertCurrent();
    if (activity !== 'idle') throw new WorktreeKeepStoppedError(activity === 'active' ? 'busy' : 'unknown');
  };
  try {
    assertCurrent();
    const sessions = await options.readSessions();
    await assertIdle(sessions);
    const moves: Array<SessionTreeInFolder & { projectDirectory: string }> = [];
    for (const tree of groupSessionTreesByFolder(sessions)) {
      assertCurrent();
      const projectDirectory = await options.resolveDestination(tree.sourceDirectory);
      assertCurrent();
      if (checkoutHoldsDirectory(normalizePath(options.worktreePath) ?? options.worktreePath, normalizePath(projectDirectory) ?? projectDirectory)) {
        throw new WorktreeKeepStoppedError('destination');
      }
      moves.push({ ...tree, projectDirectory });
    }
    for (const [index, move] of moves.entries()) {
      await assertIdle(moves.slice(index).flatMap((tree) => [tree.root, ...tree.descendants]));
      await options.moveTree(move);
      assertCurrent();
      if (!await options.confirmMoves([move])) throw new WorktreeKeepStoppedError('unconfirmed');
      assertCurrent();
      movedIds.push(...move.descendants.map((session) => session.id), move.root.id);
    }
    if (moves.length > 0 && !await options.confirmMoves(moves)) throw new WorktreeKeepStoppedError('unconfirmed');
    assertCurrent();
    // Even an old ID still reported at the source means native application is incomplete.
    if ((await options.readSessions()).length > 0) throw new WorktreeKeepStoppedError('added');
    assertCurrent();
    await options.validatePaths();
    assertCurrent();
    removing = true;
    return { removed: await options.removeWorktree(), movedIds };
  } catch (error) {
    const reason = !options.isCurrent() ? 'switched' : error instanceof WorktreeKeepStoppedError ? error.reason : removing ? 'removeFailed' : 'moveFailed';
    throw new WorktreeKeepStoppedError(reason, movedIds, { cause: error });
  }
}
