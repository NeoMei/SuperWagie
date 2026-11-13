import React from 'react';
import { captureRuntimeInstance, getRuntimeKey } from '@/lib/runtime-switch';
import { normalizePath } from '@/lib/pathNormalization';
import { useInlineCommentDraftStore, type InlineCommentDraft, type InlineCommentDraftTarget } from '@/stores/useInlineCommentDraftStore';

type DraftInput = Omit<InlineCommentDraft, 'id' | 'createdAt' | 'sessionKey'>;
type PublishedTarget = { runtimeKey: string; target: InlineCommentDraftTarget; isCurrentRuntime: () => boolean };
let mainComposer: PublishedTarget | null = null;

/** ChatInput publishes the exact target it displays and consumes, including BTW. */
export function usePublishMainComposerDraftTarget(target: InlineCommentDraftTarget | null, runtimeKey: string, enabled: boolean): void {
  React.useLayoutEffect(() => {
    if (!enabled || !target || !runtimeKey || runtimeKey !== getRuntimeKey()) return;
    const published: PublishedTarget = { runtimeKey, target, isCurrentRuntime: captureRuntimeInstance() };
    mainComposer = published;
    return () => { if (mainComposer === published) mainComposer = null; };
  }, [enabled, runtimeKey, target]);
}

/** App-wide file actions target the main composer; pinned columns keep their own drafts. */
export function attachToMainComposerDraft(runtimeKey: string, directory: string, draft: DraftInput): boolean {
  const published = mainComposer;
  if (!published || !published.isCurrentRuntime() || runtimeKey !== published.runtimeKey
    || normalizePath(directory) !== normalizePath(published.target.directory)) return false;
  return useInlineCommentDraftStore.getState().addDraft(published.target, draft) !== null;
}
