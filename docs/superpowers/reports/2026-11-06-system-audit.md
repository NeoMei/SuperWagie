# SuperWagie system audit

The audit is complete at its recorded scope. All 47 accepted findings are closed, comprising 34 product categories and 13 validation categories. The final actual UI run passes 29 checks, and the packaged macOS ARM64 startup passes. The final evidence review found no remaining actionable issue within the reviewed changes.

[SuperWagie v2.7.63](https://github.com/NeoMei/SuperWagie/releases/tag/v2.7.63) is published on GitHub with 11 verified assets. The application and tag identify commit `d7bdd70313a47468f76d373e4382910c645ab072`. It integrates audit checkpoint `7b9a8005f` and latest main `1d73bb005`. Subsequent report and website-metadata commits do not change the packaged application. The website deployment is still incomplete because SSH authentication failed; its prepared pages must not be described as published.

`A` denotes `.superpowers/sdd/2026-11-06-system-audit`. `R` denotes `A/release-2763`. The detailed ledger is `A/findings.json`. Earlier failure and interrupted-run receipts remain unchanged. This report supersedes stale status statements in earlier audit drafts and continuation checkpoints.

## The 3 requested audits

| Request | Result | Evidence boundary |
| --- | --- | --- |
| Reconcile tasks and finish gaps | The original 8 requirements remain mapped. Template allocation/symlink handling and shipped SuperVideo diagnostic/dependency gaps are repaired. All accepted task findings close. | Website deployment remains a separate authorized release action. |
| Repeat code review and repair bugs | 34 product categories have scoped repairs and independent review. The final integration review preserves both the audited changes and newer main changes. | No claim that an arbitrary future workflow or document is defect-free. |
| Exercise backend, frontend and UI | Package, API, component-browser, actual combined UI and native startup evidence pass within the scopes recorded here. VAL-11 closes after final receipt, asset, screenshot and cleanup readback. | Physical platform and external-service limits remain explicit. |

Repeated runs and corrected fixtures are not counted as new product fixes. `A/final-release-ui-evidence-review.md` and `A/final-release-ui-evidence-readback.json` record the final independent evidence verdict. `A/release-2.7.63-integration-independent-review.md` records the integrated source review.

## Original requirements and preservation

| Requirement | Current evidence | Boundary |
| --- | --- | --- |
| Packaged runtime configuration | Authorized top-frame bridge, token-free assets, 24-check generated-native acceptance and actual packaged ARM64 unlock-screen startup with production IPC. | The generated native run used `isPackaged=false`. The separate packaged smoke disables managed OpenCode and stops at runtime unlock. |
| Sessions, managed Chat and questions | Actual create/send/Stop/reload, A/B/A streaming, completion, active-turn reload, form reply and submission retry pass in final r14. CA-27 and CA-28 preserve explicit navigation against delayed startup/router work. | Owned local provider and identity fixtures. No real external provider or model-selected form-tool claim. |
| Large desktop attachments | Bounded local path/size notes, restoration and HAR/notebook sanitization retain request-shape tests. Actual small attachment failure/retry and exact Unicode bytes pass. | Small attachments do not establish native large-file acceptance. |
| Chinese terminal composition | Controlled browser/WASM composition and terminal lifecycle regressions remain accepted. | Physical IME, clipboard and PTY delivery were not observed. |
| Idle work and freshness | Session refresh, deletion authority, terminal refresh and catalog ownership tests pass. The original frozen workload pair remains the performance evidence. | No new performance improvement is claimed; approved caret deferral remains. |
| Shared and native shortcuts | Electron/VS Code suites and retained scoped IPC/helper evidence pass. | Physical accelerator/leader dispatch remains unverified. |
| Omni Office preview | Omni 0.22.0 and Word peer 0.3.7; six-format routing, bounded reads, cancellation, retry and resolved themes. Component DOCX/XLSX/PPTX/BIFF8 XLS evidence and actual FilesView DOCX/XLS pass. | Full-app arbitrary document fidelity, extra Office variants and native external-app controls remain outside the selected run. |
| Shipped skills, plugins and MCP | Approved November 5 inventory retains 165 catalog entries, 238 components and 74 skill paths. Template/video repairs, MCP component checks and actual disabled-MCP declaring-file CRUD pass. | No new latest-version sweep, every-integration clean-install or real OAuth acceptance claim. |

Omni Viewer remains the Office solution. LibreOffice is not integrated. Resolved themes preserve authored document colors. Hy memory and source retrieval, UniHub, product help, 6 Benma hints, updater feedback and EN/zh-CN remain preserved by their owning checks. OpenCode stays at 2.2.5 and Electron at 44.9.3.

## Current validation

CA-28 reproduced a delayed router continuation closing newer Settings, restoring an older Settings page and writing an older session ID into the URL. The unchanged hook produced 1 passing control and 3 expected failures. The repair applies Settings and initial URL normalization synchronously. Directory-dependent links retain authoritative resolution and cancel after newer intent or unmount. Final focused evidence passes 10 tests and 26 assertions with independent review.

| Evidence | Accepted result and exact scope |
| --- | --- |
| Integrated source gate and customizations | `A/release-validation-r10` passes type, lint, Knip and anti-slop, plus 28 Bun and 29 Node customization cases. The later website-metadata gate `A/release-validation-r11/gate` passes in 19.653 seconds with no new findings or owned survivors. |
| UI suite | 1,182 of 1,184 files pass in the integrated package invocation. Its 2 unchanged account browser tests pass separately with the reviewed scratch Chrome sandbox adapter. The original package invocation remains failed; accepted coverage spans 2 invocations. |
| Other package suites | SDK 26 files, VS Code 74 files and Electron 79 files pass at their unchanged recorded inputs. Scripts cover 33 files across 2 invocations. |
| Web suite and merged backend | Accepted deduplicated baseline totals 10,775 passes and 138 skips across 631 files. The original full invocation remains failed. A current 9-file merged help/account/model-config run passes 402 tests. |
| Current renderer builds | VS Code, Electron-staged web assets and mobile assets pass. `A/release-2763-built-identities.json` records source manifest `d4bc3d44d36e506a4963fe563a0a1b894f355be35931d13b66959c6786f66889` and artifact manifest `d73d33318d265b44083b13aaf8459465668fb595b0977e7a8a0d8d93931c5fc3`. |
| Strict offline API | 11 actual application/backend checks pass with independent review in `A/final-api-l3-review.md`. |
| Office, MCP and updater components | Office fixtures, 25 MCP snapshots and 22 updater records pass. Controlled transports do not establish remote-provider or installer acceptance. |
| Generated native runtime | 24 scoped checks pass, including sender authorization and actual production cookie flush with same-profile restart. `A/final-native-r4-review.md` records its limits. |
| Final actual combined UI | `A/functional-live-r14/runs/attempt-Y5ItGP/receipt.json` passes 29 checks in 79.279 seconds. All 7,784 inputs remain unchanged, and 279 served assets independently match the build inventory and disk. No browser errors, unexpected egress, owned process survivors or listeners remain. |
| Packaged ARM64 startup | `R/packaged-smoke-VxB4DV/receipt.json` passes actual custom-scheme React mount, native IPC version 2.7.63, health 200/version 2.7.63, local origin and anonymous API 401. Its screenshot shows the runtime unlock screen. No renderer exception or owned survivor remains. |

The final UI sequence includes Light/Dark persistence across reload, help browse/search/no-results recovery, file collision/create/save, FilesView BIFF8 XLS and DOCX, raw-document isolation, composer retry and forms. Settings passes both locales at 1440, 768 and 360 pixels, including picker reachability, nested Escape, dialog Escape and focus returning to the active composer. The 360-pixel desktop layout retains internal scrolling and clips long controls. It does not establish a physical mobile experience or every control's narrow-layout usability.

The matrix retains accepted lower-level substitutions for plugin CRUD, generic settings failure/order, preview grants/proxy abort, cross-runtime/project ownership, additional Office variants and model-selected forms. It does not label all 38 proposed cases as full-app passes. The 138 skipped cases remain 133 opt-in Docker cases and 5 conditional cases.

The original r11/r12/r13 failures retain their partial results. Later scratch-only corrections fix file-editor scope, Office host selection and the expected composer focus on Settings close. Two packaged smoke failures used incorrect health-field expectations. These are validation repairs. PID/start and port readback preceded removal of the final and diagnostic owned profiles, including the interrupted external project. Receipts, logs and screenshots remain unchanged.

## Release evidence and remaining deployment

GitHub publication is verified in `R/published-verification.json`. All 11 remote asset sizes and SHA-256 digests match local files. Public `latest.json`, `latest.yml`, `latest-x64.yml` and `SHA256SUMS` bytes match the prepared release. The default artifacts are macOS ARM64 and Windows x64; no Intel Mac or Windows ARM64 release was added.

The macOS package resource verifier checks the current app/web version, architecture, native/preload hashes and 12,913 resource entries. Windows CI run `42201055590` succeeds for the exact application commit; its installer is version 2.7.63, blockmap coverage matches its 479,159,660 bytes, and the 7,927-entry resource manifest retains the approved runtime identities. No physical Windows installation or UI run was performed.

The website is prepared locally and its 32-page build and 21 tests pass, as recorded by the release coordinator. SSH authentication remains unavailable. Public readback of 3 website pages still reports 2.7.62 in `R/public-readback/site-before.json`, so website deployment and updated website/download-mirror readback remain incomplete. GitHub release/feed success does not establish website publication.

Physical Windows/macOS installer replacement, native N-to-N+1 update, physical mobile, installed VS Code, physical IME/shortcuts, real OAuth/provider accounts and paid workflows remain unexecuted. No new audit or product-source work remains within the accepted scope; the remaining authorized action is website deployment and public readback after SSH access is restored.
