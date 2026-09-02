import { createHash } from 'node:crypto';
import {
  createPreviewRevisionId,
  validateArtifactRevisionId,
  type ArtifactRevisionId,
  type PreviewRevisionId
} from './review-identifiers';
export * from './review-identifiers';

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
  artifactRevisionId: ArtifactRevisionId;
  previewRevisionId: PreviewRevisionId;
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
  /** Trusted-host issued asset class; normal source opens remain `artifact`. */
  assetKind?: 'artifact' | 'preview';
  /** Path-free audited display metadata used only by built-shell automation evidence. */
  displayName?: string;
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
  /**
   * Task 1 transport slot only. Task 7 raw-capture and persisted-rehydration
   * APIs establish provenance and enforce the tagged fingerprint invariant.
   */
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
  automation?: ReviewAutomationSnapshot;
}

export interface ReviewAutomationMetrics {
  progress_visible_ms: number;
  cached_first_page_p95_ms: number;
  authoritative_first_reviewable_page_ms: number;
  interaction_p95_ms: number;
  peak_rss_bytes: number;
  cache_bytes: number;
  reanchor_resolved: number;
  reanchor_unresolved: number;
  reanchor_silent_misplaced: number;
  visual_diff_ratio: number;
}

export interface ReviewAutomationSnapshot {
  sessionId: string;
  fixture: 'G3-REVIEW-001';
  capturedAt: string;
  representativeMachine: boolean;
  previewHashes: Array<{ pageId: string; sha256: string }>;
  metrics: ReviewAutomationMetrics;
  samples: {
    progress: number;
    cachedFirstPage: number;
    authoritativeFirstPage: number;
    interactions: number;
  };
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

export function createPreviewRevision(input: PreviewRevisionInput): PreviewRevision {
  const identityHashes: Array<keyof PreviewRevisionInput> = [
    'rendererEnvironmentHash',
    'fontEnvironmentHash',
    'sourceContentHash',
    'pageManifestHash'
  ];

  for (const field of identityHashes) {
    if (!input[field]) throw new Error(`${field} is required`);
  }

  const canonicalInput = {
    artifactRevisionId: validateArtifactRevisionId(input.artifactRevisionId),
    fidelity: input.fidelity,
    rendererId: input.rendererId,
    rendererVersion: input.rendererVersion,
    rendererEnvironmentHash: input.rendererEnvironmentHash,
    fontEnvironmentHash: input.fontEnvironmentHash,
    sourceContentHash: input.sourceContentHash,
    pageManifestHash: input.pageManifestHash
  };

  return {
    ...canonicalInput,
    previewRevisionId: createPreviewRevisionId(createHash('sha256')
      .update(JSON.stringify(canonicalInput))
      .digest('hex')),
    acceptanceState: input.fidelity === 'fast' ? 'not_eligible' : 'reviewable'
  };
}
