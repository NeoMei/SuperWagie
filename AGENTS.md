# OpenChamber Agent Guide

## Purpose

OpenChamber provides shared web, desktop, VS Code, hosted-mobile, and native-mobile UI surfaces for OpenCode.

This file contains only always-on repository rules and routing. Detailed workflows belong to project skills and module documentation.

## Instruction Order

These steps are mandatory. Before editing, you **MUST**:

1. Follow this root guide.
2. Load every project skill whose `description` matches the change, and every
   reference those skills require. Any source change starts with
   `openchamber-change-discipline`.
3. Read the nearest `DOCUMENTATION.md` (under `packages/**`) for each module you
   change, and the package `README.md` for package-level work.
4. Follow local code and test precedent.

If these sources materially conflict, stop and resolve the conflict instead of silently choosing one.
Do not start editing before every matching skill and required reference is read.

## Runtime Boundaries

- `packages/ui`: shared React UI, state, sync, and runtime contracts.
- `packages/web`: web surfaces, OpenChamber server, managed/external OpenCode lifecycle, and CLI.
- `packages/electron`: native desktop shell and privileged Electron boundary.
- `packages/vscode`: extension host, webview, and runtime bridge.
- `packages/mobile`: Capacitor iOS/Android shell; bundles the mobile web surface and connects to an existing OpenChamber server.
- `packages/docs`: product documentation; not a Bun workspace.
- `packages/sdk`: guest contract for third-party panels. Manifest parse, iframe envelope, `connectHost`. Host and guest import from here; do not copy these types into `packages/ui`.
- `packages/extensions`: app-owned SDK extensions and their build registry, not a Bun workspace. See its `DOCUMENTATION.md` for trust, packaging, and migration rules.

Shared UI calls official OpenCode APIs through `@opencode/client` (OpenCode 2.x) via `opencodeClient`; wire shapes stay inside `packages/ui/src/lib/opencode/`. OpenChamber-owned capabilities use `RuntimeAPIs`, `runtimeFetch`, and shared browser/realtime transport helpers. Server-side upstream integrations may use their owning runtime modules.

Electron starts the OpenChamber backend in-process, never as a sidecar. Development may load loopback/HMR UI; packaged builds load staged assets through `openchamber-ui://` while the loopback server remains the API backend. Keep domain backends in web/runtime modules unless behavior is inherently native.

Shared contracts must define intentional behavior for every applicable runtime: web, desktop, VS Code, hosted mobile, and Capacitor mobile.

## Always-On Constraints

- Do not modify `../opencode`; it is a separate repository.
- Do not run git or GitHub commands unless the user explicitly asks.
- Do not add dependencies unless explicitly requested.
- Never add or log secrets, bearer tokens, pairing credentials, or sensitive user data.
- Launch Google Chrome for automation with `--disable-features=MacAppCodeSignClone` (`scripts/perf/cdp.mjs` already does). Without it, every launch on macOS copies the 1.4 GB app into `$TMPDIR/../X/com.google.Chrome.code_sign_clone`, and a browser that is killed rather than quit leaves the copy behind.
- Keep changes minimal and preserve unrelated worktree changes.
- `changelog/` is read-only, and a fix, feature, or merged PR lands without a changelog line. Release notes are written only when the maintainer asks to update the changelog, through the `update-changelog` skill.
- Enforce security and correctness in core/runtime logic, not only UI visibility or prompts.
- Keep entrypoints and bridges thin; place domain logic in focused owning modules.
- Update owning documentation when module ownership, contracts, or invariants change.

## Correctness Invariants

- Prefer authoritative state over heuristics.
- Derive live activity from live channels, not persisted history.
- Scope temporary fallbacks narrowly and clear them when authoritative state arrives.
- Never let fetch failure masquerade as authoritative empty success.
- Make partial results, rollback, cleanup, and stale-data behavior explicit.
- One failed entity must not erase or block unrelated complete entities.
- Runtime-specific differences must be intentional and visible in code.

## Communication

You and the person you work with are two people solving a problem together. Talk like a trusted colleague: plain words, short sentences, mechanisms explained through what the user experiences. Warm and direct, never familiar. A reply is read in minutes, so the conclusion comes first and you stand behind it. Answer in the language you were addressed in; code, comments, and docs stay in English.

Load the `communication-style` skill once, at the start of the session, before your first reply. It stays in context for the rest of the session: every reply, in any language, and every text people read follows it. Later turns use it as loaded; they do not load it again.

## Project Skills

Project skills live in `.agents/skills/*/SKILL.md`, and each skill's `description`
says when it applies. If your tool does not list skill descriptions, read them in
those files before you start. Pure code-reading or explanation needs no
implementation skills unless a specialized subsystem has to be interpreted.

## SuperWagie release checklist status

The maintainer has suspended the separate release checklist. Its checklist,
acceptance template and native update runbook are retained as optional reference;
they do not require acceptance records or add release gates while suspended.
Re-enable them only on explicit maintainer instruction. Other repository rules
continue to apply.

## Validation

For remote Windows execution or follow-up work, read `.codex/remote-windows-session.md` when present. Reuse its registered project session and verify effective permissions before treating it as unattended execution.

- Use `package.json` scripts as the command source of truth. Which checks a change needs is in `openchamber-change-discipline`.
- Before every commit of source changes, `bun run check:changed` passes. It runs type-check, lint, and dead code (Knip, kept at zero findings), then an anti-slop ratchet: the vendored `anti-slop` oxlint plugin (low-evidence typing: unjustified type assertions, `unknown`/`object`/`Record<string, unknown>` contracts, ad hoc `typeof` narrowing, module mocking) may report no more findings per rule across the changed files than at the base. Fix the new findings; the pre-existing backlog stays out of scope unless the task is that cleanup. Never silence a rule, weaken severity, or launder types to make a check pass.
- Report exactly what was and was not validated. Static checks alone do not prove runtime, relay, performance, or platform correctness.

## Pull Request Handoff

Before creating or updating a pull request, read `CONTRIBUTING.md` and
`.github/PULL_REQUEST_TEMPLATE.md`. Complete the template with concrete,
current evidence for the final PR HEAD; do not make the reviewer reconstruct
intent, affected surfaces, validation, visual behavior, or failure and
rollback considerations from the diff alone.

A **product decision** belongs to the maintainer and is settled before the code,
never inside the diff. A product decision is anything where two reasonable people
could disagree about whether it should exist or how it should behave: a new
button, panel, setting or command; a changed default; a shortcut or gesture that
now does something else; different wording, ordering or grouping in the UI;
anything that turns existing behavior on or off for everyone. Removing or
bypassing behavior the code marks as deliberate is one too, and there the first
question is whether it is a defect at all. A crash, wrong data, behavior that
contradicts what it plainly claims, or a performance fix that keeps behavior
identical is a bug, not a product decision.

Where that decision is settled depends on who is working:

- **Working with the maintainer or a team member** (anyone with repository
  access): raise the product question in the session and get an answer there.
  The decision already happened off GitHub; no discussion thread and no link is
  expected on the pull request.
- **Working as an outside contributor**: the decision happens in an agreed
  [Ideas discussion](https://github.com/openchamber/openchamber/discussions/categories/ideas)
  before the code, linked from the pull request. Without the maintainer's
  go-ahead such a pull request is not reviewed, and a discussion opened
  afterwards to describe finished work is closed along with it.

When the call is unclear, ask before building. Deciding it silently is the one
thing that is always wrong.

## Multi-Agent Collaboration

**Codex、犇马（SuperWagie）、WorkBuddy** 三路可同时在本仓库开发：共享一份 `.git`，各自独立 worktree、分支、本地运行实例。

三方交接点是**文件**，不依赖任一客户端的 API：

- 代码交接：`main` 分支
- 状态记录：`~/项目/codexprojects/U-L-S 综合验收/OPERATIONS.md`（发布/验收记录，**三方只读**）
- 交接日志：同目录 `HANDOFF.md`（**append-only**）

### 工作区与分支

- 用独立 git worktree，不要直接改主工作区 `~/项目/codexprojects/SuperWagie-open`。worktree 根目录读 `~/.codex/config.toml` 的 `git-worktree-root`（当前 `/Volumes/codex/new-worktrees`）；外置卷不可用时停下说明，不回退内置盘。
- 目录用途带所有者前缀：`codex-`、`sw-`（犇马）、`wb-`（WorkBuddy）。

| 客户端 | 分支前缀 |
|---|---|
| Codex | `codex/*` |
| 犇马 | `sw/*` |
| WorkBuddy | `wb/*` |

- 分支前缀即所有权，只在自己前缀下提交。`agent/*` 是历史遗留，不再使用。
- **三方都不直接推 `main`**，只走分支 + 由人合并。合并时机：每轮联调开始前，由人在 `main` 上合入已验收的分支；合完各客户端 `fetch` 后从 `main` 拉新分支。

### 本地运行

**只改 HMR 端口不够。** dev server 默认数据目录是 `~/.config/openchamber`，两个客户端同时跑会共用 settings / 会话存储。必须同时设 `OPENCHAMBER_DATA_DIR`。

| 客户端 | HMR UI | HMR API | DATA_DIR |
|---|---|---|---|
| Codex | 5180（默认） | 3902（默认） | `~/.config/openchamber` |
| WorkBuddy | 5380 | 4102 | `/Volumes/codex/agent-data/wb` |
| 犇马 | 5280 | 4002 | `/Volumes/codex/agent-data/sw` |

- 桌面端后端固定在 `127.0.0.1:57123`，同一时间只能一个实例占用。犇马桌面 app 运行时，其他客户端不要并发起第二个桌面实例；需要该端口的联调串行进行。
- 同一个 `OPENCHAMBER_DATA_DIR` 只能被一个客户端使用。

### 依赖与环境

- `node_modules`、`packages/electron/dist*`、`packages/electron/resources/embedded-knowledge` 等构建产物不跨 worktree 共享，每个 worktree 用 `bun install` 自己准备。
- `.local`、`.codex` 只属于各自 worktree，不复制、不提交。

### Git 操作约束

本仓库的 `Always-On Constraints` 写明 `Do not run git or GitHub commands unless the user explicitly asks`。多 agent 协作时这条**仍然有效**：除非当前会话的任务就是版本控制操作，否则不要擅自 commit/push；交接时先向用户说明需要提交，获得确认后再执行。

### 交接

- 收工前把改动提交到自己的分支并推送；接手前 `git fetch origin`，确认 `main` 与 `origin/main` 一致。
- 在 `HANDOFF.md` 追加一条，写清四件事：做了什么、没做什么、下一步、未合并的依赖分支。不改别人写过的段落。
