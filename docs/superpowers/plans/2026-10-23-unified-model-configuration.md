# Unified model configuration implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement bounded tasks with independent task review and final combined review.

**Goal:** Add a purpose-oriented Model configuration page with Chinese and international presets, reusable write-only credentials, persistent bindings and real component/skill consumption.

**Architecture:** A focused server module owns the purpose catalog, validated bindings, server-only credentials and adapter resolution. The shared UI uses runtimeFetch for the app-owned API and retains official OpenCode provider ownership for chat. Existing consumers adopt explicit bindings at call time and keep their current behavior until a binding is selected.

**Tech Stack:** Existing React, TypeScript, Zod, Node/Express and package test runners. No new dependencies.

**Spec:** docs/superpowers/specs/2026-10-23-unified-model-configuration.md, approved by the user's request to implement.

## Global constraints

- No Git/GitHub commands, commits, new worktrees, dependencies or changes to ../opencode.
- Preserve unrelated working files and all existing user configuration/indexes.
- No real credentials in tool output, logs, source, browser-readable responses or tests.
- Chinese/international recommendations for every purpose. Alibaba and Volcengine cover both image and video families.
- Existing native OpenCode credentials and OAuth stay owned by OpenCode; OAuth is not a universal API key.
- Unsupported protocols/consumers remain explicitly unavailable, never falsely verified or silently used via another provider.
- English source/comments/docs; every user-facing key translated in the two shipped locales, English and Simplified Chinese.
- No paid provider calls without user-supplied test credentials; use local protocol fixtures for development verification.
- Capture existing edited files with /tmp/superwagie-model-config-20261023/snapshot.py before editing; independent reviews use baseline diffs without Git.

## Runtime surfaces

- Web: the active server owns connections and bindings; UI manages them over authenticated runtimeFetch.
- Electron: same in-process backend; embedded knowledge only when its binary is available.
- VS Code: native chat/provider preferences remain usable; new app-owned model-service routes return explicit unsupported responses when no OpenChamber backend exists.
- Hosted mobile: same authenticated active server and purpose page, responsive controls; no local credential storage.
- Capacitor mobile: same server behavior through runtime transport; server identity changes reset pending UI state.

## Review focus

- Unreadable or malformed persistence must throw and must not be overwritten as empty configuration.
- Changing provider/model/endpoint invalidates its verification; older request completions cannot replace newer bindings.
- Every new provider/key/endpoint write and outbound test obeys enterprise policy at the server boundary.
- Existing embedding configuration and dimensions remain intact; changing an indexed model requires explicit rebuild intent.
- A preset matching a generic purpose does not bypass a consumer's protocol/provider or optional-repair constraints.

### Task 1: Catalog, credentials, bindings and API

**Own:** packages/web/server/lib/model-configuration/* and packages/ui/src/lib/modelConfiguration.ts.
**Consumes:** approved spec; existing auth/enterprise helpers.
**Produces:** validated public catalog/configuration response, connection CRUD, binding writes, purpose-specific validation operations, server-only resolveModelBinding and callable adapters. Describe exact API/export signatures in the task report before dependent edits.

- [x] Add failing persistence/secret/enterprise/compatibility tests.
- [x] Implement catalog, atomic versioned storage, connection/binding operations, validation and route registration without modifying server/index.js.
- [x] Implement the narrow shared UI API parser/client using runtimeFetch.
- [x] Run owning focused tests and node syntax checks; document contracts and protocols.
- [x] Independent task review and fix findings before dependent consumer work.

### Task 2: Unified settings page and navigation

**Own:** new model-configuration UI section, navigation/search/mobile availability, locale dictionaries and owning UI docs.
**Consumes:** Task 1 public contract and native Defaults/Providers controls.
**Produces:** one purpose-based model page with Chinese/international/all choices, reusable connection editing, docs/key links, explicit save and test statuses, consumer list and unsupported reasons.

- [x] Read all matching UI/settings/theme/locale/RTL skills and references.
- [x] Implement purposeful tests for selection, persisted readback, failed loads, key replacement, stale results and disabled states.
- [x] Add the page using shared settings primitives, existing native chat/provider controls, English and Simplified Chinese and search anchors.
- [x] Run single-file UI tests and independent review.

### Task 3: Existing component and skill consumers

**Own:** embedded-knowledge and knowledge-library integration, voice/dictation integration, bundled image/video credential/config readers and skill documentation.
**Consumes:** Task 1 resolve/adapter exports.
**Produces:** explicit purpose bindings consumed by the existing feature paths, without changing behavior before opt-in; real update/rebind operations for existing knowledge models; safe handling of future video/model protocols.

- [x] Add failing fixture tests for configured endpoint/model/key use and legacy fallback.
- [x] Connect native chat/helper preferences and the current component paths to the saved bindings.
- [x] Connect built-in media skill execution to the shared purpose config at call time, preserving host-tool and safe-background fallback rules.
- [x] Verify per-consumer compatibility and missing runtime errors; do not implement an unrelated independent video-generation feature.
- [x] Run focused tests and independent review.

### Task 4: Combined integration, runtime behavior and acceptance

**Own:** thin server route wiring, explicit VS Code unsupported route, combined docs, validation and fixes.
**Consumes:** Tasks 1-3.

- [x] Wire feature routes before the OpenCode proxy and ensure UI auth/enterprise guards.
- [x] Run serialized UI/web type-check and lint plus affected builds and focused integration suites.
- [x] Launch an isolated development server with fixture data; verify save/readback, origins, mobile layout and visible error states in the browser where available.
- [x] Perform independent combined review and resolve findings.
- [x] Report runtime acceptance separately from static checks and fixture tests; no release/push/commit.

## Approved follow-up requirements

- Ship only English and Simplified Chinese application dictionaries; delete retired UI/native/extension language packs and normalize retired persisted selections. Documentation-site translations remain separate.
- Keep the settings form compact: related controls share responsive rows, recommendation metadata wraps together, and provider-specific fields appear only when relevant.
- Provider/model recommendations populate editable Base URL and model defaults. Saved connections support a purpose-specific probe without changing their active bindings; unsupported adapters stay explicit.
- Unified speech bindings take precedence at invocation without rewriting legacy provider settings. Clearing a binding restores the retained preference. Unreadable configuration cannot imply absence.

## Acceptance evidence

Per-task reports and baseline snapshots are in `/tmp/superwagie-model-config-20261023/`; `reports/acceptance.md` and `reports/validation.json` contain the final coordinator evidence.

- Serialized UI, Web, VS Code, Electron and SDK type checks passed. UI, Web, VS Code, mobile and SDK lint passed; Electron's lint command is a no-op.
- Web and VS Code builds, mobile asset staging and Electron main-process bundling passed. Final rebuilt assets include the compact field spacing and shorter English tab label.
- Node syntax checks passed for 52 changed JavaScript files. Focused owning suites and independent combined review passed with no outstanding blocking finding.
- Browser fixture acceptance covered recommended defaults, create/save/model retention, successful and failed connection probes, purpose save/test/reload, opaque native-key reference selection, Chinese/English rendering and a 390px English wrapper without horizontal overflow. The final screenshot is a development preview using fake credentials and a local protocol fixture.
- Retired application language resources were removed; only English and Simplified Chinese ship. Documentation translations are outside that resource removal.

No real cloud-provider request, audible device test, installed desktop/mobile package acceptance, production knowledge-document acceptance, release or commit is implied. No Git command ran; the Git-based pre-commit gate was not used. Build logs retain existing CSS/chunk-size/dynamic-import warnings.
