import { create } from 'zustand';
import type { SyncEvent } from '@/lib/opencode/events';

/** Only live tool events populate this index. History and bootstrap never do. */
type LiveTool = { directory: string; callId: string; name: string; startedAt: number };
type ToolCall = { messageId: string; name: string; startedAt?: number };
type SessionTools = { directory: string; calls: Map<string, ToolCall> };
const MAX_SESSIONS = 2_000;
const MAX_CALLS_PER_SESSION = 32;

// OpenCode v2 sends the tool name before the event that starts execution.
// Keep those names and overlapping calls off the published store.
const sessionTools = new Map<string, SessionTools>();
export const useSessionLiveToolStore = create<{ tools: ReadonlyMap<string, LiveTool> }>(() => ({ tools: new Map() }));
export const resetSessionLiveTools = (): void => {
  sessionTools.clear();
  if (useSessionLiveToolStore.getState().tools.size > 0) useSessionLiveToolStore.setState({ tools: new Map() });
};

export const applySessionLiveToolEvents = (directory: string, events: readonly SyncEvent[]): void => {
  const changed = new Set<string>();
  const scopedSession = (id: string): SessionTools | undefined => {
    const session = sessionTools.get(id);
    return session?.directory === directory ? session : undefined;
  };
  const removeSession = (id: string): void => {
    if (scopedSession(id)) {
      sessionTools.delete(id);
      changed.add(id);
    }
  };
  const removeCall = (id: string, callId: string, messageId: string): void => {
    const session = scopedSession(id);
    if (!session || session.calls.get(callId)?.messageId !== messageId) return;
    session.calls.delete(callId);
    if (session.calls.size === 0) sessionTools.delete(id);
    changed.add(id);
  };

  for (const event of events) {
    if (event.type === 'session.idle' || event.type === 'session.error' || event.type === 'session.deleted') {
      removeSession(event.properties.sessionID);
    } else if (event.type === 'session.status') {
      const { sessionID, status, turnStart } = event.properties;
      if (status.type === 'idle' || status.type === 'retry') {
        removeSession(sessionID);
      } else if (turnStart) {
        const session = scopedSession(sessionID);
        for (const [callId, call] of session?.calls ?? []) {
          if (call.startedAt !== undefined && call.startedAt < turnStart.at) removeCall(sessionID, callId, call.messageId);
        }
      }
    } else if (event.type === 'message.tool.transition') {
      const { sessionID, messageID, partID, transition } = event.properties;
      if (transition.kind === 'success' || transition.kind === 'failed' || (transition.kind === 'called' && !transition.executed)) {
        removeCall(sessionID, partID, messageID);
      } else if (transition.kind === 'called') {
        const call = scopedSession(sessionID)?.calls.get(partID);
        if (call?.messageId === messageID && call.startedAt === undefined) {
          call.startedAt = transition.start;
          changed.add(sessionID);
        }
      }
    } else if (event.type === 'message.part.updated') {
      const { part, sessionID } = event.properties;
      if (part.type !== 'tool') continue;
      if (part.state.status === 'completed' || part.state.status === 'error' || part.executed === false) {
        removeCall(sessionID, part.id, part.messageID);
        continue;
      }
      const session = scopedSession(sessionID) ?? { directory, calls: new Map<string, ToolCall>() };
      const existing = session.calls.get(part.id);
      if (part.state.status === 'pending' && existing?.messageId === part.messageID) continue;
      const name = part.tool.slice(0, 128);
      if (!name.trim()) continue;
      const startedAt = part.state.status === 'running' ? part.state.time.start : undefined;
      if (existing?.messageId === part.messageID && existing.name === name && existing.startedAt === startedAt) continue;
      session.calls.delete(part.id);
      session.calls.set(part.id, { messageId: part.messageID, name, startedAt });
      if (session.calls.size > MAX_CALLS_PER_SESSION) {
        const oldest = session.calls.keys().next().value;
        if (oldest !== undefined) session.calls.delete(oldest);
      }
      sessionTools.delete(sessionID);
      sessionTools.set(sessionID, session);
      changed.add(sessionID);
      if (sessionTools.size > MAX_SESSIONS) {
        const oldest = sessionTools.keys().next().value;
        if (oldest !== undefined) {
          sessionTools.delete(oldest);
          changed.add(oldest);
        }
      }
    }
  }

  const previous = useSessionLiveToolStore.getState().tools;
  let draft: Map<string, LiveTool> | null = null;
  for (const id of changed) {
    const session = sessionTools.get(id);
    const current = previous.get(id);
    let latest: LiveTool | undefined;
    if (session) {
      for (const [callId, { name, startedAt }] of session.calls) {
        if (startedAt === undefined || (latest && startedAt < latest.startedAt)) continue;
        latest = { callId, name, startedAt, directory: session.directory };
      }
    }
    if (current?.callId === latest?.callId && current?.directory === latest?.directory
      && current?.name === latest?.name && current?.startedAt === latest?.startedAt) continue;
    draft ??= new Map(previous);
    if (latest) draft.set(id, latest);
    else draft.delete(id);
  }
  if (draft) useSessionLiveToolStore.setState({ tools: draft });
};
