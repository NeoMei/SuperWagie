# Task 7 Report — Publish the PoC Finding Without Promotion

## Status

Task 7 documentation and receipt-derived status projection are complete. Frozen Core remains `NO_GO`; GVP-0 macOS is `BLOCKED_ENVIRONMENT` without a receipt; Windows is missing; GVP-1–5 and all 89 format records remain `RESEARCH_REQUIRED`; production and release remain `NO_GO`.

Plan Completion Definition items 4 and 6 are unmet: there are eight reachable forbidden runtime references, and the public GVP-0 run produced no receipt. The recommended next slice is a revised Frozen Core remediation plan that removes or isolates the PPT-to-PDF fallback/write closure before rerun, not Viewer Foundation.

## Specification ruling

Task 7 Step 2 explicitly requires a small audited status-update mode. The task controller authorized minimal changes to `scripts/poc/validation-status-audit.mjs` and its tests although the brief's Files list omitted them. Reviewer round 1 clarified that the mode must be platform-parametric for exact `macos-15-arm64`↔`darwin/arm64` and `windows-11-x64`↔`win32/x64` identities, and must consume only repository-tracked reviewed bundles. It does not alter a GVP technical state, format ledger record, production admission, or release admission.

The cost of omitting this implementation would be a hand-copied status or an inability to represent a reviewed environment observation. The cost of implementing it incorrectly is higher: an empty `results.json`, arbitrary/ignored/untracked directory, copied decision, wrong platform identity, forged index/artifact hash, or malformed unrelated status fixture could masquerade as evidence or survive an update. Regression tests therefore reject all of those cases, validate the complete status projection before any write, and require exact tracked artifact binding. No self-reported duration is treated as proof of a real wall clock.

## Repository-reviewed observation and report

- Main report: `docs/技术可行性/Universal-Viewer-Frozen-Core-准入报告.md`.
- Exact current observation: `20260904T035944401Z-76821-7c4310d8b16abc8f39a59241`, exit `2`, `GVP0_LIVE_AUDIT_UNAVAILABLE`; reviewed bundle `fixtures/gvp-0/GVP-0-CORE-001/environment-attempts/20260904T035944401Z-76821-7c4310d8b16abc8f39a59241/`, index SHA-256 `34863bd531a7d6c081f4b80f4222634b5687d2ae9be3d473e1f758d6ac716c49`.
- The run's `results.json`, evidence manifest, and acceptance summary are empty; status receipt is `null`.
- Status updater verifies the tracked index, exact gate, named fixture, platform/OS/arch, run id, environment/toolchain, command, reason, draft decision, empty reserved files, and nine artifact SHA-256 bindings. The status checker recomputes the newest reviewed per-platform observations and requires exact equality. Ignored runner output requires an explicit sanitize/copy/index/review step and never enters status automatically.
- Report language is intentionally narrow: under recorded limits, the pinned candidate parsed the named PoC DOCX/PPTX fixtures. It does not claim DOCX/PPTX support.
- Windows handoff now contains the exact archive/cache preparation, public command, evidence structure, 56-role receipt condition, CIM sampling command, reviewed-bundle return flow, and callable generic `--environment-attempt-bundle` update command. The environment-attempt path handles only exit `2`; a valid receipt remains under the strict receipt validator. Windows GVP-0 cannot satisfy later gates.

## Fresh verification

- `node scripts/check-spec-refs.mjs`: pass; 16 rules, 11 aliases, 162 matrix rows, 157 referenced.
- authority/ledger/history audits: pass; `current=29 historical=4`, `records=89 extensions=96`, history markers `4`.
- Contract Foundation: `npm ci` audited 7 packages with zero vulnerabilities; `npm test` 355/355.
- Universal Viewer reviewer-round-1 fresh offline `npm ci` audited 90 packages and reported zero vulnerabilities. This developer-graph audit is not substituted for either production audit or a GVP-0 receipt.
- Final Universal Viewer full suite with npm offline, Node concurrency 1 and Vitest min/max workers 1: 111/111 in 62.333 seconds.
- Evidence runner/status integration: 47/47 after reviewer round 2.
- Status file focused suite: 32/32 after reviewer round 2; authority focused suite: 7/7.
- Public GVP-0 fresh raw run `20260904T060725371Z-49812-bcf4d3eb7fa3e4b8ec126012`: exit `2`, `GVP0_LIVE_AUDIT_UNAVAILABLE`, no receipt. It remains ignored/unreviewed runner output and was deliberately not auto-promoted; current status stays bound to the separate reviewed bundle listed above.

The first attempted deterministic UV command used `NODE_OPTIONS=--test-concurrency=1`; Node rejected that unsupported `NODE_OPTIONS` flag with exit 9 before loading tests. This was a command error, not a product failure. It was corrected to the direct Node CLI option `node --test --test-concurrency=1` while keeping npm offline and Vitest min/max workers at 1; the fresh full run then passed 111/111.

Reviewer round 1 corrected the earlier status-integrity design. RED was observed as 5/29 failures in the status suite (ignored evidence was accepted; reviewed macOS/Windows bundles and the generic CLI were unsupported; malformed unrelated fixture was not rejected before write) plus 1/7 authority failure for Windows WPS visual-truth wording. A second RED proved that a reviewed-looking but untracked bundle was still accepted. GREEN moved the sanitized nine-artifact observation into a tracked, content-indexed fixture, removed elapsed-time authenticity claims, added exact dual-platform identity and clean-checkout-style synthetic Windows coverage, and made full-status validation fail before writing. The focused validation/authority run is now 37/37; the integrated evidence run is 45/45.

Reviewer round 2 found one remaining fail-open: the inventory mapped invalid candidates to `null` and filtered them, so a valid older bundle could remain current when a lexically newer tracked bundle was corrupt. The exact RED used a valid old bundle plus tracked `20990101T000000000Z-9-deadbeefdeadbeef` whose command no longer matched its indexed hash; the audit threw no exception and fell back to the old bundle. A second RED showed a tracked direct-child symlink was also ignored. GREEN now inventories candidates from the Git index and validates every tracked direct child; invalid type/name/index/hash/schema/identity, symlink and nested aliases hard-fail with `INVALID_TRACKED_GVP0_ENVIRONMENT_ATTEMPT`, before any status write. Ordinary root README/non-directory documentation remains outside the candidate set. No superseded marker exists, so no tracked bundle is silently exempted.

Round 2 proportionate fresh verification passed status 32/32, status+authority 39/39, evidence runner/status integration 47/47, spec references, authority/ledger/history audits, status reconciliation, and diff whitespace checks. A valid current update reproduced status byte-for-byte at SHA-256 `62a198467a3567a6ec68664444ba225272ccc269f0ab936646678f4d4cb565ab`. Contract/Universal Viewer source and dependencies were not touched in round 2; the immediately preceding fresh 355/355 and 111/111 runs above remain the applicable full-suite evidence.

## Self-review boundary

- Candidate admission artifact remains `NO_GO / forbidden_runtime_edges=8`.
- Format ledger SHA-256 remains `45dbac3e7160828f1221f318f7230bc703e7743d71b54b3227665160037d8c38`; all 89 records remain research-only.
- Frozen source is pristine at commit `ffdcda3eea83527380996ac935605f1422e43d3b`, Git tree `37ed0235fb0da0124d51e5815def4f832b3724d2`.
- Viewer authority remains unique. No LibreOffice/WPS/WpsComposer Viewer fallback was added. WpsComposer generation/formatting and optional final target-application smoke remain separate and intact.
- No push, publication, release, production implementation, or Viewer Foundation work was performed.

The required placeholder scan reported no Chinese placeholder token. Its `...` pattern matched only ECMAScript rest/spread syntax in executable JavaScript and tests, such as `{ ...value }`, `[...set]`, and rest parameters. These are language operators covered by the 111/111 suite, not omitted values, ellipses, sentinels, or incomplete implementations; no machine-readable JSON placeholder matched.
