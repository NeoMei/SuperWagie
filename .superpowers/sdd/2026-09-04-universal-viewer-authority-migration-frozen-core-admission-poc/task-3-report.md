# Task 3 Report: Frozen Core Supply-Chain and Chunk Admission

## Status

`GO` for this disposable Task 3 GVP-0 evidence slice only. This does not promote any format, GVP gate, Viewer Registry entry, manifest, or production release state. The candidate remains commit `ffdcda3eea83527380996ac935605f1422e43d3b`, archive SHA-256 `1e0681afd02d7b6887bb373d5256eabcab69f8ac3015aa8372dd5e0754cc698d`, with `patches: []` and identical source/post-patch tree identities.

Rules applied: R-VP-03, R-VP-04, R-VP-07, R-VP-10, R-VP-11; R-RI-06, R-RI-07, R-RI-10, R-RI-11; R-SE-03, R-SE-04, R-SE-12; R-RP-07, R-RP-09; R-QS-03, R-QS-05, R-QS-08.

## TDD evidence

### Initial RED

Command: `cd scripts/poc/universal-viewer && npm test`

- Exit: `1`.
- Existing tests: `21` passed.
- New suites: `3` failed at module resolution because `source-policy-audit.mjs`, `dependency-audit.mjs`, and `chunk-audit.mjs` did not exist.
- This was the intended failure: the tests could not pass without the new policy boundaries.

### Initial GREEN

Command: `cd scripts/poc/universal-viewer && npm test`

- Exit: `0`.
- Result: `34` tests passed, `0` failed.
- Covered forbidden host/process/shell imports, host/write/network identifiers and endpoints, exact URI exceptions, unreachable excluded source, non-exact dependency identities, GPL/AGPL/unknown decisions, moderate/high/critical vulnerabilities, file overlap/ownership, unsigned manifest loadability, and 20/50 MiB limits.

### Self-review mutation RED/GREEN

Mutation: `import('electron' as string)`.

- RED: focused source-policy suite reported `3` passed / `1` failed because the dynamic-import cast bypassed the original regex.
- GREEN: after extending the parser for TypeScript `as` casts, the focused suite passed `4/4`. A subsequent manifest-envelope mutation added one more test; the final full suite passes `35/35`.

## Candidate build and audit evidence

`build-candidate.mjs` first verifies the pristine acquisition and zero-patch ledger, then materializes a separate disposable developer cache from `git archive`. This avoids installing dependencies or emitting upstream `dist` into `.candidate/source`; the frozen source remains clean.

Fresh full build result:

| Command | Exit | Observed result |
|---|---:|---|
| `npm ci` | 0 | 144 packages installed in disposable cache |
| `npm run typecheck` | 0 | TypeScript no-emit check passed |
| `npm test` | 0 | 128 files, 1,469 tests passed |
| `npm run build` | 0 | TypeScript and upstream styles build passed |

The full developer install printed `2 vulnerabilities (1 moderate, 1 high)`. They belong to the developer dependency closure. The required production command `npm audit --omit=dev --json` returned zero info/low/moderate/high/critical findings; raw output is preserved locally as `audit/npm-audit.raw.json`.

Supply-chain results:

- Candidate lock: npm lockfile v3, SHA-256 `53cc7a9cebf0f3cff4de196f3b803141185f466404376bb7ae163326714b6f18`.
- Dependency identities audited: 187 exact lock entries, each with fixed resolved artifact and integrity; production install-script findings: zero.
- Built-in SBOM only: npm `11.16.0`, exact command `npm sbom --package-lock-only --omit=dev --omit=optional --sbom-format cyclonedx`; output is CycloneDX 1.5 with 3 components.
- License/NOTICE: upstream MIT `LICENSE` and `THIRD_PARTY_NOTICES.md` are copied into each measured chunk; GPL/AGPL/unknown are rejected absent an explicit decision. JSZip's dual `(MIT OR GPL-3.0-or-later)` identity is admitted only through the recorded MIT-option decision and is not present in the built runtime graph.
- Obsidian closure: adapter commit `1db3137806dc4047513f6abd2ec010030e5029a2` is excluded with `reason=host_not_imported`; DOMPurify advisory `GHSA-55q2-fjhq-7xh7` and all five required Mermaid advisories are recorded in the zero-patch ledger.

## Selected module and Chunk evidence

Only `viewer-base` and `viewer-office` are built. `viewer-media`, `viewer-data`, and `viewer-specialized` remain `planned_not_built` and are not counted as passed.

- Exact built source closure: 15 Core-owned modules.
- External imports: zero.
- Third-party runtime modules: zero.
- Forbidden host/write/network/process modules: zero.
- Obsidian, Electron, DOMPurify, Mermaid, PDF viewer/write-save, legacy DOC/PPT viewer, LibreOffice/`soffice`, Share, media, data, GIS, engineering, AI-model, and archive export paths: not reachable.
- The only literal exceptions are exact W3C XHTML/SVG namespace strings used for `createElementNS`; neither is a network call.

| Chunk | Installed bytes | gzip bytes | State |
|---|---:|---:|---|
| `viewer-base` | 7,588 | 3,533 | `poc_unsigned_not_loadable` |
| `viewer-office` | 58,890 | 17,618 | `poc_unsigned_not_loadable` |
| Combined | 66,478 | 21,151 | below 20 MiB and 50 MiB gates |

Each PoC evidence envelope carries an exact ViewerChunkManifest-shaped `manifest_candidate`; the envelope, not the schema candidate, adds `signature_state=poc_unsigned_not_loadable` and `production_loadable=false`. The required schema `signature` field contains a named reserved non-cryptographic sentinel, never a claimed production signature. `chunk-audit.mjs` checks the authoritative field set, rehashes files, recomputes installed/gzip measurements, checks ownership/overlap, and separately enforces the non-loadable envelope state.

## Files

- `scripts/poc/universal-viewer/patch-ledger.json`
- `scripts/poc/universal-viewer/chunk-plan.json`
- `scripts/poc/universal-viewer/source-policy-audit.mjs`
- `scripts/poc/universal-viewer/dependency-audit.mjs`
- `scripts/poc/universal-viewer/build-candidate.mjs`
- `scripts/poc/universal-viewer/chunk-audit.mjs`
- `scripts/poc/universal-viewer/fixtures/source-policy-forbidden.json`
- `scripts/poc/universal-viewer/fixtures/dependency-policy.json`
- `scripts/poc/universal-viewer/tests/source-policy.test.mjs`
- `scripts/poc/universal-viewer/tests/dependency-audit.test.mjs`
- `scripts/poc/universal-viewer/tests/chunk-audit.test.mjs`

Generated `.candidate`, `audit`, and `dist` remain ignored.

## Self-review and concerns

- The first in-place build attempt exposed Task 2 verifier incompatibility with npm-created `.bin` symlinks. The final implementation uses a separate disposable developer cache and removes it after evidence generation; `.candidate/source` is unchanged and clean.
- This is a macOS arm64 PoC measurement, not Windows evidence and not GVP-4 platform admission.
- The selected Office surface is intentionally narrow: dependency-injected DOCX preprocessing/controllers and tree-shaken PPTX parser/render exports. It is not proof of full DOCX/PPTX fidelity, sandbox termination, fonts, or malicious-file resistance.
- The manifests are deliberately unsigned and production Registry-ineligible. Signing, dual-platform packaging, GVP-1 through GVP-5, and format status promotion remain future work.
- No Frozen Core source patch or production remediation was needed because the final reachable graph contains no forbidden edge; any future selection that makes such an edge reachable must return `NO_GO` and enter separate review.
