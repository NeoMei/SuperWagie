import React from 'react';
import { toast } from 'sonner';


import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { openDesktopPath } from '@/lib/desktop';
import { getFileExtension } from '@/lib/toolHelpers';
import { MAX_OFFICE_PREVIEW_BYTES } from '@/lib/fileOpenLimits';
import { useI18n } from '@/lib/i18n';
import { ArtifactMetaBar } from './ArtifactMetaBar';
import { formatArtifactSize } from './artifactMeta';
import type { OfficeKind, OfficeViewerMount } from './officeViewer';
import type { ViewerHandle } from 'omni-viewer-core/viewers/types';
import { OfficePreviewSizeError } from './officePreviewBytes';
import { XlsxCopyPanel, type XlsxCopyAPI } from './XlsxCopyPanel';
import type { TableQuote } from './tableSelection';

const officeKind = (name: string): OfficeKind | null => {
  const extension = getFileExtension(name);
  if (extension === 'doc' || extension === 'docx') return 'word';
  if (extension === 'xls' || extension === 'xlsx') return 'excel';
  if (extension === 'ppt' || extension === 'pptx') return 'ppt';
  return null;
};
const mountDefault: OfficeViewerMount = async (...args) => (await import('./officeViewer')).mountOfficeViewer(...args);

// Omni's documented CSS variables cross its shadow root and follow resolved app themes live.
const officeTheme: React.CSSProperties & { [key: `--omni-${string}`]: string } = {
  '--omni-bg': 'var(--surface-background)',
  '--omni-fg': 'var(--surface-foreground)',
  '--omni-fg-muted': 'var(--surface-muted-foreground)',
  '--omni-panel-bg': 'var(--surface-muted)',
  '--omni-header-bg': 'var(--surface-muted)',
  '--omni-control-bg': 'var(--surface-elevated)',
  '--omni-input-bg': 'var(--surface-elevated)',
  '--omni-button-bg': 'var(--surface-elevated)',
  '--omni-menu-bg': 'var(--surface-elevated)',
  '--omni-toast-bg': 'var(--surface-elevated)',
  '--omni-border': 'var(--interactive-border)',
  '--omni-hover-bg': 'var(--interactive-hover)',
  '--omni-highlight': 'var(--interactive-selection)',
  '--omni-accent': 'var(--primary-base)',
  '--omni-error': 'var(--status-error-text)',
  '--omni-danger': 'var(--status-error-text)',
  '--omni-warn': 'var(--status-warning-text)',
};

/**
 * Office previews consume original binary bytes. Omni Viewer's browser viewers
 * render them inside their own shadow root so their CSS cannot leak into the
 * file panel and this app's theme cannot break their layout.
 */
export const OfficeArtifact: React.FC<{
  name: string;
  path: string;
  sizeBytes: number | null;
  revision: number;
  readBytes: (signal: AbortSignal) => Promise<Uint8Array>;
  mountViewer?: OfficeViewerMount;
  download?: React.ReactNode;
  copyAPI?: XlsxCopyAPI;
  onQuote?: (quote: TableQuote) => boolean;
}> = ({ name, path, sizeBytes, revision, readBytes, mountViewer = mountDefault, download, copyAPI, onQuote }) => {
  const { t } = useI18n();
  const kind = officeKind(name);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const readBytesRef = React.useRef(readBytes);
  readBytesRef.current = readBytes;
  const [attempt, retry] = React.useReducer((value: number) => value + 1, 0);
  const [state, setState] = React.useState<{ status: 'loading' | 'ready' } | { status: 'error'; error: Error }>({ status: 'loading' });
  const [copyOpen, setCopyOpen] = React.useState(false);
  const [copyVisited, setCopyVisited] = React.useState(false);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container || !kind) return;
    const controller = new AbortController();
    const host = document.createElement('div');
    host.className = 'h-full min-h-0';
    container.append(host);
    let viewer: ViewerHandle | null = null;
    setState({ status: 'loading' });
    void (async () => {
      try {
        const data = await readBytesRef.current(controller.signal);
        controller.signal.throwIfAborted();
        if (data.byteLength > MAX_OFFICE_PREVIEW_BYTES) throw new OfficePreviewSizeError();
        const mounted = await mountViewer(kind, { fileName: name, data }, host, controller.signal);
        if (controller.signal.aborted) mounted.dispose();
        else { viewer = mounted; setState({ status: 'ready' }); }
      } catch (mountError) {
        if (!controller.signal.aborted) setState({ status: 'error', error: mountError instanceof Error ? mountError : new Error(String(mountError)) });
      }
    })();
    return () => {
      controller.abort();
      host.remove();
      viewer?.dispose();
      viewer = null;
    };
  }, [kind, name, path, revision, attempt, mountViewer]);
  const error = state.status === 'error' ? state.error : null;

  return (
    <div className="flex h-full min-h-0 flex-col" style={officeTheme}>
      <ArtifactMetaBar
        items={[kind ? kind.toUpperCase() : '', formatArtifactSize(sizeBytes)]}
        actions={(
          <>
            {copyAPI && getFileExtension(name) === 'xlsx' ? <Button type="button" size="sm" variant="chip" aria-pressed={copyOpen} onClick={() => { setCopyOpen((open) => !open); setCopyVisited(true); }}>{t('filesView.xlsx.open')}</Button> : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void openDesktopPath(path).then((opened) => {
                  if (!opened) toast.error(t('filesView.artifact.office.openUnavailable'));
                });
              }}
            >
              <Icon name="external-link" className="me-2 size-4" />
              {t('filesView.artifact.office.openDefault')}
            </Button>
            {download}
          </>
        )}
      />
      {copyVisited && copyAPI ? <div className={copyOpen ? 'min-h-0 flex-1' : 'hidden'}><XlsxCopyPanel key={JSON.stringify([path, revision])} path={path} name={name} api={copyAPI} onQuote={onQuote} /></div> : null}
      <div className={copyOpen ? 'hidden' : 'relative min-h-0 flex-1'}>
        {state.status === 'loading' ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center typography-ui text-muted-foreground">{t('filesView.artifact.office.loading')}</div>
        ) : null}
        {error ? (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 p-6 text-center">
            <div className="typography-ui-header text-foreground">{t('filesView.artifact.office.failed')}</div>
            <div className="max-w-md typography-ui text-muted-foreground">{error instanceof OfficePreviewSizeError ? t('filesView.artifact.office.tooLarge') : error.message}</div>
            <Button type="button" variant="outline" size="sm" onClick={retry}>{t('filesView.artifact.office.retry')}</Button>
            {download}
          </div>
        ) : null}
        <div ref={containerRef} className="h-full min-h-0" />
      </div>
    </div>
  );
};
