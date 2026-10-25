# Product Help Implementation Plan

> **For agentic workers:** Use subagent-driven development for the independent owners below. The coordinator integrates and validates the combined work.

**Goal:** Add the approved right-panel product assistant and guided UI navigation.

**Architecture:** Register a built-in `product-help` context surface. Keep bounded question state in a dedicated UI store, send validated requests through `runtimeFetch`, and expose a no-tool server service grounded in a fixed help catalog. Registered UI targets own navigation and highlighting.

**Tech Stack:** Existing React, Zustand, Zod, Express, OpenCode small-model helper and shared UI primitives.

**Spec:** `docs/superpowers/specs/2026-10-25-product-help-design.md`

## Global constraints

- No Git or GitHub commands, new dependencies, changelog edits or release actions.
- Preserve unrelated edits. Subagents own distinct files and run only focused test files.
- All UI copy supports English and Simplified Chinese.
- The coordinator runs broad validation serially after integration.

## Task 1: Help service

Files: new `packages/web/server/lib/product-help/` and route registration in `lib/opencode/feature-routes-runtime.js`.

Interface: `registerProductHelpRoutes(app, { getDefaultDirectory })`; `POST /api/product-help/answer` accepts question, locale, bounded assistant history, page context and optional provider/model pair. Response includes `kind`, `text`, `sources`, registered `actions`, `mode` and `modelStatus`. `GET /api/product-help/articles` publishes reviewed help articles.

- [x] Implement catalog grounding and enforce action/source allowlists at the server.
- [x] Use configured no-tool generation without another provider fallback; preserve local help when unavailable.
- [x] Test scope refusal, prompt injection, malformed requests, model failure, invented actions and abort handling through injected dependencies and the real request middleware.

## Task 2: Shared entry and panel

Files: surface registry/modes, ContextPanel, Workbench, new `components/product-help/ProductHelpPanel.tsx`, `lib/product-help/client.ts`, `store.ts`, bilingual messages.

- [x] Add `product-help` as a discoverable right-rail surface and a Workbench shortcut using the existing surface bridge.
- [x] Support opening without a project without passing a UI state key as a filesystem path.
- [x] Render answers, sources, local help, pending/error states and registered action buttons.
- [x] Preserve conversation across panel mounts and reject stale results after runtime change or clear.
- [x] Test parsed response contracts, retention, cancellation, and failure recovery.

## Task 3: Guidance

Files: new `lib/product-help/guidance*`, `components/product-help/GuidanceHighlight.tsx`, SettingsWindow integration.

Interface: `useProductHelpGuidanceStore` owns `start(target, mode)`, `back`, `stop`, and scoped action completion; target is one of `models`, `knowledge`, `appearance`, `theme`, `shortcuts`.

- [x] Reuse settings item anchors and existing page navigation.
- [x] Observe visible targets and authoritative save/test results; keep failures on their step and bound target lookup.
- [x] Retain accessible instructions while Settings is modal; exit clears observers and highlights.
- [x] Test target disappearance, late arrival, cleanup, previous step and runtime change.

## Task 4: Integration and acceptance

- [x] Register the help API before the generic OpenCode proxy and add explicit VS Code route handling.
- [x] Run focused tests, workspace type checks and lint; build the Workbench extension and web application.
- [x] Inspect the compiled UI with isolated local APIs in light/dark themes, both entry points, sources and guide exit.
- [x] Report exactly which paths were verified and which require configured provider/platform access.

## Verification

Focused tests passed in isolated file runs:

| Area | Passing tests |
| --- | ---: |
| Help service and real route middleware | 60 |
| Conversation state and response parsing | 11 |
| Guide state, DOM cleanup and Settings-close lifecycle | 18 |
| Model connection editor and configuration page | 40 |
| Locale dictionaries | 10 |
| Surface registry, SDK open-surface, Workbench and panel persistence | 94 |

Workspace type-check and lint pass. Lint retains 5 pre-existing hook dependency warnings outside this feature. The web build includes both built-in extensions. The VS Code webview build also passes; existing CSS/chunk warnings remain. No Git commands, dependency installation, commit or release was performed.

The compiled browser UI was tested against a fresh local SuperWagie server with isolated storage. OpenCode readiness was explicitly simulated to pass the startup gate; the other OpenCode endpoints remained unavailable. Product-help and language-settings requests used their real routes. Both assistant entries shared a transcript, unrelated requests were refused, language guidance opened Settings and highlighted the picker, advanced on opening, and completed after a successful save/readback. Switching back to Chinese also completed. Settings retained the assistant for further questions. Theme location and highlighting were inspected in light and dark modes.

The model guide opened Connections, highlighted the preset picker, and advanced to the form after selection. The isolated Node permission model blocks fsync, so the actual save failed; the guide correctly stayed on its failed step. Successful save and verified-test progression are covered by the form integration tests, not a cloud-provider browser run. Native Electron, narrow-window resizing, real provider calls and VS Code runtime execution remain unverified.

## Direct operation follow-up

The user requested that the assistant also complete operations. Language and
appearance answers now offer explicit Do it for me buttons, and the welcome view
includes a dark-mode task example. A strict operation allowlist, answer ownership
check and shared in-flight state prevent arbitrary or duplicate execution.
Settings saves use the existing persistence path and surface profile. Completion
requires a matching saved readback. Runtime changes and Clear reject late results.

Verification: 8 operation tests, 14 conversation/action tests, 61 service/route
tests and 10 locale tests pass. Workspace type-check and lint pass with the same
5 unrelated hook warnings. Web and VS Code webview builds pass. The compiled UI
was exercised against the isolated real help/settings server with simulated
OpenCode readiness: direct English and Simplified Chinese changes, dark mode and
system mode succeeded. The web surface settings readback confirmed the saved
values. Real cloud models and native Electron execution remain unverified.
