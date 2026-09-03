# Universal Viewer Authority Migration and Frozen Core Admission PoC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current WPS-authoritative Office Viewer rules with the confirmed Universal Viewer Platform authority, then build a disposable, evidence-producing admission PoC for the pinned `omni-viewer-core` candidate without adding production Viewer code.

**Architecture:** The first commit performs one atomic authority migration across product specs, machine-readable contracts, rules, technical admission state, and historical markers while every new Viewer item remains `RESEARCH_REQUIRED`. Later commits create an isolated PoC under `scripts/poc/universal-viewer/`: it acquires a hash-pinned upstream source tree into an ignored work area, applies auditable SuperWagie-owned patches, proves forbidden host/runtime paths are unreachable, builds selected Core entry points behind a narrow handle-based adapter, and emits hash-bound GVP-0 evidence. The PoC never registers a production Viewer, never becomes an application runtime dependency, and never treats an upstream test or a local success as release admission.

**Tech Stack:** Markdown authority documents; JSON Schema Draft 2020-12; Node.js ESM and `node:test`; AJV 8; npm lockfiles, `npm audit`, built-in npm 11.16.0 CycloneDX SBOM; Git archive/patch workflow; frozen `omni-viewer-core` 0.16.0 commit `ffdcda3eea83527380996ac935605f1422e43d3b`; existing SuperWagie `scripts/poc`, fixture, evidence, and validation-status infrastructure.

**Spec:** `docs/superpowers/specs/2026-09-04-superwagie-universal-viewer-platform-design.md`

## Global Constraints

- This plan covers only design §15.3 slices 1–2: authority/Gate foundation and Frozen Core admission PoC. It must not create a production `ViewerRegistry`, product `ViewerSurface`, product `ViewerWorker`, product UI, or release package.
- Keep the candidate technical state and every format at `RESEARCH_REQUIRED` during authority migration. A later PoC receipt may report an observed GVP-0 execution verdict, but it cannot change GVP-1–5 or production admission to `GO`.
- The authority migration is one atomic commit. Do not commit half-migrated current authority where WPS and Universal Viewer semantics coexist.
- Viewer open/read paths must not invoke WpsComposer, WPS, Microsoft Office, LibreOffice/`soffice`, system archive commands, online viewers, or first-use downloads. WpsComposer remains authoritative for generation, formatting, and structured Office modification; optional WPS/Office smoke remains an explicit final-delivery acceptance action.
- Do not copy the Omni Viewer Obsidian host. `omni-viewer-obsidian` is research evidence only. Reject Obsidian imports, share/upload features, writeback/save features, shell/process execution, external Office fallback, and ambient filesystem paths.
- Source acquisition is allowed only in the developer PoC command. Runtime tests must run with network disabled after the candidate cache is prepared. No product or first-open code may acquire dependencies.
- The pinned source commit, patch set, package lock, source-tree hash, dependency graph, license inventory, SBOM, vulnerability report, build output hashes, and chunk measurements are evidence identities. A mismatch fails closed.
- Do not silently accept `npm audit` moderate-or-higher production vulnerabilities. The known DOMPurify and Mermaid advisories must be removed from the candidate graph or the affected modules excluded; suppression without a time-bounded exception owner is not a pass.
- The PoC adapter accepts bytes plus opaque metadata, never a caller-provided absolute path. It is read-only and returns bounded summaries/diagnostics; it does not persist annotations or modify source bytes.
- GVP exit codes are `0=acceptance passed`, `1=acceptance failed`, `2=environment/arguments blocked`, matching existing PoC runners.
- Evidence belongs under `evidence/gvp-0/<run-id>/`, is generated rather than hand-edited, and binds every referenced artifact by SHA-256.
- Target platforms remain exactly `macos-15-arm64` and `windows-11-x64`. A macOS PoC result cannot sign for Windows.
- Before every commit, run `node scripts/check-spec-refs.mjs`; before final completion, run all commands in Task 7 and inspect `git diff --check` plus `git status --short`.
- Key rule anchors during execution: R-DL-05/R-DL-07, revised R-DL-08/R-DL-09, revised R-VD-10, R-US-12/R-US-13, R-RI-05/R-RI-07/R-RI-10, R-SE-07/R-SE-09/R-SE-11, R-RP-04/R-RP-05/R-RP-07, R-QS-01/R-QS-03/R-QS-05/R-QS-07, and the new Viewer rules.

---

## Planned File Structure

```text
docs/contracts/v1/
├── viewer-descriptor.schema.json
├── format-admission-record.schema.json
├── viewer-chunk-manifest.schema.json
├── viewer-protocol.schema.json
├── viewer-security.schema.json
├── viewer-review.schema.json
├── viewer-render-artifacts.schema.json
├── viewer-gate-receipt.schema.json
├── viewer-contract-fixtures.json
└── format-admission-ledger.json

scripts/poc/
├── viewer-authority-audit.mjs
├── viewer-authority-audit.test.mjs
├── viewer-ledger-audit.mjs
├── viewer-ledger-audit.test.mjs
├── viewer-history-audit.mjs
├── viewer-history-audit.test.mjs
├── validation-status-audit.mjs
├── run-gate.sh
└── universal-viewer/
    ├── .gitignore
    ├── README.md
    ├── package.json
    ├── package-lock.json
    ├── source-lock.json
    ├── patch-ledger.json
    ├── chunk-plan.json
    ├── acquire-frozen-core.mjs
    ├── provenance.mjs
    ├── source-policy-audit.mjs
    ├── dependency-audit.mjs
    ├── build-candidate.mjs
    ├── chunk-audit.mjs
    ├── host-adapter.mjs
    ├── resource-budget.mjs
    ├── malicious-corpus.mjs
    ├── gvp-0-gate.mjs
    ├── tests/
    │   ├── acquisition.test.mjs
    │   ├── provenance.test.mjs
    │   ├── source-policy.test.mjs
    │   ├── dependency-audit.test.mjs
    │   ├── chunk-audit.test.mjs
    │   ├── host-adapter.test.mjs
    │   ├── resource-budget.test.mjs
    │   ├── malicious-corpus.test.mjs
    │   └── gvp-0-gate.test.mjs
    └── fixtures/
        ├── handle-input.json
        ├── source-policy-forbidden.json
        ├── dependency-policy.json
        └── malicious/
            ├── zip-path-traversal.zip
            ├── zip-bomb-metadata.zip
            ├── svg-active-content.svg
            ├── html-active-content.html
            ├── ooxml-external-relationship.docx
            └── ambiguous-ooxml.zip

fixtures/gvp-0/
└── GVP-0-CORE-001/
    ├── README.md
    ├── acceptance.json
    └── decision.example.md

docs/技术可行性/
└── Universal-Viewer-Frozen-Core-准入报告.md
```

The `.candidate/` source tree and generated `dist/`, `audit/`, and temporary package directories live under `scripts/poc/universal-viewer/` and are ignored. Generated evidence lives under the already ignored `evidence/` root.

---

### Task 1: Perform the Atomic Authority, Contract, Rule, and Gate Migration

**Files:**
- Modify: `docs/最早期产品方案-V0.1.md`
- Modify: `docs/superpowers/specs/2026-08-29-superwagie-v1-release-scope.md`
- Modify: `docs/superpowers/specs/2026-08-29-superwagie-coding-admission-contract.md`
- Modify: `docs/superpowers/specs/2026-08-28-superwagie-workspace-delivery-design.md`
- Modify: `docs/superpowers/specs/2026-08-29-superwagie-ui-implementation-contract.md`
- Modify: `docs/superpowers/specs/2026-09-01-superwagie-bundled-chromium-electron-architecture-design.md`
- Create: `docs/contracts/v1/viewer-descriptor.schema.json`
- Create: `docs/contracts/v1/format-admission-record.schema.json`
- Create: `docs/contracts/v1/viewer-chunk-manifest.schema.json`
- Create: `docs/contracts/v1/viewer-protocol.schema.json`
- Create: `docs/contracts/v1/viewer-security.schema.json`
- Create: `docs/contracts/v1/viewer-review.schema.json`
- Create: `docs/contracts/v1/viewer-render-artifacts.schema.json`
- Create: `docs/contracts/v1/viewer-gate-receipt.schema.json`
- Create: `docs/contracts/v1/viewer-contract-fixtures.json`
- Create: `docs/contracts/v1/format-admission-ledger.json`
- Modify: `docs/contracts/v1/resource-handle.schema.json`
- Modify: `docs/contracts/v1/public-capability-facade.md`
- Modify: `docs/contracts/v1/README.md`
- Create: `rules/viewer-platform.md`
- Modify: `rules/deliverables.md`
- Modify: `rules/video.md`
- Modify: `rules/ui-shell.md`
- Modify: `rules/runtime-isolation.md`
- Modify: `rules/security-extensions.md`
- Modify: `rules/rust-packaging.md`
- Modify: `rules/quality-scope.md`
- Modify: `rules/README.md`
- Modify: `AGENTS.md`
- Modify: `docs/技术可行性/技术要求矩阵.md`
- Modify: `docs/技术可行性/技术验证执行计划.md`
- Modify: `docs/技术可行性/当前技术验证状态.json`
- Modify: `docs/技术可行性/01-桌面界面-Markdown-WebView-绘图.md`
- Modify: `docs/技术可行性/02-Agent运行时-沙箱-共享依赖-托管AI.md`
- Modify: `docs/技术可行性/05-内置能力逐项适配-PPT-Word-HTML-WPS.md`
- Modify: `docs/技术可行性/07-轻量视频制作内核-五场景.md`
- Modify: `docs/技术可行性/08-独立Office-Reviewer.md`
- Modify: `docs/技术可行性/技术验证外部条件清单.md`
- Modify: `docs/技术可行性/Windows11-x64-验证交接清单.md`
- Modify: `docs/技术可行性/README.md`
- Modify: `docs/界面原型确认索引.md`
- Modify: `docs/superpowers/plans/2026-08-30-independent-office-reviewer-poc.md`
- Modify: `docs/技术可行性/编码前技术验证收口报告-2026-09-01.md`
- Create: `scripts/poc/viewer-authority-audit.mjs`
- Create: `scripts/poc/viewer-authority-audit.test.mjs`
- Create: `scripts/poc/viewer-ledger-audit.mjs`
- Create: `scripts/poc/viewer-ledger-audit.test.mjs`
- Create: `scripts/poc/viewer-history-audit.mjs`
- Create: `scripts/poc/viewer-history-audit.test.mjs`
- Modify: `scripts/poc/contract-foundation/validate.mjs`
- Modify: `scripts/poc/contract-foundation/package.json`
- Modify: `scripts/poc/validation-status-audit.mjs`
- Modify: `scripts/poc/validation-status-audit.test.mjs`

**Interfaces:**
- `viewer-descriptor.schema.json` owns declared detection, support, capability, dependency, limit, fallback, and admission metadata.
- `format-admission-record.schema.json` owns one record per extension/container variant and binds it to required platforms, Corpus, Gate receipts, support mode, and current technical state.
- `viewer-protocol.schema.json` owns `ViewerOpenCommand`, `ViewerStateSnapshot`, and `ViewerDiagnostic`; these are internal Product Core contracts and must not enter `public-capability-methods.json`.
- `viewer-security.schema.json` owns `ViewerResourceHandle`, `SecretHandle`, `FontEnvironment`, and `OfficeFeatureInventory` definitions. `ViewerResourceHandle` composes the existing ResourceHandle rather than weakening it.
- `viewer-review.schema.json` owns `ViewerAnnotationAnchor`, per-format `DiffCapability`, and transactional `ViewerExportCommand`.
- `viewer-render-artifacts.schema.json` owns deterministic `PptPageRender` and forbids an interactive Surface screenshot as provenance.
- `viewer-gate-receipt.schema.json` owns GVP-0–5 evidence bindings and platform verdicts.
- `format-admission-ledger.json` is the only machine-readable list of target format variants and starts with every record at `RESEARCH_REQUIRED`.

- [ ] **Step 1: Write failing authority, history, ledger, and schema tests before editing authority**

Create `viewer-authority-audit.test.mjs` with both positive-current-document and mutation tests:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { auditViewerAuthorityText } from './viewer-authority-audit.mjs';

test('accepts the new current Viewer authority', () => {
  const result = auditViewerAuthorityText({
    path: 'docs/current.md',
    historical: false,
    text: 'Universal Viewer is built in. WPS is optional final-delivery smoke only.'
  });
  assert.deepEqual(result.errors, []);
});

test('rejects a current WPS-authoritative Viewer claim', () => {
  const result = auditViewerAuthorityText({
    path: 'docs/current.md',
    historical: false,
    text: 'Office Review 视觉事实仍由真实 WPS/Office 渲染提供。'
  });
  assert.match(result.errors.join('\n'), /WPS_AUTHORITATIVE_VIEWER_CONFLICT/);
});

test('accepts the same sentence only in a marked historical file', () => {
  const result = auditViewerAuthorityText({
    path: 'docs/history.md',
    historical: true,
    text: '> superseded-for-current-architecture: Universal Viewer design §14.4\nOffice Review 视觉事实仍由真实 WPS/Office 渲染提供。'
  });
  assert.deepEqual(result.errors, []);
});
```

Create ledger tests that reject duplicate `format_variant_id`, non-`RESEARCH_REQUIRED` initial records, an extension missing from design §5, a receipt not named in `required_gates`, and a matrix requirement missing the same Gate mapping. Create history tests that require the exact marker `superseded-for-current-architecture` in the two named historical documents and every old G3-REVIEW fixture README.

Extend Contract Foundation tests so the fixture file supplies one minimal valid and at least one invalid instance for every new `$defs` branch. Invalid fixtures must cover: unknown support mode, `ready` with a diagnostic that forces `partial`, absolute path in an open command, plaintext password, unsigned chunk, unbound receipt, interactive-surface provenance in `PptPageRender`, and unsupported export target.

Run:

```bash
node --test scripts/poc/viewer-authority-audit.test.mjs \
  scripts/poc/viewer-ledger-audit.test.mjs \
  scripts/poc/viewer-history-audit.test.mjs
cd scripts/poc/contract-foundation && npm test
```

Expected: FAIL because the audit modules, schemas, ledger, and fixtures do not exist.

- [ ] **Step 2: Implement the semantic conflict scanner with an explicit current/historical manifest**

`viewer-authority-audit.mjs` must export `auditViewerAuthorityText()` for mutation tests and a CLI that scans an explicit manifest. Do not scan all Markdown indiscriminately: old evidence may contain the superseded sentence. The current manifest must include the six authority specs, applicable rule files, current technical documents, `AGENTS.md`, and `docs/界面原型确认索引.md`. The historical manifest must include the old Reviewer plan, closeout report, `fixtures/gate-3/G3-REVIEW-001/README.md`, and `fixtures/gate-3/G3-REVIEW-002/README.md`.

Reject at least these current semantics, allowing inflection/spacing variants:

```js
export const FORBIDDEN_CURRENT_CLAIMS = Object.freeze([
  ['WPS_AUTHORITATIVE_VIEWER_CONFLICT', /(?:Office|WPS).{0,24}(?:视觉事实|authoritative).{0,24}(?:WPS|Office)/isu],
  ['WPS_VIEWER_FALLBACK_CONFLICT', /(?:并排|外部).{0,12}WPS.{0,24}(?:Review|预览|fallback)/isu],
  ['WPS_RENDER_PREVIEW_CONFLICT', /wps\.render_preview/u],
  ['WPSCOMPOSER_VIEWER_RENDER_CONFLICT', /WPSComposer.{0,24}(?:Viewer|预览|页面底图|convert_to_pdf)/isu],
  ['LIBREOFFICE_VIEWER_CONFLICT', /(?:LibreOffice|soffice).{0,24}(?:Viewer|fallback|预览|打开)/isu]
]);
```

The scanner must support a narrow allowlist of required negative statements such as “不得依赖 LibreOffice”; allowlist entries are exact `{path, line_sha256, rule_id, expires_on}` records, not filename-wide exclusions. Exit `1` on a conflict or stale/mismatched allowlist entry.

- [ ] **Step 3: Define and validate the Viewer contracts**

Use Draft 2020-12, `additionalProperties: false`, stable `$id`, bounded strings/arrays, and shared identifiers. The required state enums are:

```json
{
  "ViewerState": [
    "detecting", "loading", "password_required", "ready", "partial",
    "unsupported", "too_large", "corrupt", "failed_recoverable",
    "failed_terminal", "stale", "cancelled"
  ],
  "SupportMode": ["visual", "structured", "text_metadata", "media"],
  "AdmissionState": ["RESEARCH_REQUIRED", "PROVEN_POC", "PROVEN_EXISTING", "NO_GO", "DEFERRED"],
  "GateId": ["GVP-0", "GVP-1", "GVP-2", "GVP-3", "GVP-4", "GVP-5"],
  "PlatformId": ["macos-15-arm64", "windows-11-x64"],
  "GateVerdict": ["GO", "CONDITIONAL_GO", "NO_GO", "BLOCKED_ENVIRONMENT"]
}
```

`ViewerDiagnostic` must contain `code`, `severity`, `forces_partial`, and an optional bounded scope with `page`, `slide`, `sheet`, `record`, or `element_id`. `ViewerStateSnapshot.state=ready` is invalid when any diagnostic has `forces_partial=true`; encode this as an `if/then/not` condition and prove it with a fixture.

Extend `resource-handle.schema.json` with `viewer_input` and `viewer_derived_asset` resource types plus `inspect` as an allowed operation. Do not add path fields. `SecretHandle` must contain only opaque identity, `audience`, `operation=decrypt_current_document`, issued/expiry timestamps, one-shot semantics, and an auth tag; it must explicitly reject `password`, `secret`, and `value` fields.

`ViewerChunkManifest` must require chunk/version, platform/arch, compressed and installed bytes, code/assets/fonts, descriptor IDs, direct/transitive dependency identities, license/NOTICE references, source/build provenance, per-file hashes, and signature. `PptPageRender` must require source Revision, parser/renderer/font identities, viewport/background/scale, page hashes, render Gate receipt, and `producer=isolated_render_worker`.

Register every schema in `docs/contracts/v1/README.md` and `scripts/poc/contract-foundation/validate.mjs`. Add an npm script:

```json
"test": "node validate.mjs && node --test ../../poc/viewer-authority-audit.test.mjs ../../poc/viewer-ledger-audit.test.mjs ../../poc/viewer-history-audit.test.mjs"
```

Do not change the public capability method count. In `public-capability-facade.md`, move `wps.render_preview` to a dated deprecated table and state that internal Viewer Open/Query is not extension-callable; define optional Office smoke as a Trusted Host contract, not a Public Capability.

- [ ] **Step 4: Create the complete initial Format Admission Ledger and reconciliation audit**

Give each extension/container variant from design §5 its own stable record, including aliases as separate variants when magic/container behavior differs. Every initial record must include:

```json
{
  "format_variant_id": "office.docx.ooxml",
  "extensions": ["docx"],
  "container": "zip-ooxml",
  "target_support_modes": ["visual"],
  "current_state": "RESEARCH_REQUIRED",
  "required_platforms": ["macos-15-arm64", "windows-11-x64"],
  "required_gates": ["GVP-0", "GVP-1", "GVP-2", "GVP-3", "GVP-4", "GVP-5"],
  "corpus_id": "GVP-CORPUS-OFFICE-DOCX-001",
  "descriptor_id": "viewer.office.docx",
  "admission_receipts": []
}
```

Legacy DOC/PPT must target `structured` plus `visual` with a declared `partial_by_default=true`; RAR, 7z, and DMG must not appear. The audit must parse design §5’s format table, compare its extensions to ledger coverage, compare every ledger Gate to the new technical-matrix rows, and reject `PROVEN_*` unless hash-bound receipts exist for both target platforms and every required Gate.

- [ ] **Step 5: Migrate all current authority and rules in one working-tree change**

Apply design §14.1–§14.3 literally. The migration must establish these non-negotiable outcomes:

1. V1 scope contains Universal Viewer plus the entire design §5 target matrix and GVP-0–5 blocking topology.
2. CAC §1 names the 2026-09-04 Viewer design as Viewer-domain authority; CAC no longer treats old Office Review as current authority.
3. WD/UIC/BCRA define the internal Viewer Surface/Worker/Shell state and the strict `ready`/`partial` behavior, without claiming it is implemented.
4. Settings no longer contains “Office Review 检测”; replace it with a Viewer diagnostics/storage entry that does not expose WPS as a Viewer dependency.
5. `R-DL-08` separates built-in Viewer inspection from final target-application smoke. `R-DL-09` owns Universal Viewer/ReviewBridge behavior. `R-VD-10` consumes sealed `PptPageRender` artifacts.
6. New `rules/viewer-platform.md` includes numbered rules for format admission, strict state honesty, no external Office/LibreOffice/WpsComposer path, signed offline chunks, handle/secret isolation, per-format limits, supply-chain admission, cache/revision, format-specific Diff/annotation, Gate topology, and production-code prohibition before admission.
7. `AGENTS.md` routes any Viewer/parser/format/preview/Office-open change to `rules/viewer-platform.md` plus the Viewer design, UIC, CAC, BCRA, and affected contracts.
8. MATRIX adds stable `VIEW-*` requirements covering Registry/format detection, formats, Office fidelity, partial diagnostics, fonts, chunks/package budgets, security/handles, resources, caching/recovery, review/diff, performance, supply chain, and PptPageRender. Every row begins `RESEARCH_REQUIRED`.
9. Technical execution/state documents add GVP-0–5 as expected fixtures and explicitly prevent old G3-REVIEW evidence from satisfying them.
10. Technical subject documents remove Viewer dependence on WPS while retaining WPSComposer generation/formatting and optional delivery smoke.

Do not globally replace “真实 WPS”: R-DL-05, SuperPPT/SuperWriter final acceptance, and historical evidence still require it.

- [ ] **Step 6: Mark historical evidence without rewriting its old conclusions**

Prepend this semantic marker, adapted only for the target link, to the two historical documents and both G3-REVIEW fixture READMEs:

```md
> **superseded-for-current-architecture (2026-09-04):** This file preserves evidence for the retired WPS-authoritative Office Review path. It cannot satisfy Universal Viewer GVP-0–5 or current production admission. Current authority: `docs/superpowers/specs/2026-09-04-superwagie-universal-viewer-platform-design.md`.
```

Keep the original old result text below the banner intact. In `docs/技术可行性/当前技术验证状态.json`, keep old runs addressable as history but add `admission_scope: "historical-g3-review-only"`; do not relabel their result.

- [ ] **Step 7: Make all migration checks pass and commit the atomic set**

Run:

```bash
node --test scripts/poc/viewer-authority-audit.test.mjs \
  scripts/poc/viewer-ledger-audit.test.mjs \
  scripts/poc/viewer-history-audit.test.mjs
cd scripts/poc/contract-foundation && npm test
cd ../../..
node scripts/poc/viewer-authority-audit.mjs
node scripts/poc/viewer-ledger-audit.mjs
node scripts/poc/viewer-history-audit.mjs
node scripts/poc/validation-status-audit.mjs --status docs/技术可行性/当前技术验证状态.json
node scripts/check-spec-refs.mjs
git diff --check
```

Expected: all commands exit `0`; Contract Foundation reports every new valid fixture accepted and every invalid fixture rejected; all GVP items remain `RESEARCH_REQUIRED`; no current authority conflict remains.

Commit the entire migration in exactly one commit:

```bash
git add AGENTS.md docs rules scripts/poc/viewer-*.mjs scripts/poc/validation-status-audit.mjs scripts/poc/validation-status-audit.test.mjs scripts/poc/contract-foundation
git commit -m "docs: migrate universal viewer authority"
```

---

### Task 2: Lock and Reproduce the Frozen Core Candidate

**Files:**
- Create: `scripts/poc/universal-viewer/.gitignore`
- Create: `scripts/poc/universal-viewer/README.md`
- Create: `scripts/poc/universal-viewer/package.json`
- Create: `scripts/poc/universal-viewer/package-lock.json`
- Create: `scripts/poc/universal-viewer/source-lock.json`
- Create: `scripts/poc/universal-viewer/acquire-frozen-core.mjs`
- Create: `scripts/poc/universal-viewer/provenance.mjs`
- Create: `scripts/poc/universal-viewer/tests/acquisition.test.mjs`
- Create: `scripts/poc/universal-viewer/tests/provenance.test.mjs`

**Interfaces:**
- `source-lock.json` is the only allowed upstream source identity.
- `acquire-frozen-core.mjs` materializes `.candidate/source` for developer PoC use only.
- `provenance.mjs` emits `audit/source-provenance.json` containing the verified commit, tree, archive hash, lock hash, patch-ledger hash, and toolchain identity.

- [ ] **Step 1: Write acquisition and provenance rejection tests**

Tests must use local temporary Git repositories; they must not require the network. Cover exact-commit success, branch/tag input rejection, wrong remote URL, wrong tree hash, dirty source tree, symlink entry, unexpected Git submodule, second acquisition with changed lock, and provenance containing an absolute path.

Run:

```bash
cd scripts/poc/universal-viewer
node --test tests/acquisition.test.mjs tests/provenance.test.mjs
```

Expected: FAIL because the acquisition/provenance modules do not exist.

- [ ] **Step 2: Add the immutable source lock and package**

Use this source identity:

```json
{
  "schema_id": "superwagie.viewer-source-lock.v1",
  "upstream": "https://github.com/battlecook/omni-viewer-core.git",
  "version": "0.16.0",
  "commit": "ffdcda3eea83527380996ac935605f1422e43d3b",
  "source_tree_sha256": "1e0681afd02d7b6887bb373d5256eabcab69f8ac3015aa8372dd5e0754cc698d",
  "allowed_ref_kind": "commit-only"
}
```

The recorded hash is the SHA-256 of `git archive --format=tar ffdcda3eea83527380996ac935605f1422e43d3b`. The acquisition test must recompute it rather than trusting the JSON value or mutable checkout metadata.

`package.json` scripts:

```json
{
  "name": "superwagie-universal-viewer-admission-poc",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "packageManager": "npm@11.16.0",
  "engines": {
    "node": "24.18.0",
    "npm": "11.16.0"
  },
  "scripts": {
    "test": "node --test tests/*.test.mjs",
    "acquire": "node acquire-frozen-core.mjs",
    "provenance": "node provenance.mjs",
    "sbom": "npm sbom --package-lock-only --omit=dev --omit=optional --sbom-format cyclonedx"
  }
}
```

Resolve and commit the dependency-free exact lock with `npm install --package-lock-only`. SBOM generation must use the admitted built-in command `npm sbom --package-lock-only --omit=dev --omit=optional --sbom-format cyclonedx`; third-party SBOM packages are forbidden in this PoC. Provenance records exact Node/npm identity and rejects any npm version other than the admitted `11.16.0` or an npm binary that does not expose the required SBOM options. The lock regression rejects every `hasInstallScript` package entry and any moderate-or-higher `npm audit --package-lock-only --json` result.

- [ ] **Step 3: Implement fail-closed acquisition**

The command must require explicit `--cache-root <absolute temp/cache directory>` and optionally `--offline-archive <absolute tar>`. Network mode runs `git init`, configures the exact remote, fetches only the 40-character commit with tags disabled, checks out detached, verifies `HEAD`, verifies no submodules/symlinks, creates a deterministic archive, and compares its SHA-256 with `source-lock.json`. Offline mode imports only an archive whose hash matches the same lock. Never search PATH for an alternate repository and never accept a branch.

Ignore only generated local paths:

```gitignore
.candidate/
audit/
dist/
node_modules/
```

- [ ] **Step 4: Pass tests, capture the reviewed tree hash, and commit**

Run:

```bash
cd scripts/poc/universal-viewer
npm install --package-lock-only
npm ci
npm test
npm sbom --package-lock-only --omit=dev --omit=optional --sbom-format cyclonedx > audit/source-sbom.cdx.json
npm audit --package-lock-only --json
node -e "const p=require('./package-lock.json'); if(Object.values(p.packages).some(x=>x.hasInstallScript)) process.exit(1)"
node acquire-frozen-core.mjs --cache-root "$PWD/.candidate"
node provenance.mjs --candidate-root "$PWD/.candidate/source" --output "$PWD/audit/source-provenance.json"
git -C .candidate/source status --short
node -e "const p=require('./audit/source-provenance.json'); if(p.commit!=='ffdcda3eea83527380996ac935605f1422e43d3b') process.exit(1)"
cd ../../..
node scripts/check-spec-refs.mjs
git diff --check
```

Expected: tests pass, source status is empty, provenance contains no absolute path, and the computed tree hash equals the committed lock.

```bash
git add scripts/poc/universal-viewer
git commit -m "test: lock universal viewer core candidate"
```

---

### Task 3: Prove Source-Path, License, Dependency, Vulnerability, and Chunk Admission

**Files:**
- Create: `scripts/poc/universal-viewer/patch-ledger.json`
- Create: `scripts/poc/universal-viewer/chunk-plan.json`
- Create: `scripts/poc/universal-viewer/source-policy-audit.mjs`
- Create: `scripts/poc/universal-viewer/dependency-audit.mjs`
- Create: `scripts/poc/universal-viewer/build-candidate.mjs`
- Create: `scripts/poc/universal-viewer/chunk-audit.mjs`
- Create: `scripts/poc/universal-viewer/fixtures/source-policy-forbidden.json`
- Create: `scripts/poc/universal-viewer/fixtures/dependency-policy.json`
- Create: `scripts/poc/universal-viewer/tests/source-policy.test.mjs`
- Create: `scripts/poc/universal-viewer/tests/dependency-audit.test.mjs`
- Create: `scripts/poc/universal-viewer/tests/chunk-audit.test.mjs`

**Interfaces:**
- `patch-ledger.json` binds ordered patch files to SHA-256, rationale, upstream files touched, risk owner, and rerun Gates.
- `chunk-plan.json` maps selected Core exports to `viewer-base`, `viewer-office`, `viewer-media`, `viewer-data`, or `viewer-specialized` and declares the 20/50 MB compressed budgets.
- Audits emit deterministic JSON and use exit `1` for policy failure, `2` for missing tools/candidate input.

- [ ] **Step 1: Write policy mutation tests**

Create synthetic source/package trees and prove rejection of:

- imports containing `obsidian`, `electron`, `child_process`, or shell wrappers;
- identifiers or strings matching `soffice`, `libreoffice`, WPS/Office process launch, share/upload/update endpoints, writeback/save/pick-file services, or `shell.openExternal`;
- `http://`, `https://`, `fetch`, `XMLHttpRequest`, or WebSocket in reachable runtime modules unless an exact audited deny-by-construction test proves the call cannot be reached;
- dependency ranges rather than exact resolved identities in the generated candidate lock;
- GPL/AGPL/unknown licenses without an explicit blocked decision;
- moderate/high/critical production vulnerabilities without a non-expired exception record;
- overlapping files across chunks, files not owned by a chunk, unsigned manifest fixtures, or compressed bytes over 20 MiB for base+office / 50 MiB total.

Run `npm test`; expect failures because the audit modules do not exist.

- [ ] **Step 2: Define the initial allowed candidate slice**

The first PoC imports only Core-owned host/types/registry detection plus the DOCX/PPTX parser/viewer code and their transitively required styles/assets. Do not import PDF write/save modules, archive export, Obsidian adapter code, Share, media, data, GIS, engineering, AI-model, or legacy DOC/PPT viewers in this first candidate build. Those remain ledger targets for later format slices.

`chunk-plan.json` must still declare all five future chunk IDs, but only `viewer-base` and `viewer-office` may have selected files in this PoC. Empty future chunks are marked `planned_not_built`, never counted as passed.

- [ ] **Step 3: Lock a zero-patch candidate and prove the vulnerable host closure is excluded**

Create `patch-ledger.json` with `patches: []`, the pristine post-patch tree hash equal to the source tree hash, and two excluded-host findings:

- Obsidian adapter DOMPurify `GHSA-55q2-fjhq-7xh7` (`<=3.4.12`);
- Obsidian adapter Mermaid `GHSA-c4c3-pg64-4m4v`, `GHSA-6x64-9x62-f2gx`, `GHSA-3rrr-jr9j-h3q3`, `GHSA-2v8p-3f2j-5mp7`, and `GHSA-rhh3-jpg6-66xh` (`<11.16.1`).

Each exclusion must bind the audited Obsidian adapter commit `1db3137806dc4047513f6abd2ec010030e5029a2`, state `reason=host_not_imported`, and cite module-graph evidence showing that neither package occurs in the selected Core base+office graph. The pristine Core’s own `npm audit --omit=dev --json` currently reports zero vulnerabilities and must be preserved as raw evidence.

Do not edit `.candidate/source`. The SuperWagie adapter supplies only byte reads, cancellation, clock, bounded diagnostics, and local blob/object-URL lifecycle, so optional Core host services for save/file-pick remain unavailable by construction. If the generated module graph nevertheless reaches any forbidden host/write/network path, this task returns `NO_GO`; create a separately reviewed remediation plan rather than silently patching the frozen source during admission.

- [ ] **Step 4: Build selected entry points and generate supply-chain artifacts**

`build-candidate.mjs` must:

1. verify source and zero-patch ledger identities;
2. run the upstream `npm ci`, `npm run typecheck`, `npm test`, and `npm run build` in the prepared developer cache;
3. build only the selected SuperWagie base/office exports into `dist/viewer-base` and `dist/viewer-office`;
4. emit a module/metafile graph proving no forbidden module is reachable;
5. copy applicable LICENSE/NOTICE files;
6. verify provenance records the admitted exact npm identity, then run `npm sbom --package-lock-only --omit=dev --omit=optional --sbom-format cyclonedx` against the patched exact lock; no third-party SBOM package or alternate npm version is allowed;
7. run `npm audit --omit=dev --json` and preserve raw output;
8. create unsigned PoC chunk-manifest candidates that conform to `viewer-chunk-manifest.schema.json` but carry `signature_state=poc_unsigned_not_loadable` so production Registry could never load them.

The PoC measures gzip and installed bytes, but must not fake a production signature. `chunk-audit.mjs` treats the PoC manifests as measurement evidence and separately asserts they are non-loadable.

- [ ] **Step 5: Run all audits and commit**

```bash
cd scripts/poc/universal-viewer
npm test
node source-policy-audit.mjs --candidate-root "$PWD/.candidate/source" --output "$PWD/audit/source-policy.json"
node dependency-audit.mjs --candidate-root "$PWD/.candidate/source" --output "$PWD/audit/dependencies.json"
node build-candidate.mjs --candidate-root "$PWD/.candidate/source" --output-root "$PWD/dist"
node chunk-audit.mjs --dist-root "$PWD/dist" --output "$PWD/audit/chunks.json"
node -e "const a=require('./audit/dependencies.json'); if(a.moderate_or_higher!==0||a.forbidden_runtime_edges!==0) process.exit(1)"
node -e "const c=require('./audit/chunks.json'); if(c.base_office_compressed_bytes>20*1024*1024||c.total_compressed_bytes>50*1024*1024) process.exit(1)"
cd ../../..
node scripts/check-spec-refs.mjs
git diff --check
```

Expected: upstream and candidate checks pass; forbidden edges and moderate-or-higher reachable vulnerabilities are zero; base+office stays within 20 MiB; manifests are explicitly non-loadable PoC artifacts.

```bash
git add scripts/poc/universal-viewer
git commit -m "test: audit universal viewer candidate supply chain"
```

---

### Task 4: Build the Narrow Read-Only SuperWagie Host Adapter PoC

**Files:**
- Create: `scripts/poc/universal-viewer/host-adapter.mjs`
- Create: `scripts/poc/universal-viewer/resource-budget.mjs`
- Create: `scripts/poc/universal-viewer/fixtures/handle-input.json`
- Create: `scripts/poc/universal-viewer/tests/host-adapter.test.mjs`
- Create: `scripts/poc/universal-viewer/tests/resource-budget.test.mjs`

**Interfaces:**
- Input is `{handle, bytes, descriptor_id, signal, limits}` supplied by the test harness. The adapter never opens a filesystem path.
- Output is `{detected, document_model, diagnostics, metrics}` with deterministic bounded data and no DOM persistence.
- Allowed host services are `readAll`, bounded `readRange`, `isCancelled`, `reportDiagnostic`, and `createEphemeralAssetUrl`/`revokeEphemeralAssetUrl`.

- [ ] **Step 1: Write failing capability-boundary tests**

Tests must prove:

- a valid audience-bound `viewer_input` handle opens representative DOCX/PPTX bytes;
- wrong audience, operation, revision, expiry, or size fails before parser dispatch;
- the adapter object exposes no `save`, `write`, `pickFile`, `share`, `fetch`, `spawn`, `openExternal`, or path property;
- the input bytes are unchanged after success, cancellation, parser error, and limit rejection;
- an unknown OOXML relationship produces a scoped `forces_partial=true` diagnostic rather than `ready`;
- an unrecognized/ambiguous container never dispatches to an Office parser;
- cancellation revokes every ephemeral asset URL and returns `cancelled`;
- diagnostic/text/model arrays are truncated with a visible limit diagnostic rather than unbounded allocation.

Run `npm test`; expected failure because the adapter does not exist.

- [ ] **Step 2: Implement handle verification and the adapter seam**

The PoC does not implement cryptography; it accepts only a prevalidated handle fixture carrying `verification_state=verified_by_test_core`. Any other value fails. This prevents the JavaScript adapter from pretending to be Rust Product Core. The adapter must check audience, operation, revision, expiry, and declared byte length before passing a copied `Uint8Array` to Core.

Use the design §9.4 default limits as constants, including compressed input, total decompressed bytes, entry count, per-entry bytes, XML nodes/depth/text, image dimensions/pixels, rows/columns/cells, page/slide counts, parse deadline, and worker memory ceiling. Any increase is rejected by `resource-budget.mjs`; formats may only lower defaults.

- [ ] **Step 3: Use only the selected frozen Core interfaces**

Import from the generated candidate base/office output, not from `.candidate/source` and not from the Obsidian adapter. The adapter sequence is fixed:

```text
verify handle → sniff magic/container → choose admitted PoC descriptor
→ inventory OOXML features → enforce limits → parse with AbortSignal
→ normalize diagnostics → derive ready|partial|corrupt|too_large|cancelled
→ revoke ephemeral assets → return bounded result
```

In this PoC, `admitted PoC descriptor` means allowed by the PoC test fixture, not present in the production Format Admission Ledger. The production ledger remains `RESEARCH_REQUIRED`.

- [ ] **Step 4: Pass tests and commit**

```bash
cd scripts/poc/universal-viewer
npm test
node --test tests/host-adapter.test.mjs tests/resource-budget.test.mjs
cd ../../..
node scripts/check-spec-refs.mjs
git diff --check
git add scripts/poc/universal-viewer
git commit -m "test: prove universal viewer host adapter boundary"
```

---

### Task 5: Establish the Malicious-Input and Independence Baseline

**Files:**
- Create: `scripts/poc/universal-viewer/malicious-corpus.mjs`
- Create: `scripts/poc/universal-viewer/fixtures/malicious/zip-path-traversal.zip`
- Create: `scripts/poc/universal-viewer/fixtures/malicious/zip-bomb-metadata.zip`
- Create: `scripts/poc/universal-viewer/fixtures/malicious/svg-active-content.svg`
- Create: `scripts/poc/universal-viewer/fixtures/malicious/html-active-content.html`
- Create: `scripts/poc/universal-viewer/fixtures/malicious/ooxml-external-relationship.docx`
- Create: `scripts/poc/universal-viewer/fixtures/malicious/ambiguous-ooxml.zip`
- Create: `scripts/poc/universal-viewer/tests/malicious-corpus.test.mjs`
- Create: `fixtures/gvp-0/GVP-0-CORE-001/README.md`
- Create: `fixtures/gvp-0/GVP-0-CORE-001/acceptance.json`
- Create: `fixtures/gvp-0/GVP-0-CORE-001/decision.example.md`

**Interfaces:**
- `malicious-corpus.mjs` runs fixtures in a child process with a hard deadline and produces one result per immutable fixture hash.
- `acceptance.json` defines machine thresholds; tests must read it rather than duplicating magic values.

- [ ] **Step 1: Create deterministic malicious fixtures and their manifest**

Generate binary ZIP/OOXML fixtures with a small checked-in generator used only during authoring, then delete the generator after fixture hashes are fixed. README must record purpose, generation recipe, SHA-256, expected diagnosis, and why no harmful payload executes. Do not download malware or proprietary documents.

The acceptance file must require:

```json
{
  "external_processes": 0,
  "network_requests": 0,
  "filesystem_paths_exposed": 0,
  "source_mutations": 0,
  "moderate_or_higher_reachable_vulnerabilities": 0,
  "forbidden_runtime_edges": 0,
  "unexpected_fixture_outcomes": 0,
  "base_office_compressed_max_bytes": 20971520,
  "all_chunks_compressed_max_bytes": 52428800
}
```

- [ ] **Step 2: Write and pass malicious-input tests**

Prove path traversal never creates a file; ZIP-bomb metadata is rejected before expansion; active SVG/HTML returns sanitized data with no script/event/remote URL; OOXML external relationships produce `partial` diagnostics without a request; ambiguous OOXML returns unsupported/corrupt without parser guessing; deadlines terminate a hung parser child; and no fixture changes its source hash.

The harness must monkey-patch/fail `fetch`, XHR, WebSocket, and asset URL attempts in unit tests and separately inspect the actual child process tree. Unit monkey-patching alone is not independence evidence.

- [ ] **Step 3: Add an offline process-tree execution mode**

The runner must accept `--offline` and fail if DNS/socket/network hooks observe any attempt. On macOS collect child process identities with explicit `/bin/ps`; on Windows the later handoff uses PowerShell CIM. Normalize only executable basename/hash into evidence—never user paths or command-line secrets. Reject WPS, Office, LibreOffice, `soffice`, WpsComposer, shell, `tar`, and archive utility children.

- [ ] **Step 4: Run baseline and commit**

```bash
cd scripts/poc/universal-viewer
npm test
node malicious-corpus.mjs \
  --candidate-root "$PWD/.candidate/source" \
  --fixture-root "$PWD/fixtures/malicious" \
  --offline \
  --output "$PWD/audit/malicious-corpus.json"
node -e "const r=require('./audit/malicious-corpus.json'); if(!r.pass) process.exit(1)"
cd ../../..
node scripts/check-spec-refs.mjs
git diff --check
git add scripts/poc/universal-viewer fixtures/gvp-0
git commit -m "test: add universal viewer malicious corpus baseline"
```

---

### Task 6: Integrate GVP-0 with the Unified Runner and Status Audit

**Files:**
- Create: `scripts/poc/universal-viewer/gvp-0-gate.mjs`
- Create: `scripts/poc/universal-viewer/tests/gvp-0-gate.test.mjs`
- Modify: `scripts/poc/evidence-run-init.mjs`
- Modify: `scripts/poc/evidence-run-init.test.mjs`
- Modify: `scripts/poc/run-gate.sh`
- Modify: `scripts/poc/solution-b-runners.test.mjs`
- Modify: `scripts/poc/validation-status-audit.mjs`
- Modify: `scripts/poc/validation-status-audit.test.mjs`
- Modify: `scripts/poc/README.md`

**Interfaces:**
- Public invocation: `./scripts/poc/run-gate.sh gvp-0 --platform <platform> --fixture GVP-0-CORE-001 --candidate-root <absolute-dir>`.
- Output: `evidence/gvp-0/<run-id>/{manifest.json,environment.json,results.json,artifacts/*}`.
- `results.json` conforms to `viewer-gate-receipt.schema.json` and binds all audit artifacts by relative path plus SHA-256.

- [ ] **Step 1: Write fail-closed runner tests**

Cover missing candidate root, relative/symlink candidate root, wrong source commit/hash, missing patch, stale audit, schema-invalid result, artifact hash mismatch, platform mismatch, unsigned production-manifest claim, `CONDITIONAL_GO` treated as release pass, and a complete local fixture. Verify exact exit codes `2`, `1`, and `0` for environment, acceptance, and pass outcomes.

Run:

```bash
cd scripts/poc/universal-viewer
node --test tests/gvp-0-gate.test.mjs
cd ../../..
node --test scripts/poc/evidence-run-init.test.mjs scripts/poc/solution-b-runners.test.mjs scripts/poc/validation-status-audit.test.mjs
```

Expected: FAIL because `gvp-0` is not registered.

- [ ] **Step 2: Extend evidence and runner namespaces narrowly**

Update `evidence-run-init.mjs` Gate validation from `contract-foundation|gate-[0-6]` to also allow `gvp-[0-5]`. Add only the GVP-0 route to `run-gate.sh`; GVP-1–5 remain registered in status/plan as `RESEARCH_REQUIRED` but have no executable runner yet and must return exit `2` if invoked.

Do not overload old Gate 3 flags. GVP-0 accepts only `--platform`, `--fixture`, and `--candidate-root` plus existing evidence controls.

- [ ] **Step 3: Aggregate GVP-0 evidence without manufacturing signatures**

`gvp-0-gate.mjs` reruns or verifies freshness of:

- source provenance and patch ledger;
- source policy/reachability;
- licenses/NOTICE;
- CycloneDX SBOM and exact dependency lock;
- raw vulnerability report;
- build provenance and output hashes;
- PoC chunk measurements/manifests;
- Host Adapter boundary tests;
- malicious/offline baseline.

A local pass may set `decision_hint=GO` for `gate=GVP-0`, `fixture=GVP-0-CORE-001`, and the current platform only. It must also state:

```json
{
  "scope": "disposable-admission-poc",
  "production_registry_admitted": false,
  "production_chunk_signed": false,
  "release_admission": "NO_GO",
  "remaining_gates": ["GVP-1", "GVP-2", "GVP-3", "GVP-4", "GVP-5"]
}
```

If a signature, second platform, or later Gate is absent, record it as a limitation; do not convert a satisfied GVP-0 contract/provenance check into `CONDITIONAL_GO` merely because later Gates are pending.

- [ ] **Step 4: Update status audit semantics**

Add GVP-0–5 to `EXPECTED_FIXTURES` with both required platforms. The audit must keep format-ledger records `RESEARCH_REQUIRED` until all record-specific required receipts exist; a GVP-0 macOS `GO` alone is historical PoC evidence, not format admission. Old G3-REVIEW results never count toward a GVP fixture.

- [ ] **Step 5: Run integration checks and commit**

```bash
cd scripts/poc/universal-viewer && npm test
cd ../../..
node --test scripts/poc/evidence-run-init.test.mjs \
  scripts/poc/solution-b-runners.test.mjs \
  scripts/poc/validation-status-audit.test.mjs
./scripts/poc/run-gate.sh gvp-0 \
  --platform macos-15-arm64 \
  --fixture GVP-0-CORE-001 \
  --candidate-root "$PWD/scripts/poc/universal-viewer/.candidate/source"
node scripts/poc/validation-status-audit.mjs --status docs/技术可行性/当前技术验证状态.json
node scripts/check-spec-refs.mjs
git diff --check
```

Expected on the current macOS development host: runner exit `0` only if every GVP-0 acceptance check passes; status audit still reports production admission `NO_GO` and GVP-1–5 incomplete. If the environment lacks a required tool, preserve exit `2` evidence and do not fake a pass.

```bash
git add scripts/poc fixtures/gvp-0
git commit -m "test: integrate universal viewer gvp zero admission"
```

---

### Task 7: Publish the PoC Finding Without Promoting Production State

**Files:**
- Create: `docs/技术可行性/Universal-Viewer-Frozen-Core-准入报告.md`
- Modify: `docs/技术可行性/当前技术验证状态.json`
- Modify: `docs/技术可行性/技术验证执行计划.md`
- Modify: `docs/技术可行性/README.md`
- Modify: `docs/技术可行性/Windows11-x64-验证交接清单.md`
- Modify: `docs/superpowers/specs/2026-09-04-superwagie-universal-viewer-platform-design.md`

**Interfaces:**
- The report references immutable receipt/artifact hashes and distinguishes observed candidate facts, GVP-0 platform verdict, unresolved Gates, and production decision.
- The design receives only a dated implementation-status appendix/link; do not rewrite the confirmed design based on one platform result.

- [ ] **Step 1: Draft the evidence-backed report**

Report exact source/patch/lock identities, selected base+office slice, removed capabilities, vulnerability outcome, license/SBOM outcome, bundle measurements, test counts, process/network results, current platform, receipt hash, and limitations. Include a decision table with separate rows for:

- product decision: confirmed;
- authority migration: complete/incomplete;
- GVP-0 macOS: actual verdict;
- GVP-0 Windows: actual verdict or missing;
- GVP-1–5: `RESEARCH_REQUIRED`;
- format admission: none;
- production Viewer implementation: forbidden/not started;
- Universal Viewer release admission: `NO_GO`.

Do not say “supports DOCX/PPTX” based on parser smoke. Say “the pinned candidate parsed the named PoC fixtures under the recorded limits” and link the receipt.

- [ ] **Step 2: Update status from receipts only**

Use a small audited status-update mode in `validation-status-audit.mjs` or a dedicated deterministic helper; do not hand-copy a `GO`. The updater may add the GVP-0 platform run/hash. It must leave format ledger records and production admission unchanged unless their complete receipt conditions are met.

Windows handoff must state the exact command, required prepared candidate cache/offline archive, expected evidence files, and that Windows success still does not satisfy GVP-1–5.

- [ ] **Step 3: Run a fresh full verification**

Read and follow `superpowers:verification-before-completion`, then run from a clean shell:

```bash
node scripts/check-spec-refs.mjs
node scripts/poc/viewer-authority-audit.mjs
node scripts/poc/viewer-ledger-audit.mjs
node scripts/poc/viewer-history-audit.mjs
cd scripts/poc/contract-foundation && npm ci && npm test
cd ../universal-viewer && npm ci && npm test
cd ../../..
node --test scripts/poc/evidence-run-init.test.mjs \
  scripts/poc/solution-b-runners.test.mjs \
  scripts/poc/validation-status-audit.test.mjs
./scripts/poc/run-gate.sh gvp-0 \
  --platform macos-15-arm64 \
  --fixture GVP-0-CORE-001 \
  --candidate-root "$PWD/scripts/poc/universal-viewer/.candidate/source"
node scripts/poc/validation-status-audit.mjs --status docs/技术可行性/当前技术验证状态.json
git diff --check
git status --short
```

Expected: every static/test command exits `0`; GVP-0 returns an honest environment/acceptance result; no GVP-1–5 or format is promoted; `git status --short` lists only the intended report/status/doc updates before the final commit.

- [ ] **Step 4: Self-review against the approved design**

Use this explicit checklist:

- Every design §14.1–§14.4 file was migrated or historically marked.
- Viewer authority is unique; current docs contain no WPS-authoritative Viewer or LibreOffice fallback semantics.
- WpsComposer generation/formatting and optional final smoke remain intact.
- Every design §5 target extension is in the ledger; RAR/7z/DMG are absent.
- Every ledger record remains `RESEARCH_REQUIRED` without complete dual-platform GVP receipts.
- `ready` cannot coexist with an unhandled feature/fallback-font/partial diagnostic.
- Viewer schemas contain no absolute path or plaintext secret.
- Public method inventory did not gain internal Viewer Open/Query.
- Candidate source/patch/dependency/chunk identities are immutable and reproducible.
- Obsidian host, share, writeback, Office/LibreOffice/WpsComposer, system commands, and network paths are unreachable.
- Known Obsidian-host DOMPurify/Mermaid advisories are excluded from the selected reachable graph with later Diagram Gate obligations preserved.
- PoC manifests cannot masquerade as signed production chunks.
- Report separates GVP-0 evidence, per-format admission, production implementation, and release admission.
- No temporary sentinel, unresolved value, omitted implementation, or ellipsis remains in committed machine-readable files or executable scripts.

Run a final placeholder scan:

```bash
rg -n "临时值|待补|待定|以后填写|\.\.\." \
  docs/contracts/v1 scripts/poc/universal-viewer fixtures/gvp-0
```

Expected: no unexplained matches. Any deliberate prose occurrence must be removed or replaced with an exact value before completion.

- [ ] **Step 5: Commit the report and handoff state**

```bash
git add docs/技术可行性 docs/superpowers/specs/2026-09-04-superwagie-universal-viewer-platform-design.md
git commit -m "docs: record universal viewer frozen core admission"
git status --short --branch
```

Expected: clean worktree; branch remains ahead only by the intended commits. Do not push, publish, sign a release, or begin Viewer Foundation implementation without a new explicit user instruction and the next approved slice spec.

---

## Completion Definition

This plan is complete only when:

1. current authority, contracts, rules, technical matrix/state, and indexes consistently describe Universal Viewer and pass semantic/schema/reconciliation audits;
2. historical WPS-authoritative Viewer evidence is preserved and excluded from current admission;
3. the exact Frozen Core source/patch/dependency/chunk identities reproduce from a clean developer cache;
4. the selected base+office PoC has zero forbidden runtime edges and zero unexcepted moderate-or-higher reachable vulnerabilities;
5. the narrow handle-based adapter and malicious/offline baseline pass without source mutation, path disclosure, network, external process, or system command access;
6. GVP-0 emits a schema-valid, hash-bound, platform-scoped receipt through the unified runner;
7. every format and GVP-1–5 remains honestly blocked from production until later slice plans produce their own evidence;
8. the repository is clean after the final report commit.

The next plan must be chosen from design §15.3 only after reviewing this PoC’s real evidence. It may be Viewer Foundation or a revised Frozen Core remediation plan; it must not assume that DOCX/PPTX fidelity, all-format support, dual-platform isolation, package signing, or release admission has already passed.
