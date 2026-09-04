# Windows 11 Technical Validation Completion Plan

> **For Codex:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task by task. Apply systematic-debugging to every unexpected failure, test-driven-development to every code fix, and verification-before-completion before reporting results.

**Goal:** Complete every automatable `windows-11-x64` technical-validation item in the Windows handoff, preserve honest external blockers, and produce repeatable evidence without upgrading unsigned or human-unreviewed results to production approval.

**Architecture:** Reuse the existing Solution B disposable candidates and their Rust Product Core / Electron Surface / isolated Worker contracts. Parameterize platform identity and host probes at the boundary; do not create a second Windows implementation. Evidence remains fixture-scoped, hash-bound, immutable, and non-admitting until required signing, clean-machine, real-host, and Owner gates exist.

**Tech Stack:** Node.js 24.18.0, Rust stable MSVC, Visual Studio Build Tools/Windows SDK/WDK, Electron 44.1.0, PowerShell 7, WPS Office, FFmpeg/ffprobe, Node test runner, Vitest.

---

## Task 1: Repair and prove the Windows toolchain baseline

**Files:**

- Modify only if a portability defect is proven: `scripts/poc/gate-3/windows-toolchain-identity.mjs`
- Test: `scripts/poc/gate-3/windows-contract.test.mjs`
- Test: `scripts/poc/gate-3/windows-workflow-contract.test.mjs`
- Evidence input: `docs/技术可行性/Windows11-x64-验证交接清单.md`

1. Install exactly Node.js 24.18.0, Visual Studio C++ Build Tools, Windows SDK/WDK, and verify WPS/FFmpeg identities.
2. Run the existing Windows contract test first and retain the exact failing output.
3. If the failure is a repository portability defect, add a focused failing test before modifying the resolver; otherwise repair the host dependency/environment only.
4. Re-run the focused contract, workflow contract, and environment-gate tests until green.
5. Record exact executable paths, versions, hashes, platform identity, and remaining reboot/manual prerequisites in local evidence.

## Task 2: Close W00–W02 baseline gates

**Files:**

- Verify: `scripts/check-spec-refs.mjs`
- Verify: `scripts/poc/validation-status-audit.mjs`
- Verify: all package manifests below `scripts/poc/`

1. Run spec-reference, hygiene, registry, and schema audits.
2. Run the complete Node, Vitest, Python, Rust, and Electron suites using the pinned Node executable and Windows MSVC environment.
3. Fix only reproduced defects, one failing test at a time.
4. Repeat the complete baseline suite after the last fix and retain a machine-readable summary.

## Task 3: Implement and validate W10 Windows Solution B candidate

**Files:**

- Modify: `scripts/poc/solution-b-spike/src/electron-main.mjs`
- Modify: `scripts/poc/solution-b-spike/src/build-evidence.mjs`
- Modify as required: `scripts/poc/solution-b-spike/src/core-supervisor.mjs`
- Modify as required: `scripts/poc/solution-b-spike/src/secure-files.mjs`
- Test: `scripts/poc/solution-b-spike/tests/*.test.mjs`

1. Add failing Windows platform-contract tests for canonical `windows-11-x64` identity, candidate manifest hashes, named-pipe/private-channel behavior, process-tree cleanup, junction/reparse containment, offline operation, and redacted evidence.
2. Replace macOS-only boundary assertions with explicit supported-platform descriptors while preserving a single implementation and fail-closed behavior.
3. Build the native secure filesystem helper and actual Electron/Rust candidate on Windows.
4. Run the actual Electron test, crash/recovery cases, and security-boundary suite.
5. Generate a Windows child evidence bundle that explicitly records unsigned/manual/clean-machine limitations and has no admission effect.

## Task 4: Implement and validate W11 dependency, isolation, attack, and extension checks

**Files:**

- Modify: `scripts/poc/solution-b-task5/src/task5-lib.mjs`
- Modify: `scripts/poc/solution-b-task5/src/build-evidence.mjs`
- Modify as required: `scripts/poc/solution-b-task5/src/task5-worker.mjs`
- Test: `scripts/poc/solution-b-task5/tests/*.test.mjs`

1. Add failing tests for Windows platform identity, absolute executable resolution, clean environment construction, process-tree termination, PATH/config isolation, tamper rejection, and facade-only extension lifecycle.
2. Parameterize platform-specific host operations without weakening manifest, hash, audience, permission, or quarantine checks.
3. Run G0-DEPS, G0-ISOLATION, G5-ATTACK, and G5-EXT on the actual Windows candidate.
4. Generate four hash-bound Windows child runs with conditional/non-admitting decisions and explicit remaining sandbox/signing limitations.

## Task 5: Implement and validate W12 five Windows video profiles

**Files:**

- Modify: `scripts/poc/solution-b-task6/src/task6-lib.mjs`
- Modify: `scripts/poc/solution-b-task6/src/build-profile-evaluation.mjs`
- Modify as required: `scripts/poc/solution-b-task6/src/task6-media.mjs`
- Test: `scripts/poc/solution-b-task6/tests/*.test.mjs`

1. Add failing Windows tests for all five profiles, canonical platform identity, Chromium/FFmpeg/font identities, frame determinism, checkpoint recovery, process-tree cleanup, media decode, subtitles, motion, black-frame, and silence checks.
2. Parameterize candidate metadata and platform process handling while retaining exact-frame evaluation and authenticated progress receipts.
3. Render and decode real representative samples for website demo, teaching courseware, PPT narration, picture book, and photo motion.
4. Generate five fixture-scoped Windows evaluation bundles with hashes and honest cross-platform/manual limitations.

## Task 6: Implement and validate W13 Windows WPS/Office Review

**Files:**

- Modify: `scripts/poc/solution-b-task7/src/review-shell-host.mjs`
- Modify: `scripts/poc/solution-b-task7/src/wps-identity-probe.py`
- Modify: `scripts/poc/solution-b-task7/src/build-evidence.mjs`
- Modify as required: `scripts/poc/solution-b-task7/src/task7-wps-truth.mjs`
- Test: `scripts/poc/solution-b-task7/tests/*.test.mjs`
- Verify: `scripts/poc/gate-3/reviewer-ui/src/*.test.ts`

1. Add failing tests for Windows platform identity, WPS absolute identity/signature/version binding, controlled-copy containment, authoritative rendered-page binding, cache integrity, re-render, crash/restart/reopen, and no Codex Desktop coupling.
2. Add the Windows WPS host adapter/probe using structured arguments and isolated process-tree cleanup; retain external/side-by-side fallback when automation is not trustworthy.
3. Run DOCX/PPTX/PDF review interactions, page cache/zoom/lazy loading, annotations, divergence detection, and recovery against the installed WPS host where automation permits.
4. Generate Windows Review child evidence; record PowerPoint comparison, clean-machine installation, production signature, and Owner visual acceptance as external blockers when unavailable.

## Task 7: Execute W20–W39 and update the Windows validation record

**Files:**

- Modify: `docs/技术可行性/Windows11-x64-验证报告-2026-09-04.md`
- Modify only from valid evidence: `docs/技术可行性/当前技术验证状态.json`
- Verify: `docs/技术可行性/Windows11-x64-验证交接清单.md`

1. Run every W20–W39 fixture using `platform=windows-11-x64` and the repository runner where supported.
2. For each item, record command, timestamp, candidate hash, raw result, logs/artifacts, and one of `VERIFIED`, `FIXED`, or `EXTERNAL_BLOCKED`.
3. Never translate mock, macOS, unsigned, single-machine, or unreviewed evidence into Windows/production PASS.
4. Update the registry only through its validator and only where current evidence satisfies the declared fixture contract.

## Task 8: Multi-round review, regression, and release handoff

**Files:**

- Review: all changed files
- Verify: all package test/build/lint scripts and gate runners

1. Review the full diff for correctness, security boundary regressions, hidden platform assumptions, evidence trust, secrets, absolute paths, and generated artifacts.
2. Run the complete frontend/backend/UI/Electron/Rust/Python regression suite.
3. Perform an actual UI interaction smoke run for Markdown, HTML browser review, Electron surfaces, and WPS Review where the host permits.
4. Repeat review and regression after every fix until no actionable defect remains.
5. Run `node scripts/check-spec-refs.mjs`, repository hygiene checks, `git diff --check`, and status audit.
6. Summarize automatable completion separately from external production gates (Authenticode/Owner, clean-machine matrix, PowerPoint comparison, macOS counterpart, and official remote services).
