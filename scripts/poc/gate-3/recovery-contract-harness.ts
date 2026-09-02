import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// jsdom is a pinned project dev dependency; this fixed CLI harness uses its runtime API only.
// @ts-expect-error jsdom does not ship declarations in the locked dependency graph.
import { JSDOM } from 'jsdom';
import { createReviewAnnotation, reanchor } from './annotation-reanchor';
import { createPreviewOrchestrator } from './preview-orchestrator';
import type {
  ArtifactRevisionId,
  PageSurfaceRef,
  PreviewAdapter,
  PreviewManifest,
  PreviewRequest,
  PreviewRevisionId,
  PreviewSession,
  ReviewPerformanceSnapshot,
  TextLayer
} from './review-contract';
import { DocxFastAdapter } from './reviewer-ui/src/docx-fast-adapter';
import type { HostBridge } from './reviewer-ui/src/host-bridge';
import { rehydrateReviewShell } from './reviewer-ui/src/review-shell';

const OLD_ARTIFACT_REVISION = `artifact-sha256:${'2'.repeat(64)}` as ArtifactRevisionId;
const OLD_PREVIEW_REVISION = `preview-sha256:${'1'.repeat(64)}` as PreviewRevisionId;
const NEW_ARTIFACT_REVISION = `artifact-sha256:${'3'.repeat(64)}` as ArtifactRevisionId;
const NEW_PREVIEW_REVISION = `preview-sha256:${'4'.repeat(64)}` as PreviewRevisionId;
const FIXTURE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/gate-3/G3-REVIEW-001'
);

class UnavailableTruthAdapter implements PreviewAdapter {
  readonly id = 'fixed-unavailable-truth-fault';
  async probe(): Promise<{ available: boolean }> { return { available: false }; }
  async open(_request: PreviewRequest): Promise<PreviewSession> { throw new Error('dependency missing'); }
  async getManifest(_sessionId: string): Promise<PreviewManifest> { throw new Error('dependency missing'); }
  async getPage(_sessionId: string, _pageId: string, _scaleBucket: number): Promise<PageSurfaceRef> { throw new Error('dependency missing'); }
  async getThumbnail(_sessionId: string, _pageId: string): Promise<PageSurfaceRef> { throw new Error('dependency missing'); }
  async getTextLayer(_sessionId: string, _pageId: string): Promise<TextLayer | null> { return null; }
  async cancel(_sessionId: string): Promise<void> {}
}

function installDom(): JSDOM {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    pretendToBeVisual: true
  });
  const window = dom.window;
  Object.assign(globalThis, {
    window,
    document: window.document,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    HTMLCanvasElement: window.HTMLCanvasElement,
    DOMParser: window.DOMParser,
    XMLSerializer: window.XMLSerializer,
    getComputedStyle: window.getComputedStyle.bind(window)
  });
  return dom;
}

function fixedHost(bytes: Uint8Array, onTruthRender: () => void = () => {}): HostBridge {
  const assetUrl = 'reviewasset://localhost/fixed-recovery-docx';
  globalThis.fetch = async (input: string | URL | Request) => {
    const requested = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (requested !== assetUrl) return new Response('missing review asset', { status: 404 });
    return new Response(bytes.slice().buffer, { status: 200 });
  };
  return {
    async assetUrl() { return assetUrl; },
    async startTruthRender() {
      onTruthRender();
      return { jobId: '00000000000000000000000000000000' };
    },
    async previewStatus() { return { jobId: '00000000000000000000000000000000', state: 'queued' }; },
    async saveAnnotation() {},
    async acceptPreview() {},
    async openControlledCopy() { return { receiptId: 'fixed-recovery-copy-receipt' }; },
    async recordMetrics(_snapshot: ReviewPerformanceSnapshot) {}
  };
}

async function wpsMissing() {
  const dom = installDom();
  try {
    const docxBytes = new Uint8Array(await readFile(path.join(
      FIXTURE_ROOT,
      'fixtures/reviewer-torture-30p.docx'
    )));
    const host = fixedHost(docxBytes);
    const bodyContainer = document.createElement('main');
    const styleContainer = document.createElement('div');
    document.body.append(bodyContainer, styleContainer);
    const fast = new DocxFastAdapter(host, { bodyContainer, styleContainer });
    const truth = new UnavailableTruthAdapter();
    const request: PreviewRequest = {
      artifactRevisionId: OLD_ARTIFACT_REVISION,
      artifactHandle: '11111111111111111111111111111111',
      mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      preferredFidelity: 'authoritative',
      deadlineMs: 1_000
    };
    const adapterSession = await fast.open(request);
    const manifest = await fast.getManifest(adapterSession.sessionId);
    const firstTextLayer = await fast.getTextLayer(
      adapterSession.sessionId,
      manifest.pages[0]?.pageId ?? ''
    );
    await fast.cancel(adapterSession.sessionId);
    const docx = await createPreviewOrchestrator(fast, truth, () => {}).run(request);
    const pptx = await createPreviewOrchestrator(fast, truth, () => {}).run({
      artifactRevisionId: OLD_ARTIFACT_REVISION,
      artifactHandle: '22222222222222222222222222222222',
      mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      preferredFidelity: 'authoritative', deadlineMs: 1_000
    });
    const readable = manifest.pages.length > 0
      && (firstTextLayer?.items.some((item) => item.text.trim().length > 0) ?? false);
    return {
      docx: {
        state: docx.states.at(-1) === 'dependency_missing' && docx.states.includes('fast_ready')
          ? 'fast_ready' : docx.states.at(-1),
        fidelity: manifest.previewRevision.fidelity,
        readable,
        acceptance_enabled: docx.canAccept || manifest.previewRevision.acceptanceState !== 'not_eligible'
      },
      pptx: {
        state: pptx.states.at(-1),
        preview_published: pptx.states.includes('authoritative_ready'),
        acceptance_enabled: pptx.canAccept
      }
    };
  } finally {
    dom.window.close();
  }
}

function sourceRevisionChanged() {
  const annotation = Object.freeze(createReviewAnnotation({
    annotationId: 'annotation-12345678-1234-4123-8123-123456789abc',
    artifactRevisionId: OLD_ARTIFACT_REVISION,
    previewRevisionId: OLD_PREVIEW_REVISION,
    fidelity: 'authoritative',
    pageId: 'page-4',
    bbox: [0.1, 0.2, 0.3, 0.2],
    semanticObjectId: 'semantic-87654321-4321-4123-8123-cba987654321',
    status: 'active'
  }));
  const readBinding = () => ({
    annotation_id: annotation.annotationId,
    artifact_revision_id: annotation.artifactRevisionId,
    preview_revision_id: annotation.previewRevisionId,
    page_id: annotation.pageId
  });
  const before = readBinding();
  const relocation = reanchor(annotation, {
    artifactRevisionId: NEW_ARTIFACT_REVISION,
    previewRevisionId: NEW_PREVIEW_REVISION,
    fidelity: 'authoritative',
    pageOrder: ['page-4', 'page-5'],
    candidates: [{
      candidateId: 'candidate-abcdef12-3456-4789-8123-abcdef123456',
      pageId: 'page-5', bbox: [0.2, 0.2, 0.3, 0.2],
      semanticObjectId: annotation.semanticObjectId
    }]
  });
  const after = readBinding();
  const relocationIsExplicit = relocation.status === 'resolved' || relocation.status === 'unresolved';
  const bindingChanged = JSON.stringify(before) !== JSON.stringify(after);
  return {
    old_annotation_binding_before: before,
    old_annotation_binding_after: after,
    target_revision: {
      artifact_revision_id: NEW_ARTIFACT_REVISION,
      preview_revision_id: NEW_PREVIEW_REVISION
    },
    relocation: {
      status: relocation.status,
      method: relocation.method ?? null,
      page_id: relocation.pageId ?? null
    },
    silent_movement: bindingChanged || !relocationIsExplicit
  };
}

function acceptedManifest(): PreviewManifest {
  return {
    previewRevision: {
      previewRevisionId: OLD_PREVIEW_REVISION,
      artifactRevisionId: OLD_ARTIFACT_REVISION,
      fidelity: 'authoritative',
      rendererId: 'fixed-recovery-renderer',
      rendererVersion: '1',
      rendererEnvironmentHash: 'fixed-renderer-environment',
      fontEnvironmentHash: 'fixed-font-environment',
      sourceContentHash: 'fixed-source-content',
      pageManifestHash: 'fixed-page-manifest',
      acceptanceState: 'reviewable'
    },
    pages: Array.from({ length: 3 }, (_unused, index) => ({
      pageId: `page-${index + 1}`,
      width: 800,
      height: 1_000
    }))
  };
}

function webviewRestart() {
  const dom = installDom();
  try {
    let startTruthRenderCalls = 0;
    const host = fixedHost(new Uint8Array(), () => { startTruthRenderCalls += 1; });
    const root = document.createElement('div');
    document.body.append(root);
    const durableState = { acceptedPreviewRevisionId: OLD_PREVIEW_REVISION, currentPage: 2 };
    const beforeRestart = startTruthRenderCalls;
    const controller = rehydrateReviewShell({
      root,
      manifest: acceptedManifest(),
      mode: 'word',
      artifactHandle: '33333333333333333333333333333333',
      host,
      durableState
    });
    const afterRestart = startTruthRenderCalls;
    const outcome = {
      active_page_before: durableState.currentPage,
      active_page_after: controller.currentPage(),
      accepted_state_restored: root.querySelector('[data-testid="review-status"]')?.textContent
        ?.includes('此版本已接受') ?? false,
      render_side_effects: {
        before_restart: beforeRestart,
        after_restart: afterRestart,
        replayed: afterRestart !== beforeRestart
      }
    };
    controller.destroy();
    return outcome;
  } finally {
    dom.window.close();
  }
}

async function main() {
  const scenario = process.argv[2];
  if (process.argv.length !== 3
    || !['wps-missing', 'source-revision-changed', 'webview-restart'].includes(scenario ?? '')) {
    process.exitCode = 64;
    return;
  }
  const outcome = scenario === 'wps-missing'
    ? await wpsMissing()
    : scenario === 'source-revision-changed'
      ? sourceRevisionChanged()
      : webviewRestart();
  const contractSources = scenario === 'wps-missing'
    ? ['preview-orchestrator.ts', 'reviewer-ui/src/docx-fast-adapter.ts']
    : scenario === 'source-revision-changed'
      ? ['annotation-reanchor.ts']
      : ['reviewer-ui/src/review-shell.ts'];
  process.stdout.write(`${JSON.stringify({
    schema_id: 'superwagie.recovery-ts-harness.v1',
    schema_version: 1,
    scenario,
    contract_sources: contractSources,
    outcome
  })}\n`);
}

void main();
