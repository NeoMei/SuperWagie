# Task 6 report — GVP-0 unified runner and status integration

## Decision

**Task 6 integration is complete. The current frozen candidate remains `NO_GO`, and the public GVP-0 runner exits `1`.**

The local GVP-0 run produced a schema-valid `ViewerGateReceipt` for `GVP-0-CORE-001` on `macos-15-arm64`. It binds a complete 50-artifact evidence set through a relative-path SHA-256 manifest. The aggregate preserves the controlling Task 3 result of eight forbidden runtime edges:

```json
{
  "verdict": "NO_GO",
  "scope": "disposable-admission-poc",
  "production_registry_admitted": false,
  "production_chunk_signed": false,
  "release_admission": "NO_GO",
  "remaining_gates": ["GVP-1", "GVP-2", "GVP-3", "GVP-4", "GVP-5"]
}
```

No signature, production-loadable Chunk Manifest, format admission, GVP completion, Registry admission, or release admission was manufactured. GVP-1 through GVP-5 are registered but explicitly non-executable and return exit `2`.

Rules applied: R-VP-01, R-VP-03, R-VP-04, R-VP-07, R-VP-10, R-VP-11; R-RI-06, R-RI-07, R-RI-10, R-RI-11; R-SE-03, R-SE-04, R-SE-12; R-RP-07, R-RP-09; R-QS-02, R-QS-08.

## TDD evidence

### Initial RED

`node --test scripts/poc/universal-viewer/tests/gvp-0-gate.test.mjs` exited `1` with `ERR_MODULE_NOT_FOUND` because `gvp-0-gate.mjs` did not exist.

The first integration run also exited `1`: the evidence initializer rejected every GVP namespace, the unified runner had no explicit GVP-1–5 behavior, and the status audit did not export or enforce a Format Admission Ledger projection.

### GREEN and acceptance-driven corrections

- The first implementation run reached 9/10 focused tests. It correctly rejected all acceptance mutations, but also rejected ordinary macOS temporary output roots because `/var` canonicalizes to `/private/var`. Output leaf symlinks remain prohibited; the normal platform alias is no longer mistaken for an input failure. Focused GREEN: 10/10.
- The first real unified-runner invocation exposed a separate CLI mapping error: `--results-json` was mapped to `resultsJson` instead of the required `resultsPath`, producing exit `2`. The parser now maps every public flag explicitly. The complete-fixture test executes the real module CLI, so that interface regression is covered. The corrected public shell invocation produces `GVP0_ACCEPTANCE_NO_GO` and exit `1`.
- AJV now validates the authoritative 2020-12 Viewer receipt and Chunk Manifest schemas with an explicit UTC date-time format check instead of silently ignoring the format.

## Implemented boundaries

- `gvp-0-gate.mjs` requires the exact fixture, current host platform, absolute non-symlink candidate root, new absolute result path, and an empty non-symlink artifact directory.
- The authoritative acquisition verifier rechecks commit, tree, archive, materialized tree, pristine state, and source-lock bytes before aggregation and after fresh probes.
- The zero-patch ledger is bound to the candidate. Any declared patch must be a safe relative path, regular non-symlink file, and exact SHA-256 match.
- The immutable 14-file Task 3 baseline must match its reviewed index exactly. Admission decision, source-policy results, exact lock, raw audits, CycloneDX SBOM, provenance inputs/outputs, platform identity, chunks, license/NOTICE closure, and unsigned/non-loadable envelope semantics are revalidated.
- Host Adapter tests and the offline malicious corpus are rerun. A behavior pass cannot override the eight statically reachable forbidden edges.
- `results.json` contains only the strict `ViewerGateReceipt` fields. Its `evidence_sha256` binds `artifacts/evidence-manifest.json`, which binds every copied or fresh artifact using a sorted relative path and SHA-256. Missing, extra, changed, duplicated, unsafe, or symlink artifacts fail closed.
- The unified runner reserves `gvp-0` through `gvp-5`, gives only GVP-0 an executor, and does not accept legacy Gate 3 flags for GVP-0.
- Status auditing reads GVP evidence only from its own `evidence/gvp-N` namespace, validates the complete receipt bundle, never treats `CONDITIONAL_GO` as GO, never accepts a GVP receipt as signed admission, and never counts legacy G3-REVIEW evidence toward a GVP.
- Project release admission additionally depends on a complete record-specific, gate-by-platform Format Admission Ledger projection. A gate-wide GVP-0 receipt cannot promote an individual format.

## Current evidence

The real run root is ignored local evidence under:

`evidence/gvp-0/20260904T005436759Z-80377-c55e63ec8b103a4a1f8eff38`

Its receipt records:

- candidate version: `0.16.0+ffdcda3eea83527380996ac935605f1422e43d3b`;
- verdict: `NO_GO`;
- corpus SHA-256: `9fbb74fbdc045a199b0fbaa6b193835b2a6c13aa4dca3a51488a0ef3f1203b52`;
- Chunk Manifest set SHA-256: `2231bb81815d25c2c81665b3760272bae2a0f0dcfb751f909c710716fe8dd2f8`;
- evidence manifest SHA-256: `550ba0be6b8496d145e6c1df7d9f91786f02fbcb2498ca29aca5167d753a474a`;
- artifact bindings: 50, with no absolute artifact path.

The acceptance summary records eight forbidden runtime edges, zero moderate-or-higher reachable production vulnerabilities, 200,588 compressed bytes for base plus Office and all built chunks, Host Adapter pass, and malicious behavior pass. Those subordinate passes do not change the aggregate verdict.

## Status and immutable ledgers

- Task 3 `admission-decision.json` remains `NO_GO` with `forbidden_runtime_edges: 8`; SHA-256 `3218b137b6cf8efa8804edf8935c5f20e0be9488f654ff9117490a136e3a98da`.
- `patch-ledger.json` remains zero-patch at SHA-256 `7c13a791a8cf1c58263d5c4c3b84ba8a899c1042177c7b311c98bb5b99bc265f`.
- `format-admission-ledger.json` remains unchanged at SHA-256 `45dbac3e7160828f1221f318f7230bc703e7743d71b54b3227665160037d8c38`; all 89 records remain `RESEARCH_REQUIRED` with zero admission receipt references.
- `.candidate/source` remains clean.
- The status audit reports six GVP entries at `RESEARCH_REQUIRED`, two historical G3-REVIEW entries, and production implementation admission `NO_GO`.

## Verification

| Command | Exit | Result |
|---|---:|---|
| `node --test tests/gvp-0-gate.test.mjs` | 0 | 10/10 passed, including complete CLI receipt and exit-1 behavior |
| `node --test scripts/poc/evidence-run-init.test.mjs scripts/poc/solution-b-runners.test.mjs scripts/poc/validation-status-audit.test.mjs` | 0 | 31/31 passed |
| default `npm test` attempts | interrupted | existing Office closure waited indefinitely on external npm audit transport; no completed result was claimed |
| `NPM_CONFIG_OFFLINE=true npm test` | 1 | 97/98; one process-sampling timing assertion missed the short-lived `sleep` child under concurrent suite load |
| focused short-lived-descendant retry | 0 | 1/1 passed without changing implementation or timing thresholds |
| `NPM_CONFIG_OFFLINE=true node --test --test-concurrency=1 tests/*.test.mjs` | 0 | final deterministic full suite 98/98 passed |
| `./scripts/poc/run-gate.sh gvp-0 ...` | 1 | expected `GVP0_ACCEPTANCE_NO_GO`, schema-valid local receipt |
| `node scripts/poc/validation-status-audit.mjs --status docs/技术可行性/当前技术验证状态.json` | 0 | GVP=6 research_required=6 historical_g3_review=2 |
| `node scripts/check-spec-refs.mjs` | 0 | all rule anchors and matrix references valid |
| `git diff --check` | 0 | no whitespace errors |

This is a local macOS PoC receipt only. Windows evidence, GVP-1 through GVP-5, record-specific dual-platform receipts, signing, Registry admission, and production integration remain future work.
