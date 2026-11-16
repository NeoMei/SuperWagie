import { describe, expect, test } from "bun:test"
import { summarizeShellCommand, type ShellCommandSummary } from "./shell-command-summary"

describe("shell command summaries", () => {
  const cases: Array<[string, ShellCommandSummary]> = [
    ["  \n\tbun test", { kind: "test" }],
    ["CI=1 TOKEN=\"private value\" bun test", { kind: "test" }],
    ["env CI=1 TOKEN='private value' bun test", { kind: "test" }],
    ["cd \"/repo with spaces\" && bun run lint", { kind: "lint" }],
    ["cd -- /repo && bun test", { kind: "test" }],
    ["TOKEN=private cd /repo && env CI=1 npm run build", { kind: "build" }],
    ["rg 'a && b' src", { kind: "search" }],
    ["rg a\\&\\&b src", { kind: "search" }],
    ["grep private src/file", { kind: "search" }],
    ["ls -la /private/path", { kind: "list" }],
    ["cat /private/path", { kind: "read" }],
    ["git status --short", { kind: "gitStatus" }],
    ["git diff -- src/private.ts", { kind: "gitDiff" }],
    ["git log --oneline", { kind: "gitHistory" }],
    ["bun run check:changed", { kind: "script", name: "check:changed" }],
    ["npm run test", { kind: "test" }],
    ["pnpm lint", { kind: "lint" }],
    ["yarn build", { kind: "build" }],
    ["node ./scripts/check.mjs --token private", { kind: "script", name: "check.mjs" }],
    ["python3 ./scripts/check.py --token private", { kind: "script", name: "check.py" }],
    ["python -c 'private code'", { kind: "python" }],
    ["node --eval 'private code'", { kind: "node" }],
    ["python3 - <<'PY'\nprivate = 'unclosed\nPY", { kind: "python" }],
    ["node <<'JS'\nprivate = 'unclosed\nJS", { kind: "node" }],
    ["/usr/bin/curl -H 'Authorization: private' https://private.invalid", { kind: "command", name: "curl" }],
    ["bash -lc 'private code'", { kind: "command", name: "bash" }],
    ["rg foo src | head", { kind: "compound" }],
    ["bun test && bun run build", { kind: "compound" }],
    ["git status\ngit diff", { kind: "compound" }],
    ["cat <<EOF\nprivate\nEOF", { kind: "generic" }],
    ["$PRIVATE --token secret", { kind: "generic" }],
    ["curl 'unclosed", { kind: "generic" }],
    ["bun test &&", { kind: "generic" }],
    ["bun test && 'unclosed", { kind: "generic" }],
    ["TOKEN=private", { kind: "generic" }],
    ["", { kind: "generic" }],
  ]
  test.each(cases)("classifies %s without exposing its arguments", (command, summary) => {
    expect(summarizeShellCommand(command)).toEqual(summary)
  })

  test("keeps an explicit legacy label bounded and on one line", () => {
    expect(summarizeShellCommand("bun test", "  Check\n the suite  ")).toEqual({ kind: "description", text: "Check the suite" })
    expect(summarizeShellCommand("bun test", "x".repeat(1000))).toEqual({ kind: "description", text: `${"x".repeat(119)}…` })
  })

  test("does not classify beyond its input budget or expose dynamic names", () => {
    expect(summarizeShellCommand(`bun test ${" ".repeat(10_000)}&& private`)).toEqual({ kind: "generic" })
    expect(summarizeShellCommand("https://user:private@example.invalid/run")).toEqual({ kind: "generic" })
    expect(summarizeShellCommand("bun run token=private")).toEqual({ kind: "command", name: "bun" })
    expect(summarizeShellCommand(undefined)).toEqual({ kind: "generic" })
  })
})
