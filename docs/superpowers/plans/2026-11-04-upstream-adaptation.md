# SuperWagie upstream adaptation implementation plan

> **For agentic workers:** Use subagent-driven-development with focused tests and an independent task review. Do not spawn worker subagents. The coordinator owns combined checks and source packaging.

**Goal:** Adapt the approved first wave of OpenChamber changes while preserving SuperWagie branding, Hy provenance and model admission.

**Architecture:** Port selected upstream mechanisms into their existing owners. Shared UI keeps official SDK shapes inside the OpenCode wrapper and uses existing runtime/control transports. Memory retains its shared ledger and Workflow retains server-owned execution.

**Tech Stack:** Existing Bun, Node 24, React, TypeScript, Express and Electron workspaces.

**Spec:** `docs/superpowers/specs/2026-11-04-upstream-adaptation-design.md`.

## Global constraints

- Read the spec's contracts before editing. Repository rules override skill Git/worktree/commit examples. No git or gh commands, commits, pushes, publication or user-data/config mutation.
- Work in the existing `codex/fix-desktop-auth-release` directory. Initial file hashes and small-file copies are under `/Users/neomei/项目/codexprojects/SuperWagie-open/.superpowers/sdd/2026-11-04-upstream-adaptation/baseline-manifest.json` and `baseline/`.
- Immutable upstream commit JSON patches are under `/Users/neomei/项目/codexprojects/SuperWagie-open/.superpowers/sdd/2026-11-04-upstream-adaptation/upstream/<SHA>.json`. They are reference mechanisms, not permission to overwrite customized files.
- Load every matching project skill, its required references and nearest module docs before editing. Keep changes minimal. No new dependencies, retired locales, media features, provider defaults or unrelated upgrades.
- Read owning package scripts; execute focused tests only as a worker. Broad checks and mutations of manifests/lockfiles belong to the coordinator.
- Write an exact changed-file list, red/green evidence, tests and limits to your task report. Do not claim native or paid-model acceptance from fixtures.

### Task 1: Localized activity and Benma thinking feedback; persistent MCP toggles

**Files:** `packages/ui/src/hooks/useAssistantStatus*`, `components/chat/{StatusRow*,components/ScrollToBottomButton.tsx,message/parts/WorkingPlaceholder.tsx}`, new focused status/copy modules under `lib/` and `hooks/`, `lib/i18n/messages/{en,zh-CN}.ts`, MCP dropdown/work-status/store owners and their tests. Do not edit opencode client, projection, sync-context or useConfigStore.

**Interfaces:** Working status carries semantic localized data and reasoning identity to its renderers. MCP setting changes reuse the configuration owner and retain generation/directory checks. This task owns main dictionary integration; other workers send needed strings rather than editing these dictionaries.

- [ ] Read upstream `00a717e7b5cdd25ba4a99baf539400cd38609f15` and `9baed57cd9e251078f568aeba0cbcc1277ec785c`, nearby hooks, consumers and tests.
- [ ] Add failing behavior tests: active tool/count labels in both languages; deterministic rare thinking lines stable through repeated rendering; permission/retry wins over jokes; MCP off writes disabled state and failed write/runtime switch cannot commit stale state.
- [ ] Port the smallest complete semantic status/copy flow for the two product locales and the six approved Chinese lines. Keep real execution-state authority and existing throttling. Reuse existing formatting boundaries; translate complete messages.
- [ ] Persist MCP toggles through existing config APIs while preserving standalone connection controls. Run focused status, locale and MCP tests. Update owning docs where contracts change and write task-1-report.md.

### Task 2: Control announcements, pending inbox visibility and Windows directories

**Files:** `packages/ui/src/lib/openchamberEvents*`, `lib/opencode/{model,projection,client}*`, `sync/` control/reducer/materialization/context owners, `ChatContainer.tsx`, `stores/useConfigStore*`, and owning tests/docs. Do not modify the Task 1 hooks/dictionaries.

**Interfaces:** A pending synthetic inbox item is separate from delivered transcript history. The existing control stream delivers OpenChamber-owned announcements exactly once. SDK calls retain their auth/cancel/body contracts while translating only UNC directory values.

- [ ] Read patches `76a33b2478f925acfb4bd4191cf2878f41c7f28d`, `3e417b1ebde0a8fe08df3a54ff252ea3dec48ef7`, `dea7355b2a1378237269204bde39d99fb4f7caaf` and the owning relay/sync/API docs.
- [ ] Reproduce pending-page background insertion and eventual inbox delivery in deterministic tests, including a historical refresh and removed/stale messages. Cover control-only SSE/reconnect and avoid duplicate WebSocket authority.
- [ ] Port projection, delivery cleanup, materialization and visible-list behavior together. Keep recorded questions outside Activity and keep FormDock submissions authoritative.
- [ ] Cover UNC list/create/move/header payloads and startup LocationNotFoundError for one project. Port directory normalization and narrowly classify that failure without turning other fetch failures into success.
- [ ] Run focused sync/client/store/component tests, update contracts and write task-2-report.md.

### Task 3: Native Memory and Workflow adaptation; server correctness fixes

**Files:** `packages/web/server/lib/{agent-memory,session-knowledge,workflows,openchamber-control,scheduled-tasks,dispatch-results}/`, web index injection, shared feature/Workflow settings owners as needed, and tests/docs. Preserve Hy modules and ledger ownership; do not edit main UI dictionaries. Send new copy requirements to Task 1's owner.

**Interfaces:** Existing memory CRUD retains shared persistence. Feature availability becomes independent of legacy environment gates, with stored user settings defaulting off. Workflow prompts receive best-effort knowledge sync; model admission still owns authorization.

- [ ] Read patches `559a8bcf741b6436a922d885f06358f461ef5d6d`, `0623cc62c3a7680da4491ad931e2797fd20ada50`, `afdde9f64ec21aa64964e1da4e753c7c544110a4`, `8de379be77fcdd496895878b34be567ecd15d028`, `9fd950d6d10ebfad9e325c447b31387caefde022`.
- [ ] Test newest-first complete-line memory index budgeting, failed scope isolation, untouched shared manual records and source-aware recall. Open native Memory's supported setting without changing existing explicit preferences.
- [ ] Test Workflow feature defaults and supported runtime parity. Sync each child's real execution directory/current prompt before sending; failed knowledge reads preserve send behavior. Keep capture consent and source authority unchanged. Add an early clear unsupported-model result while preserving the existing UniHub core refusal. Do not design paid child-task admission until the pending product answer permits it.
- [ ] Test scheduled create/update with invalid explicit models, target worktree directories, empty catalogs and failed reads. Add only the existing control-path validation.
- [ ] Test same-parent/multi-prompt duplicate completion, persisted delivery retry and a later distinct run. Port stable grouped delivery IDs without swallowing completed or future results.
- [ ] Run focused module tests, update docs and write task-3-report.md.

### Task 4: Standard engine update and bounded preview/PTY fixes

**Files:** Root/UI/web/VS Code manifests and `bun.lock`, Electron CLI pin, Dockerfile, required engine contract docs/tests; `TableArtifact.tsx` and its preview tests/docs; `bun-patches/bun-pty@0.5.1.patch`.

**Interfaces:** SDK/schema/CLI are 2.2.5; minimum remains 2.2.4 and the existing external/packaged ownership remains intact. CSV owns its actual scroller and final-row reachability. PTY keeps its current first-listener replay contract.

- [ ] Confirm official 2.2.5 packages and read required package docs. Update only matching pins and lock resolution, preserving other exact versions, optional Intel source and Electron 44.9.3. Keep existing new-event handling rather than duplicating it. Raise Vite manifest minimum to 7.3.2 while keeping the already newer locked version.
- [ ] Read `fb639faa750d71c8b79222355eebcb2aa6ceb6a2` and `75769787bd6a7bd89c2e0ebd43974cd0bf9d3e63`. Add failing visible-row/tail/width and UTF-8 byte-boundary replay cases before porting.
- [ ] Verify an unchanged-scale CSV scenario and changed scenario with real scroll ownership, bounded rendered rows and final row reachable. Validate real PTY Unicode output under the byte limit and one-time replay.
- [ ] Run focused tests and record exact dependency/install outcomes. Write task-4-report.md.

### Task 5: Independent reviews and combined verification

**Files:** This plan ledger, current filesystem differences and a durable final verification report.

- [ ] Review each completed task's exact filesystem diff and requirements independently; return findings to its owner and rerun only covering tests after fixes.
- [ ] Compare the final customized owners with current SuperWagie main via read-only source HTTP, without replacing local changes. Run customization checks, type-check, lint and dead-code serially. Use a filesystem baseline for anti-slop because git-based changed-file scripts are unauthorized.
- [ ] Build affected web/UI/VS Code consumers and validate isolated UI status/CSV behavior. Do not replace the installed application or mutate live feeds/settings.
- [ ] Obtain a whole-change review, resolve material findings and rerun affected checks. Save exact verification evidence and remaining platform/provider limits; leave the source ready for review.
