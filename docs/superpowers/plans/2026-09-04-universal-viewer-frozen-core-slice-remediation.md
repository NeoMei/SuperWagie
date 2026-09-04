# Universal Viewer Frozen Core Slice Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the PPT-to-PDF editing closure from the disposable Frozen Core Office slice without mutating upstream source, regenerate honest admission evidence, and re-run every locally executable gate and system test.

**Architecture:** Keep the exact upstream commit and zero-patch ledger pristine. Narrow `viewer-office` to the interfaces SuperWagie actually consumes—`parsePptxVscode`, `mountPptDocument`, DOCX mount, and slide rendering—so tree shaking cannot retain `mountPptViewer` or its PDF conversion/editing closure. Rebuild all bound evidence from the exact candidate, then run the public GVP-0 path; a real registry failure remains `BLOCKED_ENVIRONMENT` and must never be converted into a receipt.

**Tech Stack:** Node.js 24.18.0, npm 11.16.0, ES modules, Node test runner, Rolldown 1.1.5, JSON Schema 2020-12, JSDOM.

**Spec:** `docs/superpowers/specs/2026-09-04-superwagie-universal-viewer-platform-design.md`

## Global Constraints

- Preserve upstream commit `ffdcda3eea83527380996ac935605f1422e43d3b`, Git tree `37ed0235fb0da0124d51e5815def4f832b3724d2`, archive SHA-256 `1e0681afd02d7b6887bb373d5256eabcab69f8ac3015aa8372dd5e0754cc698d`, and `patches: []`.
- Viewer opening may not call WPS, Office, LibreOffice/`soffice`, WpsComposer, FFmpeg, online conversion, a system command, or a first-use download (R-VP-03, R-QS-08).
- The selected executable closure must have exactly zero forbidden runtime edges and zero unexcepted reachable moderate-or-higher vulnerabilities (VIEWER §15.1, R-VP-07).
- `mountPptViewer` is not a SuperWagie Office-slice entry point because it owns an upstream PDF conversion fallback; use `parsePptxVscode` followed by `mountPptDocument`.
- The source tree is immutable. Remediation changes SuperWagie selection/build/test/evidence code only; no file under `.candidate/source` may change.
- `ready` remains fail-closed: unknown OOXML content, namespace, relationship, feature, font, or recovery path forces scoped `partial` (R-VP-02).
- Live vulnerability evidence must come from the admitted npm audit command. Timeout or audit endpoint failure is `BLOCKED_ENVIRONMENT`, exit `2`, and produces no receipt.
- GVP-1–5, every Format Admission Ledger record, production implementation, production Registry, signing, and release remain blocked by their own missing evidence.
- No production UI is created in this plan. UI testing applies only to existing PoC/prototype surfaces and must report absence of a production frontend honestly.
- Run `node scripts/check-spec-refs.mjs` before every task completion commit that changes authority, report, or plan files.

---

### Task 1: Remove the PDF editing closure from the Office chunk

**Files:**
- Modify: `scripts/poc/universal-viewer/tests/office-closure-smoke.test.mjs`
- Modify: `scripts/poc/universal-viewer/chunk-plan.json`
- Modify: `scripts/poc/universal-viewer/office-closure-smoke.mjs`

**Interfaces:**
- Consumes: `parsePptxVscode(bytes, options?)`, `mountPptDocument(deck, container, ctx, options?)`, `renderSlide(slide, zoom)` from the frozen Core.
- Produces: an Office bundle with executable DOCX and PPTX read-only rendering and no `mountPptViewer`, PDF viewer, PDF editing, conversion, save, writeback, or file-pick closure.

- [ ] **Step 1: Write the failing slice test**

Change the existing Office closure assertion to require:

```js
const bundlePath = path.join(outputRoot, 'viewer-office', 'viewer-office.mjs');
const officeBundle = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
assert.equal(result.decision, 'GO');
assert.equal(result.module_graph.forbidden_runtime_edges, 0);
assert.equal(result.module_graph.chunks.find(({ chunk_id }) => chunk_id === 'viewer-office')
  .modules.some((id) => id.includes('/viewers/pdf/')), false);
assert.equal(typeof officeBundle.mountPptViewer, 'undefined');
```

The test must still assert DOCX `ready`, PPTX parse `ok`, `mount_mode === 'slides'`, and both deterministic visible smoke strings.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
NPM_CONFIG_OFFLINE=true VITEST_MIN_WORKERS=1 VITEST_MAX_WORKERS=1 \
node --test --test-concurrency=1 tests/office-closure-smoke.test.mjs
```

Expected: FAIL because the current chunk exports `mountPptViewer`, retains `dist/viewers/pdf/index.js` and `editing.js`, and reports 8 forbidden runtime edges.

- [ ] **Step 3: Narrow the selected entry exports**

In `chunk-plan.json`, replace the PPT entry export list with exactly:

```json
{"source":"src/viewers/ppt/index.ts","exports":["mountPptDocument","PPT_VIEWER_META"]}
```

Keep the parser and `renderSlide` exports unchanged.

- [ ] **Step 4: Make the smoke use the read-only composition**

Require `mountPptDocument` instead of `mountPptViewer`, then mount the already parsed deck:

```js
const ppt = module.mountPptDocument(
  parsed.result.document,
  pptContainer,
  ctx,
  { styleIsolation: 'scoped', diagnostics: parsed.result.diagnostics },
);
```

Do not add conversion or PDF dependencies.

- [ ] **Step 5: Run focused and boundary tests**

Run:

```bash
NPM_CONFIG_OFFLINE=true VITEST_MIN_WORKERS=1 VITEST_MAX_WORKERS=1 \
node --test --test-concurrency=1 \
  tests/office-closure-smoke.test.mjs \
  tests/source-policy-audit.test.mjs \
  tests/chunk-audit.test.mjs
```

Expected: all pass; built module graph contains no `dist/viewers/pdf/*` and has `forbidden_runtime_edges: 0`.

- [ ] **Step 6: Verify source immutability and commit**

Run:

```bash
git -C scripts/poc/universal-viewer/.candidate/source status --short
git -C scripts/poc/universal-viewer/.candidate/source rev-parse HEAD
git -C scripts/poc/universal-viewer/.candidate/source rev-parse HEAD^{tree}
git diff --check
```

Expected: empty status and the exact identities in Global Constraints.

Commit:

```bash
git add scripts/poc/universal-viewer/chunk-plan.json \
  scripts/poc/universal-viewer/office-closure-smoke.mjs \
  scripts/poc/universal-viewer/tests/office-closure-smoke.test.mjs
git commit -m "fix: isolate PPT rendering from PDF editing"
```

---

### Task 2: Propagate the zero-edge result through malicious and GVP-0 evidence

**Files:**
- Modify: `scripts/poc/universal-viewer/tests/malicious-corpus.test.mjs`
- Modify: `scripts/poc/universal-viewer/tests/gvp-0-gate.test.mjs`
- Modify: `scripts/poc/universal-viewer/malicious-corpus.mjs`
- Modify: `scripts/poc/universal-viewer/baseline-evidence/**`
- Modify: `scripts/poc/universal-viewer/dist/**`

**Interfaces:**
- Consumes: Task 1 build result with `decision: GO`, `forbidden_runtime_edges: 0`, zero-patch provenance, and non-placeholder DOCX/PPTX smoke.
- Produces: a regenerated, hash-bound baseline in which malicious behavior and aggregate admission agree on `GO / 0`, while chunks remain unsigned and non-production-loadable.

- [ ] **Step 1: Write failing propagation tests**

Change the real-candidate expectations to:

```js
assert.equal(result.metrics.forbidden_runtime_edges, 0);
assert.equal(result.thresholds.forbidden_runtime_edges, 0);
assert.equal(result.behavior.pass, true);
assert.equal(result.pass, true);
assert.equal(result.decision, 'GO');
```

Change the complete-current-fixture GVP-0 expectation to a schema-valid `GO` receipt and exit `0`; retain mutations proving any forbidden edge, vulnerability, stale artifact, or tampered binding returns `NO_GO` or an environment/input failure as appropriate.

- [ ] **Step 2: Run the two focused suites and verify RED**

Run:

```bash
NPM_CONFIG_OFFLINE=true VITEST_MIN_WORKERS=1 VITEST_MAX_WORKERS=1 \
node --test --test-concurrency=1 \
  tests/malicious-corpus.test.mjs tests/gvp-0-gate.test.mjs
```

Expected: FAIL because `malicious-corpus.mjs` currently requires the old `NO_GO / 8` baseline and the tracked evidence still binds that decision.

- [ ] **Step 3: Generalize the malicious aggregate rule**

Validate the admission evidence structurally, then calculate aggregate pass from the declared threshold:

```js
const admissionPass = admissionEvidence.decision === 'GO'
  && admissionEvidence.forbidden_runtime_edges === acceptance.thresholds.forbidden_runtime_edges;
const aggregatePass = behavior.pass && admissionPass;
```

Reject negative, non-integer, mismatched, or incoherent edge counts. Preserve `NO_GO` when behavior passes but admission does not.

- [ ] **Step 4: Rebuild the exact candidate evidence**

Run:

```bash
node build-candidate.mjs \
  --candidate-root "$PWD/.candidate/source" \
  --output-root "$PWD/dist"
```

The build must run upstream typecheck/tests/build, both dependency audits, SBOM generation, module graph, Office smoke, chunk audit, provenance verification, and baseline index regeneration. If live npm audit fails, record the environment failure and retry only after the endpoint responds; do not substitute cached vulnerability data for the tracked baseline generation.

- [ ] **Step 5: Run the focused tests GREEN**

Run the Step 2 command again.

Expected: all pass; the complete local acceptance path emits `GO`, while all tamper, stale, malformed, and forbidden-edge cases still fail closed.

- [ ] **Step 6: Run the complete Universal Viewer suite and commit**

Run:

```bash
NPM_CONFIG_OFFLINE=true VITEST_MIN_WORKERS=1 VITEST_MAX_WORKERS=1 \
node --test --test-concurrency=1 tests/*.test.mjs
```

Commit the implementation plus deterministic tracked baseline/dist changes only:

```bash
git add scripts/poc/universal-viewer
git commit -m "test: rebaseline zero-edge viewer admission"
```

---

### Task 3: Re-run public GVP-0 and publish the truthful result

**Files:**
- Modify: `docs/技术可行性/Universal-Viewer-Frozen-Core-准入报告.md`
- Modify: `docs/技术可行性/当前技术验证状态.json` only through the audited updater when it accepts the new evidence
- Modify: `fixtures/gvp-0/GVP-0-CORE-001/environment-attempts/**` only for a new reviewed exit-2 bundle
- Modify: `docs/superpowers/specs/2026-09-04-superwagie-universal-viewer-platform-design.md` appendix only

**Interfaces:**
- Consumes: Task 2 zero-edge baseline and the public `run-gate.sh gvp-0` route.
- Produces: either a real schema-valid, hash-bound macOS GVP-0 receipt or a newly reviewed `BLOCKED_ENVIRONMENT` attempt with no receipt; both keep Windows, GVP-1–5, format admission, production, and release unpromoted.

- [ ] **Step 1: Execute the public route without weakening freshness**

Run:

```bash
./scripts/poc/run-gate.sh gvp-0 \
  --platform macos-15-arm64 \
  --fixture GVP-0-CORE-001 \
  --candidate-root "$PWD/scripts/poc/universal-viewer/.candidate/source"
```

Accept only exit `0` with a validated `GO` receipt, exit `1` with a validated `NO_GO` receipt, or exit `2` with no receipt and a sanitized error envelope.

- [ ] **Step 2: Reproduce and classify any live-audit failure**

If Step 1 exits `2`, run the same two `npm audit --omit=dev --json` commands with diagnostic fetch timeout and zero retries. Record `FETCH_ERROR request-timeout` against `https://registry.npmjs.org/-/npm/v1/security/advisories/bulk` only if reproduced. Do not increase the formal timeout merely to convert the state.

- [ ] **Step 3: Update reviewed evidence and status through authority**

Capture the exact public-run identifier without inventing a name:

```bash
GVP_RUN_MANIFEST="$(rg --files evidence/gvp-0 -g manifest.json | sort | tail -n 1)"
GVP_RUN_ID="$(node -e 'const m=require(process.argv[1]); process.stdout.write(m.run_id)' "$GVP_RUN_MANIFEST")"
GVP_REVIEW_BUNDLE="fixtures/gvp-0/GVP-0-CORE-001/environment-attempts/$GVP_RUN_ID"
```

Create the new direct-child bundle at `$GVP_REVIEW_BUNDLE` with the exact nine roles, SHA-256 index, platform identity, empty receipt files, and sanitized logs, then run:

```bash
node scripts/poc/validation-status-audit.mjs \
  --environment-attempt-bundle "$GVP_REVIEW_BUNDLE" \
  --update-status docs/技术可行性/当前技术验证状态.json
```

For exit `0`, preserve the receipt in the report and do not add a status projection path unless its full tracked-bundle validator is implemented test-first and independently reviewed.

- [ ] **Step 4: Update the report and design appendix**

State separately:

- selected closure: `GO / forbidden_runtime_edges=0 / patches=0`;
- public macOS GVP-0: actual exit, receipt hash if and only if present;
- Windows: missing without a real Windows 11 x64 CIM + Job Object run;
- GVP-1–5 and 89 format records: `RESEARCH_REQUIRED`;
- production and release: `NO_GO`.

The original plan Completion Definition item 4 becomes satisfied only after the regenerated graph is verified. Item 6 becomes satisfied only if Step 1 actually emits the required receipt.

- [ ] **Step 5: Verify documentation and commit**

Run:

```bash
node scripts/check-spec-refs.mjs
node scripts/poc/viewer-authority-audit.mjs
node scripts/poc/viewer-ledger-audit.mjs
node scripts/poc/viewer-history-audit.mjs
node scripts/poc/validation-status-audit.mjs --status docs/技术可行性/当前技术验证状态.json
git diff --check
```

Commit only reviewed evidence, status, report, and appendix changes:

```bash
git add docs fixtures/gvp-0/GVP-0-CORE-001/environment-attempts
git commit -m "docs: publish remediated viewer admission result"
```

---

### Task 4: Perform repeated whole-system review and test rounds

**Files:**
- Create: `.superpowers/sdd/2026-09-04-universal-viewer-frozen-core-slice-remediation/system-test-report.md`
- Modify: only files required by reproduced Critical/Important bugs

**Interfaces:**
- Consumes: the complete branch, all project package manifests, Node test files, prototype HTML, status contracts, and frozen candidate identity.
- Produces: at least two clean consecutive review/test rounds, or exact evidence for an external/platform blocker that cannot be fixed in this worktree.

- [ ] **Step 1: Inventory every executable test/build surface**

Use `rg --files` to enumerate all `package.json`, `Cargo.toml`, `*.test.mjs`, `*.test.ts`, shell runners, and HTML prototypes. Record each discovered surface and its command in `system-test-report.md`; do not claim a frontend/backend test for a component that has no implementation.

- [ ] **Step 2: Run backend, contract, PoC, and static suites**

At minimum run:

```bash
node scripts/check-spec-refs.mjs
npm --prefix scripts/poc/contract-foundation test
NPM_CONFIG_OFFLINE=true VITEST_MIN_WORKERS=1 VITEST_MAX_WORKERS=1 \
  node --test --test-concurrency=1 scripts/poc/universal-viewer/tests/*.test.mjs
node --test scripts/poc/*.test.mjs
```

Run every additional test/build command discovered in Step 1 with its own locked dependency directory. Record pass/fail/skip counts and exact environmental skips.

- [ ] **Step 3: Test existing UI/prototype interaction surfaces**

If an executable Electron/HTML prototype exists, start it locally and use its real browser test harness for navigation, keyboard, focus, state transitions, and console errors. If only static prototypes exist, validate parse/load, referenced assets, internal anchors, viewport overflow, keyboard-focusable controls, and JavaScript errors. Record that a production SuperWagie frontend/backend cannot be UI-tested because it is absent; absence is not a passing UI result.

- [ ] **Step 4: Run review round 1 and fix reproduced defects**

Review the complete branch against the plan, VIEWER design, R-VP-01–11, R-RI-11, R-SE-07/11/12, R-QS-02/03/08, and R-RP-07/09. For each Critical/Important issue, reproduce first, add a failing regression test, implement the smallest root-cause fix, and re-run the affected suite.

- [ ] **Step 5: Run review round 2 from a fresh diff package**

Generate a new whole-branch review package after round-1 fixes. The second reviewer must inspect task completion, security boundaries, path handling, evidence integrity, concurrency, cleanup, error redaction, cross-platform assumptions, and test quality. Fix every reproduced Critical/Important issue using the same RED/GREEN process.

- [ ] **Step 6: Run a final complete verification twice**

Run the commands from Steps 2–3 twice consecutively on the same clean tree. Both rounds must have identical pass/fail/skip classification. Also run:

```bash
git -C scripts/poc/universal-viewer/.candidate/source status --short
git -C scripts/poc/universal-viewer/.candidate/source rev-parse HEAD
git -C scripts/poc/universal-viewer/.candidate/source rev-parse HEAD^{tree}
git diff --check
git status --short --branch
```

- [ ] **Step 7: Commit any final reviewed fixes**

If review produced changes, commit them atomically with their tests. If no changes were needed, do not create an empty commit. Do not push, merge, publish, or release.

## Completion Definition

This remediation plan is complete when:

1. the exact pristine Frozen Core source remains unchanged with a zero-patch ledger;
2. the selected base+office executable module graph has zero forbidden runtime edges and no PDF editing/conversion closure;
3. DOCX and PPTX PoC rendering still produces deterministic non-placeholder content through read-only interfaces;
4. dependency, license, SBOM, vulnerability, provenance, chunk, malicious-input, and GVP validation suites all pass or report a truthful external `BLOCKED_ENVIRONMENT` without receipt;
5. the public GVP-0 runner is re-executed and its actual result is published without promoting Windows, GVP-1–5, formats, production, or release;
6. two consecutive whole-system review/test rounds find no remaining reproducible Critical/Important defect in implemented scope;
7. the production UI absence and Windows 11 x64 evidence gap are reported as untested/not implemented, not as successful tests;
8. the branch and frozen candidate are clean, with no push, merge, production implementation, or release side effect.
