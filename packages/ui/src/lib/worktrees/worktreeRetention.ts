import type { Session } from '@/lib/opencode/model';
import { opencodeClient } from '@/lib/opencode/client';
import { validateWorktreeDirectory, resolveGitPrimaryRoot } from '@/lib/gitApi';
import { normalizePath } from '@/lib/pathNormalization';
import { captureRuntimeInstance } from '@/lib/runtime-switch';
import { resolveFolderProjectRef } from '@/lib/worktreeSessionCreator';
import { listGlobalSessionPages } from '@/stores/globalSessions';
import { readSessionsLiveActivity } from '@/sync/session-actions';
import { checkoutHoldsDirectory } from './worktreePaths';
import { moveSessionTreeToProject } from './sessionWorktreeMove';
import { moveSessionsThenRemoveWorktree, groupSessionTreesByFolder, WorktreeKeepStoppedError, type WorktreeKeepStop, type SessionTreeInFolder } from './worktreeRemovalFlow';
import type { I18nKey, I18nParams } from '@/lib/i18n';

const requireCurrent = (isCurrent: () => boolean) => {
  if (!isCurrent()) throw new WorktreeKeepStoppedError('switched');
};

const readCheckoutPath = async (worktreePath: string, isCurrent: () => boolean): Promise<string> => {
  requireCurrent(isCurrent);
  const check = await validateWorktreeDirectory(worktreePath, worktreePath);
  requireCurrent(isCurrent);
  const path = normalizePath(check.resolvedCwd);
  if (!check.valid || !check.insideWorktreeRoot || !path) throw new WorktreeKeepStoppedError('source');
  return path;
};

/** Native pages include archived sessions and descendants. A sidebar subset cannot authorize removal. */
export async function readWorktreeSessions(worktreePath: string, isCurrent = captureRuntimeInstance()): Promise<Session[]> {
  const root = await readCheckoutPath(worktreePath, isCurrent);
  const sessions = await listGlobalSessionPages((options) => {
    requireCurrent(isCurrent);
    return opencodeClient.listSessionsPage(options);
  }, { pageSize: 500 });
  requireCurrent(isCurrent);
  const directories = [...new Set(sessions.map((session) => session.directory))];
  const contained = new Set<string>();
  // Validate aliases too: an old session can retain a symlink path outside
  // the checkout's spelling. Git probes do not start OpenCode locations.
  for (const directory of directories) {
    requireCurrent(isCurrent);
    const check = await validateWorktreeDirectory(directory, worktreePath);
    requireCurrent(isCurrent);
    const normalized = normalizePath(directory);
    const rawInside = normalized && (checkoutHoldsDirectory(root, normalized) || checkoutHoldsDirectory(normalizePath(worktreePath) ?? worktreePath, normalized));
    if (rawInside && (!check.valid || !check.insideWorktreeRoot)) {
      throw new WorktreeKeepStoppedError('source');
    }
    if (check.valid && check.insideWorktreeRoot) contained.add(directory);
  }
  const linked = sessions.filter((session) => contained.has(session.directory));
  groupSessionTreesByFolder(linked);
  return linked;
}

/** Bounded native readback proves inbox moves applied before their source folder is removed. */
async function confirmSessionMoves(
  moves: readonly (SessionTreeInFolder & { projectDirectory: string })[],
  isCurrent: () => boolean,
): Promise<boolean> {
  const signal = AbortSignal.timeout(10_000);
  const targets = moves.flatMap((tree) => [...tree.descendants, tree.root].map((session) => ({ id: session.id, directory: tree.projectDirectory })));
  let pending = targets;
  while (pending.length > 0 && !signal.aborted) {
    requireCurrent(isCurrent);
    const confirmed = await Promise.all(pending.map(async (target) => {
      try {
        const record = await opencodeClient.getSession(target.id, target.directory, signal);
        return normalizePath(record.directory) === normalizePath(target.directory);
      } catch {
        return false;
      }
    }));
    requireCurrent(isCurrent);
    pending = pending.filter((_, index) => !confirmed[index]);
    if (pending.length > 0 && !signal.aborted) await new Promise<void>((resolve) => setTimeout(resolve, 200));
  }
  return pending.length === 0;
}

export async function moveWorktreeSessionsThenRemove(input: {
  worktreePath: string;
  projectDirectory: string;
  removeWorktree: (guard: { beforeRemove: () => Promise<void>; isCurrent: () => boolean }) => Promise<boolean>;
}): Promise<{ removed: boolean; movedIds: readonly string[] }> {
  const isCurrent = captureRuntimeInstance();
  const root = await readCheckoutPath(input.worktreePath, isCurrent);
  const readPrimaryRoot = async (directory: string): Promise<string> => {
    requireCurrent(isCurrent);
    const primary = await resolveGitPrimaryRoot(directory);
    requireCurrent(isCurrent);
    const check = await validateWorktreeDirectory(primary, input.worktreePath);
    requireCurrent(isCurrent);
    const path = normalizePath(check.resolvedCwd);
    if (!check.valid || check.insideWorktreeRoot || !path) throw new WorktreeKeepStoppedError('destination');
    return path;
  };
  const sourcePrimary = await readPrimaryRoot(root);
  const destinations = new Set<string>();
  const attemptedMoves: Array<SessionTreeInFolder & { projectDirectory: string }> = [];
  const validateDestination = async (directory: string): Promise<string> => {
    requireCurrent(isCurrent);
    const check = await validateWorktreeDirectory(directory, input.worktreePath);
    requireCurrent(isCurrent);
    const target = normalizePath(check.resolvedCwd);
    if (!check.valid || !target || check.insideWorktreeRoot || normalizePath(check.resolvedWorktreeRoot) !== root) throw new WorktreeKeepStoppedError('destination');
    const primaryPath = await readPrimaryRoot(directory);
    if (primaryPath !== sourcePrimary || !checkoutHoldsDirectory(primaryPath, target)) throw new WorktreeKeepStoppedError('destination');
    return target;
  };
  const validatePaths = async () => {
    if (await readCheckoutPath(input.worktreePath, isCurrent) !== root || await readPrimaryRoot(root) !== sourcePrimary) throw new WorktreeKeepStoppedError('source');
    for (const directory of destinations) {
      if (await validateDestination(directory) !== directory) throw new WorktreeKeepStoppedError('destination');
    }
  };
  try {
    destinations.add(await validateDestination(input.projectDirectory));
    return await moveSessionsThenRemoveWorktree({
      worktreePath: input.worktreePath,
      readSessions: () => readWorktreeSessions(input.worktreePath, isCurrent),
      readActivity: async (sessions) => {
        for (const directory of new Set(sessions.map((session) => session.directory))) {
          requireCurrent(isCurrent);
          const activity = await readSessionsLiveActivity(sessions.filter((session) => session.directory === directory).map((session) => session.id), directory);
          if (activity !== 'idle') return activity;
        }
        return 'idle';
      },
      resolveDestination: async (directory) => {
        const project = await resolveFolderProjectRef(directory);
        requireCurrent(isCurrent);
        const candidate = project?.path ?? input.projectDirectory;
        // A project registered inside a worktree belongs to that checkout.
        const located = await validateWorktreeDirectory(candidate, input.worktreePath);
        requireCurrent(isCurrent);
        const target = await validateDestination(located.insideWorktreeRoot ? input.projectDirectory : candidate);
        if (await readPrimaryRoot(directory) !== sourcePrimary) throw new WorktreeKeepStoppedError('destination');
        destinations.add(target);
        return target;
      },
      moveTree: async (tree) => {
        attemptedMoves.push(tree);
        await moveSessionTreeToProject(tree, {
          isCurrent,
          assertIdle: async (sessions) => {
            const activity = await readSessionsLiveActivity(sessions.map((session) => session.id), tree.sourceDirectory);
            if (activity !== 'idle') throw new WorktreeKeepStoppedError(activity === 'active' ? 'busy' : 'unknown');
          },
        });
      },
      confirmMoves: (moves) => confirmSessionMoves(moves, isCurrent),
      validatePaths,
      removeWorktree: () => input.removeWorktree({
        isCurrent,
        beforeRemove: async () => {
          await validatePaths();
          if ((await readWorktreeSessions(input.worktreePath, isCurrent)).length > 0) throw new WorktreeKeepStoppedError('added');
          requireCurrent(isCurrent);
        },
      }),
      isCurrent,
    });
  } catch (error) {
    if (!(error instanceof WorktreeKeepStoppedError) || !isCurrent() || attemptedMoves.length === 0) throw error;
    // A tree can fail after one child moved. Report every placement a native
    // read can confirm, while preserving earlier confirmed groups on read failure.
    const movedIds = new Set(error.movedIds);
    const signal = AbortSignal.timeout(1_500);
    for (const tree of attemptedMoves) {
      for (const session of [...tree.descendants, tree.root]) {
        if (!isCurrent() || signal.aborted) break;
        try {
          const placed = await opencodeClient.getSession(session.id, tree.projectDirectory, signal);
          if (isCurrent() && normalizePath(placed.directory) === tree.projectDirectory) movedIds.add(session.id);
        } catch {
          // Unknown placement stays unknown; it never permits checkout removal.
        }
      }
    }
    throw new WorktreeKeepStoppedError(isCurrent() ? error.reason : 'switched', [...movedIds], { cause: error });
  }
}

const STOP_KEYS = {
  busy: 'sessions.sidebar.worktreeKeep.busy', unknown: 'sessions.sidebar.worktreeKeep.unknown',
  added: 'sessions.sidebar.worktreeKeep.added', unconfirmed: 'sessions.sidebar.worktreeKeep.unconfirmed',
  switched: 'sessions.sidebar.worktreeKeep.switched', destination: 'sessions.sidebar.worktreeKeep.destination',
  source: 'sessions.sidebar.worktreeKeep.source', moveFailed: 'sessions.sidebar.worktreeKeep.moveFailed',
  removeFailed: 'sessions.sidebar.worktreeKeep.removeFailed',
} satisfies Record<WorktreeKeepStop, I18nKey>;

export const worktreeKeepFailureDescription = (
  error: Error | null,
  t: (key: I18nKey, params?: I18nParams) => string,
): string => {
  if (!(error instanceof WorktreeKeepStoppedError)) return t('sessions.sidebar.worktreeKeep.moveFailed');
  const reason = t(STOP_KEYS[error.reason]);
  return error.movedIds.length > 0 ? `${reason} ${t('sessions.sidebar.worktreeKeep.partial', { count: error.movedIds.length })}` : reason;
};
