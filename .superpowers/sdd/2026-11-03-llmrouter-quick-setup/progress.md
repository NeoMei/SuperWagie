# SDD ledger — plan: docs/superpowers/plans/2026-11-03-llmrouter-quick-setup.md

## Pre-flight scan

| Pair/task | Shared interface or file | Finding | Ruling |
|---|---|---|---|
| Task 1 / Task 2 | UniHub discovery response consumed by `uniHubClient` | Task 1 owns scope/capability metadata; Task 2 consumes only public metadata and never trusts client-side scope | Keep response versioned and strict; Task 2 rejects unknown versions |
| Task 2 / Task 3 | Bootstrap route contracts | Task 3 needs stable Zod-parsed response shapes | Task 2 publishes schemas in `modelConfigurationBootstrap.ts`-compatible JSON; Task 3 uses no raw fetch |
| Task 2 / Task 4 | model configuration revision and rollback | Tests must preserve existing revision semantics | Apply/rollback always check expected revision and fail closed on conflict |
| Task 3 / Task 4 | ModelConfigurationPage entry point and locale/search contracts | Wizard must remain optional and not change native provider flow | Add only a top-level action and stable settings anchor |
| Task 1 | UniHub API key scope | A product key from another product could bypass accounting | Require `origin_product_id=superwagie` and correct instance before returning discovery |
| Task 2 | Credential storage | Imported key is security-sensitive | Never write raw key to public state, browser, logs, URL or snapshots; use encrypted private storage |
| Task 3 | Expensive tests | Automatic media calls could charge users | Default batch test excludes expensive media; user opt-in is explicit |

## Rulings

- Ruling: implement the three-stage feature as one compatible workflow with a session-first path and a SuperWagie-scoped API-key path — because the current managed session is the safest default while the approved feature requires fixed-key support.
- Ruling: keep model discovery and bootstrap orchestration separate from the existing model-configuration runtime — because the runtime already owns persistence and probes, while the wizard needs operation state, preview and rollback.
- Ruling: do not publish or commit during implementation — because repository instructions reserve Git/GitHub actions for explicit user requests; validation remains local.

## Task status

- Task 1: pending
- Task 2: pending
- Task 3: pending
- Task 4: pending

- Task 1: complete — UniHub discovery, scoped API-key model listing, product route registration, OpenAPI, focused tests and full skip-DB Go suite passed.
- Task 2: complete — SuperWagie bootstrap store/domain/routes, session/imported-key discovery, preview/apply/rollback/bounded tests, route/index wiring and focused tests passed.
- Task 3: complete — localized four-step Settings wizard, typed client, search entry, tests, UI type-check/lint passed.
- Task 4: in progress — root interface alignment, route identity coverage, full changed-file checks and final review remain.
- Task 4: complete — model-configuration backend suite 83/83, UI quick-setup/page suites 33/33, `bun run check:changed` passed, UniHub full skip-DB Go suite and vet passed.

## Final review corrections

- Await the authenticated identity resolver before session discovery and key issuance; bind session operations to the captured account/session actor.
- Keep imported LLMRouter keys behind the private `model-bootstrap` credential reference, strip the reference from public configuration, and enforce the UniHub destination policy.
- Apply connection and bindings through the runtime's single revision-locked mutation, persist the selected preview models and parameters, and issue provider idempotency keys for batch probes.
- Require UniHub product/account/instance scope metadata, preserve the discovered endpoint, and test only purposes changed by the current operation.
- Keep discovery records and secret references short-lived; reject stale revisions and rollback conflicts without overwriting concurrent edits.
- The default local secret boundary now stores imported credentials in an AES-256-GCM file plus a 0600 master key, while injected host secret stores remain supported; restart recovery was checked without plaintext in the secret file.
- Imported-key routes use the local authenticated UI owner when no UniHub session exists; session discovery still requires the platform identity, and every preview/apply/rollback validates the owner fingerprint.
- Applied imported credentials receive a durable secret reference independent of expiring discovery records; connection removal, rollback, and failed atomic apply clean that reference.
- The wizard keeps its dialog open after apply, exposes scope metadata and per-purpose results, preserves candidate model choices, and retries only failed purposes from the current operation.
