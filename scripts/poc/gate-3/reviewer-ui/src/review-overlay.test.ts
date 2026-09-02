import { fireEvent } from '@testing-library/dom';
import { describe, expect, it, vi } from 'vitest';
import type { ReviewAnnotation } from '../../review-contract';
import { createReviewAnnotation, prepareAgentChangeRequest } from '../../annotation-reanchor';
import { renderReviewOverlay } from './review-overlay';

const ARTIFACT_1 = `artifact-sha256:${'a'.repeat(64)}`;
const ARTIFACT_2 = `artifact-sha256:${'b'.repeat(64)}`;
const PREVIEW_1 = `preview-sha256:${'1'.repeat(64)}`;
const PREVIEW_2 = `preview-sha256:${'2'.repeat(64)}`;
const ANNOTATION_1 = 'annotation-11111111-1111-4111-8111-111111111111';
const ANNOTATION_2 = 'annotation-22222222-2222-4222-8222-222222222222';
const ANNOTATION_3 = 'annotation-33333333-3333-4333-8333-333333333333';
const ANNOTATION_4 = 'annotation-44444444-4444-4444-8444-444444444444';

function annotation(overrides: Partial<ReviewAnnotation> = {}): ReviewAnnotation {
  return createReviewAnnotation({
    annotationId: ANNOTATION_1,
    artifactRevisionId: ARTIFACT_1,
    previewRevisionId: PREVIEW_1,
    fidelity: 'authoritative',
    pageId: 'page-1',
    bbox: [0.1, 0.2, 0.3, 0.25],
    selectedText: '季度目标',
    status: 'active',
    ...overrides
  });
}

describe('revision-bound review overlay', () => {
  it('scales normalized page coordinates to the current page dimensions only', () => {
    const root = document.createElement('div');
    const source = annotation();
    const snapshot = structuredClone(source);
    renderReviewOverlay({
      root,
      annotations: [source],
      binding: { artifactRevisionId: ARTIFACT_1, previewRevisionId: PREVIEW_1, pageId: 'page-1' },
      pageSize: { width: 1000, height: 800 }
    });

    const marker = root.querySelector<HTMLElement>(`[data-annotation-id="${ANNOTATION_1}"]`);
    expect(marker?.style.left).toBe('100px');
    expect(marker?.style.top).toBe('160px');
    expect(marker?.style.width).toBe('300px');
    expect(marker?.style.height).toBe('200px');
    expect(source).toEqual(snapshot);
  });

  it('renders only annotations with the exact Artifact, Preview, and page revision identity', () => {
    const root = document.createElement('div');
    renderReviewOverlay({
      root,
      annotations: [
        annotation(),
        annotation({ annotationId: ANNOTATION_2, artifactRevisionId: ARTIFACT_2 }),
        annotation({ annotationId: ANNOTATION_3, previewRevisionId: PREVIEW_2 }),
        annotation({ annotationId: ANNOTATION_4, pageId: 'page-2' })
      ],
      binding: { artifactRevisionId: ARTIFACT_1, previewRevisionId: PREVIEW_1, pageId: 'page-1' },
      pageSize: { width: 500, height: 400 }
    });

    expect(Array.from(root.querySelectorAll<HTMLElement>('[data-annotation-id]')).map(
      (element) => element.dataset.annotationId
    )).toEqual([ANNOTATION_1]);
  });

  it('selects an annotation without changing its persisted revision binding', () => {
    const root = document.createElement('div');
    const onSelect = vi.fn();
    const source = annotation();
    const controller = renderReviewOverlay({
      root,
      annotations: [source],
      binding: { artifactRevisionId: ARTIFACT_1, previewRevisionId: PREVIEW_1, pageId: 'page-1' },
      pageSize: { width: 500, height: 400 },
      onSelect
    });
    const marker = root.querySelector<HTMLElement>(`[data-annotation-id="${ANNOTATION_1}"]`)!;
    fireEvent.click(marker);

    expect(controller.selectedAnnotationId()).toBe(ANNOTATION_1);
    expect(marker.getAttribute('aria-pressed')).toBe('true');
    expect(onSelect).toHaveBeenCalledWith(ANNOTATION_1);
    expect(source).toMatchObject({ artifactRevisionId: ARTIFACT_1, previewRevisionId: PREVIEW_1 });
  });

  it('displays the inert prepared receipt without invoking an Agent', () => {
    const root = document.createElement('div');
    const controller = renderReviewOverlay({
      root,
      annotations: [],
      binding: { artifactRevisionId: ARTIFACT_1, previewRevisionId: PREVIEW_1, pageId: 'page-1' },
      pageSize: { width: 500, height: 400 }
    });

    controller.showAgentRequestPrepared(prepareAgentChangeRequest({
      artifactRevisionId: ARTIFACT_1,
      previewRevisionId: PREVIEW_1,
      annotationIds: [ANNOTATION_1],
      intent: { operation: 'revise-selection' },
      context: [{ pageId: 'page-1' }]
    }));
    expect(root.querySelector('[role="status"]')?.textContent).toBe('修改请求已准备');
    expect(root.textContent).not.toMatch(/Codex|App Server|provider|model/);
  });

  it('rejects invalid page sizes and matching invalid boxes instead of displaying a misplaced marker', () => {
    const root = document.createElement('div');
    expect(() => renderReviewOverlay({
      root,
      annotations: [annotation()],
      binding: { artifactRevisionId: ARTIFACT_1, previewRevisionId: PREVIEW_1, pageId: 'page-1' },
      pageSize: { width: Number.NaN, height: 400 }
    })).toThrow('page size');
    expect(() => renderReviewOverlay({
      root,
      annotations: [{ ...annotation(), bbox: [0.9, 0.9, 0.2, 0.2] }],
      binding: { artifactRevisionId: ARTIFACT_1, previewRevisionId: PREVIEW_1, pageId: 'page-1' },
      pageSize: { width: 500, height: 400 }
    })).toThrow('bounds');
    expect(root.querySelector('[data-annotation-id]')).toBeNull();
  });
});
