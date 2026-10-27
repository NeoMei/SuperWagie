# SuperWagie release acceptance record

Draft template for the proposed [release checklist](RELEASE_CHECKLIST.md), not
adopted policy. Copy it to a sibling `<version>-<candidate>-acceptance.md` file
so its relative links remain valid. Fill required fields before the corresponding
stage. Empty results mean `NOT_RUN`.

## Candidate identity

| Field | Value |
| --- | --- |
| Release version and candidate ID | |
| Checklist revision | Draft 0.1, 2026-10-27 |
| State | CANDIDATE |
| Source revision and baseline revision | |
| Dependency lock SHA-256 | |
| Build hosts and toolchain versions | |
| Previous stable version | |
| OS versions and architectures supported | |
| Changed features, contracts and regressions | |
| Critical service/configuration/catalog/price revisions | |
| Enabled commercial capabilities | |
| Coordinator, reviewer and recovery owner | |
| Planned promotion time and time zone | |
| Observation end and 24-hour review owner/time | |
| Dedicated acceptance account reference and cost cap | |
| Evidence directory and retention/access policy | |

Keep credentials, access-bearing URLs and customer content out of this record. Use sanitized account and transaction references.

## Artifact inventory

| Platform and OS | Source revision | Filename | Bytes | SHA-256 | Embedded runtime/resource versions | Signature and notarization evidence | Installed-client evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| macOS arm64 | | | | | | | |
| macOS arm64 ZIP | | | | | | | |
| Windows x64 NSIS | | | | | | | |

Inventory checksum files and feeds as well. For Windows, retain the base64 SHA-512 used by `latest.yml`. Record exact public URLs and independent downloaded digests during P03. Add a row per additional delivered target.

## Check results

Use one row per ID and platform/environment. Duplicate rows where needed. Each PASS includes the actual result and a log, screenshot, receipt or digest reference. Apply the checklist's service applicability and per-target evidence rules.

| Check ID | Platform, OS and environment | Status | Expected and actual result | Evidence and time | Executor and reviewer |
| --- | --- | --- | --- | --- | --- |
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

For every N/A, state the applicability rule and reviewer. For BLOCKED/FAIL, retain the cause, user impact and next action. Record failed attempts and candidate changes even after a later pass.

## Model and financial evidence

| Client target and service revision | Provider/model/capability | New test or dated unchanged baseline | Task/receipt reference | Pre/post ledger and expected amount | Actual final charge/reservation/refund | Result and evidence |
| --- | --- | --- | --- | --- | --- | --- |
| | | | | | | |

Record applicable S03-S08 results using the checklist's model, billing and commerce rules. Distinguish sandbox from production and record observation time for asynchronous settlement.

## Publication and observation

| Metric or event | Previous stable baseline | Minimum sample and window | Warning threshold | Stop threshold and action | Observed result/evidence |
| --- | --- | --- | --- | --- | --- |
| Crash and startup failure | | | | | |
| Login failure | | | | | |
| Default/model call failure and latency | | | | | |
| Download/install/update failure | | | | | |
| Billing, data integrity and account isolation | | | | Any confirmed defect triggers O03 | |

Record P01-P05 and O01-O03 evidence, including public promotion time, URLs, downloaded digests, sample counts, observation ownership and visibility gaps.

## Recovery plan and rehearsal

| Field | Value and evidence |
| --- | --- |
| Last good source, installers, hashes, feeds and configuration | |
| Candidate and previous-client service compatibility | |
| Data migration/backup and safe restore procedure | |
| How to stop offering the bad release | |
| Recovery build or tested reinstall procedure | |
| Recovery owner and contact method | |
| Rehearsal date, duration, preserved/lost data and verification | |
| Billing transaction preservation during service recovery | |

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
