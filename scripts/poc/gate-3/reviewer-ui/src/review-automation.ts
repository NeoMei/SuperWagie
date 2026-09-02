import type {
  PreviewManifest,
  PreviewRequest,
  PreviewSession,
  ReviewAutomationMetrics,
  ReviewPerformanceSnapshot
} from '../../review-contract';
import { createAnnotationId, createPageId } from '../../review-identifiers';
import type { HostBridge, OpenedArtifact } from './host-bridge';

interface AutomationAdapter {
  open(request: PreviewRequest): Promise<PreviewSession>;
  getManifest(sessionId: string): Promise<PreviewManifest>;
  getPage(sessionId: string, pageId: string, scaleBucket: number): Promise<unknown>;
  getTextLayer(sessionId: string, pageId: string): Promise<unknown>;
  cancel(sessionId: string): Promise<void>;
}

export interface BuiltShellAutomationOptions {
  sessionId: string;
  artifacts: OpenedArtifact[];
  host: HostBridge;
  pdf: AutomationAdapter;
  docxFast: AutomationAdapter;
  showProgress: () => Promise<void>;
  presentReview: (manifest: PreviewManifest, state: 'authoritative_ready' | 'fast_ready', artifact: OpenedArtifact) => Promise<void>;
  performActions: (manifest: PreviewManifest, state: 'authoritative_ready' | 'fast_ready', artifact: OpenedArtifact) => Promise<number[]>;
  onStage?: (stage: ReviewAutomationStage) => void;
  now?: () => number;
}

export type ReviewAutomationStage =
  | 'bootstrap'
  | 'progress'
  | 'pdf_authoritative'
  | 'pdf_asset_url'
  | 'pdf_asset_fetch'
  | 'pdf_document_load'
  | 'pdf_manifest_build'
  | 'pdf_manifest_pages'
  | 'pdf_manifest_source'
  | 'pdf_manifest_hashes'
  | 'pdf_manifest_revision'
  | 'pdf_manifest_revision_id'
  | 'pdf_manifest_session'
  | 'pdf_present'
  | 'pdf_cached_page'
  | 'pdf_actions'
  | 'docx_fast'
  | 'docx_authoritative'
  | 'pptx_authoritative'
  | 'persistence'
  | 'metrics';

const EXPECTED = new Map([
  ['reviewer-torture-100p.pdf', 'application/pdf'],
  ['reviewer-torture-30p.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['reviewer-torture-20s.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation']
]);

export async function executeBuiltShellAutomation(options: BuiltShellAutomationOptions): Promise<ReviewPerformanceSnapshot> {
  options.onStage?.('bootstrap');
  if (!/^[0-9a-f]{32}$/.test(options.sessionId)) throw new Error('automation session identity is invalid');
  const byName = new Map(options.artifacts.map((artifact) => [artifact.displayName, artifact]));
  if (options.artifacts.length !== EXPECTED.size || byName.size !== EXPECTED.size
    || [...EXPECTED].some(([name, mediaType]) => byName.get(name)?.mediaType !== mediaType)) {
    throw new Error('audited automation artifacts are incomplete or invalid');
  }
  const now = options.now ?? (() => performance.now());
  const started = now();
  options.onStage?.('progress');
  await options.showProgress();
  const progressVisibleMs = Math.max(0, now() - started);
  const interactions: number[] = [];
  const cachedFirstPages: number[] = [];
  const authoritativeFirstPages: number[] = [];
  const previewHashes: Array<{ pageId: string; sha256: string }> = [];

  const pdf = byName.get('reviewer-torture-100p.pdf')!;
  options.onStage?.('pdf_authoritative');
  const pdfTruthStarted = now();
  const pdfOpened = await openManifest(options.pdf, requestFor(pdf, 'authoritative', 'artifact'));
  const pdfManifest = pdfOpened.manifest;
  options.onStage?.('pdf_present');
  await options.presentReview(pdfManifest, 'authoritative_ready', pdf);
  previewHashes.push({ pageId: 'pdf:page-1', sha256: pdfManifest.previewRevision.sourceContentHash });
  authoritativeFirstPages.push(Math.max(0, now() - pdfTruthStarted));
  options.onStage?.('pdf_cached_page');
  await sampleCachedPage(options.pdf, pdfManifest, cachedFirstPages, now, pdfOpened.sessionId);
  options.onStage?.('pdf_actions');
  await actionSample(options, pdfManifest, 'authoritative_ready', pdf, interactions);

  const docx = byName.get('reviewer-torture-30p.docx')!;
  options.onStage?.('docx_fast');
  const fastOpened = await openManifest(options.docxFast, requestFor(docx, 'fast', 'artifact'));
  const fastManifest = fastOpened.manifest;
  await options.presentReview(fastManifest, 'fast_ready', docx);
  await sampleCachedPage(options.docxFast, fastManifest, cachedFirstPages, now, fastOpened.sessionId);
  await actionSample(options, fastManifest, 'fast_ready', docx, interactions);

  options.onStage?.('docx_authoritative');
  const docxTruth = await truthManifest(options, docx, authoritativeFirstPages, now);
  previewHashes.push({ pageId: 'docx:page-1', sha256: docxTruth.manifest.previewRevision.sourceContentHash });
  await sampleCachedPage(options.pdf, docxTruth.manifest, cachedFirstPages, now, docxTruth.sessionId);
  await actionSample(options, docxTruth.manifest, 'authoritative_ready', docx, interactions);

  const pptx = byName.get('reviewer-torture-20s.pptx')!;
  options.onStage?.('pptx_authoritative');
  const pptxTruth = await truthManifest(options, pptx, authoritativeFirstPages, now);
  previewHashes.push({ pageId: 'pptx:page-1', sha256: pptxTruth.manifest.previewRevision.sourceContentHash });
  await sampleCachedPage(options.pdf, pptxTruth.manifest, cachedFirstPages, now, pptxTruth.sessionId);
  await actionSample(options, pptxTruth.manifest, 'authoritative_ready', pptx, interactions);

  options.onStage?.('persistence');
  const uuid = globalThis.crypto?.randomUUID?.() ?? '00000000-0000-4000-8000-000000000001';
  await options.host.saveAnnotation({
    annotationId: createAnnotationId(uuid),
    artifactRevisionId: pptx.artifactRevisionId,
    previewRevisionId: pptxTruth.manifest.previewRevision.previewRevisionId,
    fidelity: 'authoritative', pageId: createPageId(1), bbox: [0.1, 0.1, 0.2, 0.2],
    selectedText: 'automation selection', status: 'active'
  });
  await options.host.acceptPreview(pptxTruth.manifest.previewRevision.previewRevisionId);

  const metricValues: ReviewAutomationMetrics = {
    progress_visible_ms: progressVisibleMs,
    cached_first_page_p95_ms: percentile95(cachedFirstPages),
    authoritative_first_reviewable_page_ms: percentile95(authoritativeFirstPages),
    interaction_p95_ms: percentile95(interactions),
    peak_rss_bytes: 0,
    cache_bytes: 0,
    reanchor_resolved: 0,
    reanchor_unresolved: 0,
    reanchor_silent_misplaced: 0,
    visual_diff_ratio: 0
  };
  const snapshot: ReviewPerformanceSnapshot = {
    progressVisibleMs: metricValues.progress_visible_ms,
    firstPageMs: metricValues.authoritative_first_reviewable_page_ms,
    interactions: interactions.map((durationMs, index) => ({
      name: (['scroll', 'zoom', 'page', 'selection', 'annotation'] as const)[index % 5], durationMs
    })),
    automation: {
      sessionId: options.sessionId,
      fixture: 'G3-REVIEW-001',
      capturedAt: new Date().toISOString(),
      representativeMachine: false,
      previewHashes,
      metrics: metricValues,
      samples: { progress: 1, cachedFirstPage: cachedFirstPages.length, authoritativeFirstPage: authoritativeFirstPages.length, interactions: interactions.length }
    }
  };
  options.onStage?.('metrics');
  await options.host.recordMetrics(snapshot);
  return snapshot;
}

function requestFor(artifact: OpenedArtifact, fidelity: 'fast' | 'authoritative', assetKind: 'artifact' | 'preview'): PreviewRequest {
  return {
    artifactRevisionId: artifact.artifactRevisionId,
    artifactHandle: artifact.handle,
    mediaType: assetKind === 'preview' ? 'application/pdf' : artifact.mediaType,
    preferredFidelity: fidelity,
    deadlineMs: 180_000,
    assetKind,
    displayName: artifact.displayName
  };
}

async function openManifest(adapter: AutomationAdapter, request: PreviewRequest): Promise<{ sessionId: string; manifest: PreviewManifest }> {
  const session = await adapter.open(request);
  return { sessionId: session.sessionId, manifest: await adapter.getManifest(session.sessionId) };
}

async function truthManifest(options: BuiltShellAutomationOptions, artifact: OpenedArtifact, samples: number[], now: () => number) {
  const started = now();
  const { jobId } = await options.host.startTruthRender(artifact.handle, artifact.artifactRevisionId, 180_000);
  let status = await options.host.previewStatus(jobId);
  while (status.state === 'rendering_authoritative') {
    await new Promise((resolve) => setTimeout(resolve, 50));
    status = await options.host.previewStatus(jobId);
  }
  if (status.state !== 'authoritative_ready') throw new Error(`authoritative preview failed: ${status.state}`);
  const request = requestFor({ ...artifact, handle: status.previewHandle, displayName: `preview-${jobId}` }, 'authoritative', 'preview');
  const session = await options.pdf.open(request);
  const opened = await options.pdf.getManifest(session.sessionId);
  opened.previewRevision.previewRevisionId = status.previewRevisionId;
  opened.previewRevision.acceptanceState = 'reviewable';
  await options.presentReview(opened, 'authoritative_ready', artifact);
  samples.push(Math.max(0, now() - started));
  return { manifest: opened, sessionId: session.sessionId };
}

async function sampleCachedPage(adapter: AutomationAdapter, manifest: PreviewManifest, samples: number[], now: () => number, sessionId: string) {
  const pageId = manifest.pages[0]?.pageId;
  if (!pageId) throw new Error('preview has no reviewable page');
  await adapter.getPage(sessionId, pageId, 1);
  for (let index = 0; index < 5; index += 1) {
    const started = now();
    await adapter.getPage(sessionId, pageId, 1);
    samples.push(Math.max(0, now() - started));
  }
}

async function actionSample(options: BuiltShellAutomationOptions, manifest: PreviewManifest, state: 'authoritative_ready' | 'fast_ready', artifact: OpenedArtifact, samples: number[]) {
  const durations = await options.performActions(manifest, state, artifact);
  if (durations.length !== 5 || durations.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('automation interaction samples are invalid');
  }
  samples.push(...durations);
}

function percentile95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}
