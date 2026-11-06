# SuperWagie system audit implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax for tracking.

**Goal:** Complete every actionable task gap and defect found by repeated source and functional audits.

**Architecture:** Preserve existing module ownership and use reproducible findings to define narrow repair batches. Run independent read-only audits in parallel, serialize product changes and heavy/live validation, and preserve exact snapshots between rounds.

**Tech Stack:** TypeScript, React, Zustand, Bun, Node, Electron 44.9.3, OpenCode 2.2.5, Python bundled skills.

**Spec:** `docs/superpowers/specs/2026-11-06-system-audit-design.md`

## Global constraints

- The latest explicit user instruction authorizes release and supersedes the earlier no-commit, no-push, no-release and fixed-app-version constraints. Target 2.7.63 integrates audit checkpoint `7b9a8005f` with latest main `1d73bb005`. Keep OpenCode 2.2.5 and Electron 44.9.3; preserve the approved Omni Viewer approach and avoid unrelated dependency changes.
- Keep Omni Viewer, resolved-theme behavior, Hy/source retrieval, UniHub, Benma hints, updater feedback and existing customizations.
- Use one product-source writer and one heavy/live execution slot. Read-only review may run in parallel. Preserve existing work and every failed-run receipt.
- Do not alter real user accounts, profiles, providers, installed global skills or paid workflows. Use explicit isolated fixtures.
- Load matching project skills and owning documentation before source changes. All fixes receive a fresh independent review. Do not weaken checks or replace failures with success.

## Task 1: Reconcile scope and inspect current source

**Files:** Original November 5 spec/plan/report, current module source, new audit workspace `progress.md`, `task-audit-round1.md`, `code-audit-round1.md`, `functional-matrix.md`.

- [x] Verify the restored worktree and current source against the previous completion snapshot; preserve unrelated differences.
- [x] Map all original requirements, deferred defects and evidence limits to current code and a specific completion or validation action.
- [x] Independently inspect frontend/server/native/bundled-runtime integration and return concrete reachable findings with reproduction instructions.
- [x] Inventory package test commands and prepare an isolated frontend/backend/UI matrix with exact entrypoints, expected outcomes and cleanup.

## Task 2: Execute baseline suites and repair confirmed defects

**Files:** Package test scripts and each finding's owning module/test/documentation, named in the finding-specific brief before edits.

- [x] Run the package-defined root test sequence serially, retaining each package exit and full log so an early failure cannot hide later packages.
- [x] Reproduce each candidate defect on unchanged source and record the failing assertion or concrete UI/API output.
- [x] Dispatch one bounded implementer at a time with the exact finding, affected consumers, expected behavior and regression command.
- [x] Capture each fix delta, run its focused regressions, then obtain independent specification and quality review before the next repair batch.

## Current checkpoint

All 47 accepted findings are closed, comprising 34 product and 13 validation categories. The final r14 actual UI run passes 29 checks, and the packaged ARM64 startup passes. Independent source/integration and final evidence reviews accept their recorded scopes. GitHub v2.7.63 and all 11 assets/public feeds are verified at application commit `d7bdd70313a47468f76d373e4382910c645ab072`. Website deployment remains incomplete because SSH authentication failed. Later documentation and website-metadata commits do not change the packaged application. [Canonical report](../reports/2026-11-06-system-audit.md) records the exact receipts and platform limits.

## Task 3: Exercise actual frontend/backend/UI behavior

**Files:** New audit scratch scenarios, actual application entrypoints and any defects proven by these scenarios.

- [x] Launch isolated application/runtime fixtures using production components and owned local API data. Test navigation, settings, sessions/composer, questions, Office preview, plugins/MCP, updater feedback and error/retry states selected in the functional matrix.
- [x] Exercise server auth, filesystem/read bounds, runtime switching and cancellation with concrete success/failure responses; distinguish fixture provider behavior from real external providers.
- [x] Cover the previous native-bundle entrypoint and bundled-skill readiness gaps where the current host provides the required runtime. Report unsupported hosts without claiming acceptance.
- [x] For every failure, distinguish harness defects from product defects, repair product defects through Task 2, and rerun the original failing scenario plus affected regressions.
- [x] Retain screenshots/results/source identities and verify all owned processes, profiles and listeners are cleaned up.

## Task 4: Repeat review and close the audit

**Files:** Audit round reports, final exact snapshot, `docs/superpowers/reports/2026-11-06-system-audit.md`.

- [x] Perform a fresh independent second code pass with the findings ledger and exact final diff, including previously deferred low-impact defects.
- [x] Reconcile requirements again against the final implementation and functional receipts; no accepted finding may remain open.
- [x] Run `bun run check:changed -- --base 73d6cb97884ddf9873cf03e06db55271d4d41d54`, `bun run test:customizations` and affected builds when final changes require them. Reuse unchanged exact-source evidence rather than repeat unrelated expensive runs.
- [x] Obtain a final independent whole-branch review of code, task closure and test claims. If it finds an actionable issue, return to the owning repair and regression cycle, then review the new final state.
- [x] Publish a canonical checkpoint report mapping all three user requests to results, repair counts and precise validation limits. Preserve pending actual UI and release results explicitly.
- [x] Append final integrated validation, actual UI and GitHub release receipts, then issue the final task/evidence verdict. Website deployment remains tracked separately below.

## Task 5: Complete the authorized release

- [x] Record audit source checkpoint `7b9a8005f` and integrate latest main `1d73bb005` for release target 2.7.63, as confirmed by the coordinator.
- [x] Complete the applicable checks and consumer/package builds on the integrated release tree.
- [x] Complete selected actual UI acceptance and resolve VAL-11 from its final receipt and cleanup review.
- [x] Publish default macOS ARM64 and Windows x64 artifacts and verify GitHub release and public updater-feed bytes. Other architectures require explicit user scope.
- [ ] Deploy the prepared website/download mirror after SSH access is restored, then verify public page/feed/artifact readback.
- [x] Report GitHub identities and platform boundaries without treating package builds as installation acceptance. Explicitly retain incomplete website deployment.
