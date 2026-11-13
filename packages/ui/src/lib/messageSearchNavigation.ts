import { requestReasoningReveal } from '@/components/chat/search/reasoningReveal';
import type { MessageSearchHit } from '@/lib/messageSearch';
import { openSessionLink } from '@/lib/router/openSessionFromRoute';
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

/** Every search entry opens the matched message using its owning directory. */
export function openMessageSearchHit(hit: MessageSearchHit): void {
  const known = useGlobalSessionsStore.getState().entityById.get(hit.sessionId);
  const directory = known ? resolveGlobalSessionDirectory(known) : hit.directory;
  if (!directory) return;
  useSessionUIStore.getState().setCurrentSession(hit.sessionId, directory);
  requestReasoningReveal(hit.role === 'reasoning' ? hit.id : null);
  void openSessionLink(hit.sessionId, hit.id);
}
