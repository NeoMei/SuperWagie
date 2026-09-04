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

Fix round 2 added two P1 RED cases. A supply-chain executor renamed the checked run root and replaced it with a symlink to the candidate; the old path writer created four fresh artifacts inside the candidate. Separately, a complete 56-artifact bundle with an added `api_token: ghp_...` field remained valid after coherent hash rebinding. A public-runner RED also showed that the newly reserved empty result file caused the shell finalizer to print a JSON parser stack.

Fix round 3 reproduced three further P1 REDs: the shell finalizer followed a probe-swapped public run path after the Core's final verification and disclosed an absolute `ENOENT` stack; a coherently rebound `acceptance-summary.metrics.apiKey` ordinary value passed; and camel/snake/case secret assignments with ordinary values survived diagnostic sanitization.

Fix round 4 reproduced the remaining diagnostic-redaction P1: common assignments `token=ordinary-token-value`, `authToken=ordinary-auth-value`, `github_token=ordinary-github-value`, and full-width `ＴＯＫＥＮ=ordinary-fullwidth-value` survived while more specific credential keys were redacted. GREEN normalizes diagnostics with Unicode NFKC and recognizes sensitive assignment keys case-insensitively across camelCase, snake_case, kebab-case, dotted/env, colon/equal, quoted-value, and URL-query forms. Matching remains assignment-scoped, so safe prose such as “The token parser remained offline.” is preserved.

Fix round 5 reproduced the final P2: dependency assignments `tough-cookie: 4.1.4`, `tough-cookie=4.1.4`, and `cookie-parser: 1.4.7` were redacted because `cookie` matched any compound-key segment. GREEN treats only standalone `cookie`/`cookies` as sensitive on their own; authentication-context compounds such as `session_cookie`, `auth_cookie`, `access_cookie`, `refresh_cookie`, and `client_cookie` remain sensitive through their authentication segment. Ordinary dependency names are preserved without weakening token, auth, or Unicode-normalized coverage.

GREEN is now 23/23 focused and 44/44 runner/status/ledger integration tests. The regression table covers one-artifact bundles; a coherently rebound legacy 50-artifact bundle; coherent 56-artifact identity, timestamp, summary, verdict, top-level/nested-secret rewrites; newly disclosed vulnerability evidence; unavailable/stale evidence; exact probe commands; camel/snake/kebab/case subprocess redaction and package-name preservation; receipt-validation path/stack redaction; `..`, symlink, hardlink, source-tree, `.git`, Core-level and public-runner-level post-check rename/symlink output attacks; and nonexistent receipt references.

## Exact receipt and ledger contract

- `validateReceiptBundle` resolves the repository's authoritative source lock, acquired candidate, acceptance fixture, Task 3 evidence, chunk manifests, and provenance. It requires the exact 56 artifact roles for `GVP-0-CORE-001`, not merely an internally consistent list.
- Receipt, evidence manifest, run context, acquisition receipt, acceptance summary, corpus, candidate/version/commit, platform, timestamps, metrics, verdict, and 8-edge `NO_GO` conclusion must agree with those authorities.
- Every artifact is a safe relative path with a SHA-256 binding. Missing, extra, duplicate, changed, symlinked, stale, absolute-path-bearing, or wrong-role evidence fails closed.
- Immutable and upstream-complex artifact classes require their authoritative schema or bytes/hash. Every generated security-critical JSON class has a recursive schema with `additionalProperties: false`, including summary metrics, manifest bindings, freshness inputs/checks/probes, audit metadata, malicious-corpus process evidence, and run context. Every JSON value is recursively inspected after Unicode/case/separator-normalized secret-key matching; every text artifact is scanned for GitHub/OpenAI/Google/AWS tokens, Bearer credentials, private keys, and credential URLs before binding and during receipt validation.
- `projectFormatAdmissionState` reuses the strict `viewer-ledger-audit` receipt verifier. A reference counts only after safe path resolution, file existence, hash, schema, GO verdict, and exact record format/corpus/candidate/version/chunk/gate/platform binding all succeed. Twelve nonexistent references therefore produce zero complete records.
- Legacy G3-REVIEW evidence never counts toward a GVP, and a gate-wide GVP-0 receipt cannot promote a format-ledger record.

## Fresh supply chain and output isolation

- The production path runs bounded live `npm audit --omit=dev --json` probes for both the PoC and candidate locks, plus `npm sbom --package-lock-only --omit=dev --omit=optional --sbom-format cyclonedx`. Tests can inject deterministic executors; the CLI cannot.
- Offline mode, timeout, malformed/incomplete metadata, stale/future capture, dependency-policy failure, a new moderate-or-higher vulnerability, or SBOM/provenance mismatch blocks acceptance. Raw probe output and a command/hash/timestamp attestation are preserved before an acceptance rejection.
- Results and artifact directories are checked by canonical realpath and inode against candidate, fixture, source lock, patch ledger, locks, acceptance fixture, baseline evidence, and each other. Raw `..`, symlink parents/leaves, hardlink aliases, and `.git` destinations are rejected before execution.
- Before long probes, all 56 artifacts plus the evidence manifest and result are exclusively created with `O_NOFOLLOW|O_CREAT|O_EXCL`; their file descriptors and the inode identities of every directory/file are retained. Subsequent writes use only held descriptors. A probe-time run-root rename plus candidate symlink therefore writes only to the displaced owned files, detects the changed public identity, returns exit `2`, performs no path-based cleanup, and leaves the candidate hash unchanged with no fresh files.
- The public GVP-0 orchestrator also preclaims `command.txt`, `decision.md`, `stdout.log`, and `stderr.log` with non-following exclusive file descriptors, holds the initial manifest descriptor and every run-root inode, and never delegates its finalization to the generic path writer. On an unchanged root it performs those descriptor writes inside the Core callback before the final candidate/input verification; on a renamed/symlinked root it returns stable exit `2` without path-based writes, tails, or cleanup.
- Candidate identity and all authoritative input hashes are reverified after final receipt validation and the capability-owned public finalization; no evidence-path write follows that verification. Subprocess error text is bounded, Unicode-NFKC normalized, and strips token/auth/bearer/session/api/access/refresh/client/private/password/secret/credential/authorization assignments plus standalone cookie assignments and authentication-context cookie compounds across camelCase, snake_case, kebab-case, dotted/env, colon/equal, quoted-value, and URL-query forms even when values do not resemble known token formats. POSIX/Windows absolute paths are also stripped. Ordinary non-assignment prose containing “token” and package assignments such as `tough-cookie` or `cookie-parser` remain intact.

## Current real-run evidence

The latest public invocation created ignored diagnostic evidence at:

`evidence/gvp-0/20260904T024948641Z-69386-ef0b795dfb42eff270fbbb4a`

It returned `GVP0_LIVE_AUDIT_UNAVAILABLE` and exit `2` after the PoC production audit exceeded the 15-second bound. The reserved result remained empty, the draft decision is `BLOCKED_ENVIRONMENT`, and no parser stack or acceptance claim was emitted. The complete deterministic fixture remains test-only proof of the current candidate's schema-valid `NO_GO`/exit-1 behavior.

## Status and immutable ledgers

- Task 3 `admission-decision.json` remains `NO_GO` with `forbidden_runtime_edges: 8`; SHA-256 `3218b137b6cf8efa8804edf8935c5f20e0be9488f654ff9117490a136e3a98da`.
- `patch-ledger.json` remains zero-patch at SHA-256 `7c13a791a8cf1c58263d5c4c3b84ba8a899c1042177c7b311c98bb5b99bc265f`.
- `format-admission-ledger.json` remains unchanged at SHA-256 `45dbac3e7160828f1221f318f7230bc703e7743d71b54b3227665160037d8c38`; all 89 records remain `RESEARCH_REQUIRED` with zero receipt references.
- `.candidate/source` remains clean. All six GVP technical states remain `RESEARCH_REQUIRED`; the execution summary classifies the old incomplete GVP-0 receipt as `invalid_evidence` and GVP-1–5 as `research_required`. Historical G3-REVIEW evidence remains excluded and release remains `NO_GO`.

## Final verification

| Command | Exit | Result |
|---|---:|---|
| `node --test tests/gvp-0-gate.test.mjs` | 0 | 23/23 |
| runner/status/ledger integration set | 0 | 44/44 |
| full suite with npm offline, Node concurrency 1, Vitest min/max workers 1 | 0 | 111/111 in 65.0 s (round 5 final); an earlier round 5 run was 111/111 in 69.1 s; round 4 was 110/110 in 66.8 s and 64.8 s |
| no-load default-Vitest-worker comparison, Node concurrency 1 | 0 | 108/108 in 45.3 s |
| earlier loaded-host default-worker diagnostic | 1 | 103/104 outer tests; frozen candidate had three GGUF/audio 5-second timeouts |
| real `./scripts/poc/run-gate.sh gvp-0 ...` | 2 | honest live-registry timeout; no acceptance claim |
| validation status audit | 0 | production `NO_GO`; GVP technical state 6× `RESEARCH_REQUIRED`; execution invalid=1, research=5; legacy G3-REVIEW excluded |
| Viewer ledger audit | 0 | 89 records, 96 extensions |
| spec references / syntax / `git diff --check` | 0 | passed |

Windows, GVP-1 through GVP-5, record-specific dual-platform receipts, signing, Registry admission, and production integration remain unverified.

## Final whole-branch review fix — public argument boundary

The public GVP-0 runner now requires exactly one each of `--repo-root`, `--platform`, `--fixture`, and `--candidate-root`, rejects unknown/duplicate/missing/mis-shaped values before any path operation, and keeps evidence initialization inside the sanitized route boundary. Direct CLI regressions cover all argument classes plus initialization failure and require exit `2` with no local path, stack, secret, or argument-time evidence directory. The runner/status integration set now passes `48/48`.

A fresh exact macOS public invocation produced ignored run `20260904T071921526Z-95987-bb1df33cff794d0df31ff9b4`, exit `2`, `GVP0_LIVE_AUDIT_UNAVAILABLE`, and no receipt. It was not promoted. Candidate `NO_GO / 8`, zero-patch status, all six research-only GVP technical states, and 89 research-only formats are unchanged.
