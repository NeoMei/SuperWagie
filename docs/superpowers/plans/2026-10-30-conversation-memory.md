# Conversation memory implementation plan

> **For agentic workers:** Execute the approved work in this session with subagent-driven development. Use behavior tests before production edits. Do not run git/GitHub commands or add dependencies.

**Goal:** Distill OpenCode work into source-backed experience documents, index them in WeKnora and recall them in subsequent project tasks.

**Architecture:** A server runtime owns source capture, a durable queue and canonical generated Markdown. The existing knowledge library indexes a project-scoped managed library; the existing session-knowledge path injects bounded recall. Existing settings and the knowledge panel manage the feature.

**Tech stack:** Existing JavaScript/TypeScript, Zod, Node filesystem/crypto, OpenCode SDK, WeKnora reference ingest, React and runtimeFetch.

**Spec:** `docs/superpowers/specs/2026-10-30-conversation-memory.md`.

## Global constraints

- Preserve unrelated edits; no git commands, dependencies, release or changelog work.
- Source/credential ownership and runtime surfaces follow the approved spec.
- No real conversation or model processing is enabled during implementation.
- Workers run only focused test files. The coordinator runs broad checks serially.

## Task 1: Capture and distillation

Files: create `packages/web/server/lib/conversation-memory/reader.js`, `extractor.js`, their focused tests and owning documentation.

Interfaces: `readConversationSegments({client, sessionId, directory, projectId, checkpoint})` returns parsed settled segments, a durable checkpoint and reset/completeness information. `distillConversationSegment({segment, generate, signal})` validates source-bound output and returns normalized summary/experience cards. Final exact shapes are documented with the implementation and consumed by the runtime.

- [x] Write/run failing fixture tests for paging, incomplete turns, interruption, source anchors and tool evidence.
- [x] Implement a bounded SDK reader without depending on message-search enablement.
- [x] Write/run failing tests for invalid JSON/schema, fabricated sources and unsupported success claims.
- [x] Implement one-call structured distillation, secret filtering and source-safe Markdown rendering.
- [x] Run focused reader/extractor tests and document contracts.

## Task 2: Managed knowledge documents

Files: extend `packages/web/server/lib/knowledge-library/{runtime,search}.js`, focused tests and documentation.

Interfaces: add project-scoped managed-document upsert/remove/search operations using reference ingestion. Managed documents retain stable IDs and paths. Ordinary library queries exclude managed experiences unless given a trusted scope. Operations report indexing readiness and cleanup failures.

- [x] Write/run failing tests for stable upsert, readiness, project isolation and failed deletion.
- [x] Implement managed library registration and reference/reparse reuse.
- [x] Enforce managed scope before backend retrieval and again on returned hits.
- [x] Run focused knowledge-library tests and update ownership docs.

## Task 3: Runtime, routes and prompt integration

Files: create `conversation-memory/{store,runtime,routes}.js` and tests; wire web startup/shutdown and session knowledge; pass current prompt query through UI/queue/scheduler/dispatch senders.

- [x] Write/run failing durable-queue tests for duplicate work, extraction/index separation, cancellation and unknown recovery.
- [x] Implement opt-in runtime, explicit history capture, list/read/search/retry/forget and source invalidation.
- [x] Add authenticated `/api/conversation-memory` routes with schema parsing and scoped operations.
- [x] Wire event hub, OpenCode SDK, existing small model and knowledge-library managed methods.
- [x] Write/run prompt integration tests, including disabled/failed recall removal and every sending path.
- [x] Update module docs and record exact validation.

## Task 4: Shared management UI

Files: add typed `lib/conversationMemory.ts`, a shared settings/panel section, localization and focused tests. Use existing knowledge-library page/panel; VS Code stays unsupported.

- [x] Write/run route-client and component behavior tests for activation, capture, errors, source navigation, retry and forget.
- [x] Implement schema-validated runtimeFetch API and existing shared UI primitives.
- [x] Translate all added keys, update Settings search and owning docs.
- [x] Check state across runtime/session changes and explicit unavailable states.

## Task 5: Combined review and validation

- [x] Independently review implemented source and spec coverage; fix important findings.
- [x] Run focused server and UI suites against final combined source.
- [x] Run workspace type check, affected lint and UI/web builds serially.
- [x] Exercise controlled HTTP and backend integration without user data or paid provider calls.
- [x] Report completed behavior and remaining real-provider/native validation boundaries.

## Execution ledger

- 2026-10-30: User approved this design and implementation. Working in the current shared checkout because repository instructions forbid git commands without explicit request. No commit, push or release is part of this task.

- 2026-10-30: Capture/extraction, managed knowledge adapter, durable runtime, scoped prompt/agent retrieval and shared UI are implemented. Independent review strengthened retained-message citations, whole-line local tool evidence, multi-session support references and current Wiki/graph policy checks. Initial combined server suite: 389 passed; client/localization/search suites: 27 passed. Broad type-check and UI lint passed. Web production build passed with existing CSS/chunk warnings. Controlled browser fixture covered wide/small, light/dark and Chinese; a long-source-link overflow was fixed. Final recovery regressions and real bundled-backend smoke remain in progress.

- 2026-10-30: Bundled macOS ARM64 WeKnora smoke passed against a throwaway SQLite database and local fake embedding/rerank endpoints: actual scoped policy GET, parsing-to-ready, project-scoped hybrid retrieval, stable-ID reparse with changed chunks, and deletion of backend reference, Markdown and ledger. Fake endpoint calls: 4 embedding, 1 rerank; the rejecting external proxy received 0 requests. All test-owned processes and temporary data were cleaned. This does not establish real-provider semantic quality or native Windows acceptance.

- 2026-10-30: Added the actual UI-auth guard integration test for conversation-memory reads/writes. Source event gaps during disabled/restarted periods were reproduced independently; bounded authoritative source validation is being added to the final recall and agent metadata exits. This validation uses the current query directory and does not scan historical projects.

- 2026-10-30: Final combined server verification passed: 408 tests across 17 files using the web package Vitest script. Related UI/client/localization/search tests passed: 47 (27 client/localization/search, 14 conversation section, 3 knowledge settings, 1 panel clock, 1 indexing-cost notice, 1 gallery). Final workspace type-check and Electron syntax checks passed. UI/web lint, targeted server lint, and anti-slop checks over every newly introduced file passed. Web production build passed; existing CSS `::highlight`, mixed dynamic/static import and chunk-size warnings remain.
- 2026-10-30: Independent final review found no blocking issue in bounded source revalidation, methodology dependencies, disable/forget races or inactive-directory handling. Source-prefilter IDs can be stale until final validation, which may reduce retrieval relevance; final prompt/agent outputs require current source validation. Core recovery tests cover sibling-card restoration, forgotten synthesis termination, reindex after physical cleanup, extractor-version quarantine, and missing source events across disable/restart.
- Validation boundary: controlled fixtures and the real bundled macOS ARM64 knowledge binary were tested. No real conversation corpus was enabled, no paid provider was called, no native Windows/Electron interaction or semantic quality benchmark was accepted. No Git/GitHub command, commit, push, dependency addition, changelog update or release was performed. The optional dead-code runner was not executed because Knip is not installed locally; no source commit is part of this task.


## Release 2.7.37

- Frozen release source: `7ce104b08f6d8820fed7df573c95cd3e27585dfc`, based on main `7dce0c2bff1b42269ba13f1a08de5fd4cd84c4d9`. Only conversation-memory work was transplanted; parallel native-media, chat interaction and uncommitted site work stayed outside the release.
- Release-tree validation: 402 relevant server tests, 47 related UI/client/localization tests and SuperWagie customization regressions passed. The full pre-commit `check:changed` passed after removing 2 unused exports, including type checks, lint, zero dead-code findings and no new anti-slop findings.
- Repeated the real bundled WeKnora smoke against this exact release runtime with temporary data and local fake model endpoints. Index readiness, project retrieval, stable-ID reparse and forget cleanup passed.
- macOS ARM64 CI `40926222200`, Windows x64 CI `40926227743`, and manifest assembly `40927913684` succeeded for the exact source SHA. The macOS ZIP contains 9 checked server files byte-identical to the frozen source and the new conversation-learning UI. Windows packaged resource comparison passed in CI.
- Downloaded installers passed SHA-256 checks. `latest-x64.yml` passed actual EXE size and SHA-512 verification; the architecture-blind legacy feed remains frozen. Only macOS ARM64 and Windows x64 were built and published.
- macOS remains ad-hoc signed and unnotarized; Windows remains unsigned. Real-provider semantic quality, native Windows GUI, clean-install and updater-install acceptance were not performed. No real conversation corpus was enabled.
