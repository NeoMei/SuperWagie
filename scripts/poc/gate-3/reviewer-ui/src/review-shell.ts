import type {
  PageSurfaceRef,
  PreviewManifest,
  PreviewRevisionId,
  PreviewState,
  TextLayer
} from '../../review-contract';
import type { HostBridge } from './host-bridge';
import type { ReviewInteractionName } from './performance-metrics';

export const ZOOM_BUCKETS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2] as const;

export type ReviewDocumentMode = 'word' | 'presentation';
export type ZoomMode = 'fit-width' | 'fit-page' | 'percentage';

export const REVIEW_AUTOMATION_SELECTORS = {
  viewport: '[data-testid="document-viewport"]',
  fitWidth: '[data-zoom="fit-width"]',
  pageTwo: '[aria-label="第 2 页"]',
  annotation: '.annotation-button'
} as const;

export interface ReviewShellZoom {
  bucket: number;
  displayPercent: number;
  mode: ZoomMode;
}

export interface ReviewShellOptions {
  root: HTMLElement;
  manifest: PreviewManifest | null;
  state: PreviewState;
  mode: ReviewDocumentMode;
  host: Pick<HostBridge, 'acceptPreview' | 'openControlledCopy'>;
  artifactHandle: string | null;
  currentPage?: number;
  pageSurfaces?: ReadonlyMap<string, PageSurfaceRef>;
  textLayers?: ReadonlyMap<string, TextLayer | null>;
  mountSurface?: (surface: PageSurfaceRef, target: HTMLElement) => void;
  getViewportSize?: () => { width: number; height: number };
  onContinue?: () => void;
  onClose?: () => void;
  onProgressVisible?: () => void;
  onFirstPageVisible?: () => void;
  onInteraction?: (name: ReviewInteractionName) => void | Promise<void>;
}

export interface ReviewShellController {
  currentPage(): number;
  zoom(): ReviewShellZoom;
  setState(state: PreviewState): void;
  destroy(): void;
}

export interface DurableReviewShellState {
  acceptedPreviewRevisionId: PreviewRevisionId;
  currentPage: number;
}

export interface RehydrateReviewShellOptions extends Omit<ReviewShellOptions, 'state' | 'currentPage' | 'host'> {
  host: HostBridge;
  durableState: DurableReviewShellState;
}

const STATUS_LABELS: Record<PreviewState, string> = {
  queued: '正在准备预览',
  loading_fast: '正在快速预览',
  fast_ready: '快速预览可用，原格式待核对',
  rendering_authoritative: '原格式预览准备中',
  authoritative_ready: '原格式已就绪',
  dependency_missing: '需要 WPS 才能核对原格式',
  unsupported: '暂不支持此格式',
  failed_recoverable: '预览暂时失败，可以重试',
  failed_terminal: '无法打开此预览',
  accepted: '此版本已接受'
};

/**
 * Recreates the review shell strictly from already-persisted accepted state.
 * This entry point deliberately cannot start a truth render: callers must only
 * supply an existing manifest whose revision matches the durable receipt.
 */
export function rehydrateReviewShell(options: RehydrateReviewShellOptions): ReviewShellController {
  const { durableState, manifest } = options;
  if (!manifest
    || durableState.acceptedPreviewRevisionId !== manifest.previewRevision.previewRevisionId) {
    throw new Error('accepted preview revision does not match the supplied manifest');
  }
  if (!Number.isSafeInteger(durableState.currentPage)
    || durableState.currentPage < 1
    || durableState.currentPage > manifest.pages.length) {
    throw new Error('durable review page is outside the supplied manifest');
  }
  return renderReviewShell({
    ...options,
    state: 'accepted',
    currentPage: durableState.currentPage
  });
}

export function renderReviewShell(options: ReviewShellOptions): ReviewShellController {
  const {
    root,
    manifest,
    mode,
    host,
    artifactHandle,
    pageSurfaces = new Map(),
    textLayers = new Map(),
    mountSurface,
    getViewportSize = () => ({ width: root.clientWidth, height: root.clientHeight }),
    onContinue,
    onClose,
    onProgressVisible,
    onFirstPageVisible,
    onInteraction
  } = options;
  let currentState = options.state;
  let currentPage = clampPage(options.currentPage ?? 1, manifest?.pages.length ?? 0);
  let zoomState: ReviewShellZoom = { bucket: 1, displayPercent: 100, mode: 'percentage' };
  let observer: IntersectionObserver | null = null;
  let destroyed = false;
  let firstPageReported = false;
  const pendingInteractions = new Set<ReviewInteractionName>();

  root.replaceChildren();
  root.className = `review-shell review-shell--${mode}`;
  root.dataset.documentMode = mode;
  root.tabIndex = 0;
  root.setAttribute('aria-label', '文档审阅');

  const header = createRegion('header', 'review-header');
  header.className = 'review-header';
  const rail = createRegion('aside', 'page-rail');
  rail.className = 'page-rail';
  rail.setAttribute('aria-label', '页面导航');
  const viewport = createRegion('main', 'document-viewport');
  viewport.className = 'document-viewport';
  viewport.setAttribute('aria-label', mode === 'word' ? '连续文档预览' : '单张幻灯片预览');
  const overlay = createRegion('section', 'review-overlay');
  overlay.className = 'review-overlay';
  overlay.setAttribute('aria-label', '审阅标记');
  const footer = createRegion('footer', 'review-status');
  footer.className = 'review-status';
  footer.setAttribute('aria-live', 'polite');

  const continueButton = actionButton('继续修改', 'continue');
  const openCopyButton = actionButton('在 WPS 打开副本', 'open-copy');
  const acceptButton = actionButton('接受此版本', 'accept');
  const closeButton = actionButton('关闭预览', 'close');
  header.append(continueButton, openCopyButton, acceptButton, closeButton);

  const annotationButton = document.createElement('button');
  annotationButton.type = 'button';
  annotationButton.className = 'annotation-button';
  annotationButton.setAttribute('aria-label', '添加批注');
  annotationButton.textContent = '添加批注';
  overlay.append(annotationButton);

  const statusText = document.createElement('span');
  statusText.className = 'review-status__label';
  const pageText = document.createElement('span');
  pageText.className = 'review-status__page';
  const zoomToolbar = document.createElement('div');
  zoomToolbar.className = 'zoom-toolbar';
  zoomToolbar.setAttribute('role', 'toolbar');
  zoomToolbar.setAttribute('aria-label', '预览缩放');
  const fitWidthButton = zoomButton('适宽', 'fit-width');
  const fitPageButton = zoomButton('适页', 'fit-page');
  const zoomSelect = document.createElement('select');
  zoomSelect.setAttribute('aria-label', '缩放百分比');
  zoomSelect.className = 'zoom-select';
  for (const bucket of ZOOM_BUCKETS) {
    const option = document.createElement('option');
    option.value = String(bucket);
    option.textContent = `${Math.round(bucket * 100)}%`;
    if (bucket === 1) option.selected = true;
    zoomSelect.append(option);
  }
  const zoomDisplay = document.createElement('span');
  zoomDisplay.dataset.testid = 'zoom-display';
  zoomDisplay.className = 'zoom-display';
  zoomDisplay.textContent = '100%';
  zoomToolbar.append(fitWidthButton, fitPageButton, zoomSelect, zoomDisplay);
  const receiptStatus = document.createElement('span');
  receiptStatus.className = 'review-status__receipt';
  receiptStatus.setAttribute('role', 'status');
  footer.append(statusText, pageText, zoomToolbar, receiptStatus);
  root.append(header, rail, viewport, overlay, footer);

  function emitInteraction(name: ReviewInteractionName): void {
    if (!onInteraction || destroyed || pendingInteractions.has(name)) return;
    pendingInteractions.add(name);
    Promise.resolve(onInteraction(name)).finally(() => pendingInteractions.delete(name));
  }

  function renderState(): void {
    statusText.textContent = STATUS_LABELS[currentState];
    acceptButton.disabled = currentState !== 'authoritative_ready' || !manifest;
    openCopyButton.disabled = artifactHandle === null;
    if (currentState === 'loading_fast' || currentState === 'rendering_authoritative') {
      onProgressVisible?.();
    }
  }

  function renderRail(): void {
    rail.replaceChildren();
    for (let index = 0; index < (manifest?.pages.length ?? 0); index += 1) {
      const pageNumber = index + 1;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'page-rail__button';
      button.dataset.pageNumber = String(pageNumber);
      button.setAttribute('aria-label', `第 ${pageNumber} 页`);
      button.textContent = String(pageNumber);
      if (pageNumber === currentPage) button.setAttribute('aria-current', 'page');
      button.addEventListener('click', () => navigateToPage(pageNumber, true));
      rail.append(button);
    }
  }

  function renderDocument(): void {
    observer?.disconnect();
    observer = null;
    viewport.replaceChildren();
    const pages = manifest?.pages ?? [];
    if (pages.length === 0) {
      pageText.textContent = '尚无页面';
      return;
    }

    pageText.textContent = `第 ${currentPage} / ${pages.length} 页`;
    pages.forEach((page, index) => {
      const pageNumber = index + 1;
      const mounted = Math.abs(pageNumber - currentPage) <= 2;
      const pageElement = document.createElement('article');
      pageElement.className = mounted ? 'review-page' : 'review-page-placeholder';
      pageElement.dataset.pageId = page.pageId;
      pageElement.dataset.pageNumber = String(pageNumber);
      pageElement.setAttribute('aria-label', `第 ${pageNumber} 页`);
      pageElement.style.setProperty('--page-aspect-ratio', `${page.width} / ${page.height}`);
      pageElement.style.width = `${page.width * zoomState.displayPercent / 100}px`;
      pageElement.style.height = `${page.height * zoomState.displayPercent / 100}px`;
      pageElement.hidden = mode === 'presentation' && pageNumber !== currentPage;

      if (mounted) {
        pageElement.dataset.mountedPage = '';
        const visible = mode === 'word' || pageNumber === currentPage;
        if (visible) pageElement.dataset.visiblePage = '';
        if (pageNumber === currentPage) pageElement.dataset.currentPage = '';
        pageElement.dataset.scaleBucket = String(zoomState.bucket);
        renderPageContent(
          pageElement,
          page.pageId,
          pageSurfaces.get(page.pageId),
          textLayers.get(page.pageId),
          mountSurface
        );
      } else {
        pageElement.dataset.pagePlaceholder = '';
        pageElement.setAttribute('aria-hidden', 'true');
      }
      viewport.append(pageElement);
    });

    if (typeof IntersectionObserver !== 'undefined') {
      const intersectionRatios = new Map<Element, number>();
      observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          intersectionRatios.set(entry.target, entry.isIntersecting ? entry.intersectionRatio : 0);
        }
        const visible = [...intersectionRatios.entries()]
          .filter(([, ratio]) => ratio > 0)
          .sort((left, right) => right[1] - left[1])[0]?.[0];
        const pageNumber = Number((visible as HTMLElement | undefined)?.dataset.pageNumber);
        if (Number.isInteger(pageNumber) && pageNumber !== currentPage) navigateToPage(pageNumber, false);
      }, { root: viewport, threshold: [0.25, 0.5, 0.75] });
      for (const pageElement of viewport.children) {
        if (!(pageElement as HTMLElement).hidden) observer.observe(pageElement);
      }
    }

    if (!firstPageReported) {
      firstPageReported = true;
      onFirstPageVisible?.();
    }
  }

  function navigateToPage(requestedPage: number, isUserAction: boolean): void {
    const nextPage = clampPage(requestedPage, manifest?.pages.length ?? 0);
    if (nextPage === 0 || nextPage === currentPage) return;
    if (isUserAction) emitInteraction('page');
    currentPage = nextPage;
    renderRail();
    renderDocument();
    if (isUserAction) {
      viewport.querySelector<HTMLElement>(`[data-page-number="${currentPage}"]`)?.scrollIntoView?.({ block: 'center' });
    }
  }

  function setZoom(next: ReviewShellZoom, isUserAction = true): void {
    if (isUserAction) emitInteraction('zoom');
    zoomState = next;
    zoomDisplay.textContent = `${next.displayPercent}%`;
    zoomSelect.value = String(next.bucket);
    renderDocument();
  }

  function fitZoom(fitMode: 'fit-width' | 'fit-page'): void {
    const page = manifest?.pages[currentPage - 1];
    if (!page) return;
    const viewportSize = getViewportSize();
    const requestedScale = fitMode === 'fit-width'
      ? viewportSize.width / page.width
      : Math.min(viewportSize.width / page.width, viewportSize.height / page.height);
    setZoom({
      bucket: closestBucket(requestedScale),
      displayPercent: Math.max(1, Math.round(requestedScale * 100)),
      mode: fitMode
    });
  }

  function adjustZoom(direction: -1 | 1): void {
    const currentIndex = ZOOM_BUCKETS.indexOf(zoomState.bucket as typeof ZOOM_BUCKETS[number]);
    const baseIndex = currentIndex >= 0 ? currentIndex : closestBucketIndex(zoomState.bucket);
    const nextIndex = Math.min(ZOOM_BUCKETS.length - 1, Math.max(0, baseIndex + direction));
    const bucket = ZOOM_BUCKETS[nextIndex] ?? 1;
    setZoom({ bucket, displayPercent: Math.round(bucket * 100), mode: 'percentage' });
  }

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (isEditableTarget(event.target)) return;
    switch (event.key) {
      case 'PageUp': navigateToPage(currentPage - 1, true); break;
      case 'PageDown': navigateToPage(currentPage + 1, true); break;
      case 'Home': navigateToPage(1, true); break;
      case 'End': navigateToPage(manifest?.pages.length ?? 0, true); break;
      case '+': adjustZoom(1); break;
      case '-': adjustZoom(-1); break;
      case '0': setZoom({ bucket: 1, displayPercent: 100, mode: 'percentage' }); break;
      default: return;
    }
    event.preventDefault();
  };
  const handleScroll = (): void => emitInteraction('scroll');
  const handleSelection = (): void => emitInteraction('selection');
  const handleAnnotation = (): void => emitInteraction('annotation');

  continueButton.addEventListener('click', () => {
    onContinue?.();
    receiptStatus.textContent = '已返回修改流程';
  });
  openCopyButton.addEventListener('click', async () => {
    if (!artifactHandle) return;
    openCopyButton.disabled = true;
    try {
      const receipt = await host.openControlledCopy(artifactHandle);
      receiptStatus.textContent = `副本回执：${receipt.receiptId}`;
    } catch {
      receiptStatus.textContent = '暂时无法打开受控副本';
    } finally {
      if (!destroyed) openCopyButton.disabled = false;
    }
  });
  acceptButton.addEventListener('click', async () => {
    if (currentState !== 'authoritative_ready' || !manifest) return;
    acceptButton.disabled = true;
    try {
      await host.acceptPreview(manifest.previewRevision.previewRevisionId);
      currentState = 'accepted';
      renderState();
    } catch {
      receiptStatus.textContent = '暂时无法接受此版本';
      if (!destroyed) renderState();
    }
  });
  closeButton.addEventListener('click', () => {
    if (onClose) onClose();
    else root.hidden = true;
  });
  fitWidthButton.addEventListener('click', () => fitZoom('fit-width'));
  fitPageButton.addEventListener('click', () => fitZoom('fit-page'));
  zoomSelect.addEventListener('change', () => {
    const bucket = Number(zoomSelect.value);
    if (isZoomBucket(bucket)) setZoom({ bucket, displayPercent: Math.round(bucket * 100), mode: 'percentage' });
  });
  root.addEventListener('keydown', handleKeyDown);
  viewport.addEventListener('scroll', handleScroll, { passive: true });
  viewport.addEventListener('pointerup', handleSelection);
  annotationButton.addEventListener('click', handleAnnotation);

  renderState();
  renderRail();
  renderDocument();

  return {
    currentPage: () => currentPage,
    zoom: () => ({ ...zoomState }),
    setState(state) {
      if (destroyed) return;
      currentState = state;
      renderState();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      observer?.disconnect();
      observer = null;
      root.removeEventListener('keydown', handleKeyDown);
      viewport.removeEventListener('scroll', handleScroll);
      viewport.removeEventListener('pointerup', handleSelection);
      annotationButton.removeEventListener('click', handleAnnotation);
      root.replaceChildren();
    }
  };
}

function createRegion<K extends keyof HTMLElementTagNameMap>(tag: K, testId: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.dataset.testid = testId;
  return element;
}

function actionButton(label: string, action: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.action = action;
  button.dataset.reviewAction = '';
  button.setAttribute('aria-label', label);
  button.textContent = label;
  return button;
}

function zoomButton(label: string, mode: 'fit-width' | 'fit-page'): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.zoom = mode;
  button.setAttribute('aria-label', label === '适宽' ? '缩放至适宽' : '缩放至适页');
  button.textContent = label;
  return button;
}

function renderPageContent(
  pageElement: HTMLElement,
  pageId: string,
  surface: PageSurfaceRef | undefined,
  textLayer: TextLayer | null | undefined,
  mountSurface: ReviewShellOptions['mountSurface']
): void {
  const surfaceElement = document.createElement('div');
  surfaceElement.className = 'page-surface';
  surfaceElement.dataset.pageSurface = '';
  surfaceElement.setAttribute('aria-hidden', 'true');
  if (surface && mountSurface) mountSurface(surface, surfaceElement);
  pageElement.append(surfaceElement);

  const textLayerElement = document.createElement('div');
  textLayerElement.className = 'text-layer';
  textLayerElement.dataset.textLayer = '';
  textLayerElement.dataset.pageId = pageId;
  for (const item of textLayer?.items ?? []) {
    const text = document.createElement('span');
    text.textContent = item.text;
    text.style.left = `${item.bbox[0] * 100}%`;
    text.style.top = `${item.bbox[1] * 100}%`;
    text.style.width = `${item.bbox[2] * 100}%`;
    text.style.height = `${item.bbox[3] * 100}%`;
    textLayerElement.append(text);
  }
  pageElement.append(textLayerElement);
}

function clampPage(requestedPage: number, pageCount: number): number {
  if (pageCount <= 0) return 0;
  return Math.min(pageCount, Math.max(1, Math.trunc(requestedPage)));
}

function closestBucket(requestedScale: number): number {
  return ZOOM_BUCKETS[closestBucketIndex(requestedScale)] ?? 1;
}

function closestBucketIndex(requestedScale: number): number {
  let closestIndex = 0;
  let closestDistance = Number.POSITIVE_INFINITY;
  ZOOM_BUCKETS.forEach((bucket, index) => {
    const distance = Math.abs(bucket - requestedScale);
    if (distance < closestDistance) {
      closestDistance = distance;
      closestIndex = index;
    }
  });
  return closestIndex;
}

function isZoomBucket(value: number): value is typeof ZOOM_BUCKETS[number] {
  return ZOOM_BUCKETS.some((bucket) => bucket === value);
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !== null;
}
