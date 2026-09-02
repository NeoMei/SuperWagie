# SuperWagie PresentationService 接入 SuperPPT 阻塞解除计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 SuperWagie 自有 PresentationService 替换 SuperPPT 对 `@oai/artifact-tool` 和 Codex Desktop Runtime 的硬耦合，使 `G3-PPT-001` 从 Codex 耦合 `NO_GO` 进入可继续验收的状态。本计划不把 Production Implementation Admission 升为 `GO`。

**Architecture:** SuperPPT 的 `assembleDeck()` 继续负责页序、1920x1080 渲染校验、可编辑页提取和 exclusive 发布。真正写 PPTX 只走 SuperWagie 拥有的 PresentationService：锁定 `pptxgenjs@4.0.1`，把 1280x720 设计像素换成 LAYOUT_WIDE 英寸，写入整页图和可编辑文本/素材。测试运行时不再探测 `codex-primary-runtime`。完成后 `ppt-gate.mjs` 不得再因 Codex 耦合给出 `NO_GO`；七阶段、三个人工门、Signed Runtime 和 Windows 仍保持外部阻塞。

**Tech Stack:** TypeScript 5.9, Node.js >=22.6, pptxgenjs 4.0.1, jszip 3.10.1, sharp, zod 4, SuperPPT deck assembler, SuperWagie Gate 3 ppt-gate.

**Spec:**
- `docs/技术可行性/编码前技术验证收口报告-2026-09-01.md` §3.3 / §5.1
- `docs/superpowers/specs/2026-08-29-superwagie-coding-admission-contract.md` §12 Gate 3、§14
- `docs/superpowers/specs/2026-08-28-superwagie-workspace-delivery-design.md` §20.2
- `rules/deliverables.md` R-DL-01、R-DL-04、R-DL-05
- SuperPPT `src/deck/pptx.ts`、`src/deck/assemble.ts`、`src/deck/geometry.ts`

## Global Constraints

- This is a block-clearing plan, not a Production Implementation Plan. Production Implementation Admission stays `NO_GO`.
- Do not import, spawn, symlink, or probe `@oai/artifact-tool`, `codex-primary-runtime`, `codex-runtimes`, Codex Desktop cache, or Codex `RUNTIME_NODE*`.
- If Node is still required, it is SuperPPT's own dependency graph or a future SuperWagie Signed Runtime Image.
- Keep SuperPPT public workflow semantics: seven stages, three human gates, 1920x1080 source renders, 1280x720 editable bbox, complete local PPTX as the only edit/review artifact.
- Success is: Codex coupling `NO_GO` is gone, a three-slide mixed deck is generated without Codex, remaining gaps stay honest `BLOCKED_ENVIRONMENT` / `CONDITIONAL_GO`.
- SuperWagie repo root has no `.git`. SuperPPT at `/Users/neomei/项目/codexprojects/SuperPPT` is a separate Git repository. Do not `git init` SuperWagie.
- Reuse the proven spike in `scripts/poc/gate-3/presentation-service-spike/`. Do not copy OpenAI artifact-tool source.
- `image-size@1.2.1` must remain unreachable in the production adapter path. Lock `pptxgenjs@4.0.1` and `jszip@3.10.1`.
- Do not start Gate 0 shell, video, billing, AgentWiki, or packaging work in this plan.

---

## Planned File Structure

```text
SuperPPT/
  src/deck/pptx.ts
  src/deck/presentation-service.ts
  src/deck/geometry.ts
  scripts/test.ts
  tests/deck.test.ts
  tests/presentation-service.test.ts
  tests/test-runtime.test.ts
  package.json
  package-lock.json

SuperWagie/
  scripts/poc/gate-3/ppt-gate.mjs
  scripts/poc/gate-3/ppt-gate.test.mjs
  scripts/poc/gate-3/ppt-three-slide-eval.mjs
  scripts/poc/gate-3/ppt-three-slide-eval.test.mjs
  docs/superpowers/plans/2026-09-02-presentationservice-superppt-unblock.md
```

---

### Task 1: Fail-closed tests for Codex decoupling and owned adapter

**Files:**
- Create: `/Users/neomei/项目/codexprojects/SuperPPT/tests/presentation-service.test.ts`
- Modify: `/Users/neomei/项目/codexprojects/SuperPPT/tests/deck.test.ts`
- Modify: `/Users/neomei/项目/codexprojects/SuperPPT/tests/test-runtime.test.ts`
- Test: same files

**Interfaces:**
- Consumes: existing `assembleDeck(pages, output, operations?)` and `createPresentation(pages, output, trustedRoot?)`
- Produces: tests that require zero Codex runtime and prove a 3-page image/editable/image PPTX with object names `page-${id}`, `background-${id}`, `text-${id}`

- [ ] **Step 1: Write the failing adapter tests**

Create `tests/presentation-service.test.ts`. Use SuperPPT's existing 1920x1080 PNG helper pattern from `tests/deck.test.ts`. Do not import SuperWagie spike files at runtime.

The test file must:

1. Build a 3-page deck with `createPresentation` after deleting `RUNTIME_NODE`, `RUNTIME_NODE_MODULES`, and `RUNTIME_BIN_DIR`.
2. Assert slide1 XML matches `name="page-first"`, slide2 matches `name="background-second"`, `name="text-title"` and `TITLE EDIT`, slide3 matches `name="page-third"`.
3. Assert slide1 and slide3 do not contain `TITLE EDIT`.
4. Read `src/deck/pptx.ts`, `src/deck/presentation-service.ts`, and `scripts/test.ts` and reject `@oai/artifact-tool`, `codex-primary-runtime`, `codex-runtimes`, `RUNTIME_NODE`, `RUNTIME_NODE_MODULES`, and `RUNTIME_BIN_DIR`.

Editable bbox is SuperPPT design pixels on a 1280x720 slide. Converter must map px to inches with `px * 13.333 / 1280` for x/width and `px * 7.5 / 720` for y/height. Use bbox `{ x: 77, y: 67, width: 614, height: 77 }`, which equals the spike's `0.8, 0.7, 6.4, 0.8` inches. Text is `TITLE EDIT`, color `#17324D`, fontSizePx 32, bold true, align left, id `title`.

Copy the exact test source from SuperWagie spike behavioral contract, but keep it inside SuperPPT and import `createPresentation` from `../src/deck/pptx.js`.

- [ ] **Step 2: Rewrite the deck runtime test**

In `tests/deck.test.ts`, replace `"requires injected artifact runtime paths and anchors PPTX output"`. The new test must assemble a one-page deck without any `RUNTIME_*` env, then reject a symlink output parent with `/output escaped the trusted root/`.

- [ ] **Step 3: Forbid Codex fallback in test runtime**

Replace `tests/test-runtime.test.ts` so `resolveTestRuntime()` uses current process Node and SuperPPT `node_modules`, or delete the helper if `scripts/test.ts` no longer needs it. `~/.cache/codex-runtimes/codex-primary-runtime` must become a hard error if the string remains. Assert `scripts/test.ts` does not match `codex-runtimes|codex-primary-runtime|artifact-tool`.

- [ ] **Step 4: Run tests and confirm they fail for the right reason**

Run:

```bash
cd /Users/neomei/项目/codexprojects/SuperPPT
npm run test:portable
```

Expected: FAIL because `src/deck/presentation-service.ts` does not exist, `src/deck/pptx.ts` still embeds `@oai/artifact-tool`, and `scripts/test.ts` still requires artifact-tool. Do not implement production code before seeing this failure.
Expected: FAIL because `src/deck/presentation-service.ts` does not exist, `src/deck/pptx.ts` still embeds `@oai/artifact-tool`, and `scripts/test.ts` still requires artifact-tool. Do not implement production code before seeing this failure.

---

### Task 2: Implement owned PresentationService and swap SuperPPT writer

**Files:**
- Create: `/Users/neomei/项目/codexprojects/SuperPPT/src/deck/presentation-service.ts`
- Modify: `/Users/neomei/项目/codexprojects/SuperPPT/src/deck/pptx.ts`
- Modify: `/Users/neomei/项目/codexprojects/SuperPPT/src/deck/geometry.ts`
- Modify: `/Users/neomei/项目/codexprojects/SuperPPT/scripts/test.ts`
- Modify: `/Users/neomei/项目/codexprojects/SuperPPT/package.json`
- Modify: `/Users/neomei/项目/codexprojects/SuperPPT/package-lock.json`
- Test: `tests/presentation-service.test.ts`, `tests/deck.test.ts`

**Interfaces:**
- Consumes: SuperPPT `PptxPage` / `PreparedEditableSlide`
- Produces: `createPresentation(pages, output, trustedRoot?): Promise<void>` with the same exclusive publish semantics

- [ ] **Step 1: Add the locked adapter dependency**

In SuperPPT `package.json` dependencies add exactly `"pptxgenjs": "4.0.1"`. Keep `jszip`. Do not add `image-size` as a direct dependency.

```bash
cd /Users/neomei/项目/codexprojects/SuperPPT
npm install
```

If `pptxgenjs@4.0.1` cannot generate PPTX without executing `image-size` in SuperPPT's path, stop and record it as a remaining supply-chain limitation; do not import `image-size`.

- [ ] **Step 2: Add inch conversion to geometry.ts**

Keep existing exports. Append:

```ts
export const SLIDE_WIDTH_IN = 13.333;
export const SLIDE_HEIGHT_IN = 7.5;
export const pxToInchX = (px: number): number => px * SLIDE_WIDTH_IN / SLIDE_WIDTH_PX;
export const pxToInchY = (px: number): number => px * SLIDE_HEIGHT_IN / SLIDE_HEIGHT_PX;
```

Reuse existing `pxToPt` for font size.

- [ ] **Step 3: Implement presentation-service.ts**

Requirements:

- `LAYOUT_WIDE`
- image pages: full-bleed PNG/JPEG named `page-${id}`
- editable pages: full-bleed `background-${id}` plus text boxes `text-${id}` and assets `asset-${id}`
- convert 1280x720 px bbox into inches
- convert `fontSizePx` with `pxToPt`
- reject non-absolute output, symlink parents, and trusted-root escapes
- write to a temp file in the canonical parent, then `promoteExclusive(staged, output)`

Follow the SuperWagie spike in `scripts/poc/gate-3/presentation-service-spike/src/presentation-service.mjs`, but consume SuperPPT `PptxPage` objects instead of a JSON spec. Author must be `SuperWagie PresentationService`. Language `zh-CN`.

If pptxgenjs `objectName` does not serialize to `p:cNvPr name="..."`, add a post-pass over the staged ZIP that writes the names SuperPPT tests already assert. Existing deck test requires `name="page-first"` in `slide1.xml`. Preserve that exact contract.

- [ ] **Step 4: Replace pptx.ts**

Delete `BUILDER`, `artifactRuntime()`, `execFile`, and the `node_modules` symlink. Keep exported types. `createPresentation` must only call `writePresentation(pages, output, trustedRoot)`.

`addEditableSlide()` in `editable-slide.ts` is a dead Codex-shaped helper. Delete it in the same change if no production import remains.

- [ ] **Step 5: Rewrite scripts/test.ts so npm test is portable**

Remove artifact-tool existence checks and the `codex-primary-runtime` cache fallback. `npm test` / `npm run test:portable` must run SuperPPT tests with the current process Node and local `node_modules`.

- [ ] **Step 6: Run SuperPPT portable tests**

```bash
cd /Users/neomei/项目/codexprojects/SuperPPT
npm run test:portable
npm run lint:types
```

Expected: PASS.

- [ ] **Step 7: Commit in SuperPPT only**

```bash
cd /Users/neomei/项目/codexprojects/SuperPPT
git add src/deck/pptx.ts src/deck/presentation-service.ts src/deck/geometry.ts src/deck/editable-slide.ts scripts/test.ts tests/presentation-service.test.ts tests/deck.test.ts tests/test-runtime.test.ts package.json package-lock.json
git commit -m "feat: replace Codex artifact-tool PPTX writer with owned PresentationService"
```

Do not commit SuperWagie in this step.
Do not commit SuperWagie in this step.

---

### Task 3: Point G3-PPT-001 at the decoupled candidate without promoting admission

**Files:**
- Modify: `/Users/neomei/项目/codexprojects/SuperWagie/scripts/poc/gate-3/ppt-gate.mjs`
- Modify: `/Users/neomei/项目/codexprojects/SuperWagie/scripts/poc/gate-3/ppt-gate.test.mjs`
- Modify: `/Users/neomei/项目/codexprojects/SuperWagie/docs/技术可行性/编码前技术验证收口报告-2026-09-01.md`
- Test: `scripts/poc/gate-3/ppt-gate.test.mjs`

**Interfaces:**
- Consumes: SuperPPT candidate root after Task 2
- Produces: `ppt-gate.mjs` result that is `BLOCKED_ENVIRONMENT/REAL_PPT_EVALUATION_REQUIRED` after decoupling, never Codex `NO_GO`

- [ ] **Step 1: Keep coupling as a product defect, and require an owned adapter**

Do not remove the existing Codex coupling `NO_GO`. After Task 2, the real SuperPPT root must not take that branch. Add an owned-adapter check:

```js
const ownedAdapter = /pptxgenjs|writePresentation|PresentationService/.test(pptxSource);
if (!ownedAdapter) {
  writeResult(resultsPath, result('NO_GO', ['OWNED_PRESENTATION_SERVICE_MISSING'], [
    'Decoupling from Codex is not enough; SuperPPT must call a SuperWagie-owned PresentationService or audited OOXML adapter.',
  ]));
  process.exit(1);
}
```

Then keep `REAL_PPT_EVALUATION_REQUIRED` until the three-slide real evaluation exists.

- [ ] **Step 2: Update ppt-gate tests**

Keep the coupled fixture test. Change the decoupled fixture so `src/deck/pptx.ts` contains `writePresentation` and `pptxgenjs`, and still expects exit 2 / `BLOCKED_ENVIRONMENT`. Add a negative test: no Codex strings and no owned adapter is `NO_GO`.

- [ ] **Step 3: Run SuperWagie gate tests and the real candidate audit**

```bash
cd /Users/neomei/项目/codexprojects/SuperWagie
node --test scripts/poc/gate-3/ppt-gate.test.mjs
node scripts/poc/gate-3/ppt-gate.mjs --fixture G3-PPT-001 --platform macos-15-arm64 --results-json /tmp/g3-ppt-results.json --artifacts-dir /tmp/g3-ppt-artifacts --candidate-root /Users/neomei/项目/codexprojects/SuperPPT
```

Expected: exit 2, `decision_hint=BLOCKED_ENVIRONMENT`, reasons `REAL_PPT_EVALUATION_REQUIRED`. If it still returns Codex `NO_GO`, Task 2 is incomplete.

- [ ] **Step 4: Record remaining gaps in the closure report**

Append a 2026-09-02 PresentationService 接入快照 to `docs/技术可行性/编码前技术验证收口报告-2026-09-01.md` §3.3:

- SuperPPT writer no longer imports `@oai/artifact-tool`
- tests no longer default to `codex-primary-runtime`
- `G3-PPT-001` Codex coupling reason is closed
- remaining parent reasons: seven-stage workflow, three human gates, local-failure rerender, Signed Runtime, Windows WPS/PowerPoint, Owner sign-off
- Production Implementation Admission remains `NO_GO`

Do not mark `G3-PPT-001` GO.

---

### Task 4: Three-slide mixed-deck evaluation against the real SuperPPT assembler

**Files:**
- Create: `/Users/neomei/项目/codexprojects/SuperWagie/scripts/poc/gate-3/ppt-three-slide-eval.mjs`
- Create: `/Users/neomei/项目/codexprojects/SuperWagie/scripts/poc/gate-3/ppt-three-slide-eval.test.mjs`
- Test: those files plus SuperPPT `assembleDeck`

**Interfaces:**
- Consumes: SuperPPT `assembleDeck` and fixture `fixtures/gate-3/G3-PPT-001/fixtures/presentation-visual-1920x1080.png`
- Produces: a real 3-page PPTX with page 1 image, page 2 editable `TITLE EDIT`, page 3 image, ZIP/OOXML checks, no Codex env

- [ ] **Step 1: Write failing evaluation tests first**

The evaluation must fail if:

- `@oai/artifact-tool` or `codex-primary-runtime` appears in SuperPPT `src/deck/pptx.ts` or `scripts/test.ts`
- slide count is not 3
- slide 2 XML lacks `TITLE EDIT`
- output parent is a symlink
- full-slide raster is below 1920x1080

- [ ] **Step 2: Implement the evaluator by calling SuperPPT assembleDeck, not the spike**

Do not generate the deck from `presentation-service-spike`. Spawn SuperPPT's assembler so the product path is under test. A child process is acceptable; use SuperPPT `tsx` with env that does not contain Codex `RUNTIME_*`.

Three pages:

1. image page from `presentation-visual-1920x1080.png`
2. editable page using that image as render/background and one text element `TITLE EDIT`
3. image page from the same fixture, standing in for a regenerated visual

- [ ] **Step 3: Run evaluator and keep parent Gate unsigned**

Expected: evaluator `pass=true` with `decision_hint=CONDITIONAL_GO` and limitations naming seven-stage, human gates, Signed Runtime, Windows, Owner sign-off. Copy evidence under `evidence/gate-3/` only as a child spike, never as a signed parent GO.

---

## Out of scope

- SuperPPT seven-stage Guided UI inside SuperWagie client
- ai-image-to-ppt / image-to-editable-pptx Worker packaging
- WPS/PowerPoint Owner visual sign-off
- Signed Runtime Image / SBOM / notarization
- Windows 11 x64
- Gate 0 Electron shell production
- Video, Billing, AgentWiki, Official Host

Those remain later block-clearing plans, in the order of the closure report §5.

## Spec coverage

| Requirement | Task |
|---|---|
| Replace `@oai/artifact-tool` with owned PresentationService | Task 2 |
| Signed Runtime / system Node / Codex Desktop forbidden | Task 1, Task 2, Task 3 |
| Mixed image/editable assembly, 1920x1080, 1280x720 bbox | Task 1, Task 2, Task 4 |
| Do not upgrade Production Admission | Task 3, Task 4 |
| Real WPS smoke still required later | recorded limitation, not this plan |
| R-DL-01 seven stages remain product semantics | unchanged; not implemented here |
| R-DL-05 real Office smoke | next plan, after this unblock |

## Placeholder scan

No TBD, later, or similar-to-Task-N steps. Exact files, commands, and expected results are included. Task 2 adapter implementation follows the already proven spike source rather than re-pasting a second full copy of that file.
