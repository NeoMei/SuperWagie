import type { ReviewAnnotation } from '../../review-contract';
import type { NormalizedBox } from '../../review-contract';
import type { PreparedAgentChangeRequest } from '../../annotation-reanchor';

export interface ReviewOverlayBinding {
  artifactRevisionId: string;
  previewRevisionId: string;
  pageId: string;
}

export interface ReviewOverlayOptions {
  root: HTMLElement;
  annotations: readonly ReviewAnnotation[];
  binding: ReviewOverlayBinding;
  pageSize: { width: number; height: number };
  selectedAnnotationId?: string;
  onSelect?: (annotationId: string) => void;
}

export interface ReviewOverlayController {
  selectedAnnotationId(): string | null;
  showAgentRequestPrepared(receipt: PreparedAgentChangeRequest): void;
  destroy(): void;
}

export function renderReviewOverlay(options: ReviewOverlayOptions): ReviewOverlayController {
  const { root, annotations, binding, pageSize, onSelect } = options;
  root.replaceChildren();
  if (!Number.isFinite(pageSize.width)
    || !Number.isFinite(pageSize.height)
    || pageSize.width <= 0
    || pageSize.height <= 0) {
    throw new Error('overlay page size must be finite and positive');
  }

  const visible = annotations.filter((annotation) =>
    annotation.artifactRevisionId === binding.artifactRevisionId
    && annotation.previewRevisionId === binding.previewRevisionId
    && annotation.pageId === binding.pageId
    && annotation.bbox !== undefined
  );
  const boxes = visible.map((annotation) => ({
    annotation,
    bbox: validateNormalizedBox(annotation.bbox)
  }));
  let selected = boxes.some(({ annotation }) => annotation.annotationId === options.selectedAnnotationId)
    ? options.selectedAnnotationId ?? null
    : null;

  root.classList.add('revision-review-overlay');
  root.dataset.artifactRevisionId = binding.artifactRevisionId;
  root.dataset.previewRevisionId = binding.previewRevisionId;
  root.dataset.pageId = binding.pageId;
  const requestStatus = document.createElement('span');
  requestStatus.className = 'agent-change-request-status';
  requestStatus.setAttribute('role', 'status');
  requestStatus.setAttribute('aria-live', 'polite');
  root.append(requestStatus);

  for (const { annotation, bbox } of boxes) {
    const marker = document.createElement('button');
    marker.type = 'button';
    marker.className = 'review-annotation-marker';
    marker.dataset.annotationId = annotation.annotationId;
    marker.setAttribute('aria-label', annotation.selectedText
      ? `批注：${annotation.selectedText}`
      : `批注 ${annotation.annotationId}`);
    marker.setAttribute('aria-pressed', String(annotation.annotationId === selected));
    marker.style.position = 'absolute';
    marker.style.left = `${bbox[0] * pageSize.width}px`;
    marker.style.top = `${bbox[1] * pageSize.height}px`;
    marker.style.width = `${bbox[2] * pageSize.width}px`;
    marker.style.height = `${bbox[3] * pageSize.height}px`;
    marker.addEventListener('click', () => {
      selected = annotation.annotationId;
      for (const element of root.querySelectorAll<HTMLElement>('[data-annotation-id]')) {
        element.setAttribute('aria-pressed', String(element.dataset.annotationId === selected));
      }
      onSelect?.(annotation.annotationId);
    });
    root.append(marker);
  }

  return {
    selectedAnnotationId: () => selected,
    showAgentRequestPrepared(receipt) {
      if (receipt.status !== 'prepared' || receipt.label !== '修改请求已准备') {
        throw new Error('invalid Agent change request receipt');
      }
      requestStatus.textContent = '修改请求已准备';
    },
    destroy() {
      selected = null;
      root.replaceChildren();
      delete root.dataset.artifactRevisionId;
      delete root.dataset.previewRevisionId;
      delete root.dataset.pageId;
      root.classList.remove('revision-review-overlay');
    }
  };
}

function validateNormalizedBox(value: unknown): NormalizedBox {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error('normalized bbox must contain four finite numbers');
  }
  const [x, y, width, height] = value;
  if (![x, y, width, height].every((item) => typeof item === 'number' && Number.isFinite(item))) {
    throw new Error('normalized bbox values must be finite');
  }
  if (width <= 0 || height <= 0) throw new Error('normalized bbox width and height must be positive');
  if (x < 0 || y < 0 || x > 1 || y > 1 || width > 1 || height > 1) {
    throw new Error('normalized bbox values must be in normalized range');
  }
  if (x + width > 1 || y + height > 1) throw new Error('normalized bbox exceeds page bounds');
  return [x, y, width, height];
}
