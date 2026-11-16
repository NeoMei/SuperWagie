import { describe, expect, test } from "bun:test"
import { createStore } from "zustand/vanilla"
import type { PermissionRequest, FormRequest, Session, UserMessage } from "@/lib/opencode/model"
import type { MessagePage } from "@/lib/opencode/client"
import { INITIAL_STATE, type State } from "./types"
import {
  readDirectoryPermissionSnapshot,
  readDirectoryFormSnapshot,
  readDirectoryStatusSnapshot,
  recordDirectoryRecoveryEvent,
} from "./directory-recovery-snapshots"
import { ChildStoreManager } from "./child-store"
import { applySessionStatusSnapshot, createEventRoutingIndex, handleEvent, needsSnapshotAfterStatusPoll } from "./sync-context"
import { SessionMessageLoader } from "./session-message-loader"
import { getRuntimeKey } from "../lib/runtime-switch"
import { replaceGlobalSessionStatusById } from "./global-session-status"
import { trackPromptInFlight, withPromptsInFlight } from "./prompts-in-flight"
import { getReconnectCandidateSessionIds } from "./reconnect-recovery"

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => { resolve = complete })
  return { resolve, promise }
}
const source = (initial: Partial<State> = {}) => createStore<State>(() => ({ ...INITIAL_STATE, ...initial }))
const permission: PermissionRequest = { id: "permission", sessionID: "session", action: "read", resources: ["*"], metadata: {} }
const form: FormRequest = { id: "form", sessionID: "session", title: "Pick", fields: [{ key: "answer", type: "boolean" }] }
const session: Session = {
  id: "session", projectID: "project", directory: "/repo",
  title: "Session", time: { created: 1, updated: 1 }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}

describe("directory recovery snapshots", () => {
  test("the event pipeline preserves repeated busy events without publishing a redundant store update", async () => {
    const manager = new ChildStoreManager()
    const store = manager.ensureChild("/repo", { bootstrap: false })
    store.setState({ session: [session], session_status: { session: { type: "busy" } } })
    const response = deferred<State["session_status"]>()
    const snapshot = readDirectoryStatusSnapshot(store, () => response.promise)
    let publications = 0
    const unsubscribe = store.subscribe(() => { publications += 1 })
    try {
      handleEvent("/repo", { type: "session.status", properties: { sessionID: "session", status: { type: "busy" } } },
        manager, createEventRoutingIndex(), getRuntimeKey(), true)
      response.resolve({})
      expect(await snapshot).toEqual({ session: { type: "busy" } })
      expect(publications).toBe(0)
    } finally {
      response.resolve({})
      unsubscribe()
      manager.disposeAll()
      replaceGlobalSessionStatusById(new Map())
    }
  })

  test("a newer idle event cannot be overwritten by an old busy snapshot", async () => {
    const store = source()
    const response = deferred<State["session_status"]>()
    const snapshot = readDirectoryStatusSnapshot(store, () => response.promise)
    recordDirectoryRecoveryEvent(store, { type: "session.idle", properties: { sessionID: "session" } })
    response.resolve({ session: { type: "busy" } })
    expect(await snapshot).toEqual({ session: { type: "idle" } })
  })

  test("an archive event rejected by the reducer cannot erase pending requests from a snapshot", async () => {
    const manager = new ChildStoreManager()
    const store = manager.ensureChild("/repo", { bootstrap: false })
    store.setState({ session: [{ ...session, time: { created: 1, updated: 20 } }] })
    const response = deferred<PermissionRequest[]>()
    const snapshot = readDirectoryPermissionSnapshot(store, () => response.promise)
    try {
      handleEvent("/repo", {
        type: "session.patched",
        properties: { sessionID: session.id, patch: { time: { updated: 10, archived: 10 } } },
      }, manager, createEventRoutingIndex(), getRuntimeKey(), true, undefined, undefined, true)
      response.resolve([permission])
      expect(await snapshot).toEqual({ session: [permission] })
      expect(store.getState().session[0].time.archived).toBeUndefined()
    } finally {
      response.resolve([])
      manager.disposeAll()
    }
  })

  test("equal session IDs in different stores do not share in-flight events", async () => {
    const a = source()
    const b = source()
    const response = deferred<State["session_status"]>()
    const first = readDirectoryStatusSnapshot(a, () => response.promise)
    const second = readDirectoryStatusSnapshot(b, () => response.promise)
    recordDirectoryRecoveryEvent(a, { type: "session.status", properties: { sessionID: "session", status: { type: "busy" } } })
    response.resolve({})
    expect(await first).toEqual({ session: { type: "busy" } })
    expect(await second).toEqual({})
  })

  test("a permission reply received before its ask is materialized prevents resurrection", async () => {
    const store = source()
    const response = deferred<PermissionRequest[]>()
    const snapshot = readDirectoryPermissionSnapshot(store, () => response.promise)
    recordDirectoryRecoveryEvent(store, { type: "permission.replied", properties: { sessionID: "session", requestID: permission.id } })
    response.resolve([permission])
    expect(await snapshot).toEqual({})
  })

  test("a settled form cannot be reopened by an old HTTP response", async () => {
    const store = source()
    const response = deferred<FormRequest[]>()
    const snapshot = readDirectoryFormSnapshot(store, () => response.promise)
    recordDirectoryRecoveryEvent(store, { type: "form.settled", properties: { sessionID: "session", formID: form.id } })
    response.resolve([form])
    expect(await snapshot).toEqual({})
  })

  test("new asks survive empty snapshots and supersede older copies of the same request", async () => {
    const store = source()
    const response = deferred<FormRequest[]>()
    const snapshot = readDirectoryFormSnapshot(store, () => response.promise)
    const newer: FormRequest = { ...form, title: "Proceed?" }
    recordDirectoryRecoveryEvent(store, { type: "form.created", properties: { form: newer } })
    response.resolve([form])
    expect(await snapshot).toEqual({ session: [newer] })
    const permissionSnapshot = readDirectoryPermissionSnapshot(store, async () => [])
    recordDirectoryRecoveryEvent(store, { type: "permission.asked", properties: permission })
    expect(await permissionSnapshot).toEqual({ session: [permission] })
  })

  test("direct local mutations survive while unchanged stale requests are removed", async () => {
    const store = source({ form: { session: [form] } })
    const response = deferred<FormRequest[]>()
    const snapshot = readDirectoryFormSnapshot(store, () => response.promise)
    const added = { ...form, id: "new-form" }
    store.setState({ form: { session: [form, added] } })
    response.resolve([])
    expect(await snapshot).toEqual({ session: [added] })
  })

  test("deleting a session invalidates its status and blocking requests in every in-flight snapshot", async () => {
    const store = source()
    const statusResponse = deferred<State["session_status"]>()
    const permissionResponse = deferred<PermissionRequest[]>()
    const formResponse = deferred<FormRequest[]>()
    const statuses = readDirectoryStatusSnapshot(store, () => statusResponse.promise)
    const permissions = readDirectoryPermissionSnapshot(store, () => permissionResponse.promise)
    const forms = readDirectoryFormSnapshot(store, () => formResponse.promise)
    recordDirectoryRecoveryEvent(store, { type: "session.deleted", properties: { sessionID: session.id } })
    statusResponse.resolve({ session: { type: "busy" } })
    permissionResponse.resolve([permission])
    formResponse.resolve([form])
    expect(await statuses).toEqual({})
    expect(await permissions).toEqual({})
    expect(await forms).toEqual({})
  })

  test("a session whose prompt is still being sent stays busy until OpenCode lists it", async () => {
    const store = source({ session_status: { session: { type: "busy" }, other: { type: "busy" } } })
    const release = trackPromptInFlight("session")
    try {
      expect(await readDirectoryStatusSnapshot(store, async () => ({}))).toEqual({ session: { type: "busy" } })
    } finally {
      release()
    }
    expect(await readDirectoryStatusSnapshot(store, async () => ({}))).toEqual({})
  })

  test("an empty status read started before prompt admission keeps that session recoverable after admission", async () => {
    const store = source({
      session: [session],
      session_status: { session: { type: "busy" } },
      message: { session: [{ id: "prompt", sessionID: "session", role: "user", time: { created: 1 } }] },
      part: { prompt: [{ id: "text", sessionID: "session", messageID: "prompt", type: "text", text: "Fixture prompt" }] },
    })
    const response = deferred<State["session_status"]>()
    const release = trackPromptInFlight("session")
    try {
      const snapshot = readDirectoryStatusSnapshot(store, () => response.promise)
      // The server read preceded admission, but its response reaches the UI
      // after the prompt request completes. No live event repaired the gap.
      release()
      response.resolve({})
      const committed = await snapshot
      store.setState({ session_status: committed })

      expect(committed).toEqual({ session: { type: "busy" } })
      expect(getReconnectCandidateSessionIds(store.getState())).toEqual(["session"])
    } finally {
      release()
      response.resolve({})
    }
  })

  test("a completed first reply missed by the stream is recovered without another prompt", async () => {
    const manager = new ChildStoreManager()
    const target = { directory: "/repo", sessionID: session.id }
    const prompt: UserMessage = { id: "first-prompt", sessionID: session.id, role: "user", time: { created: 1 } }
    const promptParts = [{ id: "first-text", messageID: prompt.id, sessionID: session.id, type: "text", text: "Fixture prompt" }] satisfies MessagePage["items"][number]["parts"]
    const page: MessagePage = { items: [
      { info: prompt, parts: promptParts },
      { info: {
        id: "first-answer", sessionID: session.id, role: "assistant", agent: "build", providerID: "fixture", modelID: "fixture",
        time: { created: 2, completed: 3 }, finish: "stop",
      }, parts: [{ id: "answer-text", messageID: "first-answer", sessionID: session.id, type: "text", text: "Fixture completed answer" }] },
    ], cursor: {} }
    let historyReads = 0
    const loader = new SessionMessageLoader(manager, {
      runtimeKey: getRuntimeKey(),
      sdk: { getSessionMessages: async () => { historyReads += 1; return page } },
    })
    const store = manager.ensureChild(target.directory, { bootstrap: false })
    store.setState({ session: [session], session_status: { [session.id]: { type: "busy" } } })
    loader.initializeCreatedSession(target)
    loader.optimisticAdd({ ...target, message: prompt, parts: promptParts })
    const response = deferred<State["session_status"]>()
    const release = trackPromptInFlight(session.id)
    try {
      const initializing = readDirectoryStatusSnapshot(store, () => response.promise)
      release()
      response.resolve({})
      store.setState({ session_status: await initializing })

      // Exercise the watchdog's real selection, escalation and message loader.
      // Its next status read observes the already completed turn, with no
      // second user message or live event needed to make recovery eligible.
      const beforePoll = store.getState()
      const candidates = getReconnectCandidateSessionIds(beforePoll)
      applySessionStatusSnapshot(store, {}, candidates, "monotonic")
      for (const id of candidates) {
        if (!needsSnapshotAfterStatusPoll(beforePoll, id, undefined)) continue
        applySessionStatusSnapshot(store, {}, [id], "authoritative")
        await loader.refreshTail({ ...target, sessionID: id }, 100)
      }

      const state = store.getState()
      expect(historyReads).toBe(1)
      expect(state.message[session.id].map((message) => message.role)).toEqual(["user", "assistant"])
      expect(state.message[session.id][1].time).toEqual({ created: 2, completed: 3 })
      expect(state.part["first-answer"]).toEqual(page.items[1].parts)
      expect(state.session_status[session.id]).toEqual({ type: "idle" })
      expect(getReconnectCandidateSessionIds(state)).toEqual([])
      expect(await readDirectoryStatusSnapshot(store, async () => ({}))).toEqual({})
    } finally {
      release()
      response.resolve({})
      loader.dispose()
      manager.disposeAll()
    }
  })

  for (const settlement of ["idle", "error", "delete", "rejected send"] as const) {
    test(`a newer ${settlement} supersedes pre-admission status protection`, async () => {
      const store = source({ session_status: { session: { type: "busy" }, other: { type: "busy" } } })
      const response = deferred<State["session_status"]>()
      const release = trackPromptInFlight(session.id)
      try {
        const snapshot = readDirectoryStatusSnapshot(store, () => response.promise)
        release()
        if (settlement === "idle") {
          recordDirectoryRecoveryEvent(store, { type: "session.idle", properties: { sessionID: session.id } })
        } else if (settlement === "error") {
          recordDirectoryRecoveryEvent(store, { type: "session.error", properties: { sessionID: session.id, error: { type: "fixture", message: "Rejected" } } })
        } else if (settlement === "delete") {
          recordDirectoryRecoveryEvent(store, { type: "session.deleted", properties: { sessionID: session.id } })
        } else {
          store.setState({ session_status: { ...store.getState().session_status, [session.id]: { type: "idle" } } })
        }
        response.resolve({})
        const committed = await snapshot
        expect(committed).toEqual(settlement === "delete" ? {} : { session: { type: "idle" } })
        store.setState({ session_status: committed })
        expect(await readDirectoryStatusSnapshot(store, async () => ({}))).toEqual({})
      } finally {
        release()
        response.resolve({})
      }
    })
  }

  test("a snapshot keeps the active status only of sessions whose prompt is being sent", () => {
    const snapshot = { listed: { type: "busy" } } satisfies State["session_status"]
    const current = {
      sending: { type: "busy" }, sendingIdle: { type: "idle" }, notSending: { type: "busy" },
    } satisfies State["session_status"]
    expect(withPromptsInFlight(snapshot, current)).toBe(snapshot)
    const releaseBusy = trackPromptInFlight("sending")
    const releaseIdle = trackPromptInFlight("sendingIdle")
    try {
      expect(withPromptsInFlight(snapshot, current)).toEqual({ listed: { type: "busy" }, sending: { type: "busy" } })
      expect(snapshot).toEqual({ listed: { type: "busy" } })
    } finally {
      releaseBusy()
      releaseIdle()
    }
  })

  test("an idle event during the read still settles a session whose prompt is being sent", async () => {
    const store = source({ session_status: { session: { type: "busy" } } })
    const release = trackPromptInFlight("session")
    try {
      const response = deferred<State["session_status"]>()
      const snapshot = readDirectoryStatusSnapshot(store, () => response.promise)
      recordDirectoryRecoveryEvent(store, { type: "session.idle", properties: { sessionID: "session" } })
      response.resolve({})
      expect(await snapshot).toEqual({ session: { type: "idle" } })
    } finally {
      release()
    }
  })

  test("failed reads leave no event history for a later successful snapshot", async () => {
    const store = source()
    for (let index = 0; index < 100; index += 1) {
      await expect(readDirectoryStatusSnapshot(store, async () => { throw new Error("offline") })).rejects.toThrow("offline")
      recordDirectoryRecoveryEvent(store, { type: "session.status", properties: { sessionID: "session", status: { type: "busy" } } })
    }
    expect(await readDirectoryStatusSnapshot(store, async () => ({}))).toEqual({})
  })
})
