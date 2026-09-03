# Task 3 Report: Frozen Core Supply-Chain and Chunk Admission

## Status

**WITHDRAWN:** the original `GO` below was invalid because it did not build the executable Office mount closure. Review Fix Round 1 establishes an honest candidate-admission `NO_GO`; see the appended section for the superseding evidence. Task 3 implementation and evidence generation are complete, but the frozen candidate is not admitted. The candidate remains commit `ffdcda3eea83527380996ac935605f1422e43d3b`, archive SHA-256 `1e0681afd02d7b6887bb373d5256eabcab69f8ac3015aa8372dd5e0754cc698d`, with `patches: []` and identical source/post-patch tree identities.

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

## Review Fix Round 1 — superseding result

### Outcome

Task execution is complete; candidate admission is **`NO_GO`**. The modern DOCX and PPTX closure is executable and its representative fixtures render real content, but the frozen Core implementation of `mountPptViewer` statically imports its PDF fallback. That reachable fallback carries host write/save/file-pick capabilities prohibited by the admission policy. The zero-patch rule forbids editing the frozen candidate to remove that reachability.

This result does not promote any format, GVP gate, Viewer Registry entry, manifest, or production release state. Both PoC manifests remain explicitly unsigned and non-loadable.

### Corrected TDD evidence

The following failures preceded their implementations:

- Chunk schema RED: `node --test tests/chunk-audit.test.mjs` produced `8` tests, `6` passed and `2` failed: an invalid Linux architecture enum and an incomplete `file_hashes` map were incorrectly admitted.
- Provenance RED: `node --test tests/evidence-bundle.test.mjs` failed with `ERR_MODULE_NOT_FOUND` for `evidence-bundle.mjs`.
- Office closure RED: `node --test tests/office-closure-smoke.test.mjs` first failed because the smoke module was absent; once present, it exposed the missing mount/parser exports and runtime dependencies. Building the real mount closure then exposed the reachable PDF policy failure instead of preserving the old GO.
- Literal-exception RED: the source-policy suite first passed `4/5`, then `5/6`, because quoted and regex dependency-error text containing `fetch` was being treated as a network call.
- Full-suite integration RED: `npm test` passed `41/42`; nested npm failed with `EALLOWSCRIPTS` because the outer npm process propagated `npm_config_allow_scripts=opencode-ai`. The build now removes only that inherited variable for the nested frozen-candidate commands.

Corrected GREEN:

| Command | Exit | Result |
|---|---:|---|
| `node --test tests/chunk-audit.test.mjs` | 0 | `8/8` passed: authoritative AJV 2020-12 schemas plus enum, signature, path, empty-descriptor, incomplete-hash, and extra-hash mutations |
| `node --test tests/evidence-bundle.test.mjs` | 0 | `2/2` passed: each required provenance input, source identity, toolchain field, and output rejects tampering; evidence index rejects missing, extra, and modified artifacts |
| `node --test tests/source-policy.test.mjs` | 0 | `6/6` passed: real call expressions remain forbidden while the exact quoted/regex diagnostic literals are narrowly excepted |
| `node --test tests/office-closure-smoke.test.mjs` | 0 | real deterministic DOCX/PPTX bytes parsed, mounted, and rendered non-placeholder content through the built bundle |
| `npm test` | 0 | `42/42` passed, `0` failed |

### Executable Office closure

The selected Office entry now includes actual runtime entry points rather than types/controllers/styles only:

- Word: `mountWordViewer`, its bundled `docx-preview` path, viewer metadata, preprocessing, normalization, pagination, controller, and styles.
- PPTX: `openPptxZip`, `parsePptx`, `parsePptxLegacy`, `parsePptxVscode`, `mountPptDocument`, `mountPptViewer`, `renderSlide`, and `renderSlideElement`.
- Exact direct runtime identities: `buffer@6.0.3`, `docx-preview@0.3.7`, and `jszip@3.10.1`; the lock and SBOM also contain their exact transitive closure.

The deterministic DOCX fixture is `1,624` bytes, SHA-256 `7d2ea45e5397ac32da8929559067040c928b37cd8823845b46a08b9e89e43b1e`; `mountWordViewer` reaches `ready` and the DOM contains `Universal Viewer DOCX Smoke`. The deterministic PPTX fixture is `2,448` bytes, SHA-256 `488ccfd0ba8df0be57d7640d27e38954f7369359bb46716084d69646d5506821`; modern parsing returns `ok`, one slide and one element, `mountPptViewer` returns `slides`, and both its mounted DOM and direct `renderSlide` contain `Universal Viewer PPTX Smoke`. `placeholder_content` is `false`.

Measured output:

| Chunk | Installed bytes | gzip bytes |
|---|---:|---:|
| `viewer-base` | 7,588 | 3,535 |
| `viewer-office` | 698,801 | 196,946 |
| Combined | 706,389 | 200,481 |

The actual closure contains `33` frozen-Core source modules. Runtime third-party modules are `base64-js`, `buffer`, `docx-preview`, `ieee754`, and `jszip`. The exact built-in command `npm sbom --package-lock-only --omit=dev --omit=optional --sbom-format cyclonedx` under npm `11.16.0` produced CycloneDX 1.5 with `17` runtime components. The PoC runtime lock is lockfile v3, SHA-256 `d03ef959af78bb3ed2348cf402a83ddc9d63463acb68370ff9c98246a6993f9f`.

Both live production audits are clean: the PoC runtime and original candidate `npm audit --omit=dev --json` reports each contain `0` info, low, moderate, high, critical, and total vulnerabilities. Raw audit JSON is preserved even before policy evaluation. The frozen candidate's full developer install still reports `1` moderate and `1` high dev-closure vulnerability; this is not substituted for either required production audit.

Obsidian is excluded by graph evidence (`host_not_imported`); DOMPurify and Mermaid each record `reachable: false`. WPS/LibreOffice/`soffice` and network/process paths are absent from the executable closure.

### Binding `NO_GO` evidence

`src/viewers/ppt/index.ts:21-25` statically imports `mountPdfViewer` from `../pdf/index.js`. Its `mountPdfFallback` is called from the public PPT mount flow at lines `420`, `435`, `463`, and `475`. The resulting graph includes `src/viewers/pdf/index.ts` and `src/viewers/pdf/editing.ts`.

The policy audit finds eight forbidden runtime references in `src/viewers/pdf/index.ts`, including:

- line `137`: optional services `save`, `writeback`, and `filePick`;
- lines `703`, `1955`, and `2102`: reachable writeback checks;
- line `2112`: `ctx.writeback!.write(data)`;
- line `2129`: `ctx.save!.saveFile(...)`;
- line `2147`: `ctx.filePick.pickFile(...)`.

Therefore `built-source-policy.json` and `admission-decision.json` report `forbidden_runtime_edges: 8` and `decision: NO_GO`. The Chunk audit itself is `GO` at `200,481` gzip bytes, and both production audits are clean, but neither can override the reachable write-capability rule.

### Manifest, provenance, and tracked evidence

`chunk-audit.mjs` now validates every `manifest_candidate` with AJV against the real `docs/contracts/v1/viewer-chunk-manifest.schema.json` (and referenced resource-handle schema), then requires an exact one-to-one match between owned output files and `file_hashes`. Safe relative paths and the unsigned/non-loadable envelope are enforced independently.

Build provenance SHA-256 is `a5e8c646a96b737753b4a79f41e08fae2493bb36aad6e0059f0e4a6d3c538a27`. Every manifest references this exact provenance. It binds the frozen commit/archive identity, exact Node `24.18.0`, npm `11.16.0`, git/platform/architecture, `rolldown@1.1.5`, exact SBOM command, source-lock bytes, actual zero-patch ledger bytes, PoC package-lock, sanitized SBOM, raw audit, reachable module graph, Office smoke, and all `24` output hashes. The actual patch-ledger hash is `7c13a791a8cf1c58263d5c4c3b84ba8a899c1042177c7b311c98bb5b99bc265f`.

The tracked immutable baseline is `scripts/poc/universal-viewer/baseline-evidence/`. Its content-addressed index binds `14` reviewable artifacts and has SHA-256 `1696e3ec6884b65da3a6432900875a9467f5a28646c5a046f6e093b8f962589d`. Two complete builds produced byte-identical baseline hashes (`diff` exit `0`, no output). The indexed artifact hashes are:

| Artifact | SHA-256 |
|---|---|
| `admission-decision.json` | `3218b137b6cf8efa8804edf8935c5f20e0be9488f654ff9117490a136e3a98da` |
| `build-provenance.json` | `a5e8c646a96b737753b4a79f41e08fae2493bb36aad6e0059f0e4a6d3c538a27` |
| `built-source-policy.json` | `9acdd9301d57bc435e0f917f45041946680fcf082b1282fbc7612b0a33034c41` |
| `candidate-npm-audit.raw.json` | `6c7cd94ccc096ab3e36d401d06349a4d9e9f2872c02680c67f918accd80dda8e` |
| `chunks.json` | `d5e26bff40478ea02aee63d65fee479d132a952c932a8dfc56f11c61bb302d6a` |
| `dependencies.json` | `e0e5233f02f06cad26af1eedf7b9b076925a1112a79122033422eb056a53848e` |
| base manifest | `463984d4d264151dc10d7418dc12e8a290ff7f5ba2edaa187b214251248dfb03` |
| office manifest | `61b62f547adf96fa5b7b1dd9c6b20b9b8a12f4992a613e484a89ff3a158cda94` |
| `module-graph.json` | `884a4933f22142cd752cd324a3942baacd4a5b3ae387447b579cd14067d18980` |
| `npm-audit.raw.json` | `c1103db1b24f40720b44abdd22591cd934f6e3f8c2824c39b0ee811c08c5cf93` |
| `office-smoke.json` | `137dd6396030a95a0d9bc8f27b73430597304baaa4cb2b2cfdb01cf9e9107033` |
| `README.md` | `298ffb7415532b04009c76fd238dbbeec7f8d956d734f42ecb63c7052928e5b9` |
| `source-policy.json` | `f9977b60f9e9d9723f959057d8e201facd60c2a0b1e77afd59395a5496093c80` |
| `source-sbom.cdx.json` | `69bc02cb9cee011d2fb7ba5849b46787bbe5da49eee2baafd87e57bbc0d73746` |

The baseline is sanitized: nondeterministic SBOM serial/timestamp fields, host paths, secrets, and timings are not committed. Later ignored runs may regenerate raw/local evidence under `.candidate`, `audit`, and `dist`.

### Full build and final self-review

The latest frozen upstream run completed successfully: `npm ci` exit `0`; `npm run typecheck` exit `0`; `npm test` exit `0` with `128` files and `1,469` tests; `npm run build` exit `0`. The build CLI intentionally exits `1` after emitting the structured `NO_GO` decision; this is the expected admission-policy outcome, not a build hang.

Files added in this fix are `evidence-bundle.mjs`, `office-closure-smoke.mjs`, their focused tests, and the tracked baseline evidence tree. `build-candidate.mjs`, `chunk-audit.mjs`, `chunk-plan.json`, source-policy configuration/audit/tests, and the PoC package lock/config are updated. `.candidate`, `audit`, and `dist` remain ignored. Recursive cleanup is restricted to directories carrying `.superwagie-viewer-poc-owned`; a pre-existing unmarked output was preserved outside the build path rather than deleted.

Self-review conclusion: the critical unusable-closure issue and all three important evidence/validation issues are addressed. The remaining concern is an intentional admission failure, not missing Task 3 implementation. Remediation requires a separately reviewed upstream Core architecture change that removes or isolates the PDF fallback/write-capable closure; it must not be disguised as an admission-time patch. Cross-platform packaging, hostile-file limits, visual fidelity, signatures, GVP-1 through GVP-5, and format promotion remain out of scope.
