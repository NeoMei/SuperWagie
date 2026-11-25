import type { OpenCodeEvent } from "@opencode/client"
import { spaceIdOfDirectory } from "@/lib/spaces/space-route"

const TURN_STATUS_EVENTS: ReadonlySet<OpenCodeEvent["type"]> = new Set([
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.retry.scheduled",
  "session.step.started",
])

/** One watermark per session in this runtime. Durable transcript events still backfill. */
export function createTurnBoundaryOrder() {
  const newestBySession = new Map<string, number>()
  const isStale = (event: OpenCodeEvent, frameDirectory?: string): boolean => {
    if (!("durable" in event) || !event.durable || !event.data || typeof event.data !== "object") return false
    const { aggregateID, seq } = event.durable
    if (!("sessionID" in event.data) || event.data.sessionID !== aggregateID || !Number.isSafeInteger(seq)) return false
    const spaceId = spaceIdOfDirectory(event.location?.directory ?? frameDirectory)
    const key = (spaceId ?? '') + ':' + aggregateID
    const newest = newestBySession.get(key)
    if (newest !== undefined && seq <= newest) return TURN_STATUS_EVENTS.has(event.type)
    if (event.type === "session.deleted") newestBySession.delete(key)
    else newestBySession.set(key, seq)
    return false
  }
  return Object.assign(isStale, { clear: () => newestBySession.clear() })
}
