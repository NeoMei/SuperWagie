import { create } from 'zustand';
import type { SyncEvent } from '@/lib/opencode/events';

/** Only live tool events populate this index. History and bootstrap never do. */
type LiveTool = { directory: string; callId: string; name: string; startedAt: number };
export const useSessionLiveToolStore = create<{ tools: ReadonlyMap<string, LiveTool> }>(() => ({ tools: new Map() }));
export const resetSessionLiveTools = (): void => { useSessionLiveToolStore.setState({ tools: new Map() }); };

export const applySessionLiveToolEvents = (directory: string, events: readonly SyncEvent[]): void => {
  const previous = useSessionLiveToolStore.getState().tools;
  let draft: Map<string, LiveTool> | null = null;
  const remove = (id: string): void => {
    if ((draft ?? previous).get(id)?.directory !== directory) return;
    draft ??= new Map(previous);
    draft.delete(id);
  };
  for (const event of events) {
    if (event.type === 'session.idle' || event.type === 'session.error') remove(event.properties.sessionID);
    else if (event.type === 'session.status') {
      const { sessionID, status, turnStart } = event.properties;
      const current = (draft ?? previous).get(sessionID);
      if (status.type === 'idle' || (turnStart && current?.directory === directory && current.startedAt < turnStart.at)) remove(sessionID);
    }
    else if (event.type === 'session.deleted') remove(event.properties.sessionID);
    else if (event.type === 'message.part.updated' && event.properties.part.type === 'tool') {
      const { part, sessionID } = event.properties;
      if (part.type !== 'tool') continue;
      const current = (draft ?? previous).get(sessionID);
      if (part.state.status !== 'running') {
        if (current?.callId === part.id) remove(sessionID);
        continue;
      }
      const startedAt = part.state.time.start;
      if (current?.directory === directory && current.startedAt > startedAt) continue;
      if (current?.directory === directory && current.callId === part.id && current.name === part.tool) continue;
      draft ??= new Map(previous);
      draft.delete(sessionID);
      draft.set(sessionID, { directory, callId: part.id, name: part.tool.slice(0, 128), startedAt });
      if (draft.size > 2000) {
        const oldest = draft.keys().next().value;
        if (oldest) draft.delete(oldest);
      }
    }
  }
  if (draft) useSessionLiveToolStore.setState({ tools: draft });
};
