/**
 * Recent OpenCode session errors, kept in memory for diagnostics.
 *
 * OpenCode reports a failed turn as a `session.error` event. The message it
 * carries is the only account of what went wrong, and it may arrive without
 * an assistant message to attach itself to, so a turn can end with nothing
 * on screen. This buffer keeps the last errors until someone asks for them,
 * via `__opencodeDebug`; the diagnostic timeline exports only the event type,
 * not the raw error message. In-memory
 * only: never persisted, never sent anywhere, dropped on reload.
 */

import type { StructuredError } from '@/lib/opencode/model'

const MAX_RECORDED_SESSION_ERRORS = 20
const MAX_MESSAGE_LENGTH = 400
const MAX_RESPONSE_BODY_LENGTH = 16_000

export type OpenCodeErrorSummary = {
  name: string | null
  message: string | null
  status?: number
}

export type SessionErrorRecord = OpenCodeErrorSummary & {
  at: number
  sessionId: string
  directory: string | null
}

/**
 * OpenCode v2 reports a failed turn as `{ type, message, status? }`. The record
 * keeps the class, text and HTTP status so live notices can classify the same
 * error as stored history. Returns nulls when neither text field is usable, so a caller can
 * tell "no details" from a real message.
 */
export function summarizeOpenCodeError(error: StructuredError | null | undefined): OpenCodeErrorSummary {
  if (!error) return { name: null, message: null }
  const name = error.type.trim() ? error.type.trim() : null
  const message = error.message.trim()
  const summary: OpenCodeErrorSummary = { name, message: message ? message.slice(0, MAX_MESSAGE_LENGTH) : null }
  if (error.status !== undefined) summary.status = error.status
  return summary
}

/**
 * The provider's raw response body behind the error (OpenCode 2.0.20+), for
 * the details a person can expand under the notice. Kept out of the
 * diagnostics records: a body may echo request content.
 */
export function responseBodyOf(error: StructuredError | null | undefined): string | null {
  const body = error?.response?.body.trim()
  return body ? body.slice(0, MAX_RESPONSE_BODY_LENGTH) : null
}

const records: SessionErrorRecord[] = []

export function recordSessionError(record: Omit<SessionErrorRecord, 'at'>): void {
  records.push({ ...record, at: Date.now() })
  if (records.length > MAX_RECORDED_SESSION_ERRORS) {
    records.splice(0, records.length - MAX_RECORDED_SESSION_ERRORS)
  }
}

/** Newest first. */
export function getRecentSessionErrors(): SessionErrorRecord[] {
  return [...records].reverse()
}
