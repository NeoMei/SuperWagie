import { useCallback, useLayoutEffect, useMemo, useReducer, useRef } from 'react';
import { resolveEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { subscribeChatsRoot } from '@/lib/chatDirectories';
import { draftSpaceTarget, panelContentDirectory } from '@/lib/spaces/space-creation-requests';
import { useSpacesStore } from '@/lib/spaces/spaces-store';
import { captureRuntimeInstance } from '@/lib/runtime-switch';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionWorktreeStore } from '@/sync/session-worktree-store';

/** A tree mutation's continuation belongs to its mounted directory and visit. */
export const useFileTreeMutationOwner = (scope: string, normalizeDirectory: (directory: string) => string) => {
  const ownerRef = useRef({ active: false });
  const [directoryVisit, advanceDirectoryVisit] = useReducer((visit: number) => visit + 1, 0);
  const retire = useCallback(() => {
    ownerRef.current.active = false;
    ownerRef.current = { active: true };
  }, []);

  useLayoutEffect(() => {
    retire();
    // The desktop context panes and MobileFilesSurface live outside chat
    // columns, so their imperative owner follows the main effective directory.
    const readDirectories = () => {
      const panel = resolveEffectiveDirectory() ?? '';
      const state = useSessionUIStore.getState();
      const request = state.currentSessionId === null && state.newSessionDraft.open
        ? state.newSessionDraft.pendingWorktreeRequestId : null;
      const files = panelContentDirectory(draftSpaceTarget(request, useSpacesStore.getState().journey), panel) ?? '';
      return JSON.stringify([normalizeDirectory(panel.trim()), normalizeDirectory(files.trim())]);
    };
    let directories = readDirectories();
    const reconcile = () => {
      const next = readDirectories();
      if (next === directories) return;
      directories = next;
      retire();
      advanceDirectoryVisit();
    };
    const unsubscribe = [
      useSessionUIStore.subscribe((next, previous) => {
        if (next.currentSessionId !== previous.currentSessionId
          || next.newSessionDraft !== previous.newSessionDraft
          || next.worktreeMetadata !== previous.worktreeMetadata) reconcile();
      }),
      useDirectoryStore.subscribe((next, previous) => {
        if (next.currentDirectory !== previous.currentDirectory) reconcile();
      }),
      useSessionWorktreeStore.subscribe(reconcile),
      useSpacesStore.subscribe((next, previous) => {
        if (next.journey !== previous.journey) reconcile();
      }),
      subscribeChatsRoot(reconcile),
    ];
    return () => {
      for (const stop of unsubscribe) stop();
      ownerRef.current.active = false;
    };
  }, [normalizeDirectory, retire, scope]);

  const capture = useCallback(() => {
    const owner = ownerRef.current;
    const isCurrentRuntime = captureRuntimeInstance();
    return () => owner.active && isCurrentRuntime();
  }, []);

  return useMemo(() => ({ capture, retire, directoryVisit }), [capture, directoryVisit, retire]);
};
