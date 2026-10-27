# SuperWagie release checklist

Standard 1.0. Enforcement suspended by the maintainer on 2026-10-27, Asia/Shanghai.

This checklist is retained for optional reference while the program stabilizes.
Its requirements, acceptance records and blocking rules below are inactive until
the maintainer explicitly re-enables them. Existing repository validation rules
continue to apply. Preserve historical release results with their original
evidence and limits; suspension changes no recorded outcome.

Scope covers the macOS and Windows desktop clients, UniHub identity and billing, platform model routing, update feeds, and public download pages. Web, mobile, and VS Code distributions require their own release records when shipped. They remain part of impact assessment when shared code changes.

## Release rules

- Copy [the acceptance record](RELEASE_ACCEPTANCE_TEMPLATE.md) to a sibling file named `<version>-<candidate>-acceptance.md`. Record source revision, dependency lock digest, OS, architecture, artifact digests, service revisions, owners, and evidence. One release coordinator owns the decision and recovery.
- Use `PASS`, `FAIL`, `BLOCKED`, `NOT_RUN`, or `N/A` per applicable subcheck. `PASS` requires observed evidence or eligible baseline evidence under the execution rules. Record the evidence mode as NEW or REUSED. `N/A` requires the applicability rule and reviewer. Missing required evidence, a device or credentials is `BLOCKED`. An unavailable upstream lookup can use a still-valid review; an expired review remains BLOCKED.
- Every applicable item must pass before its stage completes. A cosmetic defect may have a written, version-specific exception with an owner and deadline. Identity, money, data loss, artifact integrity, installation, advertised update support, and trust requirements cannot use that exception.
- Keep automated checks, native packaging, installed-client acceptance, real service transactions, and public readback as separate results. A health response, model list, test fixture, or download-progress screenshot proves only that step.
- Freeze the candidate before acceptance. Source, dependencies, bundled resources, installer settings, signing, or artifact bytes changing creates a new candidate. Repeat affected checks and final artifact/update checks; document the impact decision.
- Publish the exact accepted bytes. Keep previous attempts and failed checks. A retry needs a recorded cause and result; it does not erase the failure.
- Every advertised OS and architecture needs its own result. A different architecture, emulation, or another OS cannot supply that result. Remove unsupported distribution claims or block that target before publication.
- Check that upstream and security reviews remain valid for every candidate, then freeze the chosen versions. A newer upstream release requires a recorded adoption or retention decision. It does not authorize an automatic upgrade during packaging or acceptance.

## Execution order and cadence

Start with readiness, select applicable checks, freeze the candidate, build and verify it, then approve promotion. Complete public readback and observation after promotion. O01 visibility and O03 recovery readiness are prepublication requirements even though their detailed criteria appear with observation.

### First operational readiness

Complete this record before the first operational release. Revalidate a row when its owning implementation, contract, platform or credentials change. The row links to evidence; it is not an assumption that the capability already exists.

| Requirement | Evidence needed before operational publication | Owning checks |
| --- | --- | --- |
| Supported product scope | Exact OS versions, native hosts/clean profiles, enabled services and per-component platform/prerequisite matrix | R01, I01, T01, T08 |
| Native update route | Reproducible macOS/Windows candidate-feed procedure, source-version/channel map, isolated test accounts and public replay plan | U02, U03, U04 |
| Artifact and updater trust | B05 signing/notarization setup, timestamp and validation commands, rejection of a wrong publisher/tampered payload | B05, U03 |
| Financial acceptance contract | Versioned prices/rounding, terminal-state rules, authoritative receipt/ledger reads, settlement deadline and reconciliation/escalation owner | S06, S07, S08 |
| Component baseline | Complete component inventory, current advisory/license review and initial native integration evidence | T01 through T08 |
| Observation and recovery | Working evidence sources, declared samples/thresholds, assigned observers and rehearsed containment/data-safe recovery | R02, O01, O02, O03, U06 |

Keep a missing capability in this readiness record with owner and next action. B05 is an adopted operational requirement. Its signing, notarization and updater-validation evidence must pass before the affected operational release can proceed. Recording the requirement does not complete its implementation or runtime acceptance.

### Four execution layers

| Layer | When it runs | Work to perform |
| --- | --- | --- |
| Initial readiness | Before first operational publication; repeat after relevant contract/platform changes | Establish the readiness evidence and full applicable behavior/failure baseline |
| Every release | For the final candidate and each delivered target | Fresh artifact/source/runtime identity, core installed-client smoke, enabled financial smoke, valid upstream/security reviews, update route, public readback and observation |
| Change-triggered | Affected dependency, native ABI, protocol, plugin, model/price, persistence, installer or permission boundary changes | Repeat the affected full integration/failure matrix and recovery tests; invalidate affected baseline evidence |
| Periodic maintenance | At the recorded due date, or immediately on a relevant advisory/incident | Full upstream adoption/maintenance review, expiring compatibility/recovery baselines and long-duration/platform sampling |

Review validity defaults are 30 calendar days for the full upstream/maintenance review and 24 hours before promotion for the advisory report covering the candidate inventory. A new component/version, changed fork/patch, end-of-support notice or relevant advisory invalidates its prior decision immediately. Each compatibility/recovery baseline records its own next review date before first reuse. An unset or overdue date prevents reuse. These are execution deadlines; this document creates no scheduled automation.

| Check IDs | Every-release minimum | Additional execution trigger |
| --- | --- | --- |
| T01, T04, T06 | Current inventory delta, lock/patch/override identities, verified staging inputs and final payload hashes | Clean preparation/rebuild of affected inputs after dependency or cache-integrity changes |
| T02, T03 | Validate review scope/date, read the current advisory result and disposition any new finding | Full official-upstream comparison at initial baseline, version/fork/patch change or review expiry |
| T05 | Confirm whether each consumer/contract changed; link eligible unchanged baseline | Full affected consumer/ABI/protocol and failure tests on change |
| T07, T08 | Verify actual managed runtime/skill selection and each required component's smallest supported workflow on clean and upgraded profiles | Full first-use, custom-content coexistence, failure and recovery cases at initial baseline, relevant change or expiry |
| R01, R02, B01 through B05 | Freeze scope, review recovery readiness, focused checks, complete native package, final-byte inspection and actual trust verification | B02 broad suites and B05 negative trust tests at initial baseline and affected changes |
| I01 through I06 | Clean install and supported upgrade, data fixture, startup/quit, file/terminal, core workflows and visible customization smoke | Full migration/failure/path/HMR cases at initial baseline, affected changes or expiry |
| S01 through S05 | Login/logout/valid restart, default streamed call and tool/file effect on both clients; required provider/capability representatives | Full auth/failure/session-isolation matrix at initial baseline or affected changes; every changed model/route/price is tested |
| S06, S07 | With product billing enabled, one successful settled task and one approved bounded cancellation/reconciliation case per target | Full interruption/restart/idempotency/fault matrix at initial baseline, billing change, relevant incident or expiry |
| S08 | When commerce is enabled, the declared safe smoke for the environment and current entitlement readback | Full order/payment/fulfillment/fault matrix when enabling or changing commerce; production claims require production evidence |
| U01, U02, U04, U05 | Feed integrity, declared upgrade/migration route, candidate test and unmodified public replay, core update controls | Additional oldest-supported source-version/configuration cases at initial baseline and installer/channel changes |
| U03, U06 | Link eligible failure/recovery baseline and recheck required recovery assets/compatibility | Native fault/recovery rehearsal at initial baseline, relevant change, incident or expiry |
| P01 through P05, O01 through O03 | Fresh prepublication decision/readiness, public readback and staffed observation; execute containment on an incident | Broader recovery rehearsal when the containment mechanism or data contract changes |

For each check, record applicable subcases, method/command or numbered runbook, fixture/input, expected result, evidence reference, executor, reviewer and elapsed time. One failing applicable subcase prevents the parent PASS. Reused evidence includes the original result/date, source/component/host-runtime/service/configuration identities, covered target/subcases, next review date and the reviewer's unchanged-impact decision. Packaging, installed runtime selection, public bytes and enabled financial smoke always require NEW evidence for the current candidate.

An emergency patch follows the same fresh core gates. It may reuse an eligible unchanged baseline; urgency does not turn expired or missing identity, money, data-integrity or update evidence into PASS. Before the first operational publication, run an internal rehearsal, record actual time/cost and close its blocking readiness items. Do not estimate release duration from the 43 parent IDs alone.

## Supported platform matrix

The initial baseline is macOS arm64 and Windows x64. Expand this matrix only with native acceptance and a working distribution/update path. Record exact supported OS versions before the first operational release. A clean test host has no project checkout, developer `node_modules`, or preconfigured CLI credentials. Ordinary supported prerequisites such as Git must be documented and tested.

| Target | User installation | Update payload and feed | Required acceptance |
| --- | --- | --- | --- |
| macOS arm64 | DMG | ZIP and `latest.json`; test any advertised DMG fallback | Clean install, previous stable upgrade, self-update, current and minimum supported macOS |
| Windows x64 | NSIS installer EXE | EXE and `latest-x64.yml`, matching `latest.json`, plus the fixed legacy `latest.yml` | Clean install, declared legacy migration, and NSIS self-update where a channel-capable source baseline exists; bootstrap scope follows the rule below |
| Additional target | Declare format explicitly | Declare its exact feed and architecture selection | Native hardware, bundled dependency compatibility, install and update evidence |

Windows portable EXE is outside the baseline. DMG is the macOS download offered to users; ZIP remains required for its self-update path.

The current OS version is exercised every release. The minimum supported OS also needs an initial baseline and a new run after installer/native-runtime/OS-support changes or baseline expiry. Name the tested OS builds explicitly. Each integration's platform contract is distinct from the app's platform contract: the bundled editable-PPTX skill declares macOS/Linux support and needs a separately supplied runtime; native Office adapters require the declared engine and format-specific capability. A bundled instruction file establishes neither installed prerequisites nor a passing native workflow.

If no released, unmodified Windows dedicated-channel client exists, R01 must resolve the bootstrap scope before acceptance. A maintainer-approved migration-only first release may validate clean/manual installation and legacy-profile migration, plus instrumented candidate NSIS replacement. Its public replay uses the unmodified legacy client and manual candidate install. Public automatic-update acceptance remains a separate NOT_RUN/BLOCKED readiness item and cannot be claimed as passed. Release-specific automatic replay can be N/A only for that explicitly approved migration-only scope and matching public instructions. Retain the exact published bootstrap installer; the next higher candidate must use it for native public self-update acceptance before making that claim. If the offered scope requires automatic self-update immediately, missing baseline evidence blocks it. This conditional route does not choose or approve a narrower product scope by itself.

## Checks on third-party components

These checks cover package-manager dependencies and their transitive dependencies, copied source, forks, standalone binaries, native modules, bundled skills, plugins, extensions, and separately installed or downloaded runtimes. Include integration points used during the build and at runtime. Treat user-installed components separately from the components SuperWagie distributes; test their supported interaction without silently replacing user content.

Apply T01 through T08 before promotion at the minimum and additional scope defined in the cadence table. Each managed component declares supported targets, enabled/required/optional status, prerequisites, test fixture and minimum real workflow in the acceptance record. A required capability with unmet prerequisites is BLOCKED. A genuinely unsupported or disabled capability can use N/A with matching product claims and runtime behavior. A failure in an advertised optional capability requires it to be repaired or explicitly disabled before promotion; optional status alone cannot pass a failed workflow.

| ID | Check | Pass condition and evidence |
| --- | --- | --- |
| T01 | Inventory actual dependencies | Keep a machine-readable component inventory or SBOM linked to the candidate. Include direct/transitive packages, nested lockfiles, vendored/forked code, binaries, skills/plugins, assets and first-run downloads outside the root package graph. Record official source, integration owner, selected version or full source revision, local patch digest, delivery path, target architecture and runtime prerequisites. Compare against the previous release and explain additions, removals and version changes. |
| T02 | Review upstream updates | Review each managed integration's official registry/repository, release notes and advisories at the required cadence. Record checked-at time, newest relevant stable version/revision and changes since the selected version, including security fixes, breaking APIs, platform changes and deprecations. For a fork, review both its source upstream and the distributed fork. Choose UPGRADE, RETAIN, DISABLE or REPLACE, with reason, owner and next review date. Unknown provenance or missing valid review is BLOCKED. An older version may pass with valid review, supported compatibility and a reasoned retention decision. |
| T03 | Review security, maintenance and redistribution | Assess known advisories against the actual direct/transitive/vendored versions and delivered execution paths. Record maintenance/end-of-support status and required mitigations. An applicable critical vulnerability, unsupported critical dependency or unresolved redistribution permission blocks the affected offering until a verified fix/mitigation, supported replacement or removal is in place. Preserve required licenses, notices and modification/source obligations in the shipped payload; record the responsible review and evidence. Version freshness alone cannot pass this check. |
| T04 | Pin and reproduce integration inputs | Locks, full source revisions, source/archive digests, local patches, build flags and environment overrides identify the exact selected inputs. Moving branches, floating latest downloads and an existing cache directory alone are insufficient. Validate nested dependencies as well as the root lock. Refresh or verify pre-existing staging/cache contents against current inputs. Record clean dependency preparation for changed components and confirm no silent dependency resolution occurs after candidate freeze. Any required first-run downloads are pinned and validated too. |
| T05 | Validate changes at their consumers | Review upstream API/event/schema/protocol, configuration, permission and data-format changes against every affected consumer. Check that local adapters and patches still apply and intended SuperWagie behavior survives upstream updates. Follow the owning OpenCode pinning policy for its CLI, SDK/schema and plugin hooks. Verify native ABI, supported OS/architecture and dependent component compatibility. Record focused integration/failure results or eligible unchanged baseline evidence. A successful upstream test suite alone cannot pass integration acceptance. |
| T06 | Match source to final package | For each shipped component, compare selected source/lock/patch identity with staged resources and the final installed payload. Verify manifests against actual files and hashes, package exclusions, entrypoints, runtime/skill assets, migrations and required license files. Regenerate linked manifests/runtime locks together when their content changes. A source tree or staging manifest alone cannot prove the delivered bytes. Keep evidence per target. |
| T07 | Match installed package to executed code | On clean and upgraded profiles, record the component actually selected, its path/version/hash or content identity, loaded plugin/skill root and resulting operation. Check PATH/env overrides, settings, duplicate host skill directories, old runtime caches and existing user-installed skill copies. Confirm supported customizations are preserved and stale managed content has an explicit supported remedy. Existing user content may intentionally override bundled content; record that outcome and its supported capability limits. A required advertised workflow must still pass or block release. |
| T08 | Exercise integrated workflows and recovery | On every target where a candidate enables and supports an integration, run its declared smallest real product workflow and inspect its output. At the additional cadence, cover first use/dependency preparation, existing-profile upgrade, custom-content coexistence, failed/unavailable optional component and recovery. One failed optional plugin must not disable unrelated complete workflows. Verify version/channel selection and supported compatibility limits for runtime-updatable components; unexpected drift requires revalidation. Component recovery preserves user files and existing financial state. |

The source checkout, installation payload and executed component each have their own identity evidence. For unchanged transitive packages, the locked dependency graph and current advisory report can provide grouped coverage. Every top-level integration, locally patched fork and independently staged runtime still needs a named owner and its own selection, packaging and execution evidence.

### Repository integration coverage

This is a starting map for T01, not a completed upstream/version audit. Build the release inventory from the actual candidate and final package. App-owned adapters and generated extension registries are included as integration owners; listing them here does not classify their source as third-party code.

| Integration group | Candidate source of truth | Acceptance focus |
| --- | --- | --- |
| OpenCode CLI, SDK/schema and managed plugins | [OpenCode owning guide](../../.agents/skills/opencode-v2/SKILL.md), root/workspace manifests, [CLI preparation](../../packages/electron/scripts/prepare-opencode-cli.mjs) | Coordinated pins, explicit build/runtime overrides, compatible hooks and live executable identity |
| Embedded knowledge and AnyDoc | [Preparation and manifest](../../packages/electron/scripts/prepare-embedded-knowledge.mjs), Windows patch, packaged resource manifest | Upstream plus fork revision, patch identity, native architecture, parser/index/retrieval and migrations |
| SuperWeb | [Resource staging](../../packages/electron/scripts/prepare-superweb-resource.mjs), its nested package manifest/lock | Existing node_modules matches the current nested lock; restored vendor resources and real preview/build work |
| SuperPPT, SuperWriter, WPSComposer and supporting skills | [Bundled source/notice map](../../packages/web/server/builtin-skills/NOTICE.md), owning manifests and [installation contract](../../packages/web/server/lib/builtin-skills/DOCUMENTATION.md) | Complete skill dependencies, external-runtime prerequisites, permission to distribute and actual selected skill after upgrade |
| SuperVideo, OpenMontage and Remotion subset | Engine/runtime manifests, skill runtime lock, vendor provenance and notices under [the bundled payload](../../packages/web/server/builtin-skills/) | Original revision plus local changes, synchronized hashes/locks, actual engine cache and valid output |
| Electron, updater, native modules and ripgrep | Root/Electron manifests, root lock, [ripgrep preparation](../../packages/electron/scripts/prepare-ripgrep.mjs) | Runtime ABI, native target, locked binary integrity, installer/update behavior |
| Built-in extensions and plugin registrations | [Extension registry and ownership](../../packages/extensions/DOCUMENTATION.md), generated built-in registry, owning plugin configuration | Correct IDs/entrypoints/grants, generated payload, successful activation and isolation of individual failures |

## Checks before packaging

| ID | Check | Pass condition and evidence |
| --- | --- | --- |
| R01 | Freeze candidate and scope | All platform builds use the same recorded source revision and lockfile. List changes, affected runtimes, enabled commercial capabilities, prior stable version, service/configuration revisions, and open defects. Identify the build host and toolchain for each target. |
| R02 | Define deployment and recovery | Record service/client deployment order, compatibility with the previous client, rollback owner, previous artifacts/feed/configuration snapshots, data backup and recovery method. Set the publication time and staffed observation window. |
| B01 | Source quality | Source changes have current type, lint, dead-code and applicable regression evidence. `bun run check:changed` passes before a source commit. Record the base revision and actual files checked; choose additional release checks for the full candidate scope. |
| B02 | Regression coverage | Run `bun run test:customizations` on the final candidate plus focused owning-package and cross-runtime tests for changed contracts. For the first operational release, dependency changes, or broad upstream merges, run the full `bun run test` suite and relevant builds. Every unresolved failure has a disposition. |
| B03 | Complete native packaging | Use the current Electron packaging path on each native target. Stage SuperWeb, web UI, pinned OpenCode, ripgrep, embedded knowledge, skills/extensions and native modules. Preserve logs and bundled-resource receipts. Missing promised resources or `INCOMPLETE-CI` artifacts block release. |
| B04 | Inspect final artifacts | Read version, bundle/app identity, architecture and expected resource versions from the final package. Verify bundled CLI execution and native modules. Record filename, byte size and SHA-256 for every distributed file, including update payloads. Root/workspace/app/current-channel feed versions agree; U01 defines the deliberately frozen Windows legacy feed exception. |
| B05 | Verify operating-system trust | The operational gate requires a valid Windows publisher signature and timestamp on installer/application, plus stable Developer ID signing, notarization and ticket validation for macOS. Keep Windows updater signature validation enabled and verify the accepted signed bundle before a custom macOS update swap. Test downloaded files under normal OS security settings. Record actual trust results and any reputation warning; unsigned or ad-hoc builds do not pass this gate. |

## Checks on installed clients

Run the every-release subcases of I01 through I06 and applicable S01 through S07 on each supported target using its exact final package. Add the full triggered cases from the cadence table. Use disposable projects and dedicated acceptance accounts. Record external charges and cleanup separately.

| ID | Check | Pass condition and evidence |
| --- | --- | --- |
| I01 | Clean installation | Install on a clean supported OS as an ordinary user. Launch from the normal app entry. Reach usable login/main UI without a source checkout or build tools. Confirm path handling, shortcuts and protocol registration. Preserve installer and launch logs. |
| I02 | Upgrade and preserve data | Upgrade a copy of a representative supported source-version profile through its declared route, including a required Windows manual channel migration. Projects, histories, drafts, files, settings, model bindings and valid account state survive. Reopen and compare recorded fixture contents. Verify triggered migration failure recovery. Never test destructive recovery on a user's only profile. |
| I03 | Lifecycle and startup | Cold launch, relaunch, tray/window close and actual quit work. The app uses the expected bundled runtime. Owned backend/terminal processes stop within the documented deadline; external services remain running. No white screen or restart loop. |
| I04 | Files and terminal | Create/open a project under Chinese and space-containing paths. Read/write a temporary file, search, preview, open through the OS, and run a terminal command. Verify disk contents and reopen after restart. Deletion preserves source files where the product promises retention. |
| I05 | Bundled product workflows | Open the workbench and built-in skills. Run a small SuperWeb workflow and import/index/query a small knowledge fixture when these are shipped. Verify the resulting preview, document or retrieved content. A running subprocess alone is insufficient. |
| I06 | Customization and basic usability | DevHMR stays stopped on ordinary launch. If manual HMR is supported, click to start, verify locked dependency preparation and failure cleanup on the native OS. Check Chinese/English critical flows, update dialogs, help entry and keyboard input. Verify the Windows diagnostics collector on Windows. Record platform-specific subcheck applicability without marking the whole item N/A. |

## Checks against critical services

S06 and S07 apply when the candidate offers a product-billed model route or
changes billing behavior. A bring-your-own-key-only candidate with no product
billing may record N/A with the disabled route and reviewer. Missing credentials
or unavailable billing evidence for an enabled route remain BLOCKED. S08 has its
own commerce applicability rule. These checks do not authorize new external
charges or payment operations.

| ID | Check | Pass condition and evidence |
| --- | --- | --- |
| S01 | Login and access control | Correct login enters the app. Wrong password fails clearly. Unauthenticated, expired and logged-out sessions cannot access protected business routes. Profile and valid session survive restart. Switching accounts preserves account boundaries. Recheck the small supported clock-skew case when auth changes. |
| S02 | Service failure behavior | Identity, account summary and financial reads have distinct outcomes. Failure to read balance does not invalidate otherwise valid identity or display an authoritative zero balance. Network/provider errors are visible, retain valid local data, and permit recovery without a restart loop. |
| S03 | Real conversation | On the installed client, send through the production-shaped model route, receive a complete streamed answer, continue the conversation, stop a response and reopen history. Run the default model on both targets. A mock response or connection probe cannot pass this item. |
| S04 | Model and capability coverage | First operational release establishes a real-call baseline for every model/capability sold as available. Each release covers the default plus each enabled provider/protocol/capability, and every changed model, binding, price or route. Reuse unchanged catalog evidence only with its date and configuration identity. Embedding, rerank, image, speech and other advertised capabilities need their own valid operation/output. |
| S05 | Agent execution and recovery | In a disposable project, perform a permitted tool read/write and verify the actual file. Exercise permission refusal, cancellation, session switching and disconnect/reconnect. No cross-session output, duplicate tool effect, or indefinitely running status remains. |
| S06 | Successful usage and billing | Use a dedicated account for one bounded real billable task. Record pre/post authoritative balance or ledger, request/task receipt, model, account and terminal settlement state. Reconcile usage and charged amount against the recorded price and rounding rules. UI balance alone cannot prove settlement. Complete one independently attributed task per baseline target. |
| S07 | Failed or interrupted billing | Use the financial acceptance contract below for the every-release cancellation/reconciliation case and triggered full timeout/failure/restart matrix. Repeated status reads retain the original task/call identity. Verify no duplicate charge or unsafe replay, then independently read the authoritative final reservation/refund/charge outcome. Pending/UNKNOWN may pass the safe-blocking subcase but cannot pass final financial completion. Start fault cases in staging; production smoke uses an approved bounded account and method. |
| S08 | Recharge and entitlement changes | Applies when payment, recharge, membership or commerce is enabled or changed. Verify order, payment, fulfillment, entitlement and ledger readback, including a duplicate callback and a recoverable failure. Use sandbox results for sandbox capability only. A capability still lacking real-payment acceptance stays disabled in production. |

### Financial acceptance contract

Before S06 or S07 can pass, link the versioned service contract and an executable readback procedure in the release record. It identifies the price/catalog revision, unit and rounding rules, authoritative usage/receipt/ledger fields, expected terminal statuses, settlement deadline, owner escalation deadline and approved reconciliation action. Record the account/role and bounded fault method without secrets. A missing settlement deadline or inaccessible ledger is a readiness blocker for the enabled product-billed route. An HTTP request timeout is a separate transport limit.

| Observed outcome | Subcheck result | Release consequence |
| --- | --- | --- |
| Receipt and ledger reach the expected SETTLED, RELEASED or REJECTED outcome within the contracted deadline, with the correct charge and no duplicate effect | PASS | Attach both authoritative records |
| Interruption safely leaves UNKNOWN/pending, prevents replay, and exposes the recovery state | Safety subcase may PASS | Financial completion remains BLOCKED until the original call is authoritatively reconciled |
| Deadline expires, receipt is missing or the gateway cannot determine the result | BLOCKED | Preserve the original call/idempotency identity, escalate to the contract owner and retain financial records |
| Wrong payer, wrong amount, duplicate charge or unsafe replay | FAIL | Block promotion or execute O03 if already public |

The coordinator cannot infer a refund from elapsed time, clear uncertain journals or create a new call to complete an uncertain old one. An authorized operator's repair passes only after independent authoritative readback. Record safety behavior and final financial completion as separate S07 subcases.

## Checks on updates and recovery

| ID | Check | Pass condition and evidence |
| --- | --- | --- |
| U01 | Feed and artifact agreement | Generate feeds from the final accepted artifacts. Current-channel JSON/YAML version, URLs, architecture, sizes, digests and bilingual notes agree. Windows `latest-x64.yml` describes this candidate; legacy `latest.yml` remains the deliberately frozen historical file and must not be advanced or required to match the current version. Verify its fixed bytes and absolute historical URL separately. Reject accidental stale/current-channel or upstream OpenChamber URLs. Every delivered target has its declared channel; missing required assets block that target. |
| U02 | Actual native update or declared migration | Test each supported source-version route to the exact candidate using [native update acceptance](NATIVE_UPDATE_ACCEPTANCE.md). Observe download, restart/install and relaunch; verify executable and bundled OpenCode identity, login, one real conversation and preserved data. Legacy Windows uses its declared one-time manual migration; it is not counted as self-update success. Preserve the source-version/channel matrix, pre/post identities and payload hashes. |
| U03 | Update failure safety | At initial readiness, relevant updater/packaging/trust/quit changes or baseline expiry, exercise interrupted download, invalid digest, installation/copy failure and close during install shutdown using the native runbook. The profile/app remains recoverable. A close must reach the app's own quit handling; record that evidence. Test wrong-publisher/signature rejection when B05 applies. |
| U04 | Candidate and public update sources | Candidate tests keep unaccepted bytes out of public Latest. Follow the native runbook's verified isolated feed and record instrumented-client differences. After publication replay the declared route with an unmodified supported source client. Windows legacy manual migration and a channel-capable client's self-update are separate results. Apply the supported-platform bootstrap rule when there is no released dedicated-channel N. Missing safe candidate testing or required public self-update evidence stays BLOCKED; a migration-only result cannot pass an advertised self-update claim. |
| U05 | User update controls | Manual check, background-check setting, skipped version, no-update, error, progress and restart actions behave as documented in both languages. No separate upstream OpenCode update is offered for the bundled runtime. Test each advertised fallback separately. |
| U06 | Recover a bad installed version | Rehearse recovery before the first operational release and after installer/data-format changes. Restore a valid previous app/profile or publish a compatible higher-version recovery build. Confirm login, files and one conversation after recovery. Record restoration duration and any data gap. A copy-failure rollback does not prove recovery from a bad app that already launched. |

The native runbook owns the SuperWagie-specific steps. The inherited updater reference and Linux AppImage fixture remain useful background for lifecycle races, but their feed gates and commands cannot establish a macOS/Windows result. If a runbook prerequisite still lacks a working local fixture or old-client baseline, assign its implementation/validation owner in readiness and keep the affected subcheck BLOCKED.

## Checks during publication

Applicable prepublication T, R, B, I, S and U checks, O01 visibility and O03 recovery readiness must pass before P01. U04's public replay, P02 through P05 and observation run after promotion. Eligible baseline evidence satisfies only its recorded subcases; unrelated NOT_RUN checks remain unaccepted.

| ID | Check | Pass condition and evidence |
| --- | --- | --- |
| P01 | Approve promotion | Coordinator and reviewer record the release decision, complete platform matrix, third-party inventory/update decisions, approved cosmetic exceptions, trust evidence and recovery readiness. Recheck current service health and candidate identity. Prepare all assets/feeds before changing public Latest or website links. |
| P02 | Publish exact accepted bytes | Upload and read back assets while draft or prerelease where possible. Promote only the complete accepted set. Record the exposure time and any non-atomic publication interval. Never replace published artifact bytes under the same version. |
| P03 | Read back public downloads | Download complete files from public user-facing URLs without maintainer authentication. Compare size and digest with accepted artifacts. Read public Latest, every feed and all referenced payload URLs. Verify the expected version, architecture and HTTP results. Cached local files or range-only probes cannot pass this check. |
| P04 | Verify website entry points | On actual macOS and Windows browsers, check homepage device selection and explicit download pages in Chinese/English. Links resolve to the correct current DMG or NSIS EXE. Check every advertised domain and redirect chain. Record mobile/unknown-device behavior if the homepage offers downloads there. |
| P05 | Verify public installed clients | Install the publicly downloaded artifacts and perform launch/login/default real call on both targets. Complete U04's public-feed update replay. Read back settlement for the public smoke task where billing is enabled. Failed public readback triggers containment and a recorded decision immediately. |

## Observation and release decisions

| ID | Check | Pass condition and evidence |
| --- | --- | --- |
| O01 | Operational visibility | Before promotion, confirm working crash/error, auth, model success/latency, update/install and billing diagnostics. Record dashboard/log access, known visibility gaps and alert recipient. No secrets or unnecessary user content enters acceptance evidence. If aggregation is unavailable, staff and record manual checks. |
| O02 | Observe and accept | Checkpoints are 30 minutes and 24 hours after promotion. Use the declared stable baseline or first-operation probe plan and record samples, errors, support reports, latency and ledger anomalies. A quiet channel supplies no population reliability estimate. Run approved probes when traffic is below the minimum; otherwise remain under observation. Complete both checkpoints and the declared sample requirements before ACCEPTED. |
| O03 | Contain and recover | A confirmed data-loss, isolation, unauthorized-access, wrong/duplicate-charge, integrity or repeatable install/start/update defect immediately triggers the containment runbook. Stop new offers where supported, preserve evidence and handle downloading, staged and installed clients separately. Record verified action time, remaining exposure, recovery owner and next checkpoint. Feed withdrawal does not revoke already downloaded/staged installers or repair installed clients. |

Before P01, assign the metric source, denominator/sample type, minimum sample, warning/stop criteria, observer, checkpoint times and escalation deadline. Use stable production rates when they exist. For initial low-traffic operation, use an approved deterministic probe plan with explicit latency bounds and immediate stop on a reproducible critical-path failure; label measured population rates unavailable. Never derive a percentage from missing data. An unmet sample requirement keeps the release under observation with a next action. Any O03 condition still triggers containment regardless of sample count.

Release states are `CANDIDATE`, `APPROVED_TO_PUBLISH`, `PUBLISHED_UNDER_OBSERVATION`, `ACCEPTED`, `BLOCKED` and `WITHDRAWN`. Completed prepublication checks lead to `APPROVED_TO_PUBLISH`. Promotion starts `PUBLISHED_UNDER_OBSERVATION`; public readback plus both O02 checkpoints and samples lead to `ACCEPTED`. An O03 stop condition or an explicit coordinator withdrawal decision moves a public release to `WITHDRAWN` and triggers containment. Approved cosmetic exceptions retain their recorded disposition. Incomplete evidence before publication is BLOCKED. An accepted release can be withdrawn on the same stop conditions.

Internal acceptance happens before public promotion. Do not describe a percentage rollout unless both clients and the hosting/feed mechanism enforce it. Current SuperWagie macOS uses its own JSON/ZIP updater; electron-updater's YAML rollout percentage alone does not establish a cross-platform rollout.

Use the [native runbook's containment matrix](NATIVE_UPDATE_ACCEPTANCE.md#containment-and-recovery) for clients that have not discovered the release, are downloading it, have staged it or have installed it. Preserve prior artifacts and immutable records. Use a higher-version recovery build where downgrade is unsupported. Restore a profile/database only through the tested method after preserving new user data. Backend recovery must remain compatible with deployed client versions and preserve new billing transactions. Service/website/feed changes require their existing action authorization; the checklist records the decision and evidence.

## Current command and evidence map

| Purpose | Existing entry | Evidence boundary |
| --- | --- | --- |
| Source pre-commit gate | `bun run check:changed` | Depends on its selected base/files; not native or installed acceptance |
| SuperWagie customizations | `bun run test:customizations` | Workbench, localization and update/feed regressions; not login/model/billing E2E |
| Broad automated regression | `bun run test` | Automated suites; not OS installation or real service readback |
| Current desktop packaging | `bun run electron:build` | Full Electron packaging on the native target; inspect final output and workflow logs |
| Updater unit regression | `bun run --cwd packages/electron test:updater` | Unit/fixture checks; not an actual update installation |
| Packaged CLI inspection | `bun run --cwd packages/electron verify:opencode-cli:packaged` | Use the script's current target/path options; cross-architecture inspection does not prove execution |
| Feed generation | `bun run release:manifests` | Supply current required version/notes/artifact options; generation does not publish or validate public bytes |

The Electron workspace's plain `build` is a no-op. Use `electron:build` for native packaging. `release:prepare` includes broad build/static checks but does not replace native packaging or installed-client acceptance.

The current manifest generator targets macOS arm64 and optionally Windows x64, including the dedicated Windows channel and frozen legacy feed. Inspect its current output and the [Windows channel migration contract](../../packages/electron/README.md#windows-update-channel-migration). Additional targets require explicit feed validation. Inspect each actual workflow/resource receipt; inherited workflows do not all prepare the full SuperWagie resource set.

Current package configuration has macOS `notarize: false` and Windows `verifyUpdateCodeSignature: false`. These settings are unresolved against B05. An actual signed/notarized artifact and active updater trust checks need verification before that gate can pass. macOS custom self-install must be assessed separately from Squirrel.Mac.

## References

- [Electron packaging and supported distribution](../../packages/electron/README.md#packaging)
- [Current Electron scripts and signing configuration](../../packages/electron/package.json)
- [Windows validation and remaining acceptance gates](../../packages/electron/WINDOWS-VALIDATION.md)
- [SuperWagie update behavior and feed contract](../specs/2026-10-24-auto-update.md)
- [Native candidate update, public replay and containment](NATIVE_UPDATE_ACCEPTANCE.md)
- [Identity, financial reads and commerce contracts](../../packages/web/server/lib/platform-account/DOCUMENTATION.md)
- [Platform model receipts and settlement contracts](../../packages/web/server/lib/platform-model/DOCUMENTATION.md)
- [Electron guidance on signing and macOS notarization](https://www.electronjs.org/docs/latest/tutorial/code-signing)
- [electron-builder 26 update channels and higher-version recovery](https://www.electron.build/v26/docs/features/auto-update/)
