# SuperWagie release acceptance record

The [release checklist](RELEASE_CHECKLIST.md) is suspended. This template is
optional reference and is not required for release while suspension remains in
effect. If used voluntarily, copy it to a sibling
`<version>-<candidate>-acceptance.md` file so relative links remain valid.
Empty results mean `NOT_RUN`.

## Candidate identity

| Field | Value |
| --- | --- |
| Release version and candidate ID | |
| Checklist revision | Standard 1.0, enforcement suspended 2026-10-27 Asia/Shanghai |
| State | CANDIDATE |
| Source revision and baseline revision | |
| Dependency lock SHA-256 | |
| Build hosts and toolchain versions | |
| Previous stable version | |
| OS versions and architectures supported | |
| Changed features, contracts and regressions | |
| Critical service/configuration/catalog/price revisions | |
| Third-party inventory or SBOM reference and digest | |
| Upstream/security review time, reviewer and report | |
| Enabled commercial capabilities | |
| Coordinator, reviewer and recovery owner | |
| Operational readiness record and unresolved prerequisites | |
| Native update runbook revision and source-version/channel routes | |
| Windows bootstrap scope/claims and maintainer approval, if applicable | |
| Financial contract revision and authoritative readback procedure | |
| Planned promotion time and time zone | |
| Observation end and 24-hour review owner/time | |
| Dedicated acceptance account reference and cost cap | |
| Evidence directory and retention/access policy | |

Keep credentials, access-bearing URLs and customer content out of this record. Use sanitized account and transaction references.

## Readiness and execution scope

Apply [the checklist's cadence and reuse rules](RELEASE_CHECKLIST.md#execution-order-and-cadence). The first operational release completes every applicable baseline. On later releases, link the readiness result and record changed/expired rows. A required missing capability remains BLOCKED.

| Readiness area | Owner | Status | Original evidence/date | Triggered change or expiry | Next action/date |
| --- | --- | --- | --- | --- | --- |
| Supported OS, test hosts/accounts and capability matrix | | NOT_RUN | | | |
| Native candidate/public update and Windows migration paths | | NOT_RUN | | | |
| Approved trust policy and actual updater validation | | NOT_RUN | | | |
| Financial rules, settlement deadline and reconciliation access | | NOT_RUN | | | |
| Component inventory and initial integration baseline | | NOT_RUN | | | |
| Metric/probe sources and rehearsed containment/recovery | | NOT_RUN | | | |

| Execution layer | Applicable check/subcase IDs | Method/fixture or baseline link | Owner | Planned time/cost | Actual time/cost and blockers |
| --- | --- | --- | --- | --- | --- |
| Every-release core | | | | | |
| Change-triggered additions | | | | | |
| Due periodic reviews | | | | | |
| Initial/invalidated readiness | | | | | |

## Baseline reuse decisions

| Check/subcases and target | Original PASS evidence/date | Source/component/runtime/service/config identities | Next review date | Unchanged-impact decision and reviewer | Reuse eligible |
| --- | --- | --- | --- | --- | --- |
| | | | | | |

Fresh candidate artifact, installed runtime selection, public readback and enabled financial smoke results cannot be replaced by historical evidence. A missing date, changed relevant identity or new applicable advisory prevents reuse. Record current advisory report time and scope even when the component version did not change.

## Artifact inventory

| Platform and OS | Source revision | Filename | Bytes | SHA-256 | Embedded runtime/resource versions | Signature and notarization evidence | Installed-client evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| macOS arm64 | | | | | | | |
| macOS arm64 ZIP | | | | | | | |
| Windows x64 NSIS | | | | | | | |

Inventory checksum files and feeds as well. For Windows x64, retain the current installer's base64 SHA-512 from `latest-x64.yml` and independently verify the fixed legacy `latest.yml` bytes and historical URL. Record exact public URLs and downloaded digests during P03. Add a row per additional delivered target.

## Check results

Use one row per applicable subcase, target and profile/environment. Expand each parent ID below before execution using the selected scope. Record method/command or runbook step, fixed input, expected result and actual result. For each PASS, state NEW or REUSED evidence mode and link the observation or eligible baseline decision. Keep unrelated subcases NOT_RUN until selected/executed or covered by an applicability decision.

| Check ID | Platform, OS and environment | Status | Expected and actual result | Evidence and time | Executor and reviewer |
| --- | --- | --- | --- | --- | --- |
| T01 | | NOT_RUN | | | |
| T02 | | NOT_RUN | | | |
| T03 | | NOT_RUN | | | |
| T04 | | NOT_RUN | | | |
| T05 | | NOT_RUN | | | |
| T06 | | NOT_RUN | | | |
| T07 | | NOT_RUN | | | |
| T08 | | NOT_RUN | | | |
| R01 | | NOT_RUN | | | |
| R02 | | NOT_RUN | | | |
| B01 | | NOT_RUN | | | |
| B02 | | NOT_RUN | | | |
| B03 | | NOT_RUN | | | |
| B04 | | NOT_RUN | | | |
| B05 | | NOT_RUN | | | |
| I01 | | NOT_RUN | | | |
| I02 | | NOT_RUN | | | |
| I03 | | NOT_RUN | | | |
| I04 | | NOT_RUN | | | |
| I05 | | NOT_RUN | | | |
| I06 | | NOT_RUN | | | |
| S01 | | NOT_RUN | | | |
| S02 | | NOT_RUN | | | |
| S03 | | NOT_RUN | | | |
| S04 | | NOT_RUN | | | |
| S05 | | NOT_RUN | | | |
| S06 | | NOT_RUN | | | |
| S07 | | NOT_RUN | | | |
| S08 | | NOT_RUN | | | |
| U01 | | NOT_RUN | | | |
| U02 | | NOT_RUN | | | |
| U03 | | NOT_RUN | | | |
| U04 candidate feed | | NOT_RUN | | | |
| U04 public feed | | NOT_RUN | | | |
| U05 | | NOT_RUN | | | |
| U06 | | NOT_RUN | | | |
| P01 | | NOT_RUN | | | |
| P02 | | NOT_RUN | | | |
| P03 | | NOT_RUN | | | |
| P04 | | NOT_RUN | | | |
| P05 | | NOT_RUN | | | |
| O01 | | NOT_RUN | | | |
| O02 initial observation | | NOT_RUN | | | |
| O02 24-hour review | | NOT_RUN | | | |
| O03 readiness and any incident | | NOT_RUN | | | |

For N/A, state disabled/unsupported scope and reviewer. For BLOCKED/FAIL, retain the cause, user impact, owner and next action. The parent passes only when every applicable subcase passes through fresh or eligible reused evidence. Record failed attempts and candidate changes after a later pass.

## Component and capability applicability

Choose ENABLED_REQUIRED, ENABLED_OPTIONAL, DISABLED or UNSUPPORTED for each capability/target before testing. Add OS versions, source contract, fixed input, expected output and evidence method. The starting rows below summarize source contracts only; none is a native acceptance result. Narrow each row to the actual shipped operation and split groups with different prerequisites or contracts. Blank enablement is unresolved scope. Apply the checklist's rules for failed advertised optional capabilities.

| Component/capability | Source ownership | macOS arm64 contract | Windows x64 contract | Candidate enablement per target | Prerequisites | Smallest workflow and expected output |
| --- | --- | --- | --- | --- | --- | --- |
| Desktop shell, native modules and search | Third-party runtimes with app-owned integration | Supported contract | Supported contract | | Native payload and declared normal prerequisites | Launch, terminal/file write, search and clean quit; actual output/path evidence |
| OpenCode CLI, SDK/schema and managed plugins | Third-party runtime with app-owned plugins | Supported contract | Supported contract | | Compatible pins and valid model/account access | Streamed conversation, actual tool file, cancel/reopen; runtime identity |
| Embedded knowledge/AnyDoc | App-maintained fork and local native patch | Conditional | Conditional | | Native payload, parser and configured embedding/retrieval | Import unique fixture, index/query, restart/query; correct retrieved content |
| Workbench/creation extensions | App-owned generated code | Supported contract | Supported contract | | Generated registry, entrypoints and declared grants | Create/persist/reopen work; correct skill/extension stage |
| SuperWeb | Separately maintained app payload plus third-party packages | Conditional | Conditional | | Matching nested lock/vendor dependencies and supported browser | Small website workflow, real browser check and reopenable delivery |
| SuperPPT/image-deck generation | Separately maintained app payload plus provider/dependencies | Conditional | Conditional for image-deck scope | | Installed runtime/dependencies and callable image provider | Small declared deck, inspect/reopen, revise one page; conversion assessed separately |
| Image-to-editable-PPTX | Separately supplied skill runtime | Conditional | Unsupported by bundled skill contract | | Full plugin runtime, Node >=22.6 and supported OCR/scene provider | One PNG to analysis/PPTX; editable text and valid safe-background fallback |
| SuperWriter and WPSComposer | App workflows/adapters plus Office/Python dependencies | Conditional by format/engine | Conditional by format/engine | | Declared WPS/Word engine, Python/resolved dependencies and native permissions | Small fixed manuscript to DOCX/PDF; native file/layout readback; separately list each offered edit operation |
| SuperVideo/OpenMontage/Remotion subset | App engine plus third-party vendored/runtime components | Conditional | Conditional | | Declared Node/Python/FFmpeg/browser/fonts and input-specific renderer/narration | Short fixed MP4, playback/audio/subtitle inspection and one scene revision |

Sources are linked from [the integration map](RELEASE_CHECKLIST.md#repository-integration-coverage). Bundled instructions, an engine cache or an installed API key alone cannot satisfy runtime prerequisites. Record limited editing/format support and user-installed overrides separately.

## Third-party inventory and upstream decisions

Attach the full machine-readable dependency inventory/SBOM. Include direct/transitive and nested package graphs, copied/forked code, native/bundled binaries, plugins/skills and separately downloaded runtimes. Use one summary row per managed integration; link grouped dependency details. An empty row is not a completed audit.

| Component and integration owner | Official upstream and fork source | Selected version/full revision and local patch digest | Newest relevant stable and checked-at/source evidence | UPGRADE/RETAIN/DISABLE/REPLACE and reason | Advisory/maintenance/license review evidence | Next review owner/date |
| --- | --- | --- | --- | --- | --- | --- |
| | | | | | | |

For unchanged components, link a valid update review and explain retention. Record upstream and fork divergence separately. Use the checklist's 30-day upstream and 24-hour advisory defaults unless the approved policy records a stricter deadline. An unavailable source with no eligible review or an unresolved applicable risk retains its blocking ID. No row implies that the newest upstream version was adopted.

## Third-party package and execution evidence

| Component and target/profile | Source/lock/patch identity | Staged identity and digest | Final installed path/version/digest | Actually executed or loaded path/identity | Overrides, preserved user content and remedy | Real workflow/output and regression/recovery evidence | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | |

Cover clean and supported source-version profiles. Link nested-lock/cache validation, engine/skill manifest consistency, native ABI tests and license/notice payload checks. Describe instrumented test differences. Record first-run download identity and runtime drift where applicable. Add full user-customization coexistence cases when triggered. Follow T01-T08 applicability and preserve user content.

## Financial contract and abnormal outcomes

| Contract field | Versioned value, owner and evidence |
| --- | --- |
| Service environment/revision and price/catalog revision | |
| Units, expected charge calculation and rounding rule | |
| Authoritative usage, receipt, reservation/refund and ledger read methods | |
| Terminal states and their amount/usage meaning | |
| Settlement deadline and its clock/start event | |
| Reconciliation/escalation deadline and responsible operator | |
| Approved bounded fault/cancellation method and cost cap | |
| Safe-blocking result, original call identity and no-replay evidence | |
| Final authoritative outcome/readback and time | |

Follow [the financial acceptance contract](RELEASE_CHECKLIST.md#financial-acceptance-contract). Pending/UNKNOWN can establish safe blocking, but leaves final financial completion BLOCKED. A request timeout is not a settlement deadline or refund receipt. These fields must be populated for an enabled product-billed route before S06/S07 can pass.

## Model and financial evidence

| Client target and service revision | Provider/model/capability | New test or dated unchanged baseline | Task/receipt reference | Pre/post ledger and expected amount | Actual final charge/reservation/refund | Result and evidence |
| --- | --- | --- | --- | --- | --- | --- |
| | | | | | | |

Record applicable S03-S08 results using the checklist's model, billing and commerce rules. Distinguish sandbox from production and record observation time for asynchronous settlement.

## Publication and observation

| Metric or event | Source/method and observer | Population rate or probe plan and baseline | Minimum samples/window | Warning/stop criteria and action | Observed result/evidence |
| --- | --- | --- | --- | --- | --- |
| Crash and startup failure | | | | | |
| Login failure | | | | | |
| Default/model call failure and latency | | | | | |
| Download/install/update failure | | | | | |
| Billing, data integrity and account isolation | | | | Any confirmed defect triggers O03 | |

Before P01, fill the measurement method, denominator or deterministic probes, required samples, latency bounds, observers, checkpoint times and escalation action. Record a failed/missing metric source explicitly. Low traffic can use the approved probe plan; population rates remain unavailable. Remain PUBLISHED_UNDER_OBSERVATION until public checks and both 30-minute/24-hour checkpoints plus sample requirements complete.

| Public checkpoint | Planned time/time zone and owner | Sample/probe requirements | Actual evidence/result | Outstanding action and next checkpoint |
| --- | --- | --- | --- | --- |
| Immediate P03-P05 public readback | | | | |
| O02 30-minute observation | | | | |
| O02 24-hour observation | | | | |

## Recovery plan and rehearsal

| Field | Value and evidence |
| --- | --- |
| Last good source, installers, hashes, feeds and configuration | |
| Candidate and previous-client service compatibility | |
| Previous third-party pins/patches and component/data recovery compatibility | |
| Data migration/backup and safe restore procedure | |
| How to stop offering the bad release | |
| Recovery build or tested reinstall procedure | |
| Recovery owner and contact method | |
| Rehearsal date, duration, preserved/lost data and verification | |
| Billing transaction preservation during service recovery | |

| Client update state | Authorized containment method | Verified effect and time | Remaining exposure/notification route | Recovery owner and next check |
| --- | --- | --- | --- | --- |
| Has not discovered the release | | | | |
| Discovered, download not started | | | | |
| Downloading | | | | |
| Downloaded or staged, not installed | | | | |
| Installed | | | | |

Use [native containment and recovery](NATIVE_UPDATE_ACCEPTANCE.md#containment-and-recovery). Feed withdrawal does not prove a staged update was revoked. Preserve user data and financial transactions. Record an actual action/result or an unresolved capability gap for each applicable population.

## Decision and open items

| Field | Value |
| --- | --- |
| Approved to publish by and at | |
| Public readback and initial observation accepted by and at | |
| 24-hour review result, reviewer and time | |
| Cosmetic exception IDs, impact, owner and deadline | |
| Blocking IDs and missing evidence | |
| Withdrawn/recovered by and at, if applicable | |
| Incident, cleanup and next-release regression actions | |

Choose the state supported by the checklist's completed stages and retain the follow-up owner until its result is recorded.
