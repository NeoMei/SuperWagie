import { describe, expect, it, vi } from 'vitest';
import {
  executeBuiltShellAutomation,
  type ReviewAutomationStage
} from './review-automation';
import type { HostBridge, OpenedArtifact } from './host-bridge';

const artifacts: OpenedArtifact[] = [
  opened('reviewer-torture-100p.pdf', 'application/pdf', '11'),
  opened('reviewer-torture-30p.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '22'),
  opened('reviewer-torture-20s.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '33')
];

describe('built-shell review automation', () => {
  it('runs PDF, DOCX fast, DOCX truth, and PPTX truth in order through existing host calls', async () => {
    const calls: string[] = [];
    const stages: ReviewAutomationStage[] = [];
    const host = fakeHost(calls);
    const final = await executeBuiltShellAutomation({
      sessionId: 'a'.repeat(32), artifacts, host,
      pdf: fakeAdapter('pdf', calls), docxFast: fakeAdapter('docx-fast', calls),
      showProgress: async () => { calls.push('progress-painted'); },
      presentReview: async (_manifest, state) => { calls.push(`present:${state}`); },
      performActions: async () => { calls.push('actions'); return [1, 2, 3, 4, 5]; },
      onStage: (stage) => { stages.push(stage); },
      now: monotonicClock()
    });

    expect(calls).toEqual([
      'progress-painted', 'pdf:artifact:reviewer-torture-100p.pdf', 'present:authoritative_ready', 'actions',
      'docx-fast:artifact:reviewer-torture-30p.docx', 'present:fast_ready', 'actions',
      'truth:reviewer-torture-30p.docx', 'status:job-1', 'pdf:preview:preview-job-1', 'present:authoritative_ready', 'actions',
      'truth:reviewer-torture-20s.pptx', 'status:job-2', 'pdf:preview:preview-job-2', 'present:authoritative_ready', 'actions',
      'save-annotation', 'accept:preview-sha256:' + '55'.repeat(32), 'record-metrics'
    ]);
    expect(final.automation?.metrics.reanchor_silent_misplaced).toBe(0);
    expect(final.automation?.metrics.interaction_p95_ms).toBe(5);
    expect(final.automation?.representativeMachine).toBe(false);
    expect(final.automation?.metrics.peak_rss_bytes).toBe(0);
    expect(final.automation?.metrics.cache_bytes).toBe(0);
    expect(final.automation?.previewHashes.map((record) => record.pageId)).toEqual(['pdf:page-1', 'docx:page-1', 'pptx:page-1']);
    expect(Object.keys(final.automation!.metrics).sort()).toEqual([
      'authoritative_first_reviewable_page_ms', 'cache_bytes', 'cached_first_page_p95_ms',
      'interaction_p95_ms', 'peak_rss_bytes', 'progress_visible_ms', 'reanchor_resolved',
      'reanchor_silent_misplaced', 'reanchor_unresolved', 'visual_diff_ratio'
    ].sort());
    expect(stages).toEqual([
      'bootstrap', 'progress', 'pdf_authoritative', 'pdf_present', 'pdf_cached_page', 'pdf_actions', 'docx_fast',
      'docx_authoritative', 'pptx_authoritative', 'persistence', 'metrics'
    ]);
  });

  it('rejects missing, duplicate, or unrecognized audited artifact metadata before host work', async () => {
    const calls: string[] = [];
    const base = { sessionId: 'b'.repeat(32), host: fakeHost(calls), pdf: fakeAdapter('pdf', calls), docxFast: fakeAdapter('docx', calls), showProgress: async () => {}, presentReview: async () => {}, performActions: async () => [1, 2, 3, 4, 5], now: monotonicClock() };
    await expect(executeBuiltShellAutomation({ ...base, artifacts: artifacts.slice(0, 2) })).rejects.toThrow('audited automation artifacts');
    await expect(executeBuiltShellAutomation({ ...base, artifacts: [artifacts[0], artifacts[0], artifacts[2]] })).rejects.toThrow('audited automation artifacts');
    expect(calls).toEqual([]);
  });
});

function opened(displayName: string, mediaType: string, byte: string): OpenedArtifact {
  return {
    handle: byte.repeat(16), displayName, mediaType, size: 1,
    artifactRevisionId: `artifact-sha256:${byte.repeat(32)}` as OpenedArtifact['artifactRevisionId']
  };
}

function fakeAdapter(name: string, calls: string[]) {
  let count = 0;
  return {
    async open(request: { assetKind?: string; displayName?: string; artifactHandle: string }) {
      const display = request.displayName ?? (request.assetKind === 'preview' ? `preview-job-${request.artifactHandle.slice(-1)}` : artifacts.find((item) => item.handle === request.artifactHandle)?.displayName);
      calls.push(`${name}:${request.assetKind ?? 'artifact'}:${display}`);
      count += 1;
      return { sessionId: `${name}-${count}`, state: 'queued' as const };
    },
    async getManifest() {
      return {
        previewRevision: { previewRevisionId: `preview-sha256:${'44'.repeat(32)}` },
        pages: [{ pageId: 'page-1', width: 100, height: 100 }]
      } as never;
    },
    async getPage() { return { pageId: 'page-1', width: 100, height: 100, surfaceHandle: 'surface' }; },
    async getTextLayer() { return null; },
    async cancel() {}
  };
}

function fakeHost(calls: string[]): HostBridge {
  let job = 0;
  return {
    assetUrl: vi.fn(),
    startTruthRender: vi.fn(async (handle) => {
      const artifact = artifacts.find((item) => item.handle === handle)!;
      calls.push(`truth:${artifact.displayName}`);
      job += 1;
      return { jobId: `job-${job}` };
    }),
    previewStatus: vi.fn(async (jobId) => {
      calls.push(`status:${jobId}`);
      return { jobId, state: 'authoritative_ready', previewRevisionId: `preview-sha256:${'55'.repeat(32)}`, previewHandle: jobId.endsWith('1') ? 'preview-job-1' : 'preview-job-2' } as never;
    }),
    saveAnnotation: vi.fn(async () => { calls.push('save-annotation'); }),
    acceptPreview: vi.fn(async (revision) => { calls.push(`accept:${revision}`); }),
    openControlledCopy: vi.fn(),
    recordMetrics: vi.fn(async () => { calls.push('record-metrics'); })
  };
}

function monotonicClock() {
  let value = 0;
  return () => ++value * 10;
}
