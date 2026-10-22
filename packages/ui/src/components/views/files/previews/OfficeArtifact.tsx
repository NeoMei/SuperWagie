import React from 'react';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { toast } from 'sonner';

import type { HostContext, NavigationService, PrintService } from 'omni-viewer-core/host';
import type { PptController } from 'omni-viewer-core/viewers/ppt';
import type { ViewerHandle } from 'omni-viewer-core/viewers/types';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { openDesktopPath } from '@/lib/desktop';
import { getFileExtension } from '@/lib/toolHelpers';
import { ArtifactMetaBar } from './ArtifactMetaBar';
import { formatArtifactSize } from './artifactMeta';

type OfficeKind = 'word' | 'excel' | 'ppt';

const officeKind = (name: string): OfficeKind | null => {
  const extension = getFileExtension(name);
  if (extension === 'doc' || extension === 'docx') return 'word';
  if (extension === 'xls' || extension === 'xlsx') return 'excel';
  if (extension === 'ppt' || extension === 'pptx') return 'ppt';
  return null;
};

const viewerContext = (): HostContext & { print: PrintService; navigation: NavigationService } => ({
  assets: {
    resolveAssetUrl: async (assetPath) => (
      assetPath.endsWith('pdf.worker.min.mjs') ? pdfWorkerUrl : assetPath
    ),
  },
  i18n: { t: (key) => key },
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

const mountOfficeViewer = async (
  kind: OfficeKind,
  input: { fileName: string; data: Uint8Array },
  container: HTMLElement,
): Promise<ViewerHandle> => {
  const ctx = viewerContext();
  if (kind === 'word') {
    const [{ mountWordViewer }, { loadWordViewerDeps }] = await Promise.all([
      import('omni-viewer-core/viewers/word'),
      import('omni-viewer-core/viewers/word/self-loading'),
    ]);
    return mountWordViewer(input, container, ctx, await loadWordViewerDeps());
  }
  if (kind === 'excel') {
    const { mountSelfLoadingExcelViewer } = await import('omni-viewer-core/viewers/excel/self-loading');
    return mountSelfLoadingExcelViewer(input, container, ctx);
  }
  const { mountPptViewer } = await import('omni-viewer-core/viewers/ppt');
  const mounted = await mountPptViewer(input, container, ctx);
  fitPptToWidth(container, mounted.controller);
  return mounted;
};

/**
 * Office documents are ZIP packages, not text. Omni Viewer's browser viewers
 * render them inside their own shadow root so their CSS cannot leak into the
 * file panel and this app's theme cannot break their layout.
 */
export const OfficeArtifact: React.FC<{
  name: string;
  path: string;
  sizeBytes: number | null;
  revision: number;
  readBytes: () => Promise<Uint8Array>;
  download?: React.ReactNode;
}> = ({ name, path, sizeBytes, revision, readBytes, download }) => {
  const kind = officeKind(name);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const readBytesRef = React.useRef(readBytes);
  readBytesRef.current = readBytes;
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container || !kind) return;
    let disposed = false;
    let viewer: ViewerHandle | null = null;
    setLoading(true);
    setError(null);
    container.replaceChildren();
    void (async () => {
      try {
        const data = await readBytesRef.current();
        const mounted = await mountOfficeViewer(kind, { fileName: name, data }, container);
        if (disposed) mounted.dispose();
        else viewer = mounted;
      } catch (mountError) {
        if (!disposed) setError(mountError instanceof Error ? mountError.message : String(mountError));
      } finally {
        if (!disposed) setLoading(false);
      }
    })();
    return () => {
      disposed = true;
      viewer?.dispose();
      viewer = null;
    };
  }, [kind, name, revision]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ArtifactMetaBar
        items={[kind ? kind.toUpperCase() : '', formatArtifactSize(sizeBytes)]}
        actions={(
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void openDesktopPath(path).then((opened) => {
                  if (!opened) toast.error('当前环境无法用默认应用打开文件。');
                });
              }}
            >
              <Icon name="external-link" className="me-2 size-4" />
              用默认应用打开
            </Button>
            {download}
          </>
        )}
      />
      <div className="relative min-h-0 flex-1">
        {loading ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center typography-ui text-muted-foreground">正在打开文件…</div>
        ) : null}
        {error ? (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 p-6 text-center">
            <div className="typography-ui-header text-foreground">无法预览这个文件</div>
            <div className="max-w-md typography-ui text-muted-foreground">{error}</div>
            {download}
          </div>
        ) : null}
        <div ref={containerRef} className="h-full min-h-0" />
      </div>
    </div>
  );
};
