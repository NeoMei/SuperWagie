import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import type { Session } from "@/lib/opencode/model"
import { opencodeClient } from "@/lib/opencode/client"
import { switchRuntimeEndpoint } from "@/lib/runtime-switch"
import { z } from 'zod'
import { useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { isSessionUnread, isSessionTurnUnread, isSessionUnreadWithError, markSessionUnreadSeen, setSessionUnread } from "./session-unread"

const session = (id: string, time: Partial<Session["time"]> = {}, extra: Partial<Session> = {}): Session => ({
  id, directory: "/repo", projectID: "project", title: id, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1, ...time },
  ...extra,
})

const record = (id: string) => useGlobalSessionsStore.getState().entityById.get(id)

describe("isSessionUnread", () => {
  test("a finished turn nobody has seen is unread until a view reaches it", () => {
    expect(isSessionUnread(session("a"))).toBe(false)
    expect(isSessionUnread(session("a", { idle: 10 }))).toBe(true)
    expect(isSessionUnread(session("a", { idle: 10, viewed: 5 }))).toBe(true)
    expect(isSessionUnread(session("a", { idle: 10, viewed: 10 }))).toBe(false)
    expect(isSessionUnread(undefined)).toBe(false)
  })

  test("subtasks and archived sessions are never unread", () => {
    expect(isSessionUnread(session("child", { idle: 10 }, { parentID: "parent" }))).toBe(false)
    expect(isSessionUnread(session("a", { idle: 10, archived: 20 }))).toBe(false)
  })

  test("manual unread overlays the viewed watermark and keeps archive rules", () => {
    const manuallyUnread = { metadata: { openchamber: { manualUnread: true } } }
    expect(isSessionUnread(session("a", { idle: 10, viewed: 10 }, manuallyUnread))).toBe(true)
    expect(isSessionUnread(session("a", {}, manuallyUnread))).toBe(true)
    expect(isSessionTurnUnread(session("a", { idle: 10, viewed: 10 }, manuallyUnread))).toBe(false)
    expect(isSessionUnread(session("child", {}, { ...manuallyUnread, parentID: "root" }))).toBe(false)
    expect(isSessionUnread(session("archived", { archived: 10 }, manuallyUnread))).toBe(false)
  })

  test("an unread failed turn carries the error mark", () => {
    expect(isSessionUnreadWithError(session("a", { idle: 10 }, { outcome: "failed" }))).toBe(true)
    expect(isSessionUnreadWithError(session("a", { idle: 10 }, { outcome: "succeeded" }))).toBe(false)
    expect(isSessionUnreadWithError(session("a", { idle: 10, viewed: 10 }, { outcome: "failed" }))).toBe(false)
  })
})

test('manual marks round-trip through metadata without moving the kernel watermark', async () => {
  const originalFetch = globalThis.fetch
  let server = session('manual', { idle: 10, viewed: 10 }, { metadata: { openchamber: { work: { state: 'open' } } } })
  const read = spyOn(opencodeClient, 'getSession').mockImplementation(async () => server)
  const view = spyOn(opencodeClient, 'viewSession').mockResolvedValue(undefined)
  globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = z.object({ patch: z.object({ openchamber: z.record(z.string(), z.json()) }) }).parse(JSON.parse(String(init?.body)))
    server = { ...server, metadata: { ...server.metadata, openchamber: { work: { state: 'open' }, ...body.patch.openchamber } } }
    return Response.json({ metadata: server.metadata })
  }, originalFetch)
  useGlobalSessionsStore.getState().applySnapshot([server], [], 'ready')
  try {
    await setSessionUnread('manual', true)
    expect(isSessionUnread(record('manual'))).toBe(true)
    expect(record('manual')?.time.viewed).toBe(10)
    expect(view.mock.calls).toEqual([])
    useGlobalSessionsStore.getState().resetForRuntimeSwitch()
    useGlobalSessionsStore.getState().applySnapshot([server], [], 'ready')
    expect(isSessionUnread(record('manual'))).toBe(true)
    await setSessionUnread('manual', false)
    expect(isSessionUnread(record('manual'))).toBe(false)
    expect(record('manual')?.time.viewed).toBe(10)
    server = { ...server, time: { ...server.time, idle: 20 } }
    useGlobalSessionsStore.getState().upsertSession(server)
    expect(isSessionUnread(record('manual'))).toBe(true)
  } finally {
    globalThis.fetch = originalFetch
    read.mockRestore()
    view.mockRestore()
    useGlobalSessionsStore.getState().resetForRuntimeSwitch()
  }
})

test('a retired manual write cannot block fresh same-key writes or remove their queue slot', async () => {
  const originalFetch = globalThis.fetch
  const initial = session('manual-aba', { idle: 10, viewed: 10 })
  let reads = 0
  let releaseOld = () => {}
  let releaseFresh = () => {}
  const oldGate = new Promise<void>((resolve) => { releaseOld = resolve })
  const freshGate = new Promise<void>((resolve) => { releaseFresh = resolve })
  const patches: boolean[] = []
  const read = spyOn(opencodeClient, 'getSession').mockImplementation(async () => {
    const ordinal = ++reads
    if (ordinal === 1) await oldGate
    if (ordinal === 2) await freshGate
    return initial
  })
  globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = z.object({ patch: z.object({ openchamber: z.object({ manualUnread: z.boolean() }) }) }).parse(JSON.parse(String(init?.body)))
    patches.push(body.patch.openchamber.manualUnread)
    return Response.json({ metadata: body.patch })
  }, originalFetch)
  const operations: Promise<void>[] = []
  const switchTo = (key: string) => switchRuntimeEndpoint({ apiBaseUrl: `http://${key}.test`, runtimeKey: key })
  try {
    switchTo('unread-a')
    useGlobalSessionsStore.getState().applySnapshot([initial], [], 'ready')
    const old = setSessionUnread(initial.id, true).catch(() => {})
    operations.push(old)
    switchTo('unread-b')
    switchTo('unread-a')
    useGlobalSessionsStore.getState().resetForRuntimeSwitch()
    useGlobalSessionsStore.getState().applySnapshot([initial], [], 'ready')
    const fresh = setSessionUnread(initial.id, true)
    operations.push(fresh)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reads).toBe(2)
    releaseOld()
    await old
    // Old cleanup must leave the fresh slot in place, so this read waits.
    const latest = setSessionUnread(initial.id, false)
    operations.push(latest)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reads).toBe(2)
    expect(patches).toEqual([])
    releaseFresh()
    await Promise.all([fresh, latest])
    expect(reads).toBe(3)
    expect(patches).toEqual([true, false])
    expect(isSessionUnread(record(initial.id))).toBe(false)
  } finally {
    releaseOld()
    releaseFresh()
    await Promise.allSettled(operations)
    globalThis.fetch = originalFetch
    read.mockRestore()
    switchRuntimeEndpoint({ apiBaseUrl: '', runtimeKey: 'local' })
    useGlobalSessionsStore.getState().resetForRuntimeSwitch()
  }
})

test('a late metadata failure from the retired instance leaves the fresh unread state intact', async () => {
  const originalFetch = globalThis.fetch
  const initial = session('manual-late-failure', { idle: 10, viewed: 10 })
  const read = spyOn(opencodeClient, 'getSession').mockResolvedValue(initial)
  let releaseOld = () => {}
  let oldStarted = () => {}
  const oldGate = new Promise<void>((resolve) => { releaseOld = resolve })
  const started = new Promise<void>((resolve) => { oldStarted = resolve })
  let patches = 0
  globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
    patches += 1
    if (patches === 1) {
      oldStarted()
      await oldGate
      return new Response('old write failed', { status: 503 })
    }
    const body = z.object({ patch: z.object({ openchamber: z.object({ manualUnread: z.boolean() }) }) }).parse(JSON.parse(String(init?.body)))
    return Response.json({ metadata: body.patch })
  }, originalFetch)
  let old: Promise<void> | undefined
  try {
    switchRuntimeEndpoint({ apiBaseUrl: 'http://unread-old.test', runtimeKey: 'unread-old' })
    useGlobalSessionsStore.getState().applySnapshot([initial], [], 'ready')
    useGlobalSessionsStore.getState().upsertSession({ ...initial, metadata: { openchamber: { manualUnread: true } } })
    old = setSessionUnread(initial.id, false).catch(() => {})
    await started
    switchRuntimeEndpoint({ apiBaseUrl: 'http://unread-other.test', runtimeKey: 'unread-other' })
    switchRuntimeEndpoint({ apiBaseUrl: 'http://unread-old.test', runtimeKey: 'unread-old' })
    useGlobalSessionsStore.getState().resetForRuntimeSwitch()
    useGlobalSessionsStore.getState().applySnapshot([initial], [], 'ready')
    await setSessionUnread(initial.id, true)
    expect(isSessionUnread(record(initial.id))).toBe(true)
    releaseOld()
    await old
    expect(isSessionUnread(record(initial.id))).toBe(true)
    expect(record(initial.id)?.time.viewed).toBe(10)
  } finally {
    releaseOld()
    await old
    globalThis.fetch = originalFetch
    read.mockRestore()
    switchRuntimeEndpoint({ apiBaseUrl: '', runtimeKey: 'local' })
    useGlobalSessionsStore.getState().resetForRuntimeSwitch()
  }
})

describe("markSessionUnreadSeen", () => {
  let view = spyOn(opencodeClient, "viewSession")

  beforeEach(() => {
    view = spyOn(opencodeClient, "viewSession")
    useGlobalSessionsStore.getState().applySnapshot([session("a", { idle: 10, viewed: 5 })], [], "ready")
  })

  afterEach(() => {
    view.mockRestore()
    useGlobalSessionsStore.getState().resetForRuntimeSwitch()
  })

  test("clears the mark at once and records the view in OpenCode once", async () => {
    view.mockResolvedValue(undefined)
    markSessionUnreadSeen("a")
    markSessionUnreadSeen("a")
    expect(record("a")?.time.viewed).toBe(10)
    expect(view.mock.calls).toEqual([["a", 10, "/repo"]])
    await Promise.resolve()
    expect(isSessionUnread(record("a"))).toBe(false)
  })

  test("a failed write brings the mark back", async () => {
    let reject: (error: Error) => void = () => undefined
    view.mockImplementation(() => new Promise<void>((_, fail) => { reject = fail }))
    markSessionUnreadSeen("a")
    expect(isSessionUnread(record("a"))).toBe(false)
    reject(new Error("offline"))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(record("a")?.time.viewed).toBe(5)
    expect(isSessionUnread(record("a"))).toBe(true)
  })

  test("a failed write leaves a newer turn's state alone", async () => {
    let reject: (error: Error) => void = () => undefined
    view.mockImplementation(() => new Promise<void>((_, fail) => { reject = fail }))
    markSessionUnreadSeen("a")
    // Another device saw a later turn before this write failed.
    useGlobalSessionsStore.getState().upsertSession(session("a", { idle: 20, viewed: 20, updated: 2 }))
    reject(new Error("offline"))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(record("a")?.time.viewed).toBe(20)
  })

  test("a session that is already seen sends nothing", () => {
    useGlobalSessionsStore.getState().upsertSession(session("a", { idle: 10, viewed: 10, updated: 2 }))
    markSessionUnreadSeen("a")
    markSessionUnreadSeen("missing")
    expect(view.mock.calls).toEqual([])
  })
})
