import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { HostContext, NavigationService, PrintService } from 'omni-viewer-core/host';
import type { PptController } from 'omni-viewer-core/viewers/ppt';
import type { ViewerHandle } from 'omni-viewer-core/viewers/types';
import { resolveLocalizedCatalogMessage } from 'omni-viewer-core/i18n';
import { useI18nStore } from '@/lib/i18n';

export type OfficeKind = 'word' | 'excel' | 'ppt';
export type OfficeViewerMount = (kind: OfficeKind, input: { fileName: string; data: Uint8Array }, container: HTMLElement, signal: AbortSignal) => Promise<ViewerHandle>;

const viewerContext = (): HostContext & { print: PrintService; navigation: NavigationService } => ({
  assets: {
    resolveAssetUrl: async (assetPath) => (
      assetPath.endsWith('pdf.worker.min.mjs') ? pdfWorkerUrl : assetPath
    ),
  },
  i18n: { t: (key, args) => resolveLocalizedCatalogMessage(useI18nStore.getState().locale, key, args) },
  logger: {
    log: (level, message) => {
      if (level === 'error') console.error('[omni-viewer]', message);
      else if (level === 'warn') console.warn('[omni-viewer]', message);
    },
  },
  print: { print: () => window.print() },
  navigation: {
    openExternalUrl: async (url) => {
      if (/^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener,noreferrer');
    },
  },
});

const PPT_MIN_ZOOM = 0.25;
const PPT_MAX_ZOOM = 4;

/**
 * The slide viewer starts at 100%, which overflows any panel narrower than
 * the slide. Fit the first render to the viewport before the user sees it;
 * the toolbar keeps its own zoom controls from there.
 */
const fitPptToWidth = (container: HTMLElement, controller: PptController): void => {
  const root = container.shadowRoot ?? container;
  const viewport = root.querySelector<HTMLElement>('.omni-ppt__viewport');
  const slide = root.querySelector<HTMLElement>('.omni-ppt__slide');
  if (!viewport || !slide) return;
  const available = viewport.clientWidth - 40;
  const slideWidth = Number.parseFloat(slide.style.width) || slide.getBoundingClientRect().width;
  if (available <= 0 || slideWidth <= 0) return;
  const target = Math.min(PPT_MAX_ZOOM, Math.max(PPT_MIN_ZOOM, available / slideWidth));
  let steps = 0;
  while (controller.state.zoom > target + 0.051 && steps++ < 80) {
    controller.dispatch({ type: 'zoom-out' });
  }
  while (controller.state.zoom < target - 0.051 && steps++ < 80) {
    controller.dispatch({ type: 'zoom-in' });
  }
};

export const mountOfficeViewer: OfficeViewerMount = async (
  kind: OfficeKind,
  input: { fileName: string; data: Uint8Array },
  container: HTMLElement,
  signal: AbortSignal,
): Promise<ViewerHandle> => {
  const ctx = viewerContext();
  if (kind === 'word') {
    const [{ mountWordViewer }, { loadWordViewerDeps }] = await Promise.all([
      import('omni-viewer-core/viewers/word'),
      import('omni-viewer-core/viewers/word/self-loading'),
    ]);
    signal.throwIfAborted();
    const deps = await loadWordViewerDeps();
    signal.throwIfAborted();
    const mounted = await mountWordViewer(input, container, ctx, deps, { signal });
    // Theme the surrounding canvas while retaining document-authored page colors.
    const wrapper = container.shadowRoot?.querySelector<HTMLElement>('.docx-wrapper');
    if (wrapper) wrapper.style.background = 'var(--omni-bg)';
    return mounted;
  }
  if (kind === 'excel') {
    const { mountSelfLoadingExcelViewer } = await import('omni-viewer-core/viewers/excel/self-loading');
    signal.throwIfAborted();
    return mountSelfLoadingExcelViewer(input, container, ctx, { signal });
  }
  const { mountPptViewer } = await import('omni-viewer-core/viewers/ppt');
  signal.throwIfAborted();
  const mounted = await mountPptViewer(input, container, ctx, undefined, { signal });
  fitPptToWidth(container, mounted.controller);
  return mounted;
};

