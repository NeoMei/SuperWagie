export type ShellCommandSummary =
  | { kind: "generic" | "compound" | "search" | "list" | "read" | "gitStatus" | "gitDiff" | "gitHistory" | "test" | "lint" | "build" | "python" | "node" }
  | { kind: "command" | "script"; name: string }
  | { kind: "description"; text: string }

type CommandPrefix = { words: string[]; operator: string; rest: string }

const MAX_COMMAND_CHARS = 8192
const MAX_LABEL_CHARS = 120
const SAFE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,59}$/
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** Reads one simple command. Shell control syntax stays opaque. */
const commandPrefix = (source: string): CommandPrefix | null => {
  const words: string[] = []
  let word = ""
  let started = false
  let quote = ""
  const finishWord = () => {
    if (started) words.push(word)
    word = ""
    started = false
  }
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (char === "\\" && quote !== "'") {
      const next = source[index + 1]
      if (next === undefined) return null
      index += 1
      if (next !== "\n") { word += next; started = true }
    } else if (quote) {
      if (char === quote) quote = ""
      else word += char
    } else if (char === "'" || char === '"') {
      quote = char
      started = true
    } else if (char === "\n" && (started || words.length > 0)) {
      finishWord()
      const rest = source.slice(index + 1).trim()
      return { words, operator: rest ? "\n" : "", rest }
    } else if (/\s/.test(char)) {
      finishWord()
    } else if ("&|;<>`()".includes(char)) {
      finishWord()
      const pair = source.slice(index, index + 2)
      const operator = ["&&", "||", "<<", ">>"].includes(pair) ? pair : char
      return { words, operator, rest: source.slice(index + operator.length).trim() }
    } else {
      word += char
      started = true
    }
  }
  if (quote) return null
  finishWord()
  return { words, operator: "", rest: "" }
}

const executableWords = (words: string[]): string[] => {
  let index = 0
  while (ASSIGNMENT.test(words[index] ?? "")) index += 1
  if (words[index] === "env") {
    index += 1
    while (ASSIGNMENT.test(words[index] ?? "")) index += 1
    if (words[index] === "--") index += 1
  }
  return words.slice(index)
}

const safeBasename = (value: string | undefined): string | undefined => {
  if (!value || value.includes("://")) return undefined
  const name = value.split("/").pop()
  return name && SAFE_NAME.test(name) ? name : undefined
}

/** Summarizes the action only. Arguments, environment values and output stay out. */
export const summarizeShellCommand = (command: string | undefined, description?: string): ShellCommandSummary => {
  const label = description?.slice(0, MAX_LABEL_CHARS * 4).replace(/\s+/g, " ").trim()
  if (label) return { kind: "description", text: label.length > MAX_LABEL_CHARS ? `${label.slice(0, MAX_LABEL_CHARS - 1)}…` : label }
  if (!command || command.length > MAX_COMMAND_CHARS) return { kind: "generic" }
  let prefix = commandPrefix(command)
  while (prefix) {
    const words = executableWords(prefix.words)
    if (words[0] !== "cd" || prefix.operator !== "&&") break
    if (words.length !== (words[1] === "--" ? 3 : 2)) break
    prefix = commandPrefix(prefix.rest)
  }
  if (!prefix) return { kind: "generic" }
  const [executable, action, task] = executableWords(prefix.words)
  const name = safeBasename(executable)
  if (!name) return { kind: "generic" }
  const python = /^python(?:\d+(?:\.\d+)?)?$/.test(name)
  const node = name === "node" || name === "nodejs"
  if (prefix.operator === "<<") return { kind: python ? "python" : node ? "node" : "generic" }
  if (prefix.operator) {
    if (!["&&", "||", "|", ";", "&", "\n"].includes(prefix.operator)) return { kind: "generic" }
    if (!prefix.rest) return { kind: "generic" }
    let remaining: CommandPrefix | null = prefix
    while (remaining.operator && remaining.operator !== "<<") {
      remaining = commandPrefix(remaining.rest)
      if (!remaining || remaining.words.length === 0) return { kind: "generic" }
    }
    return { kind: "compound" }
  }
  if (["rg", "grep"].includes(name)) return { kind: "search" }
  if (["ls", "pwd"].includes(name)) return { kind: "list" }
  if (["cat", "head", "tail"].includes(name)) return { kind: "read" }
  if (name === "git") {
    if (action === "status") return { kind: "gitStatus" }
    if (action === "diff") return { kind: "gitDiff" }
    if (["log", "show"].includes(action ?? "")) return { kind: "gitHistory" }
  }
  if (["bun", "npm", "pnpm", "yarn"].includes(name)) {
    const script = action === "run" ? task : action
    if (script === "test") return { kind: "test" }
    if (script === "lint") return { kind: "lint" }
    if (script === "build") return { kind: "build" }
    if (action === "run" && script && SAFE_NAME.test(script)) return { kind: "script", name: script }
  }
  if (python || node) {
    const script = action && !action.startsWith("-") ? safeBasename(action) : undefined
    return script ? { kind: "script", name: script } : { kind: python ? "python" : "node" }
  }
  return { kind: "command", name }
}
