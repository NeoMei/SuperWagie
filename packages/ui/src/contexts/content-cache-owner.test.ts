import { describe, expect, test } from "bun:test"
import type { FilesAPI } from "@/lib/api/types"
import { createContentCachedFiles } from "./content-cache-owner"
import { getRuntimeApiBaseUrl, getRuntimeKey, switchRuntimeEndpoint } from "@/lib/runtime-switch"

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

describe("content cache owner", () => {
  test("creation invalidates cached bytes even when metadata still matches", async () => {
    let content = "old"
    const files: FilesAPI = {
      listDirectory: async path => ({ directory: path, entries: [] }),
      search: async () => [],
      createDirectory: async path => ({ path, success: true }),
      readFile: async path => ({ path, content }),
      statFile: async path => ({ path, isFile: true, size: 3, mtimeMs: 1 }),
      createFile: async path => { content = "new"; return { path, success: true } },
    }
    const owner = createContentCachedFiles(files)
    try {
      expect((await owner.files.readFile!("file.txt")).content).toBe("old")
      await owner.files.createFile!("file.txt")
      expect((await owner.files.readFile!("file.txt")).content).toBe("new")
    } finally { owner.dispose() }
  })

  test("reads await creation and discard an earlier in-flight result", async () => {
    const firstRead = deferred<{ path: string; content: string }>()
    const readStarted = deferred<void>()
    const createFinished = deferred<void>()
    const createStarted = deferred<void>()
    let content = "old"
    let reads = 0
    const files: FilesAPI = {
      listDirectory: async path => ({ directory: path, entries: [] }),
      search: async () => [],
      createDirectory: async path => ({ path, success: true }),
      readFile: async path => {
        reads += 1
        if (reads === 1) { readStarted.resolve(); return firstRead.promise }
        return { path, content }
      },
      statFile: async path => ({ path, isFile: true, size: 3, mtimeMs: 1 }),
      createFile: async path => {
        createStarted.resolve()
        await createFinished.promise
        content = "new"
        return { path, success: true }
      },
    }
    const owner = createContentCachedFiles(files)
    try {
      const pending = owner.files.readFile!("file.txt")
      await readStarted.promise
      const creating = owner.files.createFile!("file.txt")
      await createStarted.promise
      const during = owner.files.readFile!("file.txt")
      firstRead.resolve({ path: "file.txt", content: "old" })
      createFinished.resolve()
      await creating
      expect((await pending).content).toBe("new")
      expect((await during).content).toBe("new")
    } finally { owner.dispose() }
  })

  test("reuses only strongly validated content", async () => {
    let reads = 0
    const files = {
      readFile: async (path: string) => ({ path, content: `value-${++reads}` }),
      statFile: async () => ({ isFile: true, isDirectory: false, size: 7, mtimeMs: 1 }),
    } as unknown as FilesAPI
    const owner = createContentCachedFiles(files)

    expect((await owner.files.readFile!("file.ts")).content).toBe("value-1")
    expect((await owner.files.readFile!("file.ts")).content).toBe("value-1")
    expect(reads).toBe(1)
    owner.dispose()
  })

  test("does not retain size-only reads without mtime", async () => {
    let reads = 0
    const owner = createContentCachedFiles({
      readFile: async (path: string) => ({ path, content: `value-${++reads}` }),
      statFile: async () => ({ isFile: true, isDirectory: false, size: 7 }),
    } as unknown as FilesAPI)

    await owner.files.readFile!("file.ts")
    await owner.files.readFile!("file.ts")
    expect(reads).toBe(2)
    owner.dispose()
  })

  test("bypasses metadata cache for an authoritative read", async () => {
    let content = "old"
    let reads = 0
    const owner = createContentCachedFiles({
      readFile: async (path: string) => {
        reads += 1
        return { path, content }
      },
      statFile: async () => ({ isFile: true, isDirectory: false, size: 3, mtimeMs: 1 }),
    } as unknown as FilesAPI)

    await owner.files.readFile!("file.ts")
    content = "new"
    expect((await owner.files.readFile!("file.ts")).content).toBe("old")
    expect((await owner.files.readFile!("file.ts", { fresh: true })).content).toBe("new")
    expect(reads).toBe(2)
    owner.dispose()
  })

  test("retries a read that overlaps a write", async () => {
    const firstRead = deferred<{ path: string; content: string }>()
    let content = "old"
    let reads = 0
    const owner = createContentCachedFiles({
      readFile: async (path: string) => {
        reads += 1
        return reads === 1 ? firstRead.promise : { path, content }
      },
      statFile: async () => ({ isFile: true, isDirectory: false, size: content.length, mtimeMs: content === "old" ? 1 : 2 }),
      writeFile: async (_path: string, next: string) => { content = next },
    } as unknown as FilesAPI)

    const reading = owner.files.readFile!("file.ts")
    await owner.files.writeFile!("file.ts", "new")
    firstRead.resolve({ path: "file.ts", content: "old" })

    expect((await reading).content).toBe("new")
    expect(reads).toBe(2)
    owner.dispose()
  })

  test("separates identical paths by directory scope", async () => {
    let reads = 0
    const owner = createContentCachedFiles({
      readFile: async (path: string, options?: Parameters<NonNullable<FilesAPI['readFile']>>[1]) => ({ path, content: `${options?.directory}-${++reads}` }),
      statFile: async () => ({ isFile: true, isDirectory: false, size: 1, mtimeMs: 1 }),
    } as unknown as FilesAPI)

    const first = await owner.files.readFile!("file.ts", { directory: "/a" })
    const second = await owner.files.readFile!("file.ts", { directory: "/b" })
    expect(first.content).toBe("/a-1")
    expect(second.content).toBe("/b-2")
    owner.dispose()
  })

  test("disposed owners throw on subsequent reads", async () => {
    const owner = createContentCachedFiles({
      readFile: async (path: string) => ({ path, content: "value" }),
      statFile: async () => ({ isFile: true, isDirectory: false, size: 5, mtimeMs: 1 }),
    } as unknown as FilesAPI)

    owner.dispose()
    await expect(owner.files.readFile!("notes.txt", { optional: true, directory: "/tmp/project" }))
      .rejects.toThrow("File cache owner disposed")
  })

  test("runtime endpoint changes clear cache but keep serving reads", async () => {
    const originalWindow = globalThis.window
    const events = new EventTarget()
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
        dispatchEvent: events.dispatchEvent.bind(events),
      },
    })

    try {
      let reads = 0
      const owner = createContentCachedFiles({
        readFile: async (path: string) => ({ path, content: `value-${++reads}` }),
        statFile: async () => ({ isFile: true, isDirectory: false, size: 7, mtimeMs: 1 }),
      } as unknown as FilesAPI)

      expect((await owner.files.readFile!("notes.txt")).content).toBe("value-1")
      window.dispatchEvent(new CustomEvent("openchamber:runtime-endpoint-will-change", {
        detail: {
          apiBaseUrl: "http://127.0.0.1:3902",
          previousApiBaseUrl: "http://127.0.0.1:3901",
          runtimeKey: "url:http://127.0.0.1:3902",
          previousRuntimeKey: "url:http://127.0.0.1:3901",
        },
      }))
      expect((await owner.files.readFile!("notes.txt")).content).toBe("value-2")
      expect(reads).toBe(2)
      owner.dispose()
    } finally {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: originalWindow,
      })
    }
  })
})


const nextTurn = () => new Promise<void>(resolve => setTimeout(resolve, 0))
const outcome = <T>(promise: Promise<T>) => promise.then(() => "fulfilled", () => "rejected")

const withMutationRuntime = async (run: (fixture: {
  owner: ReturnType<typeof createContentCachedFiles>
  calls: Array<{ runtime: string; method: string; path: string }>
  reads: string[]
  content: Map<string, string>
  block: (path: string) => { started: Promise<void>; finish: () => void }
  switchTo: (runtime: string) => void
}) => Promise<void>) => {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  const previousRuntime = { apiBaseUrl: getRuntimeApiBaseUrl(), runtimeKey: getRuntimeKey() }
  const events = new EventTarget()
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
    },
  })
  // The real switch also attempts URL-token refresh. Keep all transport local.
  globalThis.fetch = async () => new Response(null, { status: 404 })
  const switchTo = (runtime: string) => switchRuntimeEndpoint({
    apiBaseUrl: `https://${runtime}.invalid`, runtimeKey: runtime,
  })
  switchTo("a")
  const calls: Array<{ runtime: string; method: string; path: string }> = []
  const reads: string[] = []
  const content = new Map([["a:/shared", "aaa"], ["b:/shared", "bbb"]])
  const gates = new Map<string, { started: ReturnType<typeof deferred<void>>; finished: ReturnType<typeof deferred<void>> }>()
  const block = (path: string) => {
    const gate = { started: deferred<void>(), finished: deferred<void>() }
    gates.set(`${getRuntimeKey()}:${path}`, gate)
    return { started: gate.started.promise, finish: () => gate.finished.resolve() }
  }
  const invoke = async (method: string, path: string) => {
    const runtime = getRuntimeKey()
    calls.push({ runtime, method, path })
    const gate = gates.get(`${runtime}:${path}`)
    if (gate) { gate.started.resolve(); await gate.finished.promise }
    return `${runtime}:${path}`
  }
  const files: FilesAPI = {
    listDirectory: async path => ({ directory: path, entries: [] }),
    search: async () => [],
    createDirectory: async path => ({ success: true, path }),
    statFile: async path => ({ path, isFile: true, size: 3, mtimeMs: 1 }),
    readFile: async path => {
      const key = `${getRuntimeKey()}:${path}`
      reads.push(key)
      return { path, content: content.get(key) ?? "" }
    },
    createFile: async path => { content.set(await invoke("create", path), ""); return { success: true, path } },
    writeFile: async (path, value) => {
      const key = await invoke("write", path)
      if (value === "fail") throw new Error("write failed")
      content.set(key, value)
      return { success: true, path }
    },
    delete: async path => { content.delete(await invoke("delete", path)); return { success: true } },
    rename: async (path, newPath) => {
      const key = await invoke("rename", path)
      content.set(`${key.slice(0, key.indexOf(":"))}:${newPath}`, content.get(key) ?? "")
      content.delete(key)
      return { success: true, path: newPath }
    },
  }
  const owner = createContentCachedFiles(files)
  try { await run({ owner, calls, reads, content, block, switchTo }) }
  finally {
    owner.dispose()
    for (const gate of gates.values()) gate.finished.resolve()
    await nextTurn()
    switchRuntimeEndpoint(previousRuntime)
    await nextTurn()
    globalThis.fetch = originalFetch
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow })
  }
}

describe("file mutation runtime ownership", () => {
  const mutations = [
    { name: "create", run: (files: FilesAPI) => files.createFile!("/shared") },
    { name: "write", run: (files: FilesAPI) => files.writeFile!("/shared", "new") },
    { name: "delete", run: (files: FilesAPI) => files.delete!("/shared") },
    { name: "rename", run: (files: FilesAPI) => files.rename!("/shared", "/renamed") },
  ]
  for (const mutation of mutations) {
    test(`queued ${mutation.name} cannot dispatch against a replacement runtime`, () => withMutationRuntime(async ({ owner, calls, content, block, switchTo }) => {
      const gate = block("/busy")
      const first = owner.files.writeFile!("/busy", "one")
      await gate.started
      const queued = outcome(mutation.run(owner.files))
      switchTo("b")
      gate.finish()
      await first
      expect(await queued).toBe("rejected")
      expect(calls).toEqual([{ runtime: "a", method: "write", path: "/busy" }])
      expect(content.get("b:/shared")).toBe("bbb")
      expect(content.has("b:/renamed")).toBe(false)
    }))
  }

  test("a switch during the first mutation microtask prevents dispatch", () => withMutationRuntime(async ({ owner, calls, switchTo }) => {
    const pending = outcome(owner.files.writeFile!("/shared", "new"))
    switchTo("b")
    expect(await pending).toBe("rejected")
    expect(calls).toEqual([])
  }))

  test("a runtime round trip retires old queued work and permits fresh work", () => withMutationRuntime(async ({ owner, calls, block, switchTo }) => {
    const gate = block("/busy")
    const first = owner.files.writeFile!("/busy", "one")
    await gate.started
    const queued = outcome(owner.files.delete!("/shared"))
    switchTo("b")
    switchTo("a")
    const fresh = owner.files.writeFile!("/fresh", "new")
    gate.finish()
    await Promise.all([first, fresh])
    expect(await queued).toBe("rejected")
    expect(calls).toEqual([
      { runtime: "a", method: "write", path: "/busy" },
      { runtime: "a", method: "write", path: "/fresh" },
    ])
  }))

  test("disposal rejects queued and new mutations and promptly rejects new reads", () => withMutationRuntime(async ({ owner, calls, block }) => {
    const gate = block("/busy")
    const first = owner.files.writeFile!("/busy", "one")
    await gate.started
    const queued = outcome(owner.files.delete!("/shared"))
    owner.dispose()
    let readResult = "pending"
    const read = outcome(owner.files.readFile!("/shared")).then(value => { readResult = value })
    const subsequent = outcome(owner.files.writeFile!("/shared", "new"))
    await nextTurn()
    expect(readResult).toBe("rejected")
    gate.finish()
    await Promise.all([first, read])
    expect(await queued).toBe("rejected")
    expect(await subsequent).toBe("rejected")
    expect(calls).toEqual([{ runtime: "a", method: "write", path: "/busy" }])
  }))

  test("fresh runtime reads and writes complete while the previous runtime is stalled", () => withMutationRuntime(async ({ owner, block, switchTo }) => {
    const gate = block("/busy")
    const first = owner.files.writeFile!("/busy", "one")
    await gate.started
    switchTo("b")
    let readContent = "pending"
    let writeResult = "pending"
    const read = owner.files.readFile!("/shared").then(result => { readContent = result.content }, () => { readContent = "rejected" })
    const write = outcome(owner.files.writeFile!("/fresh", "new")).then(result => { writeResult = result })
    await nextTurn()
    expect(readContent).toBe("bbb")
    expect(writeResult).toBe("fulfilled")
    gate.finish()
    await Promise.all([first, read, write])
  }))

  test("retired completion preserves current cached bytes and current mutation ordering", () => withMutationRuntime(async ({ owner, content, reads, calls, block, switchTo }) => {
    const oldGate = block("/shared")
    const oldWrite = owner.files.writeFile!("/shared", "old")
    await oldGate.started
    switchTo("b")
    let readContent = "pending"
    const reading = owner.files.readFile!("/shared").then(result => { readContent = result.content }, () => { readContent = "rejected" })
    await nextTurn()
    expect(readContent).toBe("bbb")
    await reading
    content.set("b:/shared", "ccc")
    const currentGate = block("/busy")
    const currentWrite = owner.files.writeFile!("/busy", "two")
    await currentGate.started
    const queuedWrite = owner.files.writeFile!("/later", "new")
    oldGate.finish()
    await oldWrite
    await nextTurn()
    expect(calls.some(call => call.path === "/later")).toBe(false)
    currentGate.finish()
    await Promise.all([currentWrite, queuedWrite])
    expect((await owner.files.readFile!("/shared")).content).toBe("bbb")
    expect(reads.filter(key => key === "b:/shared")).toHaveLength(1)
  }))

  test("same-runtime mutation order and read freshness survive transport refresh", () => withMutationRuntime(async ({ owner, calls, content, block }) => {
    const gate = block("/busy")
    const first = owner.files.writeFile!("/busy", "one")
    await gate.started
    const create = owner.files.createFile!("/new")
    const write = owner.files.writeFile!("/new", "new")
    const rename = owner.files.rename!("/new", "/final")
    const remove = owner.files.delete!("/busy")
    switchRuntimeEndpoint({ apiBaseUrl: "https://replacement-transport.invalid", runtimeKey: "a", clientToken: "fixture-token" })
    let readContent = "pending"
    const read = owner.files.readFile!("/final").then(result => { readContent = result.content })
    await nextTurn()
    expect(calls).toHaveLength(1)
    expect(readContent).toBe("pending")
    gate.finish()
    await Promise.all([first, create, write, rename, remove, read])
    expect(calls.map(call => `${call.method}:${call.path}`)).toEqual([
      "write:/busy", "create:/new", "write:/new", "rename:/new", "delete:/busy",
    ])
    expect(readContent).toBe("new")
    expect(content.has("a:/busy")).toBe(false)
    expect(content.has("a:/new")).toBe(false)
  }))

  test("failed mutations release the same-runtime queue and its waiting read", () => withMutationRuntime(async ({ owner, calls }) => {
    const failed = outcome(owner.files.writeFile!("/shared", "fail"))
    const next = owner.files.writeFile!("/shared", "new")
    const read = owner.files.readFile!("/shared")
    expect(await failed).toBe("rejected")
    await next
    expect((await read).content).toBe("new")
    expect(calls.map(call => call.method)).toEqual(["write", "write"])
  }))
})
