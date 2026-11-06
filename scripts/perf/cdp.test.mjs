import assert from "node:assert/strict"
import { once } from "node:events"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { platform, tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { launchChrome } from "./cdp.mjs"

// The owned executable records arguments without opening a browser or profile.
for (const headless of [false, true]) {
  test(`Chrome ${headless ? "headless" : "headed"} launch keeps isolation and platform arguments`, {
    skip: platform() === "win32" ? "The fake executable uses a POSIX shebang" : false,
    timeout: 5_000,
  }, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "oc-cdp-"))
    let child
    t.after(async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL")
        await once(child, "exit")
      }
      await rm(dir, { recursive: true, force: true })
    })
    const record = join(dir, "argv.json")
    const chrome = join(dir, "fake-chrome")
    await writeFile(chrome, `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)))
`)
    await chmod(chrome, 0o700)
    const profileDir = join(dir, "owned-profile")
    child = launchChrome({ chrome, profileDir, port: 43123, headless, extraArgs: ["--fixture-arg"] })
    const [code, signal] = await once(child, "exit")
    assert.equal(code, 0)
    assert.equal(signal, null)
    const args = JSON.parse(await readFile(record, "utf8"))
    assert.equal(args.includes("--use-mock-keychain"), platform() === "darwin")
    for (const arg of [
      "--remote-debugging-port=43123",
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,MacAppCodeSignClone",
      "--fixture-arg",
    ]) assert.ok(args.includes(arg), arg)
    assert.equal(args.includes("--headless=new"), headless)
    assert.equal(args.includes("--disable-gpu"), headless)
    assert.equal(args.includes("--no-sandbox"), process.getuid?.() === 0)
    assert.equal(args.at(-1), "about:blank")
  })
}
