// ---------------------------------------------------------------------------
// Unread sessions: a turn that finished and nobody has looked at yet.
//
// OpenCode owns the state. Its session record carries `time.idle`, when the
// last turn ended, and `time.viewed`, a monotone watermark of the last idle
// transition a viewer saw. A session is unread while the turn that ended last
// is newer than the watermark. Because the record lives in OpenCode's database
// the mark survives restarts, and every client of the server sees the same one:
// a view recorded on the phone clears it on the desktop through the
// `session.viewed` event.
// ---------------------------------------------------------------------------

import { useCallback } from "react"
import { compact, type Session } from "@/lib/opencode/model"
import { opencodeClient } from "@/lib/opencode/client"
import { captureRuntimeInstance, getRuntimeKey } from "@/lib/runtime-switch"
import { useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { z } from 'zod'
import { patchSessionMetadata } from './session-actions'

const manualUnreadSchema = z.object({ openchamber: z.object({ manualUnread: z.literal(true) }) })
const namespaceSchema = z.object({ openchamber: z.record(z.string(), z.json()) })
const hasManualUnread = (session: Session): boolean => manualUnreadSchema.safeParse(session.metadata).success

/**
 * Only top-level sessions are announced; a subtask reports to its parent. An
 * archived session is put away, whichever path archived it, so it is never
 * unread.
 */
export const isSessionUnread = (session: Session | undefined): boolean => {
  if (!session || session.parentID || session.time.archived !== undefined) return false
  return hasManualUnread(session) || isSessionTurnUnread(session)
}

/** Automatic attention checks react only to completed turns. */
export const isSessionTurnUnread = (session: Session | undefined): boolean => {
  if (!session || session.parentID || session.time.archived !== undefined) return false
  const { idle, viewed } = session.time
  return idle !== undefined && (viewed === undefined || viewed < idle)
}

/** Unread, and the turn that left it unread failed. */
export const isSessionUnreadWithError = (session: Session | undefined): boolean => (
  isSessionUnread(session) && session?.outcome === "failed"
)

export const useSessionUnread = (sessionId: string): boolean => (
  useGlobalSessionsStore(useCallback((state) => isSessionUnread(state.entityById.get(sessionId)), [sessionId]))
)

/** Idle stamps being recorded right now, so repeated calls send one request. */
const pendingViews = new Map<string, { idle: number; request: Promise<void>; ownerCurrent: () => boolean }>()
const pendingManualWrites = new Map<string, { request: Promise<void>; ownerCurrent: () => boolean }>()

/** Writes serialize per runtime/session so a delayed unread cannot undo a read. */
export async function setSessionUnread(sessionId: string, unread: boolean): Promise<void> {
  const runtimeKey = getRuntimeKey()
  const ownerCurrent = captureRuntimeInstance()
  const key = JSON.stringify([runtimeKey, sessionId])
  const session = useGlobalSessionsStore.getState().entityById.get(sessionId)
  if (!session || session.parentID || session.time.archived !== undefined) return
  const pending = pendingManualWrites.get(key)
  const previous = pending?.ownerCurrent() ? pending.request : undefined
  if (unread || hasManualUnread(session) || previous) {
    const write = async () => {
      if (!ownerCurrent()) throw new Error('runtime changed')
      await patchSessionMetadata(sessionId, session.directory, (metadata) => {
        const namespace = namespaceSchema.safeParse(metadata).data?.openchamber ?? {}
        // False is explicit, so a client with an old true value is cleared by
        // the same metadata merge and control event as every other client.
        return { ...metadata, openchamber: { ...namespace, manualUnread: unread } }
      }, runtimeKey)
    }
    const request = previous ? previous.catch(() => {}).then(write) : write()
    const entry = { request, ownerCurrent }
    pendingManualWrites.set(key, entry)
    try { await request } finally {
      if (pendingManualWrites.get(key) === entry) pendingManualWrites.delete(key)
    }
  }
  if (!unread && ownerCurrent()) await recordViewedTurn(sessionId)
}

/**
 * Records that the user saw the session's last turn. The local record takes
 * the watermark at once, so the mark clears without waiting for the round
 * trip; a failed write restores it, unless something newer replaced it.
 */
export const markSessionUnreadSeen = (sessionId: string): void => {
  void setSessionUnread(sessionId, false).catch((error) => console.warn("[session-unread] failed to record a view", error))
}

function recordViewedTurn(sessionId: string): Promise<void> {
  const store = useGlobalSessionsStore.getState()
  const session = store.entityById.get(sessionId)
  if (!session || !isSessionTurnUnread(session)) return Promise.resolve()
  const idle = session.time.idle
  const runtimeKey = getRuntimeKey()
  const key = JSON.stringify([runtimeKey, sessionId])
  const pending = pendingViews.get(key)
  if (pending && pending.idle === idle && pending.ownerCurrent()) return pending.request
  if (idle === undefined) return Promise.resolve()

  const previousViewed = session.time.viewed
  const ownerCurrent = captureRuntimeInstance()
  store.upsertSession({ ...session, time: { ...session.time, viewed: idle } })

  const request = opencodeClient.viewSession(sessionId, idle, session.directory)
    .catch((error) => {
      if (!ownerCurrent()) return
      const current = useGlobalSessionsStore.getState().entityById.get(sessionId)
      if (current?.time.viewed !== idle) return
      useGlobalSessionsStore.getState().upsertSession({
        ...current,
        time: compact({ ...current.time, viewed: previousViewed }),
      })
      throw error
    })
    .finally(() => {
      if (pendingViews.get(key)?.request === request) pendingViews.delete(key)
    })
  pendingViews.set(key, { idle, request, ownerCurrent })
  return request
}
