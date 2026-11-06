# SuperWagie system audit implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax for tracking.

**Goal:** Complete every actionable task gap and defect found by repeated source and functional audits.

**Architecture:** Preserve existing module ownership and use reproducible findings to define narrow repair batches. Run independent read-only audits in parallel, serialize product changes and heavy/live validation, and preserve exact snapshots between rounds.

**Tech Stack:** TypeScript, React, Zustand, Bun, Node, Electron 44.9.3, OpenCode 2.2.5, Python bundled skills.

**Spec:** `docs/superpowers/specs/2026-11-06-system-audit-design.md`

## Global constraints

- Keep app 2.7.59, OpenCode 2.2.5 and Electron 44.9.3. No LibreOffice integration, unrelated dependency upgrade, release, commit, push or deployment.
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

## Task 3: Exercise actual frontend/backend/UI behavior

**Files:** New audit scratch scenarios, actual application entrypoints and any defects proven by these scenarios.

- [ ] Launch isolated application/runtime fixtures using production components and owned local API data. Test navigation, settings, sessions/composer, questions, Office preview, plugins/MCP, updater feedback and error/retry states selected in the functional matrix.
- [ ] Exercise server auth, filesystem/read bounds, runtime switching and cancellation with concrete success/failure responses; distinguish fixture provider behavior from real external providers.
- [ ] Cover the previous native-bundle entrypoint and bundled-skill readiness gaps where the current host provides the required runtime. Report unsupported hosts without claiming acceptance.
- [ ] For every failure, distinguish harness defects from product defects, repair product defects through Task 2, and rerun the original failing scenario plus affected regressions.
- [ ] Retain screenshots/results/source identities and verify all owned processes, profiles and listeners are cleaned up.

## Task 4: Repeat review and close the audit

**Files:** Audit round reports, final exact snapshot, `docs/superpowers/reports/2026-11-06-system-audit.md`.

- [x] Perform a fresh independent second code pass with the findings ledger and exact final diff, including previously deferred low-impact defects.
- [ ] Reconcile requirements again against the final implementation and functional receipts; no accepted finding may remain open.
- [x] Run `bun run check:changed -- --base 73d6cb97884ddf9873cf03e06db55271d4d41d54`, `bun run test:customizations` and affected builds when final changes require them. Reuse unchanged exact-source evidence rather than repeat unrelated expensive runs.
- [ ] Obtain a final independent whole-branch review of code, task closure and test claims. If it finds an actionable issue, return to the owning repair and regression cycle, then review the new final state.
- [ ] Publish a local report mapping all three user requests to results, repair counts, review rounds and precise validation limits. Keep source uncommitted and unpublished.
