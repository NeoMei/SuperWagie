> **superseded-for-current-architecture (2026-09-04):** This file preserves evidence for the retired WPS-authoritative Office Review path. It cannot satisfy Universal Viewer GVP-0–5 or current production admission. Current authority: `docs/superpowers/specs/2026-09-04-superwagie-universal-viewer-platform-design.md`.

# Independent Office Reviewer PoC Implementation Plan

> **历史验证说明（2026-09-01）：** 本计划记录的是架构变更前的 Tauri/System WebView 一次性 PoC，不是当前生产实施计划。其 Office 事实源、Artifact 隔离和 Reviewer 行为证据仍可参考，但壳层结果不能为 Electron + bundled Chromium 架构签署 GO。当前桌面架构、Gate 与安装完整性以 `docs/superpowers/specs/2026-09-01-superwagie-bundled-chromium-electron-architecture-design.md` 为准；后续验证使用 `G0-SHELL-002`，不继续扩展本计划中的 Tauri 生产路径。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build reproducible Gate 3 proof that SuperWagie can review PDF, DOCX, and PPTX with a Codex-independent ReviewShell, DOCX fast preview, WPS-authoritative rendering, stable annotations, and explicit dependency degradation.

**Architecture:** A Tauri 2 PoC shell owns file authorization, WPS processes, immutable preview cache, and a restricted `reviewasset` protocol. A TypeScript ReviewShell runs PDF.js and `docx-preview` in the system WebView; WPSComposer is invoked only through an explicit-path Python worker to create authoritative PDF revisions. Gate executors produce machine-readable metrics, screenshots, access/isolation evidence, and `GO`/`CONDITIONAL_GO`/`NO_GO` decisions without promoting the PoC into production code.

**Tech Stack:** Rust 1.97.1, Tauri 2, Node.js 24.18.0, npm 12.0.1, TypeScript 7.0.2, Vite 8.2.2, Vitest 4.1.11, PDF.js 6.3.289, `docx-preview` 0.4.0, WPSComposer `convert_to_pdf()`, Python 3, Pixelmatch 7.2.0.

**Spec:** `docs/技术可行性/08-独立Office-Reviewer.md`

## Global Constraints

- This plan implements disposable Technical Validation only. Nothing under `scripts/poc/gate-3/` is a production SuperWagie module.
- XLSX preview is outside this PoC. Adding a spreadsheet adapter is a separately admitted scope change and cannot be inferred from the Office Reviewer name.
- Target platforms are exactly `macos-15-arm64` and `windows-11-x64`; a result from one platform cannot sign for the other.
- PDF/DOCX/PPTX preview, page navigation, annotations, and cache must work when Codex Desktop has never been installed.
- Do not read, launch, connect to, copy, import, or package Codex Desktop code, assets, processes, IPC, configuration, session data, or cache.
- The bundled SuperWagie Agent sidecar is outside the renderer. The PoC creates an Agent change-request artifact but does not call raw App Server or implement production Agent execution.
- WPS/Office PDF output is authoritative. `docx-preview` is always marked `fast`, never `authoritative` or accepted for Office visual sign-off.
- The WebView receives opaque handles and `reviewasset` URLs, never unrestricted absolute paths or process handles.
- WPS is absent from scrolling, zooming, search, selection, annotations, and cached-page hot paths.
- One IPC envelope stays below 1 MiB; document bytes and rendered pages travel through the bounded `reviewasset` protocol.
- Exact web dependency versions are locked in `package-lock.json`; Rust dependencies are locked in `Cargo.lock`; Python is supplied by an explicit absolute path.
- Gate exit codes remain `0=passed`, `1=acceptance failed`, `2=environment/arguments blocked`.
- Current `/Users/neomei/项目/codexprojects/SuperWagie` is not a Git worktree. Do not run `git init`. Conditional commit steps must print `SKIP_COMMIT_NON_GIT` until the user restores Git metadata.

---

## Planned File Structure

```text
scripts/poc/gate-3/
├── package.json                         # locked JS toolchain and scripts
├── package-lock.json                    # exact npm graph
├── vitest.config.ts                     # deterministic DOM test environment
├── review-contract.ts                   # shared Preview/Annotation types
├── review-contract.test.ts              # contract and state invariants
├── preview-orchestrator.ts              # fast/authoritative transitions
├── preview-orchestrator.test.ts
├── annotation-reanchor.ts               # deterministic anchor relocation
├── annotation-reanchor.test.ts
├── review-gate.mjs                      # G3-REVIEW-001 executor
├── review-isolation-gate.mjs            # G3-REVIEW-002 executor
├── fixture-audit.mjs                    # hash/provenance/feature audit
├── wps-render-worker.py                 # explicit WPSComposer adapter
├── test_wps_render_worker.py            # worker protocol tests
├── reviewer-ui/
│   ├── index.html
│   ├── vite.config.ts
│   └── src/
│       ├── main.ts                      # application composition only
│       ├── host-bridge.ts               # typed Tauri bridge
│       ├── review-shell.ts              # page rail/viewport/status UI
│       ├── pdf-adapter.ts               # PDF.js adapter
│       ├── docx-fast-adapter.ts         # docx-preview adapter
│       ├── review-overlay.ts            # selections and annotations
│       └── styles.css                   # PoC layout, not product styling
└── reviewer-shell/
    ├── Cargo.toml
    ├── Cargo.lock
    ├── build.rs
    ├── tauri.conf.json
    ├── capabilities/default.json
    └── src/
        ├── main.rs                      # Tauri composition only
        ├── artifact_store.rs            # opaque handle authorization
        ├── review_protocol.rs           # bounded read-only protocol
        ├── preview_cache.rs             # immutable preview publication
        └── wps_worker.rs                # child ownership/deadline/receipt

fixtures/gate-3/
├── G3-REVIEW-001/
│   ├── README.md
│   ├── fixture-manifest.json
│   ├── checklist-result.example.json
│   ├── fixtures/
│   │   ├── reviewer-torture-30p.docx
│   │   ├── reviewer-torture-20s.pptx
│   │   ├── reviewer-torture-100p.pdf
│   │   ├── corrupt-tail.pdf
│   │   └── oversize-placeholder.bin
│   └── checklist.md
└── G3-REVIEW-002/
    ├── README.md
    ├── scenarios.json
    └── checklist.md
```

---

### Task 1: Lock the Review Contract and State Machine

**Files:**
- Create: `scripts/poc/gate-3/package.json`
- Create: `scripts/poc/gate-3/review-contract.ts`
- Create: `scripts/poc/gate-3/review-contract.test.ts`
- Create: `scripts/poc/gate-3/preview-orchestrator.ts`
- Create: `scripts/poc/gate-3/preview-orchestrator.test.ts`
- Create: `scripts/poc/gate-3/tsconfig.json`
- Create: `scripts/poc/gate-3/vitest.config.ts`

**Interfaces:**
- Consumes: `ArtifactRef` identity from `docs/contracts/v1/envelopes.schema.json`.
- Produces: `PreviewRequest`, `PreviewManifest`, `PreviewRevision`, `ReviewAnnotation`, `PreviewAdapter`, and `PreviewOrchestrator` used by every later task.

- [ ] **Step 1: Create the locked Node package and TypeScript configuration**

Use this exact `package.json`:

```json
{
  "name": "superwagie-gate-3-reviewer-poc",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run --config vitest.config.ts",
    "test:watch": "vitest",
    "build:ui": "vite build --config reviewer-ui/vite.config.ts"
  },
  "dependencies": {
    "@tauri-apps/api": "2.11.1",
    "docx-preview": "0.4.0",
    "pdfjs-dist": "6.3.289"
  },
  "devDependencies": {
    "@testing-library/dom": "10.4.1",
    "@types/node": "26.4.0",
    "@types/pixelmatch": "5.2.6",
    "@types/pngjs": "6.0.5",
    "jsdom": "30.0.1",
    "pixelmatch": "7.2.0",
    "pngjs": "7.0.0",
    "typescript": "7.0.2",
    "vite": "8.2.2",
    "vitest": "4.1.11"
  }
}
```

Use this exact `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['**/*.test.ts'],
    clearMocks: true,
    restoreMocks: true
  }
});
```

Run:

```bash
cd scripts/poc/gate-3
npm install --package-lock-only
npm ci
```

Expected: `package-lock.json` is created and `npm ci` exits `0`.

- [ ] **Step 2: Write failing contract tests**

```ts
import { describe, expect, it } from 'vitest';
import { createPreviewRevision, assertTransition } from './review-contract';

describe('PreviewRevision', () => {
  it('rejects authoritative revisions without renderer environment identity', () => {
    expect(() => createPreviewRevision({
      artifactRevisionId: 'ar-1', fidelity: 'authoritative',
      rendererId: 'wps-pdf', rendererVersion: '12.1',
      rendererEnvironmentHash: '', fontEnvironmentHash: 'font-hash',
      sourceContentHash: 'source-hash', pageManifestHash: 'pages-hash'
    })).toThrow('rendererEnvironmentHash');
  });

  it('does not allow fast_ready to become accepted', () => {
    expect(() => assertTransition('fast_ready', 'accepted')).toThrow('invalid preview transition');
  });
});
```

- [ ] **Step 3: Run the tests and verify the intended failure**

Run:

```bash
cd scripts/poc/gate-3
npm test -- review-contract.test.ts
```

Expected: FAIL because `review-contract.ts` does not exist.

- [ ] **Step 4: Implement the exact shared types and transition guard**

```ts
export type PreviewFidelity = 'fast' | 'authoritative';
export type PreviewState =
  | 'queued' | 'loading_fast' | 'fast_ready'
  | 'rendering_authoritative' | 'authoritative_ready'
  | 'dependency_missing' | 'unsupported'
  | 'failed_recoverable' | 'failed_terminal' | 'accepted';

export interface PreviewRevisionInput {
  artifactRevisionId: string;
  fidelity: PreviewFidelity;
  rendererId: string;
  rendererVersion: string;
  rendererEnvironmentHash: string;
  fontEnvironmentHash: string;
  sourceContentHash: string;
  pageManifestHash: string;
}

export interface PreviewRevision extends PreviewRevisionInput {
  previewRevisionId: string;
  acceptanceState: 'not_eligible' | 'reviewable' | 'accepted';
}

export interface PreviewAdapter {
  readonly id: string;
  probe(): Promise<{ available: boolean; reason?: string }>;
  open(request: PreviewRequest): Promise<PreviewSession>;
  getManifest(sessionId: string): Promise<PreviewManifest>;
  getPage(sessionId: string, pageId: string, scaleBucket: number): Promise<PageSurfaceRef>;
  getThumbnail(sessionId: string, pageId: string): Promise<PageSurfaceRef>;
  getTextLayer(sessionId: string, pageId: string): Promise<TextLayer | null>;
  cancel(sessionId: string): Promise<void>;
}

export interface PageSurfaceRef {
  pageId: string;
  width: number;
  height: number;
  surfaceHandle: string;
}

export interface TextLayer {
  items: Array<{ text: string; bbox: NormalizedBox }>;
}

export interface PreviewRequest {
  artifactRevisionId: string;
  artifactHandle: string;
  mediaType: string;
  preferredFidelity: PreviewFidelity;
  deadlineMs: number;
}

export interface PreviewSession {
  sessionId: string;
  state: PreviewState;
  manifest?: PreviewManifest;
}

export interface PreviewManifest {
  previewRevision: PreviewRevision;
  pages: Array<{ pageId: string; width: number; height: number }>;
}

export type NormalizedBox = [x: number, y: number, width: number, height: number];

export interface ReviewAnnotation {
  annotationId: string;
  artifactRevisionId: string;
  previewRevisionId: string;
  fidelity: PreviewFidelity;
  pageId: string;
  bbox?: NormalizedBox;
  selectedText?: string;
  beforeContextHash?: string;
  afterContextHash?: string;
  semanticObjectId?: string;
  status: 'active' | 'stale' | 'unresolved';
}

export interface ReviewPerformanceSnapshot {
  progressVisibleMs: number;
  firstPageMs: number;
  interactions: Array<{ name: 'scroll' | 'zoom' | 'page' | 'selection' | 'annotation'; durationMs: number }>;
}

export interface PreviewRunResult {
  states: PreviewState[];
  canAccept: boolean;
}

export interface PreviewOrchestrator {
  run(request: PreviewRequest): Promise<PreviewRunResult>;
  cancel(): Promise<void>;
}

const ALLOWED: Record<PreviewState, PreviewState[]> = {
  queued: ['loading_fast', 'rendering_authoritative', 'unsupported', 'dependency_missing'],
  loading_fast: ['fast_ready', 'rendering_authoritative', 'failed_recoverable'],
  fast_ready: ['rendering_authoritative', 'failed_recoverable'],
  rendering_authoritative: ['authoritative_ready', 'dependency_missing', 'failed_recoverable', 'failed_terminal'],
  authoritative_ready: ['accepted', 'rendering_authoritative'],
  dependency_missing: ['rendering_authoritative'],
  unsupported: [], failed_recoverable: ['loading_fast', 'rendering_authoritative'],
  failed_terminal: [], accepted: []
};

export function assertTransition(from: PreviewState, to: PreviewState): void {
  if (!ALLOWED[from].includes(to)) throw new Error(`invalid preview transition: ${from} -> ${to}`);
}
```

`createPreviewRevision()` must SHA-256 the canonical input fields for `previewRevisionId`, require all identity hashes, and set `acceptanceState='not_eligible'` for `fast` and `reviewable` for `authoritative`.

- [ ] **Step 5: Add orchestrator tests for automatic fast-to-authoritative progression**

Test these exact cases in `preview-orchestrator.test.ts`:

```ts
it('keeps fast preview visible while authoritative rendering runs', async () => {
  const result = await runScenario({ fast: 'success', truth: 'pending_then_success' });
  expect(result.states).toEqual(['queued', 'loading_fast', 'fast_ready', 'rendering_authoritative', 'authoritative_ready']);
});

it('keeps DOCX readable but unaccepted when WPS is missing', async () => {
  const result = await runScenario({ fast: 'success', truth: 'dependency_missing' });
  expect(result.at(-1)).toBe('dependency_missing');
  expect(result.canAccept).toBe(false);
});
```

`runScenario()` is a test-local helper with signature:

```ts
type Scenario = { fast: 'success' | 'failure'; truth: 'pending_then_success' | 'dependency_missing' | 'failure' };
async function runScenario(input: Scenario): Promise<{ states: PreviewState[]; canAccept: boolean }>;
```

It constructs two fake `PreviewAdapter` instances, records every orchestrator transition, and derives `canAccept` only from an `authoritative_ready` result.

- [ ] **Step 6: Implement the orchestrator without hiding dependency failure**

Expose this constructor:

```ts
export function createPreviewOrchestrator(
  fastAdapter: PreviewAdapter | null,
  truthAdapter: PreviewAdapter,
  onState: (state: PreviewState) => void
): PreviewOrchestrator;
```

`run()` emits `queued`; for DOCX it opens the fast adapter and emits `loading_fast` then `fast_ready`; it next probes the truth adapter and emits `dependency_missing` when unavailable or `rendering_authoritative` then `authoritative_ready` on success. PDF skips the fast adapter. The returned `canAccept` is true only after `authoritative_ready`. `cancel()` calls `cancel(sessionId)` for every active adapter session and never changes an already published Preview Revision.

- [ ] **Step 7: Run unit tests and the conditional commit checkpoint**

Run:

```bash
cd scripts/poc/gate-3
npm test -- review-contract.test.ts preview-orchestrator.test.ts
cd ../../..
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git add scripts/poc/gate-3
  git commit -m "test: define independent reviewer contracts"
else
  echo SKIP_COMMIT_NON_GIT
fi
```

Expected: tests PASS; current workspace prints `SKIP_COMMIT_NON_GIT`.

---

### Task 2: Create Reproducible Office Fixtures and Provenance Audit

**Files:**
- Create: `fixtures/gate-3/G3-REVIEW-001/README.md`
- Create: `fixtures/gate-3/G3-REVIEW-001/fixture-manifest.json`
- Create: `fixtures/gate-3/G3-REVIEW-001/checklist.md`
- Create: `fixtures/gate-3/G3-REVIEW-001/checklist-result.example.json`
- Create: `fixtures/gate-3/G3-REVIEW-001/fixtures/*`
- Create: `fixtures/gate-3/G3-REVIEW-002/README.md`
- Create: `fixtures/gate-3/G3-REVIEW-002/scenarios.json`
- Create: `fixtures/gate-3/G3-REVIEW-002/checklist.md`
- Create: `scripts/poc/gate-3/fixture-audit.mjs`
- Create: `scripts/poc/gate-3/fixture-audit.test.mjs`

**Interfaces:**
- Consumes: team-owned files only; no user documents and no Codex resources.
- Produces: immutable fixture paths, hashes, expected page counts, required feature tags, and isolation scenarios.

- [ ] **Step 1: Write the manifest audit test before adding binary fixtures**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { auditFixtureSet } from './fixture-audit.mjs';

test('G3-REVIEW-001 has three primary formats and matching hashes', async () => {
  const result = await auditFixtureSet('G3-REVIEW-001');
  assert.deepEqual(result.primaryFormats.sort(), ['docx', 'pdf', 'pptx']);
  assert.equal(result.hashMismatches.length, 0);
  assert.equal(result.provenanceViolations.length, 0);
});
```

Run `node --test scripts/poc/gate-3/fixture-audit.test.mjs`; expect FAIL because the manifest is absent.

- [ ] **Step 2: Build the fixture set from project-owned sources**

Create exactly these primary fixtures:

1. `reviewer-torture-30p.docx`: 30 pages; TOC, linked numbering, sections, portrait/landscape changes, headers/footers, footnotes, tables, floating images, Chinese text, Latin text, missing-font substitution, and an edit that forces repagination.
2. `reviewer-torture-20s.pptx`: 20 slides; image-first slides, editable text, SVG, chart, table, transparency, gradient, grouped shapes, media poster frame, missing-font substitution, and a slide/object rebuild.
3. `reviewer-torture-100p.pdf`: 100 pages; text pages, scanned pages, mixed page sizes, bookmarks, links, existing PDF annotations, and a deliberately malformed copy named `corrupt-tail.pdf`.

Generate them through the reviewed WPSComposer checkout using its explicit `.venv/bin/python` and public `generate()`/`convert_to_pdf()` API. Copy only the resulting team-owned fixtures into SuperWagie. Do not copy WPSComposer source, caches, or build directories.

- [ ] **Step 3: Generate the exact fixture manifest from current bytes**

`fixture-audit.mjs --write-manifest` must own these literal definitions and calculate hashes from file bytes:

```js
const definitions = [
  { path: 'fixtures/reviewer-torture-30p.docx', format: 'docx', expected_pages: 30 },
  { path: 'fixtures/reviewer-torture-20s.pptx', format: 'pptx', expected_pages: 20 },
  { path: 'fixtures/reviewer-torture-100p.pdf', format: 'pdf', expected_pages: 100 },
  { path: 'fixtures/corrupt-tail.pdf', format: 'pdf-corrupt', expected_outcome: 'failed_terminal' },
  { path: 'fixtures/oversize-placeholder.bin', format: 'oversize', expected_outcome: 'unsupported' }
];

const manifest = {
  fixture: 'G3-REVIEW-001',
  provenance: 'SuperWagie project-owned torture documents generated for technical validation',
  redistributable: true,
  files: definitions.map((entry) => ({
    ...entry,
    sha256: sha256(fs.readFileSync(path.join(fixtureRoot, entry.path)))
  }))
};
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
```

Run `node scripts/poc/gate-3/fixture-audit.mjs --fixture G3-REVIEW-001 --write-manifest` once after fixture creation. The audit must reject missing or non-64-character hashes, absolute paths, paths containing `Codex.app`, and files outside the fixture root.

- [ ] **Step 4: Define isolation scenarios**

`scenarios.json` must contain these exact IDs:

```json
{
  "fixture": "G3-REVIEW-002",
  "scenarios": [
    {"id":"codex-never-installed","required":true},
    {"id":"codex-installed-not-running","required":true},
    {"id":"codex-running","required":true},
    {"id":"codex-config-mutated","required":true},
    {"id":"wps-missing","required":true},
    {"id":"wps-timeout","required":true},
    {"id":"wps-crash","required":true},
    {"id":"webview-restart","required":true},
    {"id":"cache-corrupt","required":true},
    {"id":"source-revision-changed","required":true}
  ]
}
```

- [ ] **Step 5: Run the audit and conditional commit checkpoint**

Run:

```bash
node --test scripts/poc/gate-3/fixture-audit.test.mjs
node scripts/poc/gate-3/fixture-audit.mjs --fixture G3-REVIEW-001
```

Expected: all files exist, hashes match, primary formats are DOCX/PPTX/PDF, and provenance violations are zero.

---

### Task 3: Implement PDF.js and DOCX Fast Preview Adapters

**Files:**
- Create: `scripts/poc/gate-3/reviewer-ui/index.html`
- Create: `scripts/poc/gate-3/reviewer-ui/vite.config.ts`
- Create: `scripts/poc/gate-3/reviewer-ui/src/host-bridge.ts`
- Create: `scripts/poc/gate-3/reviewer-ui/src/pdf-adapter.ts`
- Create: `scripts/poc/gate-3/reviewer-ui/src/docx-fast-adapter.ts`
- Create: `scripts/poc/gate-3/reviewer-ui/src/adapters.test.ts`

**Interfaces:**
- Consumes: `PreviewAdapter`, `PreviewRequest`, and opaque `artifactHandle` from Task 1.
- Produces: `PdfAdapter` and `DocxFastAdapter`; neither receives an absolute path.

- [ ] **Step 1: Write adapter tests using a fake host bridge**

```ts
it('PDF adapter reports authoritative fidelity for source PDF', async () => {
  const adapter = new PdfAdapter(fakeHost(pdfBytes));
  const session = await adapter.open(request('application/pdf', 'authoritative'));
  expect(session.manifest?.previewRevision.fidelity).toBe('authoritative');
});

it('DOCX adapter can never report authoritative fidelity', async () => {
  const adapter = new DocxFastAdapter(fakeHost(docxBytes));
  const session = await adapter.open(request('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'fast'));
  expect(session.manifest?.previewRevision.fidelity).toBe('fast');
  expect(session.manifest?.previewRevision.acceptanceState).toBe('not_eligible');
});

it('adapters only request reviewasset URLs', async () => {
  const host = fakeHost(pdfBytes);
  await new PdfAdapter(host).open(request('application/pdf', 'authoritative'));
  expect(host.requestedUrls.every((u) => u.startsWith('reviewasset://localhost/'))).toBe(true);
});
```

The test file defines `fakeHost(bytes: Uint8Array): HostBridge & { requestedUrls: string[] }` and `request(mediaType: string, fidelity: PreviewFidelity): PreviewRequest`. `pdfBytes` and `docxBytes` are loaded from the audited fixture manifest, not embedded from user files.

- [ ] **Step 2: Run tests to prove the adapters are absent**

Run `cd scripts/poc/gate-3 && npm test -- reviewer-ui/src/adapters.test.ts`.

Expected: FAIL on missing modules.

- [ ] **Step 3: Implement `HostBridge` and PDF.js Worker configuration**

Use this exact Vite configuration:

```ts
import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: ['safari17', 'chrome131']
  }
});
```

```ts
import { invoke } from '@tauri-apps/api/core';

export interface HostBridge {
  assetUrl(handle: string, kind: 'artifact' | 'preview'): Promise<string>;
  startTruthRender(handle: string, artifactRevisionId: string, deadlineMs: number): Promise<{ jobId: string }>;
  previewStatus(jobId: string): Promise<HostPreviewStatus>;
  saveAnnotation(annotation: ReviewAnnotation): Promise<void>;
  acceptPreview(previewRevisionId: string): Promise<void>;
  openControlledCopy(handle: string): Promise<{ receiptId: string }>;
  recordMetrics(snapshot: ReviewPerformanceSnapshot): Promise<void>;
}

export interface HostPreviewStatus {
  jobId: string;
  state: PreviewState;
  previewHandle?: string;
  errorCode?: string;
}

export const tauriHostBridge: HostBridge = {
  assetUrl: (handle, kind) => invoke('asset_url', { handle, kind }),
  startTruthRender: (handle, artifactRevisionId, deadlineMs) => invoke('start_truth_render', { handle, artifactRevisionId, deadlineMs }),
  previewStatus: (jobId) => invoke('preview_status', { jobId }),
  saveAnnotation: (annotation) => invoke('save_annotation', { annotation }),
  acceptPreview: (previewRevisionId) => invoke('accept_preview', { previewRevisionId }),
  openControlledCopy: (handle) => invoke('open_controlled_copy', { handle }),
  recordMetrics: (snapshot) => invoke('record_metrics', { snapshot })
};
```

Configure PDF.js with a local Vite-built Worker URL. Network URLs, CDN fallback, `file://`, and `convertFileSrc()` are forbidden by tests.

- [ ] **Step 4: Implement PDF and DOCX adapters**

`PdfAdapter` must call `getDocument({ url, disableAutoFetch: false })`, enumerate page dimensions, expose text-layer items, and cancel pending render tasks. `DocxFastAdapter` must fetch the `reviewasset` URL as `ArrayBuffer`, call:

```ts
await renderAsync(bytes, bodyContainer, styleContainer, {
  className: 'superwagie-docx-fast',
  renderAltChunks: false,
  useBase64URL: true,
  ignoreLastRenderedPageBreak: false
});
```

The DOCX adapter must stamp every manifest and UI status with `fidelity='fast'` and `acceptanceState='not_eligible'`.

- [ ] **Step 5: Build and test**

Run:

```bash
cd scripts/poc/gate-3
npm test -- reviewer-ui/src/adapters.test.ts
npm run build:ui
```

Expected: tests PASS and `reviewer-ui/dist/` contains no `http://`, `https://`, `Codex.app`, or `/Applications/ChatGPT.app` string.

---

### Task 4: Build the Virtualized ReviewShell and Status UI

**Files:**
- Create: `scripts/poc/gate-3/reviewer-ui/src/review-shell.ts`
- Create: `scripts/poc/gate-3/reviewer-ui/src/review-shell.test.ts`
- Create: `scripts/poc/gate-3/reviewer-ui/src/performance-metrics.ts`
- Create: `scripts/poc/gate-3/reviewer-ui/src/performance-metrics.test.ts`
- Create: `scripts/poc/gate-3/reviewer-ui/src/styles.css`
- Create: `scripts/poc/gate-3/reviewer-ui/src/main.ts`

**Interfaces:**
- Consumes: `PreviewManifest`, page surfaces, text layers, and orchestrator states.
- Produces: page rail, continuous Word mode, single-slide PPT mode, fit-width/fit-page/percentage zoom, progress and fidelity labels.

- [ ] **Step 1: Write DOM tests for required visual states**

```ts
it.each([
  ['loading_fast', '正在快速预览'],
  ['rendering_authoritative', '原格式预览准备中'],
  ['authoritative_ready', '原格式已就绪'],
  ['dependency_missing', '需要 WPS 才能核对原格式']
])('renders %s without technical provider names', (state, label) => {
  const root = renderShell({ state });
  expect(root.textContent).toContain(label);
  expect(root.textContent).not.toMatch(/docx-preview|pdfjs|Codex|App Server/);
});

it('mounts only the current page and two neighbors', () => {
  const root = renderShell({ pageCount: 100, currentPage: 50 });
  expect(root.querySelectorAll('[data-mounted-page]')).toHaveLength(5);
});

it('enables acceptance only for authoritative_ready', () => {
  expect(renderShell({ state: 'fast_ready' }).querySelector('[data-action="accept"]')?.hasAttribute('disabled')).toBe(true);
  expect(renderShell({ state: 'authoritative_ready' }).querySelector('[data-action="accept"]')?.hasAttribute('disabled')).toBe(false);
});
```

- [ ] **Step 2: Run failing UI tests**

Run `cd scripts/poc/gate-3 && npm test -- reviewer-ui/src/review-shell.test.ts`.

Expected: FAIL because `review-shell.ts` is missing.

- [ ] **Step 3: Implement the smallest complete ReviewShell**

Required DOM regions and stable test IDs:

```html
<header data-testid="review-header"></header>
<aside data-testid="page-rail"></aside>
<main data-testid="document-viewport"></main>
<section data-testid="review-overlay"></section>
<footer data-testid="review-status"></footer>
```

The header exposes exactly four review actions: `继续修改`, `在 WPS 打开副本`, `接受此版本`, and `关闭预览`. `接受此版本` invokes `acceptPreview()` only in `authoritative_ready`; `在 WPS 打开副本` invokes `openControlledCopy()` and displays the returned receipt ID.

Use `IntersectionObserver` for current-page tracking and mount only current ±2 full pages plus lightweight placeholders. Zoom buckets are exactly `0.5`, `0.67`, `0.8`, `1`, `1.25`, `1.5`, and `2`; fit modes calculate the closest bucket but preserve the requested display percentage.

- [ ] **Step 4: Instrument performance without putting WPS in hot paths**

`performance-metrics.ts` records `progress_visible_ms`, `first_page_ms`, and click-to-paint samples for scroll, zoom, page navigation, selection, and annotation using `performance.mark()` plus two `requestAnimationFrame()` callbacks. Export:

```ts
export function percentile(values: number[], p: 0.5 | 0.95): number;
export function snapshotMetrics(): ReviewPerformanceSnapshot;
```

Tests use a deterministic fake clock and verify P95 calculation and that metrics contain no path, document text, or annotation content.
`main.ts` calls `recordMetrics(snapshotMetrics())` after each completed interaction sample and on window close; Rust atomically stores only numeric metrics under the current evidence run directory.

- [ ] **Step 5: Verify build, keyboard navigation, performance tests, and accessibility semantics**

Run:

```bash
cd scripts/poc/gate-3
npm test -- reviewer-ui/src/review-shell.test.ts reviewer-ui/src/performance-metrics.test.ts
npm run build:ui
```

Expected: PASS; PageUp/PageDown, Home/End, `+`, `-`, and `0` are covered by tests; page buttons have `aria-label="第 N 页"`.

---

### Task 5: Implement the Tauri Artifact Broker and Restricted Protocol

**Files:**
- Create: `scripts/poc/gate-3/reviewer-shell/Cargo.toml`
- Create: `scripts/poc/gate-3/reviewer-shell/build.rs`
- Create: `scripts/poc/gate-3/reviewer-shell/tauri.conf.json`
- Create: `scripts/poc/gate-3/reviewer-shell/capabilities/default.json`
- Create: `scripts/poc/gate-3/reviewer-shell/src/main.rs`
- Create: `scripts/poc/gate-3/reviewer-shell/src/artifact_store.rs`
- Create: `scripts/poc/gate-3/reviewer-shell/src/review_protocol.rs`
- Create: `scripts/poc/gate-3/reviewer-shell/src/review_state.rs`

**Interfaces:**
- Consumes: native drop paths inside Rust only.
- Produces: opaque 128-bit handles and read-only `reviewasset://localhost/{artifact|preview}/{handle}` URLs.

- [ ] **Step 0: Create the exact Cargo manifest**

```toml
[package]
name = "superwagie-reviewer-poc"
version = "0.1.0"
edition = "2021"

[build-dependencies]
tauri-build = "2.6.3"

[dependencies]
tauri = "2.11.5"
serde = { version = "1.0.229", features = ["derive"] }
serde_json = "1.0.151"
sha2 = "0.11.0"
uuid = { version = "1.26.0", features = ["v4"] }
lopdf = "0.44.0"
mime_guess = "2.0.5"

[dev-dependencies]
tempfile = "3.27.0"
```

Run `cargo generate-lockfile --manifest-path scripts/poc/gate-3/reviewer-shell/Cargo.toml` and retain `Cargo.lock`.

Use this Tauri configuration; do not enable broad filesystem or shell plugins:

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "SuperWagie Reviewer PoC",
  "version": "0.1.0",
  "identifier": "com.superwagie.poc.reviewer",
  "build": { "frontendDist": "../reviewer-ui/dist" },
  "app": {
    "withGlobalTauri": false,
    "windows": [{ "label": "main", "title": "SuperWagie Reviewer PoC", "width": 1440, "height": 900, "dragDropEnabled": true }],
    "security": {
      "csp": "default-src 'self'; img-src 'self' blob: data: reviewasset:; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; connect-src ipc: http://ipc.localhost reviewasset:"
    }
  }
}
```

`capabilities/default.json` allows only the seven custom commands declared in `HostBridge`; it does not grant Tauri filesystem, shell, process, HTTP, opener, or unrestricted asset-scope permissions.

- [ ] **Step 1: Write Rust tests for authorization and range reads**

```rust
#[test]
fn unknown_handle_is_not_found() {
    let store = ArtifactStore::default();
    assert_eq!(store.resolve("missing").unwrap_err(), StoreError::NotFound);
}

#[test]
fn range_is_clamped_to_authorized_file() {
    let store = fixture_store(b"0123456789");
    assert_eq!(store.read_range("fixture", 3, 4).unwrap(), b"3456");
    assert!(store.read_range("fixture", 0, MAX_RANGE + 1).is_err());
}

#[test]
fn public_metadata_never_contains_absolute_path() {
    let meta = fixture_store(b"x").public_metadata("fixture").unwrap();
    assert!(!serde_json::to_string(&meta).unwrap().contains("/tmp/"));
}

#[test]
fn fast_preview_cannot_be_accepted() {
    let state = ReviewStateStore::temporary();
    let result = state.accept_preview("fast-preview", PreviewFidelity::Fast);
    assert_eq!(result.unwrap_err(), ReviewStateError::NotAuthoritative);
}

#[test]
fn annotation_survives_store_reopen() {
    let dir = tempfile::tempdir().unwrap();
    ReviewStateStore::open(dir.path()).unwrap().save(&fixture_annotation()).unwrap();
    let reopened = ReviewStateStore::open(dir.path()).unwrap();
    assert_eq!(reopened.annotations("preview-1").unwrap().len(), 1);
}
```

Inside the `#[cfg(test)]` module define `const MAX_RANGE: usize = 8 * 1024 * 1024;` and `fn fixture_store(bytes: &[u8]) -> ArtifactStore`, which writes a temporary fixture, inserts it through the same authorization method used by native drop, and returns the store.

- [ ] **Step 2: Run Cargo tests to verify they fail before implementation**

Run `cargo test --manifest-path scripts/poc/gate-3/reviewer-shell/Cargo.toml`.

Expected: FAIL on missing modules.

- [ ] **Step 3: Implement handle creation and scope validation**

`ArtifactStore` owns `HashMap<ArtifactHandle, AuthorizedArtifact>`. Only the native drop handler can insert. Allow `.pdf`, `.docx`, and `.pptx`; reject directories, symlinks, files above the fixture-configured limit, and extensions that do not match magic/OOXML container type.

The WebView event payload is:

```rust
#[derive(Serialize, Clone)]
struct ArtifactOpened {
    handle: String,
    display_name: String,
    media_type: String,
    size: u64,
    revision_hash: String,
}
```

It must not contain `path`.

`ReviewStateStore` writes annotations and accepted Preview IDs with temporary-file + fsync + atomic rename semantics under the PoC data directory. It rejects acceptance unless `PreviewFidelity::Authoritative`; reopening the store after a simulated WebView restart must reproduce annotations byte-for-byte.

`record_metrics` accepts only finite non-negative numbers and the fixed interaction names `scroll`, `zoom`, `page`, `selection`, and `annotation`. It rejects unknown fields and strings, then atomically writes the latest numeric snapshot to the evidence run directory selected by `SUPERWAGIE_REVIEW_EVIDENCE_DIR`.

- [ ] **Step 4: Implement the read-only protocol**

Accept only host `localhost`, path kinds `artifact` and `preview`, methods `GET` and `HEAD`, and valid handles. Support `Range: bytes=start-end`, cap one response range at 8 MiB, return `206` with `Content-Range`, set `Cache-Control: private, immutable`, and deny path traversal before lookup.

Implement `open_controlled_copy(handle)` in Rust: copy the authorized Office artifact to a job-owned review directory, verify its hash, open that copy through the platform Office launcher, and return a receipt ID. Never open or edit the original dropped path. The command is disabled for PDF and for unknown handles.

- [ ] **Step 5: Run Rust tests and build the Tauri shell**

Run:

```bash
cargo test --manifest-path scripts/poc/gate-3/reviewer-shell/Cargo.toml
cargo build --locked --manifest-path scripts/poc/gate-3/reviewer-shell/Cargo.toml
```

Expected: PASS; generated executable contains no literal `/Applications/ChatGPT.app` and the WebView API does not expose a filesystem command.

---

### Task 6: Implement the Explicit WPS Render Worker and Immutable Cache

**Files:**
- Create: `scripts/poc/gate-3/wps-render-worker.py`
- Create: `scripts/poc/gate-3/test_wps_render_worker.py`
- Create: `scripts/poc/gate-3/reviewer-shell/src/wps_worker.rs`
- Create: `scripts/poc/gate-3/reviewer-shell/src/preview_cache.rs`

**Interfaces:**
- Consumes: host-private source path, explicit Python path, explicit WPSComposer root, deadline, expected source hash.
- Produces: one-line `WpsRenderReceipt`, staged PDF, immutable cache entry, and stable error code.

- [ ] **Step 1: Write Python protocol tests with a fake converter**

```python
def test_success_receipt_contains_no_staging_path(tmp_path, monkeypatch):
    source = tmp_path / "source.docx"
    source.write_bytes(b"fixture")
    output = tmp_path / "out.pdf"
    monkeypatch.setenv("SUPERWAGIE_WPS_FAKE_PDF", str(FIXTURE_PDF))
    result = run_worker(source, output)
    assert result["status"] == "success"
    assert result["output_sha256"]
    assert "staging" not in json.dumps(result).lower()

def test_missing_wps_is_dependency_missing(tmp_path):
    result = run_worker(tmp_path / "source.docx", tmp_path / "out.pdf", composer_root=tmp_path / "missing")
    assert result["status"] == "dependency_missing"
    assert result["code"] == "WPS_RUNTIME_MISSING"
```

The test module defines `FIXTURE_PDF` as the audited `reviewer-torture-100p.pdf` path and a `run_worker(source, output, composer_root=WPSCOMPOSER_ROOT)` helper that invokes the worker with the current test interpreter, parses its single stdout JSON object, and fails if stdout has extra lines.

- [ ] **Step 2: Run tests to prove the worker is absent**

Run:

```bash
/Users/neomei/项目/codexprojects/WpsComposer/.venv/bin/python -m pytest scripts/poc/gate-3/test_wps_render_worker.py -q
```

Expected: FAIL because `wps-render-worker.py` does not exist.

- [ ] **Step 3: Implement the worker protocol**

The worker must import only through the explicit source root:

```python
sys.path.insert(0, str(args.wpscomposer_root.resolve()))
from skills.WPSComposer import convert_to_pdf

published = convert_to_pdf(
    str(args.source.resolve()),
    output=str(args.output.resolve()),
    overwrite=False,
)
print(json.dumps({
    "status": "success",
    "code": "OK",
    "component": component_for(args.source),
    "backend": "wpscomposer-explicit-source",
    "output_sha256": sha256(Path(published)),
}, ensure_ascii=False))
```

`component_for()` maps `.doc/.docx` to `writer`, `.ppt/.pptx` to `presentation`, and `.xls/.xlsx` to `spreadsheet`. Map WPSComposer `ConversionError` fields to `WPS_RUNTIME_MISSING`, `WPS_INTERACTIVE_INPUT_REQUIRED`, `WPS_RENDER_TIMEOUT`, or `WPS_RENDER_FAILED`. Emit exactly one JSON object on stdout; diagnostics go to stderr. Rust validates the published PDF and page count with `lopdf` before cache publication.

- [ ] **Step 4: Implement owned-child deadlines and cache identity in Rust**

`wps_worker.rs` must spawn the explicit Python executable with `env_clear()`, then add only locale, the job-owned temp directory, WPS bridge variables, and the OS user home when the WPS container feature probe proves it is required. It must never set `CODEX_HOME`, `PATH`, `OPENAI_*`, or other Agent configuration; Python and WPSComposer locations come only from absolute arguments. On timeout, terminate only the owned worker process and return `WPS_RENDER_TIMEOUT`.

`preview_cache.rs` computes:

```text
sha256(source_content_hash || renderer_id || renderer_version ||
       renderer_environment_hash || font_environment_hash || render_options)
```

Write to `staging/<job-id>/preview.pdf`, validate PDF magic/page count, fsync, then atomically publish `previews/<cache-key>/preview.pdf` and `manifest.json`. A crash before publish leaves the previous immutable revision untouched.

- [ ] **Step 5: Run worker and cache tests**

Run:

```bash
/Users/neomei/项目/codexprojects/WpsComposer/.venv/bin/python -m pytest scripts/poc/gate-3/test_wps_render_worker.py -q
cargo test --manifest-path scripts/poc/gate-3/reviewer-shell/Cargo.toml preview_cache wps_worker
```

Expected: PASS using the fake converter; real WPS is not required for unit tests.

---

### Task 7: Implement Review Annotations, Re-anchoring, Diff, and Agent Request Artifacts

**Files:**
- Create: `scripts/poc/gate-3/annotation-reanchor.ts`
- Create: `scripts/poc/gate-3/annotation-reanchor.test.ts`
- Create: `scripts/poc/gate-3/reviewer-ui/src/review-overlay.ts`
- Create: `scripts/poc/gate-3/reviewer-ui/src/review-overlay.test.ts`

**Interfaces:**
- Consumes: Artifact/Preview revision IDs, page ID, normalized bbox, optional semantic ID, selected text and context hash.
- Produces: `ReviewAnnotation`, `ReanchorResult`, visual diff mask, and an inert `AgentChangeRequest` JSON artifact.

- [ ] **Step 1: Write re-anchoring tests**

```ts
it('prefers semantic identity over coordinates', () => {
  const result = reanchor(annotation({ semanticObjectId: 'shape-7' }), next({ semanticObjectId: 'shape-7', bbox: [0.2, 0.3, 0.4, 0.1] }));
  expect(result).toMatchObject({ status: 'resolved', method: 'semantic', confidence: 1 });
});

it('marks ambiguous nearby text unresolved', () => {
  const result = reanchor(annotation({ selectedText: '季度目标' }), nextWithDuplicateText('季度目标'));
  expect(result.status).toBe('unresolved');
});

it('never carries a fast-preview bbox directly into authoritative preview', () => {
  const result = reanchor(annotation({ fidelity: 'fast', bbox: [0.1, 0.1, 0.2, 0.1] }), authoritativeWithoutText());
  expect(result.status).toBe('unresolved');
});
```

- [ ] **Step 2: Implement deterministic relocation order**

Use this exact order and thresholds:

1. semantic object ID exact match → confidence `1.0`;
2. selected text + both context hashes on one page → `0.95`;
3. selected text + one context hash within adjacent page neighborhood → `0.85`;
4. image feature match within the same page → accept only `>=0.90`;
5. normalized bbox alone never resolves across Preview Revisions.

Anything below `0.85`, any duplicate best candidate, or any fast-to-authoritative bbox-only move becomes `unresolved`.

- [ ] **Step 3: Implement Overlay output and Agent request schema**

```ts
export interface AgentChangeRequest {
  requestId: string;
  artifactRevisionId: string;
  previewRevisionId: string;
  annotationIds: string[];
  instruction: string;
  context: Array<{ pageId: string; selectedText?: string; bbox?: [number, number, number, number] }>;
}

export interface ReanchorResult {
  status: 'resolved' | 'unresolved';
  method?: 'semantic' | 'text-context' | 'image-feature';
  confidence: number;
  pageId?: string;
  bbox?: NormalizedBox;
}
```

The PoC writes this JSON under the evidence artifacts directory and displays “修改请求已准备”. It must not invoke Codex Desktop or raw App Server.

- [ ] **Step 4: Add page-level visual diff**

Rasterize the same page from two Preview Revisions at the same pixel dimensions, then run Pixelmatch with `threshold=0.1`. Save `diff.png`, `changed_pixels`, `total_pixels`, and `ratio`. Dimension mismatch is a failed comparison, not an auto-resize.

- [ ] **Step 5: Run annotation, overlay, and diff tests**

Run:

```bash
cd scripts/poc/gate-3
npm test -- annotation-reanchor.test.ts reviewer-ui/src/review-overlay.test.ts
```

Expected: PASS; duplicate and fast-to-truth ambiguity always produce `unresolved`.

---

### Task 8: Register Gate 3 Executors and Produce Standard Evidence

**Files:**
- Create: `scripts/poc/gate-3/review-gate.mjs`
- Create: `scripts/poc/gate-3/review-isolation-gate.mjs`
- Create: `scripts/poc/gate-3/review-gate.test.mjs`
- Create: `scripts/poc/gate-3/license-audit.mjs`
- Create: `scripts/poc/gate-3/license-audit.test.mjs`
- Modify: `scripts/poc/run-gate.sh`
- Modify: `scripts/poc/README.md`

**Interfaces:**
- Consumes: G3-REVIEW-001/002 fixtures, built Tauri shell, checklist JSON, explicit WPS Python/root.
- Produces: standard evidence tree and decision hint consumed by the Technical Validation Plan.

- [ ] **Step 1: Add CLI arguments without environment discovery**

Extend `run-gate.sh` with:

```text
--wps-python PATH
--wpscomposer-root DIRECTORY
--review-checklist JSON_FILE
--scenario SCENARIO_ID
```

Reject relative paths. Do not default to the current WPSComposer checkout, `PATH`, `HOME`, or a Codex directory.

- [ ] **Step 2: Write executor contract tests**

Test that:

- unknown Gate 3 fixture exits `2`;
- missing explicit WPS arguments produces `BLOCKED_ENVIRONMENT`, not pass/fail;
- `G3-REVIEW-001` without manual checklist can only emit `CONDITIONAL_GO`;
- invalid checklist or any silent annotation misplacement emits `NO_GO`;
- `G3-REVIEW-002 --scenario codex-never-installed` is mandatory before `GO`;
- evidence contains no raw user path, WPS staging path, Secret, or Codex configuration content.

- [ ] **Step 3: Implement `review-gate.mjs` metrics**

Write these keys to `results.json`:

```json
{
  "metrics": {
    "progress_visible_ms": 0,
    "cached_first_page_p95_ms": 0,
    "authoritative_first_reviewable_page_ms": 0,
    "interaction_p95_ms": 0,
    "peak_rss_bytes": 0,
    "cache_bytes": 0,
    "reanchor_resolved": 0,
    "reanchor_unresolved": 0,
    "reanchor_silent_misplaced": 0,
    "visual_diff_ratio": 0
  }
}
```

The executor passes only when `progress_visible_ms<=300`, cached P95 `<=1000`, authoritative first page `<=5000` for the declared fixture, interaction P95 `<=100`, and silent misplacement is `0`. If a representative machine misses only a performance threshold, emit `CONDITIONAL_GO` with the external/side-by-side WPS fallback.

For automated measurement, `review-gate.mjs` launches the built Tauri executable with an explicit audited fixture-manifest path, `SUPERWAGIE_REVIEW_EVIDENCE_DIR`, and `SUPERWAGIE_REVIEW_AUTOMATION=1`. In this test-only mode Rust authorizes only files already present in the audited manifest; `main.ts` opens PDF, DOCX fast preview, and WPS truth preview in order, performs fixed scroll/zoom/page/selection/annotation actions, calls `recordMetrics`, and writes `automation-complete.json`. The executor uses a 180-second deadline, terminates only its owned PoC process, and treats missing completion/metrics as failure. Manual checklist runs omit the automation variable and use native drag/drop.

- [ ] **Step 4: Implement `review-isolation-gate.mjs` comparisons**

For each scenario, record a normalized snapshot containing:

```ts
interface IsolationSnapshot {
  binary_sha256: string;
  dependency_manifest_sha256: string;
  renderer_manifest_sha256: string;
  preview_hashes: string[];
  process_executables: string[];
  opened_path_prefixes: string[];
  network_targets: string[];
}
```

Normalize timestamps and run IDs before comparison. `codex-never-installed`, `codex-installed-not-running`, `codex-running`, and `codex-config-mutated` must have identical dependency/renderer/preview hashes. Process/opened-path lists must not contain `ChatGPT.app`, `Codex.app`, `.codex`, `CODEX_HOME`, or Codex sockets.

- [ ] **Step 5: Register Gate 3 in the unified runner**

Add a `gate-3)` case that dispatches exactly:

```sh
G3-REVIEW-001)
  node "$G3_DIR/review-gate.mjs" --fixture "$FIXTURE" \
    --results-json "$EV/results.json" --artifacts-dir "$EV/artifacts" \
    --wps-python "$WPS_PYTHON" --wpscomposer-root "$WPSCOMPOSER_ROOT" \
    --checklist-result "$REVIEW_CHECKLIST"
  ;;
G3-REVIEW-002)
  node "$G3_DIR/review-isolation-gate.mjs" --fixture "$FIXTURE" \
    --results-json "$EV/results.json" --artifacts-dir "$EV/artifacts" \
    --scenario "$SCENARIO"
  ;;
```

Always pass `--results-json "$EV/results.json"` and `--artifacts-dir "$EV/artifacts"`. Copy manual screenshots into `$EV/screenshots`; never accept screenshots as a substitute for metrics JSON.

- [ ] **Step 6: Generate dependency and clean-room evidence**

`license-audit.test.mjs` must fail if direct dependency licenses differ from the checked-in policy:

```js
const ALLOWED_DIRECT = {
  'docx-preview': ['Apache-2.0'],
  'pdfjs-dist': ['Apache-2.0'],
  '@tauri-apps/api': ['Apache-2.0', 'MIT']
};
```

`license-audit.mjs` reads actual installed package metadata and license files, runs `cargo metadata --locked --format-version 1`, and writes `third-party-inventory.json`. It also scans `reviewer-ui/dist`, the Rust source tree, and the compiled executable for `ChatGPT.app`, `Codex.app`, `/Applications/ChatGPT.app`, `.codex`, and Codex Reviewer asset names; any match outside documentation/evidence produces failure.

Generate machine-readable inventories:

```bash
cd scripts/poc/gate-3
npm sbom --sbom-format cyclonedx > ../../../evidence/gate-3/npm-sbom.cdx.json
cargo metadata --locked --format-version 1 --manifest-path reviewer-shell/Cargo.toml > ../../../evidence/gate-3/cargo-metadata.json
node license-audit.mjs --output ../../../evidence/gate-3/third-party-inventory.json
```

The manual Gate 3 checklist records WPS exact version, WPSComposer source identity, terms-review owner, and decision. Missing WPS commercial-use/re-distribution review keeps the decision conditional even when rendering works.

- [ ] **Step 7: Run executor, license, and shell syntax checks**

Run:

```bash
node --test scripts/poc/gate-3/review-gate.test.mjs scripts/poc/gate-3/license-audit.test.mjs
sh -n scripts/poc/run-gate.sh
node scripts/check-spec-refs.mjs
```

Expected: PASS.

---

### Task 9: Execute macOS G3-REVIEW-001 and Record Real WPS Review Evidence

**Files:**
- Modify: `fixtures/gate-3/G3-REVIEW-001/checklist-result.json`
- Create at runtime: a timestamped run directory under `evidence/gate-3/`

**Interfaces:**
- Consumes: completed PoC, real macOS WPS, explicit WPSComposer paths, user-operated visual checklist.
- Produces: signed macOS `GO`, `CONDITIONAL_GO`, `NO_GO`, or `BLOCKED_ENVIRONMENT`; never a cross-platform conclusion.

- [ ] **Step 1: Run all automated tests before opening the GUI**

```bash
cd scripts/poc/gate-3
npm ci
npm test
npm run build:ui
cd ../../..
cargo test --manifest-path scripts/poc/gate-3/reviewer-shell/Cargo.toml
/Users/neomei/项目/codexprojects/WpsComposer/.venv/bin/python -m pytest scripts/poc/gate-3/test_wps_render_worker.py -q
```

Expected: all commands exit `0`.

- [ ] **Step 2: Start the Gate 3 Review fixture through the unified runner**

```bash
./scripts/poc/run-gate.sh gate-3 \
  --platform macos-15-arm64 \
  --fixture G3-REVIEW-001 \
  --wps-python /Users/neomei/项目/codexprojects/WpsComposer/.venv/bin/python \
  --wpscomposer-root /Users/neomei/项目/codexprojects/WpsComposer
```

Expected before manual sign-off: exit `0` with `decision_hint=CONDITIONAL_GO`, or exit `2` only for a precisely reported missing/incompatible WPS environment.

- [ ] **Step 3: Perform the real visual checklist**

For DOCX, PPTX, and PDF: open, scroll, zoom, search/select when supported, create point/region/text annotations, issue one Agent change-request artifact, switch to a new Revision, inspect visual diff, and confirm. Compare authoritative pages with the same source opened/exported directly in WPS. Record page count, pagination, fonts, numbering, tables, images, slide geometry, transparency, SVG, and missing-font behavior.

Use `checklist-result.example.json` as schema; every item must contain `passed`, operator role, WPS exact version, start/end time, screenshot references, and notes. Do not record a bare `all_passed=true`.

- [ ] **Step 4: Re-run with the checklist**

```bash
./scripts/poc/run-gate.sh gate-3 \
  --platform macos-15-arm64 \
  --fixture G3-REVIEW-001 \
  --wps-python /Users/neomei/项目/codexprojects/WpsComposer/.venv/bin/python \
  --wpscomposer-root /Users/neomei/项目/codexprojects/WpsComposer \
  --review-checklist fixtures/gate-3/G3-REVIEW-001/checklist-result.json
```

Expected: decision reflects metrics and human evidence. It is `NO_GO` if authoritative fidelity, silent-anchor correctness, or clean-room checks fail; performance-only failure yields `CONDITIONAL_GO` with explicit fallback.

---

### Task 10: Execute Independence, Failure, and Recovery Scenarios

**Files:**
- Create at runtime: timestamped run directories under `evidence/gate-3/`
- Modify after evidence: `docs/技术可行性/技术要求矩阵.md`
- Modify after evidence: `docs/技术可行性/README.md`
- Modify after evidence: `docs/技术可行性/08-独立Office-Reviewer.md`

**Interfaces:**
- Consumes: scenario snapshots from G3-REVIEW-002 and G3-REVIEW-001 decision.
- Produces: final status update for UI-05, DOC-04, DOC-05, and DOC-06 with exact evidence paths.

- [ ] **Step 1: Run non-destructive local isolation scenarios**

Do not uninstall, stop, or modify Codex Desktop. For the current machine, run only `codex-installed-not-running`, `codex-running`, and a fixture-local fake-config mutation that cannot touch real Codex configuration:

```bash
./scripts/poc/run-gate.sh gate-3 --platform macos-15-arm64 --fixture G3-REVIEW-002 --scenario codex-installed-not-running
./scripts/poc/run-gate.sh gate-3 --platform macos-15-arm64 --fixture G3-REVIEW-002 --scenario codex-running
./scripts/poc/run-gate.sh gate-3 --platform macos-15-arm64 --fixture G3-REVIEW-002 --scenario codex-config-mutated
```

Expected: normalized hashes match and no prohibited process/path/network target appears.

- [ ] **Step 2: Run dependency and recovery injection**

Use fixture-local fake executable paths and owned child processes to execute `wps-missing`, `wps-timeout`, `wps-crash`, `webview-restart`, `cache-corrupt`, and `source-revision-changed`. Never kill a user-owned WPS process. Expected outcomes:

- WPS missing: DOCX fast preview remains readable, acceptance disabled; PPTX truth preview blocked.
- WPS timeout/crash: owned worker terminates, previous Preview Revision remains intact.
- WebView restart: annotations and last confirmed Revision restore.
- Cache corruption: hash validation discards only the corrupt entry and rerenders.
- Source revision change: old annotation remains bound to old Revision until deterministic relocation finishes.

- [ ] **Step 3: Run `codex-never-installed` on a clean target machine**

This scenario cannot be simulated by hiding the local app. Use a clean macOS arm64 machine or VM snapshot that has never installed Codex Desktop. Install only the PoC build, supported WPS, and explicit WPSComposer validation dependency. Run G3-REVIEW-001 and G3-REVIEW-002 and retain environment/application inventory as evidence.

If no such environment is available, return exit `2`, mark `BLOCKED_ENVIRONMENT`, and keep DOC-06 at `FEASIBLE_CONDITIONAL`. Do not mark it passed from local negative scans.

- [ ] **Step 4: Repeat on Windows 11 x64**

Use explicit Windows Python and WPSComposer paths. Run the same fixtures and scenarios. Windows failure cannot be replaced by the macOS result; keep the matrix status conditional until both target platforms complete.

- [ ] **Step 5: Update technical statuses only from signed evidence**

Rules:

- Set `DOC-06` to `PROVEN_POC` only when both platforms pass G3-REVIEW-001/002, including `codex-never-installed`.
- Set `DOC-04` to `PROVEN_POC` only when authoritative WPS rendering and interaction thresholds pass; performance-only fallback keeps it `FEASIBLE_CONDITIONAL`.
- Set `DOC-05` to `PROVEN_POC` only when silent misplacement is zero across repagination, slide rebuild, and fast-to-authoritative transition.
- Keep `UI-05` conditional or research-required until the other non-Office preview formats also have their own evidence.
- Add evidence paths and platform decisions to `08-独立Office-Reviewer.md`; never replace design text with a success claim lacking run IDs.

- [ ] **Step 6: Run final verification and conditional commit checkpoint**

```bash
node scripts/check-spec-refs.mjs
cd scripts/poc/gate-3 && npm test && npm run build:ui && cd ../../..
cargo test --manifest-path scripts/poc/gate-3/reviewer-shell/Cargo.toml
sh -n scripts/poc/run-gate.sh
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git add scripts/poc/gate-3 fixtures/gate-3 docs/技术可行性 scripts/poc/run-gate.sh scripts/poc/README.md
  git commit -m "test: validate independent office reviewer"
else
  echo SKIP_COMMIT_NON_GIT
fi
```

Expected: all automated tests pass, specification references pass, and matrix status matches actual signed evidence rather than the intended architecture.

---

## Spec Coverage Map

| Architecture spec section | Implementation-plan coverage | Required evidence |
|---|---|---|
| §1 Product boundary and non-goals | Tasks 2, 5, 8, 10 | Fixture scope, protocol boundary, dependency audit, clean-machine inventory |
| §2 Codex Desktop independence | Tasks 5, 8, 10 | Forbidden dependency scan, isolation snapshots, never-installed-Codex run |
| §3 Target platforms and runtime boundary | Tasks 2, 5, 8, 10 | macOS arm64 and Windows 11 x64 signed runs; explicit runtime paths |
| §4 Review state model | Tasks 1, 5, 6 | State-transition tests, persistent session state, immutable revision receipts |
| §5 Rendering and cache architecture | Tasks 1, 5, 6 | Adapter contract, opaque artifact protocol, content-addressed cache validation |
| §6 Format strategies | Tasks 3, 6 | PDF.js, DOCX fast preview, and WPS-authoritative DOCX/PPTX evidence |
| §7 Review interaction and Agent handoff | Tasks 4, 7, 9 | Navigation/selection/annotation UI, deterministic reanchoring, change-request artifact |
| §8 Performance, fallback, and failure recovery | Tasks 4, 6, 8, 10 | P95 metrics, timeout/crash injection, WebView restart, cache recovery |
| §9 Security, privacy, and supply chain | Tasks 2, 5, 8, 10 | Provenance hashes, bounded read-only protocol, SBOM/license report, no path leakage |
| §10 Gate 3 acceptance | Tasks 2, 8, 9, 10 | Machine-readable results, human WPS checklist, platform decisions, screenshots |
| §11 Decision and production boundary | Plan Completion Boundary | Explicit distinction between PoC construction, platform proof, and production admission |

The coverage map is a navigation aid, not a substitute for reading `docs/技术可行性/08-独立Office-Reviewer.md`. Any implementation ambiguity is resolved against that architecture spec and the repository authority order.

---

## Plan Completion Boundary

Completing Tasks 1–8 means the PoC and runners exist; it does not prove the feature. Completing Task 9 proves only the current macOS/WPS combination. Production planning is allowed only after Task 10 records both target platforms, a never-installed-Codex environment, licenses/SBOM, real WPS fidelity, annotation correctness, performance, and fallback decisions.

Do not merge PoC source into the eventual production tree. The production plan must re-use the proven contracts and fixtures while independently designing the Product Core modules and migration path.
> **superseded-for-current-architecture (2026-09-04):** This file preserves evidence for the retired WPS-authoritative Office Review path. It cannot satisfy Universal Viewer GVP-0–5 or current production admission. Current authority: `docs/superpowers/specs/2026-09-04-superwagie-universal-viewer-platform-design.md`.
