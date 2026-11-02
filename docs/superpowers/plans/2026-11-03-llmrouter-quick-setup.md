# LLMRouter Quick Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a secure one-click LLMRouter/UniHub setup flow that discovers scoped models, previews and atomically applies purpose bindings, tests supported models in batch, supports rollback, and keeps existing BYOK and managed-session behavior intact.

**Architecture:** UniHub exposes a bounded, product-scoped model discovery and key-inspection contract. SuperWagie owns a bootstrap orchestration module beside the existing model-configuration runtime; it stores imported credentials through the existing server-side secret boundary, computes a capability-aware mapping plan, applies it under the existing revision lock, and runs bounded test jobs. The Settings page adds a localized four-step wizard using the shared settings primitives and the existing model overview.

**Tech Stack:** Go/Chi-style UniHub HTTP API, Node.js server modules, React/TypeScript, Zod, existing model-configuration adapters, Vitest/Bun tests, existing i18n/settings/search/theme contracts.

**Spec:** `docs/superpowers/specs/2026-11-03-llmrouter-quick-setup-design.md`

## Global Constraints

- Existing BYOK connections, project/session overrides, native OpenCode Agent settings, and managed UniHub session behavior remain intact.
- Imported credentials are never returned after discovery, never stored in browser state, URL, logs, snapshots, or error text, and are scoped to `origin_product_id=superwagie` and the selected instance.
- Default apply mode only fills missing bindings; replacing managed bindings requires explicit user choice and revision checks.
- Expensive media tests are opt-in; no automatic retry may duplicate a billable call.
- No new dependency is added. All visible strings, labels, status text, and accessible names use i18n dictionaries.
- No Git/GitHub command or publication is part of this implementation; release remains a separate explicit action.

## File Map

- UniHub `internal/httpapi/model_discovery.go`: authenticated scoped model catalog and API-key inspection endpoint.
- UniHub `internal/modelaccess/discovery.go`: shared key/product/instance/model capability projection.
- UniHub tests beside those modules and the OpenAPI/source docs.
- SuperWagie `packages/web/server/lib/model-configuration/bootstrap.js`: discovery, mapping, atomic apply, rollback, and test-run orchestration.
- SuperWagie `packages/web/server/lib/model-configuration/bootstrap-store.js`: private operation state and encrypted credential reference boundary.
- SuperWagie `packages/web/server/lib/model-configuration/bootstrap-routes.js`: HTTP routes and request/response validation.
- SuperWagie `packages/web/server/lib/model-configuration/bootstrap.test.js` and route tests.
- SuperWagie `packages/ui/src/lib/modelConfigurationBootstrap.ts`: typed client contract.
- SuperWagie `packages/ui/src/components/sections/model-configuration/ModelQuickSetupWizard.tsx`: four-step flow.
- SuperWagie `packages/ui/src/components/sections/model-configuration/ModelQuickSetupWizard.test.tsx`: user flow tests.
- SuperWagie `packages/ui/src/components/sections/model-configuration/ModelConfigurationPage.tsx`: entry point and refresh integration.
- SuperWagie `packages/ui/src/lib/i18n/messages/model-configuration.i18n.ts` and locale dictionaries: all new copy.
- SuperWagie `packages/ui/src/lib/settings/search.ts`: quick-setup search anchor.
- SuperWagie model-configuration documentation and integration spec updates.

### Task 1: Add UniHub scoped discovery and key inspection

**Files:**
- Create: `/Users/neomei/项目/codexprojects/unihub/internal/modelaccess/discovery.go`
- Create: `/Users/neomei/项目/codexprojects/unihub/internal/httpapi/model_discovery.go`
- Modify: `/Users/neomei/项目/codexprojects/unihub/internal/httpapi/api.go` (route registration and OpenAPI route table)
- Test: `/Users/neomei/项目/codexprojects/unihub/internal/modelaccess/discovery_test.go`
- Test: `/Users/neomei/项目/codexprojects/unihub/internal/httpapi/model_discovery_test.go`

**Interfaces:**
- Produces `GET /v1/models` response for an already verified API key: `{data:[{id,name,operations,input_modalities,output_modalities,context,max_output,probe,rate_id}]}` plus non-sensitive `account_id`, `instance_id`, `origin_product_id`, `expires_at` metadata in response headers or a separate authenticated inspection route.
- Produces `POST /v1/accounts/{account}/model-discovery` for a signed-in SuperWagie product client, which can inspect the current account without exposing a raw credential.
- Rejects revoked, expired, wrong-product, wrong-instance, and out-of-scope keys before returning model metadata.

- [ ] Write failing Go tests for valid scoped discovery, wrong product/instance, revoked/expired key, empty allowlist, and no raw token in responses/log fields.
- [ ] Implement capability projection from published model/rate data; keep pricing and model scope authoritative in UniHub.
- [ ] Register routes under the existing product/client authorization rules and add OpenAPI schemas.
- [ ] Run focused Go tests, then the existing UniHub API and SDK tests.

### Task 2: Implement SuperWagie bootstrap domain and routes

**Files:**
- Create: `packages/web/server/lib/model-configuration/bootstrap-store.js`
- Create: `packages/web/server/lib/model-configuration/bootstrap.js`
- Create: `packages/web/server/lib/model-configuration/bootstrap-routes.js`
- Modify: `packages/web/server/lib/model-configuration/routes.js`
- Modify: `packages/web/server/lib/model-configuration/DOCUMENTATION.md`
- Test: `packages/web/server/lib/model-configuration/bootstrap.test.js`
- Test: `packages/web/server/lib/model-configuration/bootstrap-routes.test.js`

**Interfaces:**
- `createModelBootstrapRuntime({ dataDir, modelRuntime, platformAccount, uniHubClient, fetchImpl, secretStore })` returns `discover`, `issueKey`, `preview`, `apply`, `startTests`, `readTestRun`, `rollback`.
- `discover({ source: 'session'|'imported-key', key? })` returns a non-secret `discoveryId` and scoped catalog.
- `preview({ discoveryId, revision, mode, purposes })` returns a deterministic plan with `add`, `replace`, `preserve`, `unavailable`, `costs`.
- `apply({ operationId, discoveryId, revision, mode, selections })` atomically updates model configuration and stores a rollback snapshot.
- `startTests({ revision, purposes, expensive })` returns `testRunId`; `readTestRun(testRunId)` returns per-purpose states.

- [ ] Write failing tests for API-key product/instance rejection, session discovery, model-to-purpose mapping, fill-missing behavior, explicit managed replacement, stale revisions, idempotent apply, rollback conflicts, and secret redaction.
- [ ] Implement the private bootstrap store with 0600 operation files and an encrypted secret reference; persist only fingerprints and metadata in public state.
- [ ] Implement capability-aware mapping using the catalog and UniHub model operations; never bind a model to an unsupported purpose.
- [ ] Implement routes with strict Zod input/output schemas and bounded body sizes. Keep expensive test execution server-side with max concurrency two, unique idempotency keys, deadlines, and no automatic retries.
- [ ] Register the routes only on authenticated web/Electron runtimes; return explicit unsupported responses for VS Code/mobile runtimes without the backend.
- [ ] Run the focused backend tests and existing model-configuration tests.

### Task 3: Build the localized Settings wizard

**Files:**
- Create: `packages/ui/src/lib/modelConfigurationBootstrap.ts`
- Create: `packages/ui/src/components/sections/model-configuration/ModelQuickSetupWizard.tsx`
- Create: `packages/ui/src/components/sections/model-configuration/ModelQuickSetupWizard.test.tsx`
- Modify: `packages/ui/src/components/sections/model-configuration/ModelConfigurationPage.tsx`
- Modify: `packages/ui/src/lib/i18n/messages/model-configuration.i18n.ts` and all existing locale dictionaries
- Modify: `packages/ui/src/lib/settings/search.ts`

**Interfaces:**
- Client functions `discoverModelBootstrap`, `issueModelBootstrapKey`, `previewModelBootstrap`, `applyModelBootstrap`, `startModelBootstrapTests`, `readModelBootstrapTestRun`, `rollbackModelBootstrap` use `runtimeFetch` and parsed Zod contracts.
- `ModelQuickSetupWizard` receives `{ open, configuration, onClose, onApplied, client? }` and owns only transient form/progress state.

- [ ] Write failing component tests for the four steps, session/key source selection, preview fill-missing default, explicit replacement confirmation, test progress, failure retry, rollback, and unsupported runtime.
- [ ] Implement the wizard with `SettingsSection`, `SettingsFieldRow`, shared `Button`, `Input`, `Select`, status tokens and container-query layout.
- [ ] Add complete Chinese and English strings for labels, errors, warnings, cost notices, accessibility text and statuses.
- [ ] Add a searchable `models.quick-setup` anchor and ensure it is available only when the wizard can render.
- [ ] Add the quick-setup button to the existing page without changing the purpose tabs or native provider flow.
- [ ] Run focused UI tests, locale parity tests, and type-check.

### Task 4: Add full coverage and compatibility regression checks

**Files:**
- Modify: `packages/web/server/lib/model-configuration/connection-probe.test.js` where shared probe semantics apply
- Modify: `packages/web/server/lib/model-configuration/runtime.test.js` where revision/rollback interactions apply
- Modify: `packages/ui/src/components/sections/model-configuration/ModelConfigurationPage.test.tsx`
- Modify: `packages/ui/src/lib/modelConfiguration.contract.test.ts`
- Modify: `docs/superpowers/specs/2026-11-03-llmrouter-quick-setup-design.md` only for settled contract corrections

- [ ] Add a sandbox end-to-end fixture covering discover → preview → apply → batch test → rollback with a synthetic UniHub key and provider.
- [ ] Verify existing BYOK connections, project/session model overrides, native Agent defaults, managed session chat, and unsupported media states remain unchanged.
- [ ] Verify no raw Key appears in response bodies, persisted public configuration, test snapshots, or captured error text.
- [ ] Run `bun run check:changed`, focused Vitest suites, and the UniHub focused Go/API suites. Report unavailable external/database gates explicitly.
- [ ] Perform a final whole-branch review against the spec and this plan before considering the implementation complete.
