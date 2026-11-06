# Single-key all-models implementation plan

> **For agentic workers:** Use subagent-driven-development for independent repository tasks. The coordinator reviews contracts and integration before release.

**Goal:** One unchanged SuperWagie Key can discover and use LLMRouter's available models under LLMRouter pricing and the original Key's payer and limits.

**Architecture:** Explicit dynamic scope delegates model availability and native pricing to LLMRouter. UniHub retains credential validation, original wallet and budget enforcement. SuperWagie separates catalog snapshots and feature selections from authorization.

**Tech Stack:** Existing Go/Gin/GORM and Go/pgx services, shared React/JavaScript runtime, existing PostgreSQL and ledger interfaces. No new dependency.

**Spec:** `../specs/2026-11-07-single-key-all-models-design.md` defines all wire fields, monetary invariants and compatibility behavior.

## Global constraints

- Preserve token/hash, credential ID, identity, payer, original llmrouter product wallet, subscription and limits.
- Historical selected-scope Keys and task credentials keep their existing contracts.
- Dynamic pricing uses CNY/6 prepaid cash and existing native conversion; CREDIT is not implicitly converted.
- No local vendor-secret migration, native Token enrollment, balance migration or provider-call replay.
- Keep release sources and preexisting worktrees intact. Separate current evidence from historical receipts.
- Root alone runs broad checks and builds in a shared checkout. Tests use verified isolated endpoints.

## Task 1: UniHub dynamic scope and native settlement

**Owner:** UniHub worker in `unihub-all-models-key/unihub`.

**Files:** `internal/modelaccess/api_keys.go`, `service.go`, `discovery.go`; `internal/httpapi/api_keys.go`, `model.go`, `model_discovery.go`, product route scope tables; `internal/billing` native-pricing module and tests; migration and owning docs/config assembly.

**Interfaces:** Implement the exact scope, discovery, native-reserve and native-settle JSON contracts in the spec. Existing authenticated top-up/release/call reads retain their identity and budget checks.

- [ ] Add failing API tests showing a selected Key cannot yet upgrade to `llmrouter_available`, then preserve its original token, ID, actor, payer and limits across upgrade.
- [ ] Add the default-compatible migration and atomic audited upgrade. Test idempotency, revoked/expired Keys, wrong instance and concurrent scope changes.
- [ ] Add dynamic catalog proxy tests using an isolated HTTP server with 150 models and a later 151st model. Verify authenticated scope echo and failure propagation; the Key is unchanged.
- [ ] Implement native quote validation and original-wallet reservation. Test the monetary boundary with explicit cases:

```go
cases := []struct{ quota, numerator, denominator, amount string }{
    {"0", "73", "5", "0"},
    {"1", "73", "5", "15"},
    {"5", "73", "5", "73"},
}
```

- [ ] Verify a team payer and original product wallet, free calls without zero postings, budgets, conflicting replay, wrong quote digest, old/new settlement isolation, above-held top-up and pending recovery.
- [ ] Run focused modelaccess/httpapi/billing tests against a new owned PostgreSQL and ledger instance. Record non-skipped results and preserve old-wallet evidence.

## Task 2: LLMRouter catalog and native pricing execution

**Owner:** LLMRouter worker owns shared files; root owns new `router/provider_catalog.go` and `router/provider_catalog_test.go`.

**Files:** `router/managed_key.go`, `model_catalog.go`, new provider catalog module; `internal/platformbilling` scope/client/native-pricing modules; `controller/relay.go`, `service/billing.go`, operation admission and settlement owners; OCR document module and owning docs.

**Interfaces:** `readProviderCatalog(context.Context, *platformbilling.Adapter, platformbilling.Claims)` returns an authoritative catalog. `SetProviderCatalogRouter(*gin.Engine, *platformbilling.Adapter, platformbilling.CatalogConfig)` registers the service-only catalog endpoint. `Adapter.NativePrincipal()` selects the configured native group. Native calls use the UniHub quote endpoints in the spec while `PlatformMode` continues to prohibit local quota deductions.

- [ ] Add failing catalog tests for more than 32 legacy chat models plus explicit embedding/OCR/image routes, dynamic channel changes and dedicated service authentication.
- [ ] Assemble models from current enabled abilities and explicit routes with native price checks. Publish actual operation metadata, immutable scope echo and deterministic catalog version. Test channel disable, wrong group and missing-price behavior.
- [ ] Add native-pricing session tests proving the original managed credential authorizes the request and native helpers determine the frozen quote. Ensure selected credentials retain existing tariffs.
- [ ] Integrate native pricing into synchronous and asynchronous operations. Persist the complete native price snapshot and conversion before dispatch; recover from that snapshot. Compare native and delegated amounts for the same bounded request and response usage.
- [ ] Bring the existing reviewed OCR document candidate into this new tree and verify current credential ownership, settlement, result digest and revoked access before delivery.
- [ ] Verify no local quota mutation, no shadow Token, no cross-Key private result reads, no unknown-dispatch retry and no silent final-charge truncation.
- [ ] Run focused platformbilling/router/operation tests. The root runs the final combined suite after catalog and pricing edits are complete.

## Task 3: SuperWagie dynamic catalog and same-Key configuration

**Owner:** SuperWagie worker in the current tree; root owns this spec/plan and final checks.

**Files:** `packages/web/server/lib/model-configuration/account-key-{activation,store,test-plan,catalog,provider}.js`, `bootstrap-client.js`, `bootstrap.js`, owning docs and focused tests. UI metadata parsers change only as required by the compatible API fields.

**Interfaces:** Create and upgrade requests explicitly use `model_scope: "llmrouter_available"`. The account discovery facade and same-Key LLMRouter `/v1/models` provide catalog snapshots; selection no longer narrows authorization.

- [ ] Add a failing activation test with 150 available models that issues one dynamic Key, plus a resumed old receipt that upgrades the same Key through `/scope`.
- [ ] Separate durable Key scope from catalog snapshots and purpose selection. Preserve issuer/account ownership and uncertain issuance handling.
- [ ] Register the complete chat catalog in the native provider. Test a removed model and concurrent manual provider edits with exact old-snapshot comparison.
- [ ] Keep compatible actual-model selections and bounded three-worker probes; verify that an absent original model remains explicit and is not substituted.
- [ ] Route account quick setup through the same owned Key and catalog. Verify imported-key identity headers; unrelated BYOK and selected Keys keep their behavior.
- [ ] Run focused tests for activation, store, provider, catalog and bootstrap, plus existing progressive-row UI coverage if UI contracts change.

## Task 4: Cross-service verification and publication

**Owner:** Root with independent reviewers.

- [ ] Run protocol fixtures through both services: dynamic creation/upgrade, provider catalog, native reserve/top-up/settle/release and legacy selected calls.
- [ ] Review the combined diffs, run project-required checks on final source and commit only scoped changes. Changes to failures require another relevant check.
- [ ] Recheck live versions, account identity, balances, Key fingerprint and configuration. Prepare guarded additive schema/config deployment with backups and no database restoration.
- [ ] Deploy compatible service changes before the desktop client. Upgrade the existing authorized Key once and verify its identity and limits remain unchanged.
- [ ] Test configured supported modalities using that same Key, then read back financial settlement. Do not trigger the entire directory as paid tests or claim unavailable native endpoints passed.
- [ ] Build macOS ARM64 and Windows x64 packages from frozen source, verify installed contents and publish the authorized release and website. Report actual tests, deployment, real calls and client acceptance separately.
