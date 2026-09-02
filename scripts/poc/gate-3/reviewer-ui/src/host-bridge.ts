import { invoke } from '@tauri-apps/api/core';
import type {
  ArtifactRevisionId,
  PreviewRevisionId,
  PreviewState,
  ReviewPerformanceSnapshot
} from '../../review-contract';
import {
  createArtifactRevisionId,
  validatePreviewRevisionId
} from '../../review-identifiers';
import type { RawReviewAnnotationInput } from '../../annotation-reanchor';

export interface HostArtifactOpened {
  handle: string;
  displayName: string;
  mediaType: string;
  size: number;
  revisionHash: string;
  automationSessionId?: string;
  automationIndex?: number;
}

export interface OpenedArtifact {
  handle: string;
  displayName: string;
  mediaType: string;
  size: number;
  artifactRevisionId: ArtifactRevisionId;
  automationSessionId?: string;
  automationIndex?: number;
}

export function normalizeHostArtifactOpened(opened: HostArtifactOpened): OpenedArtifact {
  if (!/^[0-9a-f]{32}$/.test(opened.handle)
    || typeof opened.displayName !== 'string'
    || opened.displayName.length === 0
    || typeof opened.mediaType !== 'string'
    || opened.mediaType.length === 0
    || !Number.isSafeInteger(opened.size)
    || opened.size < 0) {
    throw new Error('host artifact payload is invalid');
  }
  return {
    handle: opened.handle,
    displayName: opened.displayName,
    mediaType: opened.mediaType,
    size: opened.size,
    artifactRevisionId: createArtifactRevisionId(opened.revisionHash),
    ...(opened.automationSessionId === undefined ? {} : {
      automationSessionId: validateAutomationSession(opened.automationSessionId),
      automationIndex: validateAutomationIndex(opened.automationIndex)
    })
  };
}

function validateAutomationSession(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{32}$/.test(value)) throw new Error('host artifact payload is invalid');
  return value;
}

function validateAutomationIndex(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 2) throw new Error('host artifact payload is invalid');
  return value as number;
}

export interface HostBridge {
  assetUrl(handle: string, kind: 'artifact' | 'preview'): Promise<string>;
  startTruthRender(handle: string, artifactRevisionId: ArtifactRevisionId, deadlineMs: number): Promise<{ jobId: string }>;
  previewStatus(jobId: string): Promise<HostPreviewStatus>;
  saveAnnotation(annotation: RawReviewAnnotationInput): Promise<void>;
  acceptPreview(previewRevisionId: PreviewRevisionId): Promise<void>;
  openControlledCopy(handle: string): Promise<{ receiptId: string }>;
  recordMetrics(snapshot: ReviewPerformanceSnapshot): Promise<void>;
}

type NonReadyPreviewState = Exclude<PreviewState, 'authoritative_ready'>;

export type HostPreviewStatus = {
  jobId: string;
  state: 'authoritative_ready';
  previewRevisionId: PreviewRevisionId;
  previewHandle: string;
  errorCode?: never;
} | {
  jobId: string;
  state: NonReadyPreviewState;
  previewRevisionId?: never;
  previewHandle?: never;
  errorCode?: string;
};

const PREVIEW_STATES = new Set<PreviewState>([
  'queued', 'loading_fast', 'fast_ready', 'rendering_authoritative',
  'authoritative_ready', 'dependency_missing', 'unsupported',
  'failed_recoverable', 'failed_terminal', 'accepted'
]);

export function normalizeHostPreviewStatus(value: unknown): HostPreviewStatus {
  if (typeof value !== 'object' || value === null) throw new Error('host preview status is invalid');
  const status = value as Record<string, unknown>;
  const keys = Object.keys(status);
  const knownKeys = new Set(['jobId', 'state', 'previewRevisionId', 'previewHandle', 'errorCode']);
  if (keys.some((key) => !knownKeys.has(key))
    || typeof status.jobId !== 'string'
    || !/^[0-9a-f]{32}$/.test(status.jobId)
    || typeof status.state !== 'string'
    || !PREVIEW_STATES.has(status.state as PreviewState)) {
    throw new Error('host preview status is invalid');
  }
  if (status.state === 'authoritative_ready') {
    if (typeof status.previewRevisionId !== 'string'
      || typeof status.previewHandle !== 'string'
      || !/^[0-9a-f]{32}$/.test(status.previewHandle)
      || status.errorCode !== undefined) {
      throw new Error('host preview status is invalid');
    }
    let previewRevisionId: PreviewRevisionId;
    try {
      previewRevisionId = validatePreviewRevisionId(status.previewRevisionId);
    } catch {
      throw new Error('host preview status is invalid');
    }
    return {
      jobId: status.jobId,
      state: 'authoritative_ready',
      previewRevisionId,
      previewHandle: status.previewHandle
    };
  }
  if (status.previewRevisionId !== undefined
    || status.previewHandle !== undefined
    || (status.errorCode !== undefined
      && (typeof status.errorCode !== 'string'
        || !/^[A-Z][A-Z0-9_]{0,127}$/.test(status.errorCode)))) {
    throw new Error('host preview status is invalid');
  }
  return {
    jobId: status.jobId,
    state: status.state as NonReadyPreviewState,
    ...(status.errorCode === undefined ? {} : { errorCode: status.errorCode as string })
  };
}

export const tauriHostBridge: HostBridge = {
  assetUrl: (handle, kind) => invoke('asset_url', { handle, kind }),
  startTruthRender: (handle, artifactRevisionId, deadlineMs) => invoke('start_truth_render', { handle, artifactRevisionId, deadlineMs }),
  previewStatus: async (jobId) => normalizeHostPreviewStatus(
    await invoke('preview_status', { jobId })
  ),
  saveAnnotation: (annotation) => invoke('save_annotation', { annotation }),
  acceptPreview: (previewRevisionId) => invoke('accept_preview', { previewRevisionId }),
  openControlledCopy: (handle) => invoke('open_controlled_copy', { handle }),
  recordMetrics: (snapshot) => invoke('record_metrics', { snapshot })
};
