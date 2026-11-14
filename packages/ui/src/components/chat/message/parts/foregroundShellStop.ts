import { useCallback } from 'react';
import { create } from 'zustand';
import type { ShellToStop } from '@/lib/opencode/background-shell';
import { opencodeClient } from '@/lib/opencode/client';
import { captureRuntimeInstance } from '@/lib/runtime-switch';
import { useRuntimeInstance } from '@/hooks/useRuntimeInstance';
import { useBackgroundShellsStore, waitForShellSettle } from '@/sync/background-shells';

// OpenCode cannot cancel a shell call the turn waits for, so Stop on such a
// call moves the session's blocking work to the background and then stops the
// command there, the way a background row does. The call turns into a
// background row on the way, which unmounts the row that started the stop, so
// the stop runs outside React and its state lives here.

const SETTLE_TIMEOUT_MS = 10_000;
type StopOwner = { isCurrent: () => boolean; promise: Promise<void> };
const useStoppingShells = create<{ owners: ReadonlyMap<string, StopOwner> }>(() => ({ owners: new Map() }));

const publishOwner = (shellID: string, owner: StopOwner): void => {
  const owners = new Map([...useStoppingShells.getState().owners].filter(([, entry]) => entry.isCurrent()));
  owners.set(shellID, owner);
  useStoppingShells.setState({ owners });
};

const unmarkStopping = (shellID: string, owner: StopOwner): void => {
  const current = useStoppingShells.getState().owners;
  if (current.get(shellID) !== owner) return;
  const owners = new Map(current);
  owners.delete(shellID);
  useStoppingShells.setState({ owners });
};

export const isForegroundShellStopping = (shellID: string): boolean =>
  useStoppingShells.getState().owners.get(shellID)?.isCurrent() ?? false;

export const useForegroundShellStopping = (shellID: string | undefined): boolean => {
  const current = useRuntimeInstance();
  return useStoppingShells(useCallback((state) => current() && Boolean(shellID && state.owners.get(shellID)?.isCurrent()), [current, shellID]));
};

// A lifecycle reset also withdraws a completed stop before an ID can be reused.
useBackgroundShellsStore.subscribe((state) => {
  const owners = useStoppingShells.getState().owners;
  const retained = new Map([...owners].filter(([id, owner]) => state.byId.has(id) && owner.isCurrent()));
  if (retained.size !== owners.size) useStoppingShells.setState({ owners: retained });
});

/**
 * Stops a command the turn waits for: moves the session's blocking work to
 * the background (every shell or subagent it waits for, as OpenCode does it),
 * waits for this command's call to settle there, then stops the command with
 * the note a background stop posts. Resolves without stopping anything when
 * the command ended on its own first. Rejects when backgrounding fails, the
 * call does not settle and the background call answer within
 * `settleTimeoutMs` (OpenCode found nothing blocking, the event fell into a
 * stream gap, or the route hangs), the runtime changes, or
 * the stop fails; the command may then run on in the background, where its
 * row offers the ordinary Stop.
 */
export const stopForegroundShell = (
  params: { sessionID: string; sessionDirectory?: string | null; shell: ShellToStop },
  settleTimeoutMs = SETTLE_TIMEOUT_MS,
): Promise<void> => {
  const { shellID } = params.shell;
  const existing = useStoppingShells.getState().owners.get(shellID);
  if (existing?.isCurrent()) return existing.promise;
  const ownsRuntime = captureRuntimeInstance();
  const running = useBackgroundShellsStore.getState().byId.get(shellID);
  if (!running) return Promise.resolve();
  if (running.sessionID !== params.sessionID || running.directory !== params.shell.shellDirectory) {
    return Promise.reject(new Error('The command no longer belongs to this session.'));
  }
  const owner: StopOwner = { isCurrent: ownsRuntime, promise: Promise.resolve() };
  owner.promise = Promise.resolve().then(async () => {
    try {
      if (!ownsRuntime()) throw new Error('The runtime changed before the command was stopped.');
      const wait = waitForShellSettle(shellID, settleTimeoutMs);
      const abort = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(new Error('The command stop could not be confirmed in time.'));
        }, settleTimeoutMs);
      });
      try {
        const operation = async () => {
          const [, outcome] = await Promise.all([
            opencodeClient.backgroundSessionWork(params.sessionID, params.sessionDirectory, abort.signal),
            wait.settled,
          ]);
          if (!ownsRuntime()) throw new Error('The runtime changed before the command was stopped.');
          if (outcome === 'ended' || !useBackgroundShellsStore.getState().byId.has(shellID)) {
            unmarkStopping(shellID, owner);
            return;
          }
          await opencodeClient.stopBackgroundShells({
            sessionID: params.sessionID,
            sessionDirectory: params.sessionDirectory,
            shells: [params.shell],
            signal: abort.signal,
          });
          if (!ownsRuntime()) throw new Error('The runtime changed before the command was stopped.');
        };
        await Promise.race([operation(), deadline]);
      } finally {
        clearTimeout(timer);
        abort.abort();
        wait.cancel();
      }
    } catch (error) {
      unmarkStopping(shellID, owner);
      throw error;
    }
  });
  publishOwner(shellID, owner);
  return owner.promise;
};
