# SuperWagie release checklist

Draft 0.1, 2026-10-27. Proposed for maintainer review before adoption.

This proposal is not adopted release policy. Current work follows the root
agent guide and its owning project skills. Preserve historical release results
with their original evidence and limits.

Scope covers the macOS and Windows desktop clients, UniHub identity and billing, platform model routing, update feeds, and public download pages. Web, mobile, and VS Code distributions require their own release records when shipped. They remain part of impact assessment when shared code changes.

## Release rules

- Copy [the acceptance record](RELEASE_ACCEPTANCE_TEMPLATE.md) to a sibling file named `<version>-<candidate>-acceptance.md`. Record source revision, dependency lock digest, OS, architecture, artifact digests, service revisions, owners, and evidence. One release coordinator owns the decision and recovery.
- Use `PASS`, `FAIL`, `BLOCKED`, `NOT_RUN`, or `N/A`. `PASS` requires an observed result and evidence. `N/A` requires a reason and reviewer. An unavailable upstream, missing device, or missing credential is `BLOCKED`.
- Every applicable item must pass before its stage completes. A cosmetic defect may have a written, version-specific exception with an owner and deadline. Identity, money, data loss, artifact integrity, installation, advertised update support, and trust requirements cannot use that exception.
- Keep automated checks, native packaging, installed-client acceptance, real service transactions, and public readback as separate results. A health response, model list, test fixture, or download-progress screenshot proves only that step.
- Freeze the candidate before acceptance. Source, dependencies, bundled resources, installer settings, signing, or artifact bytes changing creates a new candidate. Repeat affected checks and final artifact/update checks; document the impact decision.
- Publish the exact accepted bytes. Keep previous attempts and failed checks. A retry needs a recorded cause and result; it does not erase the failure.
- Every advertised OS and architecture needs its own result. A different architecture, emulation, or another OS cannot supply that result. Remove unsupported distribution claims or block that target before publication.

## Supported platform matrix

The initial baseline is macOS arm64 and Windows x64. Expand this matrix only with native acceptance and a working distribution/update path. Record exact supported OS versions before the first operational release. A clean test host has no project checkout, developer `node_modules`, or preconfigured CLI credentials. Ordinary supported prerequisites such as Git must be documented and tested.

| Target | User installation | Update payload and feed | Required acceptance |
| --- | --- | --- | --- |
| macOS arm64 | DMG | ZIP and `latest.json`; test any advertised DMG fallback | Clean install, previous stable upgrade, self-update, current and minimum supported macOS |
| Windows x64 | NSIS installer EXE | EXE and `latest.yml`, with the matching `latest.json` entry | Clean install, previous stable upgrade, NSIS self-update, current and minimum supported Windows |
| Additional target | Declare format explicitly | Declare its exact feed and architecture selection | Native hardware, bundled dependency compatibility, install and update evidence |

Windows portable EXE is outside the baseline. DMG is the macOS download offered to users; ZIP remains required for its self-update path.

## Checks before packaging

| ID | Check | Pass condition and evidence |
| --- | --- | --- |
| R01 | Freeze candidate and scope | All platform builds use the same recorded source revision and lockfile. List changes, affected runtimes, enabled commercial capabilities, prior stable version, service/configuration revisions, and open defects. Identify the build host and toolchain for each target. |
| R02 | Define deployment and recovery | Record service/client deployment order, compatibility with the previous client, rollback owner, previous artifacts/feed/configuration snapshots, data backup and recovery method. Set the publication time and staffed observation window. |
| B01 | Source quality | Source changes have current type, lint, dead-code and applicable regression evidence. `bun run check:changed` passes before a source commit. Record the base revision and actual files checked; choose additional release checks for the full candidate scope. |
| B02 | Regression coverage | Run `bun run test:customizations` on the final candidate plus focused owning-package and cross-runtime tests for changed contracts. For the first operational release, dependency changes, or broad upstream merges, run the full `bun run test` suite and relevant builds. Every unresolved failure has a disposition. |
| B03 | Complete native packaging | Use the current Electron packaging path on each native target. Stage SuperWeb, web UI, pinned OpenCode, ripgrep, embedded knowledge, skills/extensions and native modules. Preserve logs and bundled-resource receipts. Missing promised resources or `INCOMPLETE-CI` artifacts block release. |
| B04 | Inspect final artifacts | Read version, bundle/app identity, architecture and expected resource versions from the final package. Verify bundled CLI execution and native modules. Record filename, byte size and SHA-256 for every distributed file, including update payloads. Root/workspace/app/feed versions agree. |
| B05 | Verify operating-system trust | Proposed operational gate requires a valid Windows publisher signature and timestamp on installer/application, plus stable Developer ID signing, notarization and ticket validation for macOS. Keep Windows updater signature validation enabled and verify the accepted signed bundle before a custom macOS update swap. Test downloaded files under normal OS security settings. Record actual trust results and any reputation warning; unsigned or ad-hoc builds do not pass this gate. |

## Checks on installed clients

Run I01 through I06 and S01 through S07 on each baseline target using its exact final package. Use disposable projects and dedicated acceptance accounts. Record external charges and cleanup separately.

| ID | Check | Pass condition and evidence |
| --- | --- | --- |
| I01 | Clean installation | Install on a clean supported OS as an ordinary user. Launch from the normal app entry. Reach usable login/main UI without a source checkout or build tools. Confirm path handling, shortcuts and protocol registration. Preserve installer and launch logs. |
| I02 | Upgrade and preserve data | Upgrade a copy of a representative previous stable profile. Projects, histories, drafts, files, settings, model bindings and valid account state survive. Reopen and compare recorded fixture contents. Verify required migration failure recovery. Never test destructive recovery on a user's only profile. |
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
| S07 | Failed or interrupted billing | Exercise a controlled timeout/failure, cancellation, reconnect and repeated status retrieval using the same task identity. Reconcile reservations, refunds and final charges under the product's billing rules. No duplicate charge or unresolved reservation remains after the documented timeout. Test this in staging first; production checks use an approved bounded acceptance account. |
| S08 | Recharge and entitlement changes | Applies when payment, recharge, membership or commerce is enabled or changed. Verify order, payment, fulfillment, entitlement and ledger readback, including a duplicate callback and a recoverable failure. Use sandbox results for sandbox capability only. A capability still lacking real-payment acceptance stays disabled in production. |

## Checks on updates and recovery

| ID | Check | Pass condition and evidence |
| --- | --- | --- |
| U01 | Feed and artifact agreement | Generate feeds from the final accepted artifacts. JSON and YAML versions, URLs, architecture, byte sizes, SHA-256/SHA-512 and Chinese/English notes agree. Every required target has its own working channel. Reject stale, missing or upstream OpenChamber URLs. A missing Windows installer must fail the target's release even if the generator permits it. |
| U02 | Actual native update | On both targets, update an installed previous stable client to the exact candidate. Observe check, download, restart/install and relaunch. Verify the new executable and bundled OpenCode path/version, then repeat login, one real conversation and data-preservation checks. Preserve pre/post versions and payload hashes. Download completion alone cannot pass. |
| U03 | Update failure safety | Before first operation and whenever updater, packaging, trust or quit behavior changes, exercise interrupted download, invalid digest, installation/copy failure and close during install shutdown. The installed app/profile remains recoverable. Prove a close reached the app's own quit handling. Review OS-specific fixture and isolation limits before the run. |
| U04 | Production-shaped update source | Candidate testing must not expose unaccepted bytes through public Latest. Use a verified isolated feed/test setup and record its route plus any instrumented-client differences. After publication, repeat U02 on an unmodified previous stable client against the public feed. If a safe candidate test is unavailable, keep the release blocked and record the missing capability. |
| U05 | User update controls | Manual check, background-check setting, skipped version, no-update, error, progress and restart actions behave as documented in both languages. No separate upstream OpenCode update is offered for the bundled runtime. Test each advertised fallback separately. |
| U06 | Recover a bad installed version | Rehearse recovery before the first operational release and after installer/data-format changes. Restore a valid previous app/profile or publish a compatible higher-version recovery build. Confirm login, files and one conversation after recovery. Record restoration duration and any data gap. A copy-failure rollback does not prove recovery from a bad app that already launched. |

## Checks during publication

Stages R through U must pass before public promotion, except U04's explicitly marked public replay. Draft assets and internal candidate testing do not complete public acceptance.

| ID | Check | Pass condition and evidence |
| --- | --- | --- |
| P01 | Approve promotion | Coordinator and reviewer record the release decision, complete platform matrix, approved cosmetic exceptions, trust evidence and recovery readiness. Recheck current service health and candidate identity. Prepare all assets/feeds before changing public Latest or website links. |
| P02 | Publish exact accepted bytes | Upload and read back assets while draft or prerelease where possible. Promote only the complete accepted set. Record the exposure time and any non-atomic publication interval. Never replace published artifact bytes under the same version. |
| P03 | Read back public downloads | Download complete files from public user-facing URLs without maintainer authentication. Compare size and digest with accepted artifacts. Read public Latest, every feed and all referenced payload URLs. Verify the expected version, architecture and HTTP results. Cached local files or range-only probes cannot pass this check. |
| P04 | Verify website entry points | On actual macOS and Windows browsers, check homepage device selection and explicit download pages in Chinese/English. Links resolve to the correct current DMG or NSIS EXE. Check every advertised domain and redirect chain. Record mobile/unknown-device behavior if the homepage offers downloads there. |
| P05 | Verify public installed clients | Install the publicly downloaded artifacts and perform launch/login/default real call on both targets. Complete U04's public-feed update replay. Read back settlement for the public smoke task where billing is enabled. Failed public readback triggers containment and a recorded decision immediately. |

## Observation and release decisions

| ID | Check | Pass condition and evidence |
| --- | --- | --- |
| O01 | Operational visibility | Before promotion, confirm working crash/error, auth, model success/latency, update/install and billing diagnostics. Record dashboard/log access, known visibility gaps and alert recipient. No secrets or unnecessary user content enters acceptance evidence. If aggregation is unavailable, staff and record manual checks. |
| O02 | Observe and accept | Proposed initial observation windows are 30 minutes after promotion and a 24-hour follow-up. Compare against the previous stable release using the same OS/profile and model inputs. Record traffic/sample count, errors, support reports, latency and ledger anomalies. No traffic is insufficient evidence. Use scheduled acceptance probes if needed. |
| O03 | Contain and recover | Any confirmed data loss, account isolation failure, unauthorized access, wrong/duplicate charge, integrity failure or repeatable install/start/update blocker stops expansion immediately. Coordinator disables the affected offering or update promotion, preserves evidence, chooses compatible recovery, verifies it and records user impact. |

Each release record sets numeric warning and stop thresholds before promotion for crash/startup failure, auth failure, model failure/latency and update failure. Use the known stable baseline and a declared minimum sample/window. Unknown rates remain unknown; critical synthetic failures and the O03 conditions still trigger action. A threshold breach pauses expansion for triage. A confirmed release regression requires recovery.

Release states are `CANDIDATE`, `APPROVED_TO_PUBLISH`, `PUBLISHED_UNDER_OBSERVATION`, `ACCEPTED`, `BLOCKED` and `WITHDRAWN`. Prepublication checks lead to `APPROVED_TO_PUBLISH`. Public readback and the initial observation gate lead to `ACCEPTED`; the 24-hour review remains assigned until completed. A later failure may move an accepted release to `WITHDRAWN`.

Internal acceptance happens before public promotion. Do not describe a percentage rollout unless both clients and the hosting/feed mechanism enforce it. Current SuperWagie macOS uses its own JSON/ZIP updater; electron-updater's YAML rollout percentage alone does not establish a cross-platform rollout.

Retargeting a feed to an older version does not repair clients already upgraded. Preserve prior artifacts and immutable release records. Use a higher-version recovery build where downgrade is unsupported. Restore a profile/database only through the tested recovery method; first preserve new user data that would otherwise be lost. Backend recovery must remain compatible with both deployed client versions and must not restore an old billing database over new transactions.

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

The current manifest generator targets macOS arm64 and optionally Windows x64. Additional targets require explicit feed validation. Inherited upstream workflows do not all prepare the full SuperWagie resource set. Inspect the actual workflow and resource receipt for each artifact.

Current package configuration has macOS `notarize: false` and Windows `verifyUpdateCodeSignature: false`. These settings are unresolved against proposed B05. An actual signed/notarized artifact and active updater trust checks need verification before that gate can pass. macOS custom self-install must be assessed separately from Squirrel.Mac.

## References

- [Electron packaging and supported distribution](../../packages/electron/README.md#packaging)
- [Current Electron scripts and signing configuration](../../packages/electron/package.json)
- [Windows validation and remaining acceptance gates](../../packages/electron/WINDOWS-VALIDATION.md)
- [SuperWagie update behavior and feed contract](../specs/2026-10-24-auto-update.md)
- [Updater test isolation and quit/install evidence](../../.agents/skills/openchamber-change-discipline/references/updater-testing.md)
- [Identity, financial reads and commerce contracts](../../packages/web/server/lib/platform-account/DOCUMENTATION.md)
- [Platform model receipts and settlement contracts](../../packages/web/server/lib/platform-model/DOCUMENTATION.md)
- [Electron guidance on signing and macOS notarization](https://www.electronjs.org/docs/latest/tutorial/code-signing)
- [electron-builder 26 update channels and higher-version recovery](https://www.electron.build/v26/docs/features/auto-update/)
