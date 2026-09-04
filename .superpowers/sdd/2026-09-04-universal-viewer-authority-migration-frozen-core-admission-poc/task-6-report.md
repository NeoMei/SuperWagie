# Task 6 report — GVP-0 unified runner and status integration

## Decision

**Task 6 is fail-closed. The frozen candidate remains `NO_GO`; the latest real public run returned environment exit `2` because current npm registry audit evidence could not be obtained within 15 seconds. It did not emit or claim an acceptance receipt.**

The deterministic injected acceptance fixture proves that, when all required evidence is available, the current candidate produces a schema-valid `ViewerGateReceipt` with `verdict=NO_GO` and exit `1`. Task 3 still reports eight forbidden runtime edges. No signature, production-loadable Chunk Manifest, format/GVP/Registry admission, or release promotion is manufactured:

```json
{
  "scope": "disposable-admission-poc",
  "production_registry_admitted": false,
  "production_chunk_signed": false,
  "release_admission": "NO_GO",
  "remaining_gates": ["GVP-1", "GVP-2", "GVP-3", "GVP-4", "GVP-5"]
}
```

GVP-1 through GVP-5 remain registered, `RESEARCH_REQUIRED`, non-executable, and exit `2`. Rules applied: R-VP-01, R-VP-03, R-VP-04, R-VP-07, R-VP-10, R-VP-11; R-RI-06, R-RI-07, R-RI-10, R-RI-11; R-SE-03, R-SE-04, R-SE-12; R-RP-07, R-RP-09; R-QS-02, R-QS-08.

## Fix-round TDD evidence

The independent review produced four concrete RED groups:

- GVP focused tests were 10/15: a self-consistent one-artifact bundle and coherent corpus/viewer/version/platform/candidate/timestamp/GO rewrites were not tied to the authoritative fixture; fresh supply-chain evidence and output aliases were not enforced.
- Status tests were 16/19: one-artifact and minimal `CONDITIONAL_GO` receipts remained admissible, and 12 nonexistent ledger references could falsely complete a record.
- A further command-integrity RED showed a freshness attestation could replace `npm audit --omit=dev --json` with `npm audit --json`, rebind all hashes, and still validate.

GREEN is now 17/17 focused and 42/42 runner/status/ledger integration tests. The regression table covers one-artifact bundles; a coherently rebound legacy 50-artifact bundle; coherent 56-artifact identity, timestamp, summary, and verdict rewrites; newly disclosed vulnerability evidence; unavailable/stale evidence; exact probe commands; `..`, symlink, hardlink, source-tree, and `.git` output aliases; and nonexistent receipt references.

## Exact receipt and ledger contract

- `validateReceiptBundle` resolves the repository's authoritative source lock, acquired candidate, acceptance fixture, Task 3 evidence, chunk manifests, and provenance. It requires the exact 56 artifact roles for `GVP-0-CORE-001`, not merely an internally consistent list.
- Receipt, evidence manifest, run context, acquisition receipt, acceptance summary, corpus, candidate/version/commit, platform, timestamps, metrics, verdict, and 8-edge `NO_GO` conclusion must agree with those authorities.
- Every artifact is a safe relative path with a SHA-256 binding. Missing, extra, duplicate, changed, symlinked, stale, absolute-path-bearing, or wrong-role evidence fails closed.
- `projectFormatAdmissionState` reuses the strict `viewer-ledger-audit` receipt verifier. A reference counts only after safe path resolution, file existence, hash, schema, GO verdict, and exact record format/corpus/candidate/version/chunk/gate/platform binding all succeed. Twelve nonexistent references therefore produce zero complete records.
- Legacy G3-REVIEW evidence never counts toward a GVP, and a gate-wide GVP-0 receipt cannot promote a format-ledger record.

## Fresh supply chain and output isolation

- The production path runs bounded live `npm audit --omit=dev --json` probes for both the PoC and candidate locks, plus `npm sbom --package-lock-only --omit=dev --omit=optional --sbom-format cyclonedx`. Tests can inject deterministic executors; the CLI cannot.
- Offline mode, timeout, malformed/incomplete metadata, stale/future capture, dependency-policy failure, a new moderate-or-higher vulnerability, or SBOM/provenance mismatch blocks acceptance. Raw probe output and a command/hash/timestamp attestation are preserved before an acceptance rejection.
- Results and artifact directories are checked by canonical realpath and inode against candidate, fixture, source lock, patch ledger, locks, acceptance fixture, baseline evidence, and each other. Raw `..`, symlink parents/leaves, hardlink aliases, and `.git` destinations are rejected before execution.
- Outputs use exclusive atomic creation. Candidate identity and all authoritative input hashes are reverified after the final receipt validation; no write follows that final verification.

## Current real-run evidence

The latest public invocation created ignored diagnostic evidence at:

`evidence/gvp-0/20260904T013803163Z-54243-f9a52e59aa018e95104e25dd`

It returned `GVP0_LIVE_AUDIT_UNAVAILABLE` and exit `2` after the PoC production audit exceeded the 15-second bound. This is an environment result, not a `NO_GO` acceptance receipt. The complete deterministic fixture remains test-only proof of the current candidate's schema-valid `NO_GO`/exit-1 behavior.

## Status and immutable ledgers

- Task 3 `admission-decision.json` remains `NO_GO` with `forbidden_runtime_edges: 8`; SHA-256 `3218b137b6cf8efa8804edf8935c5f20e0be9488f654ff9117490a136e3a98da`.
- `patch-ledger.json` remains zero-patch at SHA-256 `7c13a791a8cf1c58263d5c4c3b84ba8a899c1042177c7b311c98bb5b99bc265f`.
- `format-admission-ledger.json` remains unchanged at SHA-256 `45dbac3e7160828f1221f318f7230bc703e7743d71b54b3227665160037d8c38`; all 89 records remain `RESEARCH_REQUIRED` with zero receipt references.
- `.candidate/source` remains clean. Status remains GVP=6, research_required=6, historical_g3_review=2, release `NO_GO`.

## Final verification

| Command | Exit | Result |
|---|---:|---|
| `node --test tests/gvp-0-gate.test.mjs` | 0 | 17/17 |
| runner/status/ledger integration set | 0 | 42/42 |
| full suite, offline, serial, candidate Vitest single-worker | 0 | 105/105 |
| default-concurrency Office closure diagnostic | 1 | frozen candidate's three heavy tests exceeded their existing 5-second limits; no handle leak |
| single-worker Office closure retry | 0 | 1/1, without extending a timeout |
| real `./scripts/poc/run-gate.sh gvp-0 ...` | 2 | honest live-registry timeout; no acceptance claim |
| validation status audit | 0 | GVP=6 research_required=6 historical_g3_review=2 |
| Viewer ledger audit | 0 | 89 records, 96 extensions |
| spec references / syntax / `git diff --check` | 0 | passed |

Windows, GVP-1 through GVP-5, record-specific dual-platform receipts, signing, Registry admission, and production integration remain unverified.
