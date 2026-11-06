# SuperWagie Upstream Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Adapt the approved OpenChamber correctness, desktop interaction, and measured idle-work improvements onto SuperWagie 2.7.59.

**Architecture:** Port bounded changes into existing module owners, retaining SuperWagie's runtime and product contracts. Upstream commits supply reference implementations; local callers and customization tests determine integration details.

**Tech Stack:** TypeScript, React, Zustand, Bun, Node, Electron 44.9.3, OpenCode 2.2.5.

**Spec:** `docs/superpowers/specs/2026-11-05-upstream-followup-design.md`

## Global Constraints

- Base: SuperWagie 2.7.59, `73d6cb97884ddf9873cf03e06db55271d4d41d54`.
- Keep OpenCode 2.2.5 and Electron 44.9.3. Only explicitly authorized Omni Viewer/required Word peer and bundled skill/plugin/MCP updates are allowed; add no unrelated dependencies; changelog and release versions stay unchanged.
- Preserve Hy memory, source retrieval, UniHub identity/billing/bootstrap, product help, six Benma hints, updater feedback, Office formats, and question/FormDock behavior.
- Preserve EN and zh-CN copy and existing persisted overrides; explicitly support applicable web, desktop, VS Code, and mobile boundaries.
- Implementation agents edit only their task, run focused tests, and create no commits or subagents. The coordinator runs broad checks serially on the combined diff. Review snapshots replace per-task commits until the final gate.
- Load matching project skills, required references, nearest DOCUMENTATION.md, and package README before editing. Follow root AGENTS.md.
- Reference commits are available with `git show <sha>` after the coordinator fetches upstream. Port relevant hunks; do not replace whole customized modules.

---

### Task 1: Confine packaged runtime configuration

**Files:** `packages/electron/{main.mjs,preload.mjs,packaged-runtime-config.mjs,test.mjs,README.md}` and nearest documentation.
**Interfaces:** Consume existing packaged origin and runtime settings. Produce a synchronous preload reader restricted to the app top frame; preserve bootstrap readiness gating and remote-host semantics.
**Reference:** `aba4e2284e13f83eb4e210e4d1ec63e95e053cd5`.

- [x] Read desktop-shell, enterprise-boundary, change-discipline and relevant docs; inspect `git show aba4e228 -- packages/electron`.
- [x] Add behavioral cases: own top frame succeeds; child frame, foreign origin, missing/destroyed frame fail; returned script/HTML never contains token/origins. Verify current implementation fails the security cases.
- [x] Adapt static `RUNTIME_CONFIG_SCRIPT`, bridge delivery, and `isRuntimeConfigFrame`. Keep script load blocking until backend readiness; authorize the actual IPC sender frame, not renderer-supplied metadata.
- [x] Run the package's focused native helper tests and `node --check` on changed JavaScript. Update native runtime documentation, self-review, and write task report with commands/results.

### Task 2: Preserve session ownership and waiting interactions

**Files:** `packages/ui/src/sync/{bootstrap.ts,sync-context.tsx,session-ui-store.ts,session-folders-sync.ts}`, `stores/{useSessionFoldersStore.ts,useConfigStore.ts}`, session-folder server/runtime contracts, `components/chat/ChatContainer.tsx`, owning tests/docs.
**Interfaces:** Session directory remains authoritative; global active statuses are partial. Session-folder operations carry an expected source placement and reject stale placement changes. Existing FormDock owns actionable questions.
**References:** `82544f4ddffea3b80fb98c570ed45aff93c37690`, `e3418e6612dad1a1d470ab23a310d7bcf6fdebee`, `0ea55ec2414f97f11eb6e629eb34cbd7adee5dd6`, `ba56b0a1ce22ab70e327cde297494fff0ba23ec9`.

- [x] Read sync-state-invariants, opencode-v2, ui-api-decoupling, performance-engineering, relevant UI skills and owning docs. Inspect each reference and local customized callers.
- [x] Add failing scenarios: two directories with global activity; restoration before list completion; failed list is unknown; stale move after newer placement; wake/reconnect grouping refresh; managed-chat catalog selection without changing explicit model; waiting page while Activity is open.
- [x] Filter status seeds by authoritative session ownership and use authoritative send directories. Add grouping refresh/timeout/retry only for the demonstrated lifecycle gaps, with source-placement preconditions on both client and server. Use managed chat directory for new chat agent catalogs. Release frozen snapshots while an interactive page waits, preserving question text/options/answers and financial notice rendering.
- [x] Run focused sync/folder/chat/catalog tests, including ordering and failure cases. Update owning contracts and report exact validation. Do not import OpenUI or virtual-list changes.

### Task 3: Bound large attachment ingestion

**Files:** `packages/ui/src/sync/input-store.ts`, attachment preparation/send/draft/history owners, adjacent tests and docs.
**Interfaces:** A large desktop file above 10 MiB becomes a bounded path-and-size text reference. The existing text/plain data attachment is a valid transport for that note; the request must contain neither the original bytes nor a file:// URL that causes automatic original-file ingestion. Sanitized HAR/notebook content must never be bypassed through a raw server path.
**Reference:** `3fd8baf11f46a151d7e8992fb05905c0be473783`.

- [x] Read opencode-v2, ui-api-decoupling, sync-state-invariants, change-discipline and attachment docs. Inspect the upstream commit and local draft schema.
- [x] Add failing cases for a large ordinary file, Unicode path, HAR/notebook exclusion, restored draft/history, and duplicate @ reference.
- [x] Adapt the bounded path-and-size note to the existing attachment representation and send builder; preserve sanitized attachment flow, preview, removal, and persisted restoration. Keep prompt text bounded independently of file size.
- [x] Run attachment/send/restore focused tests and report request shape and size evidence; update owning docs.

### Task 4: Render terminal IME preedit

**Files:** `packages/ui/src/lib/ghostty/surface.ts`, adjacent terminal tests/docs.
**Interfaces:** Composition preedit is visual only; committed text enters the terminal once. Clipboard copy preserves active composition.
**Reference:** `fb5f21f512fb1514959c41862f6a158f0bd5b9dd`.

- [x] Read terminal owner docs plus desktop-shell, UI, theme, RTL, performance and change skills as applicable; inspect upstream hunk and local cursor geometry.
- [x] Add focused composition start/update/commit/cancel, copy-during-composition, and cursor/scroll cleanup cases.
- [x] Port visible cursor-anchored preedit, matching fonts/colors and cursor geometry. Do not rewrite the input textarea during composition or duplicate committed input. Clean up listeners/overlay on disposal.
- [x] Run focused terminal tests and the prepared scratch terminal-composition probe with `--expect visible`. Compare with `terminal-composition-baseline-report.md`; document controlled browser input versus real OS IME/PTY validation boundaries.

### Task 5: Reduce measured idle work

**Files:** `hooks/useGlobalSessionsPolling.ts`, `lib/terminalSessionObserver.ts`, quota observer/readout owners, runtime window visibility, `stores/catalogRefresh.ts`, `packages/web/server/index.js`, associated tests/docs. Paths are under `packages/ui/src` unless qualified. Caret gating is deferred because the inactive measurement failed its liveness check.
**Interfaces:** Partial head refreshes merge without deletion; only successful complete snapshots authorize deletion. Desktop visibility is native, not inferred solely from document.visibilityState. Catalog coalescing preserves a trailing invalidation and directory identity. CORS caching changes no authentication decisions or Idempotency-Key support.
**References:** `ac2899e9c7c350a466746a4e2eb838a6bc12c1bb`; measurement tooling references `c4773a8c954be95905aeabdd5789cc701d45b4af`, `d60dceaa428898d46d44ce6f9613cf61e35a539d`.

- [x] Read performance-engineering, sync-state-invariants, desktop-shell, ui-api-decoupling, relay-transport where affected, and scripts/perf/DOCUMENTATION.md. Define workload, budget, cardinalities, cost equation, and state invariants in the task report before code changes.
- [x] Capture production baseline for large idle session lists, terminal open/closed, foreground/background window, quota consumer visible/hidden and a burst of catalog invalidations. Use operation/network counts with live browser evidence; check loaded build and instrumentation liveness. Reuse the coordinator baseline artifacts.
- [x] Add focused correctness cases for partial/full/failed refresh, lifecycle cleanup/reconnect, hidden/visible behavior, catalog trailing refresh and A-to-B-to-A, CORS allowed headers/auth.
- [x] Adapt demonstrated hot paths: bounded recent-session refresh with less frequent full refresh, lifecycle terminal observation, hidden-window quota gating, bounded same-directory catalog task coalescing, retained models.dev enrichment during automatic catalog refresh, and preflight cache. The fresh complete baseline and unchanged-build repeat each read agents 4 times for 8 events, so target at most 2 while retaining final revision 8. Capture directory and runtime identity at scheduling; keep one trailing invalidation where needed. Preserve complete-snapshot contracts, fresh-on-resume behavior, SDK catalog refresh and explicit metadata refresh.
- [x] Run paired before/after production scenarios with the same workload; retain improvements that meet the declared operation-count/latency budget and pass correctness tests. Report local measurements without quoting upstream gains as local outcomes.

### Task 6: Extend configurable shortcuts

**Files:** `packages/ui/src/lib/shortcuts*`, settings shortcut UI/store, shortcut consumers, runtime desktop contract; `packages/electron/{main.mjs,preload.mjs,menu-shortcuts.mjs}`, English/Chinese catalogs, relevant tests/docs. Resolve owning paths from the reference commit.
**Interfaces:** Persisted shortcut overrides retain meaning. Renderer-to-main menu updates accept validated known IDs and valid accelerator shapes. The focused window owns the application menu bindings and language. Permission reply shortcuts run before composer input; held modifiers can complete leader sequences in real Electron despite native accelerator collisions. Native and renderer dispatch produce one action.
**Reference:** `0137dc30eb3022af139ef5cbe26ed2d025c6c208`.

- [x] Read desktop-shell, settings-ui-patterns, locale-ui-patterns, theme-system, UI guidance, RTL, ui-api-decoupling, sync-state-invariants and owning docs.
- [x] Add failing tests covering old overrides, save/find, permission reply priority and main/pinned arbitration, project/session navigation, held-modifier leader sequence against native Cmd/Ctrl+B, native menu normalization, invalid IPC input, focus ownership across two windows, EN/zh menu rebuilds, zoom/window commands and Mac/Windows accelerator mappings.
- [x] Adapt upstream configurable actions and settings into local UI/runtime consumers. Preserve product-specific commands, keyboard defaults, input guards, runtime differences and English/Chinese labels; ensure native menu accelerators update with settings. Resolve leader/native interception at the owning window boundary, bounded to the pending sequence with timeout/blur/disposal cleanup, while preserving ordinary native commands.
- [x] Run focused shortcuts/settings/native-menu tests. Update docs and report runtime checks needed for final Electron smoke.

### Task 7: Upgrade and theme Omni Viewer; bound Office preview lifecycle

**Files:** `packages/ui/src/components/views/files/previews/OfficeArtifact.tsx`, `FilesView.tsx`, the owning bounded raw-byte reader, VS Code local raw-file proxy, `packages/ui/package.json`, `bun.lock`, theme owner, tests/docs. Existing model attachment extraction in `sync/document-attachments.ts` retains its separate contract.
**Interfaces:** Preserve doc/docx, xls/xlsx, ppt/pptx via omni-viewer-core. Bounded Office preview reads use a 30 MiB limit; stale reads cannot replace a newly selected file; failure exposes retry and cleanup aborts in-flight work where supported. The optional preview byte limit must also bound VS Code's native read before base64 allocation; raw-file callers omitting the limit retain their behavior.
**Reference:** `0cecfab607c9f114912db6047e8a8ac320028686` for bounded read/lifecycle behavior only.

- [x] Read file-preview owning docs and applicable UI, locale, runtime API, sync and performance skills. Trace existing reader cancellation and size behavior before adding mechanisms.
- [x] Cover oversized headers and chunk overflow, read failure then retry, selection changed during read or mount, disposal and successful six-format detection. Cover native proxy limit validation, omitted-limit compatibility and file growth during bounded reads. Keep Omni Viewer as the renderer and use its supported mount signal. Upgrade existing omni-viewer-core from 0.19.0 to the latest published version (verified 0.22.0), inspect peer/API compatibility, and limit manifest/lock changes to this authorized upgrade.
- [x] Implement missing read-size/cancellation/retry guarantees in their owning layers. Preserve six-format support. Match viewer chrome/background/control colors to the app resolved theme on initial mount and live light/dark/custom-theme changes without recoloring authored page/slide content. No replacement renderer, LibreOffice integration or conversion fallback.
- [x] Run focused preview/read tests, verify browser-visible loading/error/retry, real Office content and computed internal viewer colors in light/dark themes and a live theme switch, update docs and report validation.


### Task 8: Update shipped skills, plugins and MCP components

**Scope:** App-owned bundled payloads, their verified source pins/receipts, required runtime dependencies and relevant managed MCP/plugin registration. Resolve the exact update set from `task-8-inventory.md` before edits. User-global Codex/Claude skills, unrelated apps and user-defined remote MCP connections remain outside this bundled update.
**Interfaces:** Keep SuperWagie model/credential broker adaptations, existing offline boundaries, encoded local file links, WPS physical runtime paths, Chrome launch flag, ownership receipts, local-edit preservation and data/config compatibility. Keep OpenCode2.2.5/Electron44.9.3.

- [x] Inventory every shipped item and verify current versus latest primary-source release/tag/commit; record source URL, exact pin and update/already-current/unavailable status.
- [x] Split substantive component updates into fresh implementation/review batches after the inventory; use matched skills/module docs. Port upstream changes while retaining named local adaptations instead of replacing customized payloads blindly.
- [x] Regenerate provenance/bundle identities and necessary staged runtime receipts, retaining licenses and exact dependency locks. Validate managed installation/update plus edited/foreign installation preservation in isolated fixtures.
- [x] Exercise affected skill/plugin/MCP entrypoints and compatibility using existing supported runtimes; report simulated, built, native and installed/runtime evidence separately. No user-state migration or paid indexing is implied.
- [x] Independently review each meaningful update batch, then include all updates in final whole-branch validation and review. Release versioning/publishing remain separate.

#### Task 8 execution batches

Primary-source inventory was completed on 2026-11-05. Execute sequentially, with a fresh implementer and independent review for each batch. Exact source identities, archive digests and preservation constraints are in the matching task brief and inventory receipts.

1. **8c — writing dependencies and SuperWriter repair.** Import stable mattpocock/skills v1.3.2 for grilling, grill-me, grill-with-docs, to-spec and domain-modeling. Preserve automatic invocation, existing CONTEXT projects and customer-only context. Restore SuperWriter 0.2.9's missing official tender_template.py helper; do not add unrelated repository installers.
2. **8e — plugin config sources.** Adapt upstream 82878285b source enumeration and exact-source mutation for both global files, custom config and all project ancestors, in web and VS Code. Preserve options, canonical identity, source errors and managed ownership.
3. **8f — connected MCP OAuth.** Adapt 967236877 so connected remote MCPs can request authorization explicitly. Preserve blocked/disabled/policy gates, directory/runtime identity and no unsolicited OAuth.
4. **8g — runtime-only MCP rows.** Adapt a2d8fb73a with authoritative successful config-load gate and read-only runtime-only rows. Failure is not empty config; preserve scope/status and ordinary configured actions.
5. **8a — SuperVideo 0.1.2.** Import official e3536f25 source delta while preserving managed media/model/voice/asset adapters. Validate browser DOCX/PPTX rendering and regenerate coupled engine/source/lock identities. No Office viewer change or unrelated runtime dependency sweep.
6. **8b — Excalidraw current source.** Import 8d6663e9 full renderer/fonts/locks/licenses. Use a preflighted supported host browser with existing app-owned Node/Playwright and read-only packaged Python, retaining standalone compatibility. Preserve the local-browser prerequisite; no new browser downloader or fresh-install bundled-Chromium guarantee. Missing preview runtime fails actionably; actual offline font/render verification remains required.

Already-current main skills, Hy stable algorithm subset and knowledge compatibility branch retain their adapted bytes. Dynamic catalog selectors are audited without rewriting user-installed configuration. Azure's existing @latest currently resolves to a prerelease; do not silently downgrade or label it stable. Final validation distinguishes catalog/version audit from installed-runtime acceptance.
