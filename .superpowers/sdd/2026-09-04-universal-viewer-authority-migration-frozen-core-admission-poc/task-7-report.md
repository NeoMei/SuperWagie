# Task 7 Report — Publish the PoC Finding Without Promotion

## Status

Task 7 documentation and receipt-derived status projection are complete. Frozen Core remains `NO_GO`; GVP-0 macOS is `BLOCKED_ENVIRONMENT` without a receipt; Windows is missing; GVP-1–5 and all 89 format records remain `RESEARCH_REQUIRED`; production and release remain `NO_GO`.

Plan Completion Definition items 4 and 6 are unmet: there are eight reachable forbidden runtime references, and the public GVP-0 run produced no receipt. The recommended next slice is a revised Frozen Core remediation plan that removes or isolates the PPT-to-PDF fallback/write closure before rerun, not Viewer Foundation.

## Specification ruling

Task 7 Step 2 explicitly requires a small audited status-update mode. The task controller authorized minimal changes to `scripts/poc/validation-status-audit.mjs` and its tests although the brief's Files list omitted them. The implementation is restricted to validating the exact current GVP-0 macOS exit-2 environment attempt and projecting it into status. It does not alter a GVP technical state, format ledger record, production admission, or release admission.

The cost of omitting this implementation would be a hand-copied status or an inability to represent a real environment attempt. The cost of implementing it incorrectly is higher: an empty `results.json`, arbitrary environment directory, copied decision, wrong identity, or forged hash could masquerade as a receipt/status promotion. Regression tests therefore reject all of those cases and require exact artifact binding.

## Published evidence

- Main report: `docs/技术可行性/Universal-Viewer-Frozen-Core-准入报告.md`.
- Exact current run: `20260904T035944401Z-76821-7c4310d8b16abc8f39a59241`, exit `2`, `GVP0_LIVE_AUDIT_UNAVAILABLE`.
- The run's `results.json`, evidence manifest, and acceptance summary are empty; status receipt is `null`.
- Status updater verifies exact gate, named fixture, platform, run id, environment/toolchain, command, reason, draft decision, empty reserved files, and nine artifact SHA-256 bindings. The status checker recomputes the newest verified attempt and requires exact equality.
- Report language is intentionally narrow: under recorded limits, the pinned candidate parsed the named PoC DOCX/PPTX fixtures. It does not claim DOCX/PPTX support.
- Windows handoff now contains the exact archive/cache preparation, public command, evidence structure, 56-role receipt condition, CIM sampling command, and status updater command. It says explicitly that Windows GVP-0 cannot satisfy later gates.

## Fresh verification

- `node scripts/check-spec-refs.mjs`: pass; 16 rules, 11 aliases, 162 matrix rows, 157 referenced.
- authority/ledger/history audits: pass; `current=29 historical=4`, `records=89 extensions=96`, history markers `4`.
- Contract Foundation: `npm ci` audited 7 packages with zero vulnerabilities; `npm test` 355/355.
- Universal Viewer: `npm ci` audited 90 packages and reported one moderate issue in the developer graph. This is not substituted for either production audit.
- Final Universal Viewer full suite with npm offline, Node concurrency 1 and Vitest min/max workers 1: 111/111 in 63.127 seconds.
- Evidence runner/status integration: 39/39.
- Status file focused suite: 24/24.
- Public GVP-0: honest exit 2 environment result; no receipt.

The first attempted deterministic UV command used `NODE_OPTIONS=--test-concurrency=1`; Node rejected that unsupported `NODE_OPTIONS` flag with exit 9 before loading tests. This was a command error, not a product failure. It was corrected to the direct Node CLI option `node --test --test-concurrency=1` while keeping npm offline and Vitest min/max workers at 1; the fresh full run then passed 111/111.

That final UV run exposed one status-integrity defect before commit: an injected public-runner regression test left an otherwise well-shaped exit-2 directory under the real `evidence/gvp-0` root and initially became the newest attempt. It completed in 182 ms, so it could not have exhausted the real 15-second live-audit contract. The verifier now requires an elapsed duration of at least 15,000 ms in addition to exact identity/reason/hash checks, and the attack table includes the fast synthetic form. Focused 24/24 and integrated 39/39 reruns passed; the status projection returned to the genuine 15.158-second run `20260904T035944401Z-76821-7c4310d8b16abc8f39a59241`.

## Self-review boundary

- Candidate admission artifact remains `NO_GO / forbidden_runtime_edges=8`.
- Format ledger SHA-256 remains `45dbac3e7160828f1221f318f7230bc703e7743d71b54b3227665160037d8c38`; all 89 records remain research-only.
- Frozen source is pristine at commit `ffdcda3eea83527380996ac935605f1422e43d3b`, Git tree `37ed0235fb0da0124d51e5815def4f832b3724d2`.
- Viewer authority remains unique. No LibreOffice/WPS/WpsComposer Viewer fallback was added. WpsComposer generation/formatting and optional final target-application smoke remain separate and intact.
- No push, publication, release, production implementation, or Viewer Foundation work was performed.

The required placeholder scan reported no Chinese placeholder token. Its `...` pattern matched only ECMAScript rest/spread syntax in executable JavaScript and tests, such as `{ ...value }`, `[...set]`, and rest parameters. These are language operators covered by the 111/111 suite, not omitted values, ellipses, sentinels, or incomplete implementations; no machine-readable JSON placeholder matched.
