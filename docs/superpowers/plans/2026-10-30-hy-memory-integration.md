# Hy memory integration implementation plan

> **For agentic workers:** Use subagent-driven-development and focused task reviews. This work uses the existing isolated conversation-memory-release checkout. Repository rules prohibit git/GitHub commands without explicit request, so no commits or checkout changes are part of this implementation.

**Goal:** Make Hy the working organizer behind a unified, source-governed knowledge and memory service.

**Architecture:** Node authorizes sources, models and jobs; a pinned Hy Python worker stages actual algorithm changes; the existing embedded Go backend owns transactional memory state and shared sqlite-vec/FTS indexes. Existing tools, cards and routes remain compatible.

**Tech stack:** Existing Node/Bun/Go/SQLite, pinned Hy Python core and required Python libraries.

**Spec:** docs/superpowers/specs/2026-10-30-hy-memory-integration-design.md

## Constraints

Preserve unrelated files and existing data; no live memory migration during development. Source/model credentials remain server-only. No git/GitHub commands, changelog edits or publication. Default platform validation targets macOS ARM64 and Windows x64. Add only dependencies required for the explicitly requested Hy integration. Each owner reads applicable project skills and documentation before editing. Coordinators run broad checks serially.

## Tasks

- [x] 1. Backend shared store. Own packages/electron/scripts/embedded-knowledge-memory/ overlay and focused Go tests. Implement the spec's authenticated CAS state, node/vector/FTS operations, model-space embedding and namespace policy. Use a temporary backend copy; do not mutate the developer cache. Verify real SQLite transactions, scope before topK, idempotency and rollback.
- [x] 2. Hy core worker. Own packages/web/server/lib/hy-memory/{vendor,python} and Python tests/dependency manifest. Vendor the pinned Apache-2.0 core, preserve linked extraction/reconciliation/S2 behavior, implement reverse RPC providers and staging adapters. Verify actual algorithms, bad model data, source links, per-project history, code patch preservation, update/delete consistency and complete operation receipts.
- [x] 3. Retrieval/tool compatibility. Fix actual ranking and lexical failure behavior with regression tests first. Add typed availability, ledger inspection and unified search/read entry points while retaining tool names and scope. Own new retrieval module, agent-tool/control adapters and owning docs. Coordinate conversation-runtime edits with root.
- [x] 4. Node integration. Own shared-backend client, durable store adapter, stdio worker lifecycle and dispatch, runtime composition, source/target revision commit, S1/S2 scheduling and cleanup. Add integration tests for restart, blocked/transient/unknown failures and generation/index separation.
- [x] 5. Packaging and UI. Apply backend overlay in the reproducible build, add deterministic Python runtime preparation and resource manifests, wire Electron/Web startup and shutdown. Expose actionable failure/stage/engine state through existing UI and locales. Retain explicit VS Code unsupported behavior.
- [x] 6. End-to-end validation. Run focused suites during development, then serial type/lint/dead-code checks and affected builds. Run actual native store/worker/agent-route fixture including the PPT lesson scenario. Review combined source, fix findings, document verified and unverified platform limits accurately.

Tests are written before changed behavior. Required core examples: ranked [e5,e4,e3,e2,e1] injects [e5,e4,e3,e2]; a lexical title lookup survives semantic unavailability; revision conflict makes zero staged memory changes; a duplicate commit returns its original revision; failed vector write retains old rows; a source withdrawn during generation cannot activate the result; a model-produced unknown citation cannot be committed; Wiki enabled in a document namespace does not block a memory namespace.
