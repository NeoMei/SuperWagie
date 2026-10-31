# Upstream fixes and engine upgrade implementation plan

> **For agentic workers:** Use subagent-driven-development task by task, with an independent specification and quality review after every task. Only the coordinator runs combined gates/builds.

**Goal:** Integrate current SuperWagie source, selected OpenChamber correctness fixes and OpenCode2.2.3 while retaining existing product behavior and customized memory/model contracts.

**Architecture:** Reconcile the frozen current-origin source with the reviewed local component refresh. Port selected upstream mechanisms in their owning modules. Keep UI data calls behind the OpenCode wrapper, preserve server-side UniHub/knowledge ownership and retain the frozen full-local Intel compatibility lane.

**Tech stack:** Existing Bun/Node24 workspace, React/TypeScript, Express, Electron, OpenCode client/schema2.2.3.

**Spec:** The user's approval to follow the preceding assessment and explicit selection of fixes and engine upgrade only. Source assessment is /tmp/superwagie-upstream-assessment-20261031/assessment.md, with runtime-compatibility.md and assessment-challenge.md there. Exact task requirements and authoritative global constraints are copied into each task brief.

## Global constraints

- Current origin is822b9f900a6cc87717017e9e71c3c73b67409f3f; existing local HEAD is4e0ad9653fec8fe275b63d9601047cf5efe8abf5 plus the reviewed364-path component refresh. Preserve all unrelated/current work.
- Official upstream target ised6e35ff224ed7e6f0c95d79518e568838e44b46, with review baselinec4919abc1e7a0a3beeaa126666487806bf79cfe0. Pinned HTTP source archives and patches are under /tmp/superwagie-upstream-assessment-20261031.
- This task is source implementation and validation. No git/GitHub commands, index/HEAD mutation, commits, shared push, release, changelog edit, user-app replacement/restart or real-user config mutation. Use filesystem snapshots/diffs and immutable source archives. Final result stays uncommitted.
- The complete initial worktree archive/manifest is at /tmp/superwagie-upstream-implementation-20261031.8726 entries and archive SHAfc9a0dc51dad292779988acbe3c5dfe9c9ba0e6caf960d2f739c65b37b1283ee were verified before source changes.
- Implement only selected bug fixes and coordinated engine migration. All new features, settings, defaults, snippets, PR watch, background review, response-style feature, folder-trust/admission subsystem, image tool, secret cards, extension events, compaction UI, Claude Agent UI, appearance changes and upstream governance remain outside this execution.
- Preserve source-aware conversation capture/organization/recall, current query argument and prompt-entry paths, ledger/provenance/checkpoints, and existing shared index. No paid extraction/embedding or production model/telemetry calls.
- Preserve current-origin UniHub access/admission, immutable actor/account/task/payer, durable receipts, unresolved recovery and deliberately blocked media operations. A model-purpose binding never grants execution authorization. Keep BYOK and local providers independent.
- Preserve LangSmith removal, Langfuse^0.7.0, all current component versions, executable skill resources, managed receipts and crash-safe refresh. Existing stricter simple-git environment policy stays.
- Upgrade standard fixed CLI/client/schema pins coherently to2.2.3, minimum2.2.0 only with matching consumers. Preserve frozen optional Intel full-local2.1.4/Electron43.8.4/macOS12 candidate until a separate port; no remote-client substitution or accidental use of new minimum on that frozen source.
- Keep app branding, feeds, release matrices, user-visible defaults and existing6h engine update policy. No new root/workspace dependencies; existing requested dependency versions may update. Keep Electron44.9.3 unless a concrete selected fix needs44.10.0; its update is not required for OpenCode API migration.
- Each worker loads applicable project skills, required references and nearest docs before edits, uses focused tests only, and reports exact failures/limits. No worker subagents. Sequential mutations; reviews are read-only. Root owns type/lint/dead-code/anti-slop, build and native smoke.

## Authorized Git validation exception

The user explicitly authorized subsequent temporary test-repository Git init/add/commit/clone and project read-only checks. This overrides the earlier blanket Git execution restriction only for that scope. Real source index/staging/HEAD/branches/commits/pushes, GitHub mutations and publication remain unauthorized. Isolated test commands must keep their repository and URL rewrite within owned temporary fixtures. The Task3 earlier execution deviation is not retroactively authorized.

## Runtime surfaces

| Runtime | Intentional behavior |
| --- | --- |
| Web | Same product features and model/knowledge policy, corrected runtime/auth/config behavior and official OpenCode2.2.3 adapter. |
| Electron | Reuses in-process web backend and packaged native resources. Default ARM Mac/Windowsx64. Frozen Intel source remains full local and separately pinned. |
| VSCode | Official SDK and owned proxy/credential behavior adapted where applicable. Existing unsupported UniHub account state remains explicit. |
| Hosted mobile | Uses the same corrected server/shared UI paths; no new mobile features. |
| Capacitor mobile | Uses existing runtime bridge/shared UI; no new platform plugin or capability. |

### Task 1: Reconcile current-origin source and reviewed component refresh

**Files:** The206 paths in origin-new-work.json, with particular attention to15 overlaps with the local refresh in local-overlap.json.
**Consumes:** Frozen4e source archive,822 current-origin archive and the complete initial current-worktree snapshot.
**Produces:** Source equivalent to current origin plus preserved local work; unchanged user product contracts; no branch history claim.

- [x] Verify snapshots and exact overlap list; read matching skills/module documentation for changed owners.
- [x] For each origin-changed path, take origin when local equals4e; retain local when origin equals4e; reconcile both-changed paths with diff3 and owner-level review. New files and deletions must preserve file types/modes and unrelated local paths. Keep conflict markers out of source.
- [x] Explicitly reconcile managed skill installer, package preparation/extra resources, knowledge package checks and release-workflow tests. Preserve origin's model/media restrictions, platform receipts, portable dictionary/anydoc preparation and language strings. Source versions follow origin2.7.40 without declaring a release.
- [x] Run focused builtin installer/model configuration and current-origin changed owner tests, identity check and module syntax checks. Record exact source snapshot equivalence and every resolved15-path overlap.
- [x] Update owner documentation only where the combined invariant changes. Write task-1-report.md with file inventory, test evidence and limitations.

### Task 2: Runtime-instance and live session reconciliation fixes

**Files:** Upstreamf1782dab and14e86b39 owning runtime-switch, endpoint-reset, directory/global paging, queue/provider/worktree caches; child discoveryb4c46973 where independent.
**Consumes:** Task1 source and existing runtime key/knowledge contracts.
**Produces:** Generation-safe A-to-B-to-A transitions, retired old queued reads, live-parent-only child discovery; same product defaults.

- [x] Trace exact commit patch and local callers, capture a failing A/B/A stale request case before implementing guards.
- [x] Port the generation/cancellation mechanism to existing runtime owner. Preserve same-runtime auth refresh behavior and current endpoint/reset lifecycle. Make failed reads preserve prior authoritative state.
- [x] Cover delayed old-instance completions, repeated same-runtime refresh, same IDs across endpoints, queue retirement and live/historical parent discovery. Use operation counts for bounded discovery rather than unmeasured performance claims.
- [x] Run focused runtime/sync/store tests; document source authority and lifecycle decisions. Report scope, tests and any deliberately excluded feature-coupled hunk.

### Task 3: URL auth, provider/MCP and configuration correctness

**Files:** eb3fc500 runtime-auth/ui-auth; c6be86de/e9279673 MCP; d79a5945 credential location;8063635b/e9e3c02c/eee34144/6bd21999 plugin rules/discovery;f6044717 JSONC preservation;de9e512a model discovery if existing path needs it.
**Consumes:** Existing auth/enterprise/config/runtime contracts plus Task2 runtime generation.
**Produces:** Clock-independent short-lived URL-token lifetime, same-location credential writes, repaired MCP remains enabled, control entries distinguished from packages and preserved JSONC comments.

- [x] Reproduce clock-ahead token reuse and plugin-control classification with exact fixtures before porting.
- [x] Preserve narrow URL-token scopes, server TTL/revocation and current-origin access gates. Use remaining lifetime without weakening absolute server expiration.
- [x] Adapt only existing provider/MCP/config behavior; preserve hot reload, global/project config precedence, native symlink identity, opt-in catalog and enterprise restrictions. Keep LangSmith removal/Langfuse range.
- [x] Cover failed and successful connect, sign-in retry, location capture, plugin enable/disable rules, unpinned spec behavior and JSONC comment roundtrip; run focused owner/bridge/locale tests.
- [x] Write owning docs and task-3-report.md, including no actual credential/provider/telemetry acceptance claim.

### Task 4: Native updater, managed engine lifecycle and certificate fixes

**Files:** ae9cb258 lifecycle/upgrades across web/VSCode;d313e906 updater state; a38b5f0a system CA; selected existing Windows app/SSH correctness patches only when independently applicable.
**Consumes:** Current SuperWagie updater/feed/package contracts.
**Produces:** Safe executable replacement with restart on success/failure, downloaded payload preservation by version and native OS CA support where available.

- [x] Read updater-testing reference, package README and exact existing handoff. Reproduce same-version/feed-error payload loss and managed executable replacement ordering in focused tests.
- [x] Port lifecycle ordering while retaining bundled fallback, idle activation, six-hour policy, Windows hidden process behavior, mac latest.json and retired Intel automatic channel behavior.
- [x] Reconcile current-origin shutdown/recovery and verify downloaded payloads never attach to a different release version. System CA preserves explicit OpenSSL options and degrades deliberately on missing API.
- [x] Run focused updater/lifecycle/architecture/CA tests with real bounded Node child fixtures when supported. Coordinator owns real isolated packaged verification; native Windows result remains separate.
- [x] Report native/platform limits precisely and update owner docs. No live app installation or production feed mutation.

### Task 5: Workflow process ownership and background goal recovery

**Files:**0a7e539b/06dfa40b workflow process-owner/store/runtime;7385e800 goal background completion/reconnect owners.
**Consumes:** Task1 current-origin workflow state/admission and Task2 runtime freshness.
**Produces:** Independent process-instance recovery and goal completion that waits for live background jobs.

- [x] Reproduce a second server seeing a live first server's workflow, PID reuse and reconnect with pending background work.
- [x] Port PID plus start identity ownership through owner module; retain unknown legacy live owners conservatively with bounded diagnostics and safe retries. Maintain current-origin fail-closed immutable accounting.
- [x] Preserve known activity source, notification/cost/default limits and no automatic new execution features. Handle terminal process exit, canceled work and reconnect without duplicate goal delivery.
- [x] Run focused store/runtime/process tests on host, including another complete workflow surviving one failed entity. Report unrun OS branches and updated owner documentation.

### Task 6: Existing chat and session correctness fixes

**Files:**722bff1f/5068382e move+permission;1efd302f ancestor tool results;063217de attachments;06e1c592/aaf45d94/066376b8 create/recovery; fca8fae/4476fd8/3ba7215 question existing forms;97f03bb links only where absent.
**Consumes:** Existing visible question/form authority, artifacts, current-origin ChatInput and source-aware memory lifecycle.
**Produces:** Correct continuity for existing sends/moves/forms/attachments without new UI controls or defaults.

- [x] Audit each commit against current source; record already-present mechanisms and adapt missing fixes rather than replacing full components.
- [x] Preserve question text/options/recorded answers outside collapsed execution and authoritative live FormDock disposition. Test long-answer deletion, interrupted pending answers and stale settled form responses.
- [x] Keep created session after later failure; prevent duplicate initial send; preserve original desktop attachment paths and model/agent readiness across send paths.
- [x] Follow a moved session's permissions and message ownership, update prior location without deleting unrelated data, and retain Hy source move/revert/hash semantics. Verify Chinese/spaced local artifact links remain correct.
- [x] Run focused component/domain/locale tests; report existing product behavior preserved and any absent feature-dependent hunks excluded.

### Task 7: Upgrade standard runtime and existing SDK consumers

Owner: OpenCode version contract across UI, web, VS Code and standard packaged desktop.

Upstream references: extract migration hunks from eaa85b174d8d296096ca2f5d6877b2c0d0d793d5 and final ed6e35ff sources; extract only pins from 8eb89128fd24ccd5ca6f1e041ee9af1dfc9bcc44. Intermediate 2.2.1 is evidence, not a required staged installation.

Files: root/package manifests and bun.lock for @opencode/client and @opencode/schema; Electron opencodeCli.version; Dockerfile CLI pin; `packages/web/server/lib/opencode/compatibility.js`; `packages/ui/src/lib/opencode/client.ts`; `packages/web/server/lib/small-model/index.js`; `packages/vscode/src/bridge-git-special-runtime.ts`; adapters required by compiler/runtime evidence; owning docs and direct contract tests.

Deliverable: standard SDK/schema/bundled CLI 2.2.3; minimum external engine 2.2.0; generate.text under experimental and /api/experimental/generate/text in web and VS Code; MCP connect/disconnect and file.write under experimental. These SDK namespace edits are mandatory for existing consumers. All declarations and lock resolution must agree. Maintain Electron/node-pty versions from the reconciled baseline unless separately approved or demonstrated necessary for the engine. Do not import unrelated upstream dependency majors.

Validation: compile every real SDK consumer, existing commit/PR text generation against stub providers, MCP connect/disconnect, attachment writes, clear rejection of an old external engine, timeout/cancel and exact pre-dispatch retry behavior. Test cold/warm local provider catalogs and missing-directory session mutations against 2.2.3. Preserve old warmup/archive recovery until evidence shows it is unnecessary or harmful; engine upgrade alone does not require the upstream deletions. Project reads are global in 2.2; ensure no new unopened-project activation.

Independent review: block accidental console budgets, file watchers, image picker, response-style persistence, Claude Agent presentation, default small-model reranking or archive UI redesign. The entire upstream engine-bump commit is not a minimal patch. Keep `experimental-media-uri` opt-in disabled.

- [x] Reproduce the selected incompatible/failing behavior with focused fixtures, implement the exact deliverable and run the listed focused validation.
- [x] Update owning contract documentation and write task-7-report.md with exact files, before/after evidence, tests, output and limitations.

### Task 8: Preserve UniHub config, permissions and execution admission on 2.2.3

Owner: managed model transport and permission/configuration boundary. Depends on Task 7.

Files: `packages/web/server/lib/opencode/{managed-config-file,config-v2}.js`, managed permission generation, `packages/web/server/lib/platform-model/{plugin,runtime,store}.js`, platform-account/model-configuration owners only if the compatibility evidence requires an adapter, VS Code config parity, and owning tests/docs.

Deliverable: modern skill.use/mcp.use/plugin.use action handling with legacy prefixed-policy compatibility; enabling a skill removes its applicable modern deny and disabling it round-trips accurately. Preserve immutable actor/account/task/session/model/payer binding, exact primary-prompt hook, no client replay, receipt recovery, provider merge, private callback environment and library tools.

No-new-features requirement: OpenCode 2.2.2+ enables a builtin image plugin by default. Confirm its exact official control id from pinned engine source, then disable that new builtin in the app-owned managed configuration for this release. Do not condition this on a nonexistent OpenChamber image feature. Do not modify user-owned external config without explicit existing ownership. Keep all current managed speech/transcription/image and slide-QA blocked states. Engine-provided Claude Agent availability must not trigger frontend integration, automatic provider choice, plugin installation or UniHub admission; record observed engine catalog behavior.

Validation: managed config refresh with owned/external config, private env/provider/library preservation, effective builtin image exclusion, policy round-trip for modern and legacy rules, real 2.2.3 hook calls to a deterministic local gateway, primary multi-step tool loop, model/account mutation, duplicate prompt, child/auxiliary/image/command refusal, SSE truncation/cancel, restart/receipt resolution, enterprise refusal and BYOK streaming. No real paid settlement is inferred.

Independent review: configuration availability does not authorize execution. Verify the default-image mitigation preserves the approved no-new-features boundary and cannot bypass user-owned external configuration. Existing policy rules must not be broadened by a legacy '*' translation.

- [x] Reproduce the selected incompatible/failing behavior with focused fixtures, implement the exact deliverable and run the listed focused validation.
- [x] Update owning contract documentation and write task-8-report.md with exact files, before/after evidence, tests, output and limitations.

### Task 9: Prove conversation memory and all prompt-entry contracts

Owner: session knowledge and source-aware recall. Depends on Tasks 3, 5, 7 and 8.

Files: `packages/web/server/lib/session-knowledge/`, `conversation-memory/`, source-aware Hy owners only where contract changes are required, foreground UI request adapter, `message-queue/`, `scheduled-tasks/`, existing review and dispatched-session callers, and focused suites/docs.

Deliverable: preserve `sync(sessionId, directory, query = "")` and the routes' query field. Do not add responseStyle or openchamber.response-style. The positional collision exists only if the deferred upstream response-style feature is imported. There is no need to broaden this contract to carry a disabled feature. If a selected fix requires whole-sync serialization, adapt only its ordering mechanism and retain recall supersession, nonblocking send and current omission/clear semantics.

Validation: run existing reader/source/runtime/recall-contract/methodology suites and add bounded 2.2.3 default-payload fixtures; replay old checkpoints/anchors, large paged sessions, tool error/partial output, revert/fork/move/delete/reconnect, disabled capture and independent source failures. Foreground, queue, scheduler, existing review and dispatch each deliver the current prompt as the recall query; an ordinary prompt can never become a response-style instruction. Failed/unknown source reads withhold only affected recall and never prove deletion. No history-wide directory activation, embedding calls or extraction is permitted during deterministic fixtures.

Independent review: compare source provenance and decoded hashes across versions, verify current origin's recall behavior after every orchestration change, and confirm no response-style fields or generated-media opt-in entered the tree.

- [x] Reproduce the selected incompatible/failing behavior with focused fixtures, implement the exact deliverable and run the listed focused validation.
- [x] Update owning contract documentation and write task-9-report.md with exact files, before/after evidence, tests, output and limitations.

### Task 10: Combined validation and artifact acceptance

**Files:** Final combined filesystem diff, docs, isolated resources/profile and evidence.
**Consumes:** Independently reviewed Tasks1-9.
**Produces:** Final whole-change review, current test/build receipts, native ARM packaged smoke and honest platform limits.

- [x] Run same-scope filesystem anti-slop comparison, type-check, lint, Knip, customization and affected UI/web/VSCode integration suites serially. No git-based check script or commits.
- [x] Verify builtin source identities and native resources still match current combined sources. Prepare actual OpenCode2.2.3 standard native resources from official registry, preserve Intel source lock unchanged and native payload target guards.
- [x] Build web/Electron assets and an unsigned isolated native ARM directory package, then test bundled cross-origin UI and HMR startup, local stub model/recall flows, forced kill/restart, owned process/profile cleanup and resource inventories. Run updater fixture only within an isolated owned install; never replace user app.
- [x] Obtain a final whole-change read-only review. Address load-bearing findings and rerun covering checks once. Record native Windows/old Intel/Linux/Docker/Office/live-service acceptance only if actually performed.
- [x] Save durable final report and complete the ledger. No public release, install or automatic channel change is implied.
