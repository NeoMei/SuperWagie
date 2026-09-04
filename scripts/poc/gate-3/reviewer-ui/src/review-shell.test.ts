import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PageSurfaceRef,
  PreviewManifest,
  PreviewState,
  ReviewPerformanceSnapshot,
  TextLayer
} from '../../review-contract';
import { createArtifactRevisionId, createPreviewRevisionId } from '../../review-identifiers';
import type { HostBridge } from './host-bridge';
import {
  rehydrateReviewShell,
  renderReviewShell,
  REVIEW_AUTOMATION_SELECTORS,
  ZOOM_BUCKETS
} from './review-shell';

class ControlledIntersectionObserver implements IntersectionObserver {
  static instances: ControlledIntersectionObserver[] = [];
  readonly root = null;
  readonly rootMargin = '0px';
  readonly scrollMargin = '0px';
  readonly thresholds = [0];
  readonly observed = new Set<Element>();
  disconnected = false;

  constructor(private readonly callback: IntersectionObserverCallback) {
    ControlledIntersectionObserver.instances.push(this);
  }

  observe(target: Element): void { this.observed.add(target); }
  unobserve(target: Element): void { this.observed.delete(target); }
  disconnect(): void { this.disconnected = true; this.observed.clear(); }
  takeRecords(): IntersectionObserverEntry[] { return []; }

  show(target: Element, ratio = 1): void {
    this.showMany([[target, ratio]]);
  }

  showMany(entries: Array<[Element, number]>): void {
    this.callback(entries.map(([target, ratio]) => ({
      target,
      isIntersecting: ratio > 0,
      intersectionRatio: ratio,
      boundingClientRect: target.getBoundingClientRect(),
      intersectionRect: target.getBoundingClientRect(),
      rootBounds: null,
      time: 1
    })), this);
  }
}

function manifest(pageCount = 8): PreviewManifest {
  return {
    previewRevision: {
      previewRevisionId: createPreviewRevisionId('22'.repeat(32)),
      artifactRevisionId: createArtifactRevisionId('11'.repeat(32)),
      fidelity: 'authoritative',
      rendererId: 'internal-renderer-id',
      rendererVersion: 'internal-version',
      rendererEnvironmentHash: 'renderer-environment-hash',
      fontEnvironmentHash: 'font-environment-hash',
      sourceContentHash: 'source-content-hash',
      pageManifestHash: 'page-manifest-hash',
      acceptanceState: 'reviewable'
    },
    pages: Array.from({ length: pageCount }, (_unused, index) => ({
      pageId: `page-${index + 1}`,
      width: 800,
      height: 1_000
    }))
  };
}

function fakeHost(): HostBridge & {
  acceptPreview: ReturnType<typeof vi.fn>;
  openControlledCopy: ReturnType<typeof vi.fn>;
  startTruthRender: ReturnType<typeof vi.fn>;
} {
  return {
    assetUrl: vi.fn(async () => 'reviewasset://localhost/unused'),
    startTruthRender: vi.fn(async () => ({ jobId: 'unused-job' })),
    previewStatus: vi.fn(async () => ({ jobId: 'unused-job', state: 'queued' as const })),
    saveAnnotation: vi.fn(async () => {}),
    acceptPreview: vi.fn(async () => {}),
    openControlledCopy: vi.fn(async () => ({ receiptId: 'copy-receipt-42' })),
    recordMetrics: vi.fn(async (_snapshot: ReviewPerformanceSnapshot) => {})
  };
}

function render(options: {
  state?: PreviewState;
  pageCount?: number;
  currentPage?: number;
  mode?: 'word' | 'presentation';
  host?: HostBridge;
  pageSurfaces?: ReadonlyMap<string, PageSurfaceRef>;
  textLayers?: ReadonlyMap<string, TextLayer | null>;
  loadPage?: (pageId: string, scaleBucket: number) => Promise<{ surface: PageSurfaceRef; textLayer: TextLayer | null }>;
  mountSurface?: (surface: PageSurfaceRef, target: HTMLElement) => void;
  onFirstPageVisible?: () => void;
  onInteraction?: (name: 'scroll' | 'zoom' | 'page' | 'selection' | 'annotation') => void | Promise<void>;
  useDefaultViewportSize?: boolean;
} = {}) {
  const root = document.createElement('div');
  document.body.append(root);
  const controller = renderReviewShell({
    root,
    manifest: manifest(options.pageCount),
    state: options.state ?? 'authoritative_ready',
    mode: options.mode ?? 'word',
    currentPage: options.currentPage,
    artifactHandle: 'opaque-artifact-handle',
    host: options.host ?? fakeHost(),
    pageSurfaces: options.pageSurfaces,
    textLayers: options.textLayers,
    loadPage: options.loadPage,
    mountSurface: options.mountSurface,
    onFirstPageVisible: options.onFirstPageVisible,
    onInteraction: options.onInteraction,
    getViewportSize: options.useDefaultViewportSize ? undefined : () => ({ width: 1_000, height: 700 })
  });
  return { root, controller };
}

function press(root: HTMLElement, key: string): void {
  root.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

beforeEach(() => {
  ControlledIntersectionObserver.instances = [];
  vi.stubGlobal('IntersectionObserver', ControlledIntersectionObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('ReviewShell status and actions', () => {
  it('rehydrates the accepted revision and active page without replaying truth render', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const host = fakeHost();
    const acceptedManifest = manifest(8);

    const controller = rehydrateReviewShell({
      root,
      manifest: acceptedManifest,
      mode: 'word',
      artifactHandle: 'opaque-artifact-handle',
      host,
      durableState: {
        acceptedPreviewRevisionId: acceptedManifest.previewRevision.previewRevisionId,
        currentPage: 4
      }
    });

    expect(controller.currentPage()).toBe(4);
    expect(root.querySelector('[data-testid="review-status"]')?.textContent).toContain('此版本已接受');
    expect(root.querySelector('[aria-current="page"]')?.getAttribute('data-page-number')).toBe('4');
    expect(host.startTruthRender).not.toHaveBeenCalled();
  });

  it('refuses to rehydrate an accepted revision onto a different manifest', () => {
    const acceptedManifest = manifest(8);
    const root = document.createElement('div');

    expect(() => rehydrateReviewShell({
      root,
      manifest: acceptedManifest,
      mode: 'word',
      artifactHandle: 'opaque-artifact-handle',
      host: fakeHost(),
      durableState: {
        acceptedPreviewRevisionId: createPreviewRevisionId('33'.repeat(32)),
        currentPage: 4
      }
    })).toThrow(/accepted preview revision/i);
    expect(root.childElementCount).toBe(0);
  });

  it.each([
    ['loading_fast', '正在快速预览'],
    ['rendering_authoritative', '原格式预览准备中'],
    ['authoritative_ready', '原格式已就绪'],
    ['dependency_missing', '需要 WPS 才能核对原格式']
  ] as const)('renders %s as a user-facing state', (state, label) => {
    const { root } = render({ state });

    expect(root.querySelector('[data-testid="review-status"]')?.textContent).toContain(label);
    expect(root.textContent).not.toMatch(/docx-preview|pdfjs|Codex|App Server|provider|model/i);
  });

  it('renders the five stable regions and exactly four header review actions', () => {
    const { root } = render();

    for (const testId of ['review-header', 'page-rail', 'document-viewport', 'review-overlay', 'review-status']) {
      expect(root.querySelector(`[data-testid="${testId}"]`)).not.toBeNull();
    }
    const actions = [...root.querySelectorAll<HTMLButtonElement>('[data-testid="review-header"] button')];
    expect(actions.map((button) => button.textContent)).toEqual([
      '继续修改', '在 WPS 打开副本', '接受此版本', '关闭预览'
    ]);
    expect(actions.every((button) => Boolean(button.getAttribute('aria-label')))).toBe(true);
  });

  it('accepts only an authoritative-ready preview', async () => {
    const blockedHost = fakeHost();
    const blocked = render({ state: 'fast_ready', host: blockedHost });
    const blockedAccept = blocked.root.querySelector<HTMLButtonElement>('[data-action="accept"]')!;
    expect(blockedAccept.disabled).toBe(true);
    blockedAccept.click();
    expect(blockedHost.acceptPreview).not.toHaveBeenCalled();

    const readyHost = fakeHost();
    const ready = render({ state: 'authoritative_ready', host: readyHost });
    const readyAccept = ready.root.querySelector<HTMLButtonElement>('[data-action="accept"]')!;
    expect(readyAccept.disabled).toBe(false);
    readyAccept.click();
    await Promise.resolve();
    expect(readyHost.acceptPreview).toHaveBeenCalledWith(`preview-sha256:${'22'.repeat(32)}`);
  });

  it('opens only the opaque controlled-copy handle and displays its receipt ID', async () => {
    const host = fakeHost();
    const { root } = render({ host });

    root.querySelector<HTMLButtonElement>('[data-action="open-copy"]')!.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(host.openControlledCopy).toHaveBeenCalledWith('opaque-artifact-handle');
    expect(root.querySelector('[role="status"]')?.textContent).toContain('copy-receipt-42');
  });
});

describe('ReviewShell virtualization and document modes', () => {
  it('mounts only the current page and two neighbors while retaining lightweight placeholders', () => {
    const { root } = render({ pageCount: 100, currentPage: 50 });

    expect(root.querySelectorAll('[data-mounted-page]')).toHaveLength(5);
    expect([...root.querySelectorAll<HTMLElement>('[data-mounted-page]')].map((page) => page.dataset.pageNumber))
      .toEqual(['48', '49', '50', '51', '52']);
    expect(root.querySelectorAll('[data-page-placeholder]')).toHaveLength(95);
  });

  it('uses continuous pages for Word and a single visible slide for presentations', () => {
    const word = render({ mode: 'word', currentPage: 4 });
    expect(word.root.querySelectorAll('[data-visible-page]')).toHaveLength(5);

    const presentation = render({ mode: 'presentation', currentPage: 4 });
    expect(presentation.root.querySelectorAll('[data-visible-page]')).toHaveLength(1);
    expect(presentation.root.querySelector('[data-visible-page]')?.getAttribute('data-page-number')).toBe('4');
    expect(presentation.root.querySelectorAll('[data-mounted-page]')).toHaveLength(5);
    const slides = [...presentation.root.querySelectorAll<HTMLElement>('[data-testid="document-viewport"] > article')];
    const currentSlide = slides.find((slide) => slide.dataset.pageNumber === '4')!;
    expect(currentSlide.hidden).toBe(false);
    expect(getComputedStyle(currentSlide).display).not.toBe('none');
    for (const slide of slides.filter((candidate) => candidate !== currentSlide)) {
      expect(slide.hidden).toBe(true);
      expect(getComputedStyle(slide).display).toBe('none');
    }
  });

  it('mounts visible page content and normalized text layers for mounted pages', () => {
    const surfaces = new Map<string, PageSurfaceRef>([[
      'page-3',
      { pageId: 'page-3', width: 800, height: 1_000, surfaceHandle: 'opaque-surface-3' }
    ]]);
    const textLayers = new Map<string, TextLayer>([[
      'page-3',
      { items: [{ text: 'Visible fixture text', bbox: [0.1, 0.2, 0.3, 0.04] }] }
    ]]);
    const mountSurface = (surface: PageSurfaceRef, target: HTMLElement) => {
      const canvas = document.createElement('canvas');
      canvas.dataset.paintedSurface = surface.surfaceHandle;
      canvas.width = surface.width;
      canvas.height = surface.height;
      target.replaceChildren(canvas);
    };
    const { root } = render({ currentPage: 3, pageSurfaces: surfaces, textLayers, mountSurface });
    const page = root.querySelector<HTMLElement>('[data-page-id="page-3"]')!;

    const canvas = page.querySelector<HTMLCanvasElement>('[data-page-surface] canvas');
    expect(canvas?.dataset.paintedSurface).toBe('opaque-surface-3');
    expect(canvas?.width).toBe(800);
    expect(canvas?.height).toBe(1_000);
    expect(page.querySelector('[data-text-layer]')?.textContent).toContain('Visible fixture text');
  });

  it('reports the first page only after a real surface is mounted', () => {
    const onFirstPageVisible = vi.fn();
    render({ onFirstPageVisible });
    expect(onFirstPageVisible).not.toHaveBeenCalled();

    const surfaces = new Map<string, PageSurfaceRef>([[
      'page-1',
      { pageId: 'page-1', width: 800, height: 1_000, surfaceHandle: 'opaque-surface-1' }
    ]]);
    render({
      pageSurfaces: surfaces,
      mountSurface: (_surface, target) => target.append(document.createElement('canvas')),
      onFirstPageVisible
    });
    expect(onFirstPageVisible).toHaveBeenCalledOnce();
  });

  it('lazy-loads and paints pages beyond the initial three-page window', async () => {
    const initial = new Map<string, PageSurfaceRef>(['page-1', 'page-2', 'page-3'].map((pageId) => [
      pageId,
      { pageId, width: 800, height: 1_000, surfaceHandle: `opaque-${pageId}` },
    ]));
    const loadPage = vi.fn(async (pageId: string) => ({
      surface: { pageId, width: 800, height: 1_000, surfaceHandle: `opaque-${pageId}` },
      textLayer: { items: [{ text: `Text ${pageId}`, bbox: [0, 0, 1, 1] as [number, number, number, number] }] },
    }));
    const { root } = render({
      pageCount: 6,
      pageSurfaces: initial,
      loadPage,
      mountSurface: (surface, target) => {
        const canvas = document.createElement('canvas');
        canvas.dataset.paintedSurface = surface.surfaceHandle;
        target.append(canvas);
      },
    });

    root.querySelector<HTMLButtonElement>('[aria-label="第 4 页"]')!.click();
    await vi.waitFor(() => {
      expect(root.querySelector('[data-page-id="page-4"] [data-painted-surface="opaque-page-4"]')).not.toBeNull();
    });
    expect(loadPage).toHaveBeenCalledWith('page-4', 1);
    expect(root.querySelector('[data-page-id="page-4"] [data-text-layer]')?.textContent).toContain('Text page-4');
  });

  it('requests and mounts a new surface when the zoom bucket changes', async () => {
    const initial = new Map<string, PageSurfaceRef>(['page-1', 'page-2', 'page-3'].map((pageId) => [
      pageId,
      { pageId, width: 800, height: 1_000, surfaceHandle: `${pageId}@1` },
    ]));
    const loadPage = vi.fn(async (pageId: string, scaleBucket: number) => ({
      surface: { pageId, width: 800, height: 1_000, surfaceHandle: `${pageId}@${scaleBucket}` },
      textLayer: null,
    }));
    const { root } = render({
      pageCount: 3,
      pageSurfaces: initial,
      loadPage,
      mountSurface: (surface, target) => {
        const canvas = document.createElement('canvas');
        canvas.dataset.paintedSurface = surface.surfaceHandle;
        target.append(canvas);
      },
    });
    const zoom = root.querySelector<HTMLSelectElement>('[aria-label="缩放百分比"]')!;
    zoom.value = '2';
    zoom.dispatchEvent(new Event('change'));

    await vi.waitFor(() => {
      expect(root.querySelector('[data-page-id="page-1"] [data-painted-surface="page-1@2"]')).not.toBeNull();
    });
    expect(loadPage).toHaveBeenCalledWith('page-1', 2);
  });

  it('tracks the current page with IntersectionObserver and remounts its two neighbors', () => {
    const { root, controller } = render({ pageCount: 10, currentPage: 2 });
    const observer = ControlledIntersectionObserver.instances.at(-1)!;
    const pageSeven = root.querySelector<HTMLElement>('[data-page-number="7"]')!;

    observer.show(pageSeven);

    expect(controller.currentPage()).toBe(7);
    expect([...root.querySelectorAll<HTMLElement>('[data-mounted-page]')].map((page) => page.dataset.pageNumber))
      .toEqual(['5', '6', '7', '8', '9']);
  });

  it('retains intersection ratios that were reported in earlier observer callbacks', () => {
    const { root, controller } = render({ pageCount: 6, currentPage: 2 });
    const observer = ControlledIntersectionObserver.instances.at(-1)!;
    const pageTwo = root.querySelector<HTMLElement>('[data-page-number="2"]')!;
    const pageThree = root.querySelector<HTMLElement>('[data-page-number="3"]')!;

    observer.showMany([[pageTwo, 0.75], [pageThree, 0.5]]);
    observer.show(pageTwo, 0.25);

    expect(controller.currentPage()).toBe(3);
  });

  it('labels every page button with its one-based page number', () => {
    const { root } = render({ pageCount: 4 });
    expect([...root.querySelectorAll<HTMLButtonElement>('[data-testid="page-rail"] button')]
      .map((button) => button.getAttribute('aria-label'))).toEqual([
        '第 1 页', '第 2 页', '第 3 页', '第 4 页'
      ]);
  });
});

describe('ReviewShell zoom, keyboard, and interaction feedback', () => {
  it('uses the exact zoom buckets and preserves the requested fit percentage', () => {
    const { root, controller } = render({ currentPage: 2 });
    expect(ZOOM_BUCKETS).toEqual([0.5, 0.67, 0.8, 1, 1.25, 1.5, 2]);

    root.querySelector<HTMLButtonElement>('[data-zoom="fit-page"]')!.click();

    expect(controller.zoom()).toEqual({ bucket: 0.67, displayPercent: 70, mode: 'fit-page' });
    expect(root.querySelector('[data-testid="zoom-display"]')?.textContent).toBe('70%');
    expect(root.querySelector<HTMLElement>('[data-current-page]')?.style.width).toBe('560px');
    expect(root.querySelector<HTMLElement>('[data-current-page]')?.dataset.scaleBucket).toBe('0.67');

    root.querySelector<HTMLButtonElement>('[data-zoom="fit-width"]')!.click();
    expect(controller.zoom()).toEqual({ bucket: 1.25, displayPercent: 125, mode: 'fit-width' });
    expect(root.querySelector<HTMLElement>('[data-current-page]')?.style.width).toBe('1000px');
    expect(root.querySelector<HTMLElement>('[data-current-page]')?.dataset.scaleBucket).toBe('1.25');
  });

  it('computes fit zoom from the document viewport rather than the outer shell', () => {
    const { root, controller } = render({ useDefaultViewportSize: true });
    const viewport = root.querySelector<HTMLElement>('[data-testid="document-viewport"]')!;
    Object.defineProperties(root, { clientWidth: { value: 1_200 }, clientHeight: { value: 900 } });
    Object.defineProperties(viewport, { clientWidth: { value: 640 }, clientHeight: { value: 480 } });

    root.querySelector<HTMLButtonElement>('[data-zoom="fit-width"]')!.click();

    expect(controller.zoom()).toEqual({ bucket: 0.8, displayPercent: 80, mode: 'fit-width' });
  });

  it('handles PageUp, PageDown, Home, End, plus, minus, and zero from the keyboard', () => {
    const { root, controller } = render({ pageCount: 10, currentPage: 5 });

    press(root, 'PageDown');
    expect(controller.currentPage()).toBe(6);
    press(root, 'PageUp');
    expect(controller.currentPage()).toBe(5);
    press(root, 'Home');
    expect(controller.currentPage()).toBe(1);
    press(root, 'End');
    expect(controller.currentPage()).toBe(10);
    press(root, '+');
    expect(controller.zoom().bucket).toBe(1.25);
    press(root, '-');
    expect(controller.zoom().bucket).toBe(1);
    press(root, '0');
    expect(controller.zoom()).toEqual({ bucket: 1, displayPercent: 100, mode: 'percentage' });
  });

  it('does not intercept navigation shortcuts from descendants of editable regions', () => {
    const { root, controller } = render({ pageCount: 10, currentPage: 5 });
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    const nestedText = document.createElement('span');
    editor.append(nestedText);
    root.append(editor);
    const event = new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true, cancelable: true });

    nestedText.dispatchEvent(event);

    expect(controller.currentPage()).toBe(5);
    expect(event.defaultPrevented).toBe(false);
  });

  it('reports real scroll, page, zoom, selection, and annotation interactions', async () => {
    const onInteraction = vi.fn(async (_name: 'scroll' | 'zoom' | 'page' | 'selection' | 'annotation') => {});
    const { root } = render({ onInteraction });
    for (const selector of Object.values(REVIEW_AUTOMATION_SELECTORS)) {
      expect(root.querySelector(selector), selector).not.toBeNull();
    }
    const viewport = root.querySelector<HTMLElement>('[data-testid="document-viewport"]')!;

    viewport.dispatchEvent(new Event('scroll'));
    root.querySelector<HTMLButtonElement>('[aria-label="第 4 页"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-zoom="fit-width"]')!.click();
    viewport.dispatchEvent(new Event('pointerup', { bubbles: true }));
    root.querySelector<HTMLButtonElement>('[aria-label="添加批注"]')!.click();
    await Promise.resolve();

    expect(onInteraction.mock.calls.map(([name]) => name)).toEqual([
      'scroll', 'page', 'zoom', 'selection', 'annotation'
    ]);
  });

  it('starts page and zoom measurement before their synchronous DOM/state work', () => {
    const observedBoundaries: Array<{ name: string; page: number; bucket: number }> = [];
    let controller!: ReturnType<typeof render>['controller'];
    const rendered = render({
      currentPage: 2,
      onInteraction(name) {
        observedBoundaries.push({
          name,
          page: controller.currentPage(),
          bucket: controller.zoom().bucket
        });
      }
    });
    controller = rendered.controller;

    rendered.root.querySelector<HTMLButtonElement>('[aria-label="第 4 页"]')!.click();
    rendered.root.querySelector<HTMLButtonElement>('[data-zoom="fit-width"]')!.click();

    expect(observedBoundaries).toEqual([
      { name: 'page', page: 2, bucket: 1 },
      { name: 'zoom', page: 4, bucket: 1 }
    ]);
    expect(controller.currentPage()).toBe(4);
    expect(controller.zoom().bucket).toBe(1.25);
  });

  it('disconnects observers and removes listeners during teardown', () => {
    const onInteraction = vi.fn();
    const { root, controller } = render({ onInteraction });
    const observer = ControlledIntersectionObserver.instances.at(-1)!;
    const viewport = root.querySelector<HTMLElement>('[data-testid="document-viewport"]')!;

    controller.destroy();
    viewport.dispatchEvent(new Event('scroll'));
    press(root, 'PageDown');

    expect(observer.disconnected).toBe(true);
    expect(onInteraction).not.toHaveBeenCalled();
  });
});
