import React from 'react';
import { createPortal } from 'react-dom';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { PauseClock } from '@/components/ui/pause-clock';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useWaitingBlink } from '@/hooks/useDurationTicker';
import { isDesktopLocalOriginActive, openDesktopPath, requestDirectoryAccess } from '@/lib/desktop';
import { useI18n, type I18nKey } from '@/lib/i18n';
import {
  addKnowledgeLibrary,
  KnowledgeLibraryError,
  listKnowledgeDocuments,
  listKnowledgeImages,
  listKnowledgeLibraries,
  loadKnowledgeImage,
  readKnowledgeWikiFolders,
  readKnowledgeWikiGraph,
  readKnowledgeWikiPages,
  previewKnowledgeLibrary,
  readKnowledgeLibraryStatus,
  reconnectKnowledgeLibrary,
  removeKnowledgeDocument,
  removeKnowledgeLibrary,
  rescanKnowledgeLibrary,
  searchKnowledgeLibrary,
  setKnowledgeLibraryWatching,
  type KnowledgeLibraryDocument,
  type KnowledgeLibraryImage,
  type KnowledgeLibraryLibrary,
  type KnowledgeLibraryWikiFolders,
  type KnowledgeLibraryWikiGraph,
  type KnowledgeLibraryWikiPages,
  type KnowledgeLibrarySearchResult,
  type KnowledgeLibraryStatus,
  type KnowledgeLibraryPreview,
} from '@/lib/knowledgeLibrary';
import {
  buildGraphLayout,
  graphLandmarkTitle,
  stepGraphLayout,
  type ForceNode,
} from '@/lib/wikiGraphLayout';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { estimateDisplay, type EstimateDuration } from './knowledgeLibraryEstimate';

type LibraryTab = 'documents' | 'wiki' | 'graph' | 'gallery' | 'experiences';

const LIBRARY_TABS: ReadonlyArray<{ id: LibraryTab; icon: IconName; labelKey: I18nKey }> = [
  { id: 'documents', icon: 'file-text', labelKey: 'knowledgeLibrary.panel.tabs.documents' },
  { id: 'wiki', icon: 'book-open', labelKey: 'knowledgeLibrary.panel.tabs.wiki' },
  { id: 'graph', icon: 'node-tree', labelKey: 'knowledgeLibrary.panel.tabs.graph' },
  { id: 'gallery', icon: 'image', labelKey: 'knowledgeLibrary.panel.tabs.gallery' },
  { id: 'experiences', icon: 'file-text', labelKey: 'conversationMemory.tab' },
];

const ConversationMemoryPanelSection = React.lazy(() => import('./ConversationMemorySection')
  .then((module) => ({ default: module.ConversationMemoryPanelSection })));

const PROGRESS_POLL_MS = 2_000;

// Gallery captions have no chat directory; load the shared Markdown body only
// when a preview opens, without subscribing it to the active chat.
const GallerySummary = React.lazy(() => import('@/components/chat/MarkdownRendererImpl')
  .then((module) => ({ default: module.MarkdownContent })));

const ACTIVE_STATES = new Set(['pending', 'queued', 'parsing']);

const stateKeyOf = (state: KnowledgeLibraryDocument['state']): I18nKey => {
  switch (state) {
    case 'ready': return 'knowledgeLibrary.panel.state.ready';
    case 'parsing': return 'knowledgeLibrary.panel.state.parsing';
    case 'queued':
    case 'pending': return 'knowledgeLibrary.panel.state.parsing';
    case 'failed': return 'knowledgeLibrary.panel.state.failed';
    case 'skipped': return 'knowledgeLibrary.panel.state.skipped';
    case 'missing':
    default: return 'knowledgeLibrary.panel.state.missing';
  }
};

const statusDotClass = (
  status: KnowledgeLibraryStatus | null,
  supported: boolean,
  provisioned: boolean,
): string => {
  if (!status) return 'bg-[var(--muted-foreground)]';
  if (!supported) return 'bg-[var(--muted-foreground)]';
  if (status.backend.state === 'running') return provisioned ? 'bg-[var(--success)]' : 'bg-[var(--warning)]';
  if (status.backend.state === 'starting') return 'bg-[var(--warning)]';
  if (status.backend.state === 'unavailable' || status.backend.state === 'port-conflict') return 'bg-[var(--destructive)]';
  return 'bg-[var(--muted-foreground)]';
};

const errorKeyOf = (code: string): I18nKey =>
  code === 'knowledge_work_outcome_pending'
    ? 'knowledgeLibrary.panel.error.searchPending'
    : code === 'not_provisioned' || code.startsWith('provision_')
    ? 'knowledgeLibrary.panel.error.notProvisioned'
    : code === 'path_unreadable' || code === 'http_403'
      ? 'knowledgeLibrary.panel.error.permission'
      : code === 'already_added'
        ? 'knowledgeLibrary.panel.error.alreadyAdded'
        : 'knowledgeLibrary.panel.error.generic';

const durationKeyOf = (duration: EstimateDuration): I18nKey => {
  if (duration.unit === 'underMinute') return 'knowledgeLibrary.panel.addConfirm.timeUnderMinute';
  if (duration.unit === 'minutes') return 'knowledgeLibrary.panel.addConfirm.timeMinutes';
  if (duration.unit === 'hours') return 'knowledgeLibrary.panel.addConfirm.timeHours';
  return 'knowledgeLibrary.panel.addConfirm.timeDays';
};

const dotClassOf = (state: KnowledgeLibraryDocument['state']): string => {
  if (state === 'ready') return 'bg-[var(--success)]';
  if (state === 'failed') return 'bg-[var(--destructive)]';
  if (state === 'skipped' || state === 'missing') return 'bg-[var(--muted-foreground)]';
  return 'bg-[var(--warning)]';
};

const DocumentStateDot = ({ state }: { state: KnowledgeLibraryDocument['state'] }) => {
  const blink = useWaitingBlink(ACTIVE_STATES.has(state));
  return <span className={cn('size-1.5 shrink-0 rounded-full', dotClassOf(state), blink)} aria-hidden />;
};

const folderOf = (relPath: string): string => {
  const slash = relPath.lastIndexOf('/');
  return slash === -1 ? '' : relPath.slice(0, slash);
};

/**
 * 资料库: the folders the agent can search, plus one search over them.
 *
 * Read-only towards indexing: adding, pausing, rescanning and removing are the
 * folder lifecycle, and the agent's tool never reaches any of it. Document rows
 * open the original file; gallery tiles open a preview with a source action.
 */
export const KnowledgeLibraryPanel: React.FC<{ visible?: boolean }> = ({ visible = true }) => {
  const { t, locale } = useI18n();
  const { editor, runtime } = useRuntimeAPIs();
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);

  const [status, setStatus] = React.useState<KnowledgeLibraryStatus | null>(null);
  const [libraries, setLibraries] = React.useState<KnowledgeLibraryLibrary[]>([]);
  const [documents, setDocuments] = React.useState<KnowledgeLibraryDocument[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState('');
  const searchAbort = React.useRef<AbortController | null>(null);
  React.useEffect(() => { if (!visible) searchAbort.current?.abort(); return () => searchAbort.current?.abort(); }, [visible]);
  const [results, setResults] = React.useState<KnowledgeLibrarySearchResult | null>(null);
  const [searchFailed, setSearchFailed] = React.useState(false);
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(new Set());
  const [pendingRemove, setPendingRemove] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState<LibraryTab>('documents');
  const [wikiFocus, setWikiFocus] = React.useState<string | null>(null);

  const openWikiPage = React.useCallback((slug: string) => {
    setWikiFocus(slug);
    setTab('wiki');
  }, []);
  const consumeWikiFocus = React.useCallback(() => setWikiFocus(null), []);

  const refresh = React.useCallback(async (signal?: AbortSignal) => {
    const [nextStatus, nextLibraries, nextDocuments] = await Promise.all([
      readKnowledgeLibraryStatus(signal),
      listKnowledgeLibraries(signal),
      listKnowledgeDocuments({ signal }),
    ]);
    if (signal?.aborted) return null;
    setStatus(nextStatus);
    setLibraries(nextLibraries);
    setDocuments(nextDocuments);
    return nextStatus;
  }, []);

  const reload = React.useCallback(() => {
    setError(null);
    return refresh().catch((error) => {
      setError(error instanceof KnowledgeLibraryError ? error.code : 'request_failed');
      return null;
    }).finally(() => setLoading(false));
  }, [refresh]);

  // Provisioning happens in the settings dialog while this panel stays mounted
  // behind it, so the panel cannot trust the status it read on mount: re-read
  // when it becomes visible and keep a slow poll running while it is open.
  React.useEffect(() => {
    if (!visible) return;
    void reload();
    const timer = setInterval(() => {
      void refresh().catch(() => {});
    }, 5_000);
    return () => clearInterval(timer);
  }, [visible, refresh, reload]);

  // While the backend is starting or something is queued, read again; a settled
  // library is read once.
  React.useEffect(() => {
    if (!visible) return;
    const progressing = status?.backend.state === 'starting'
      || documents.some((document) => ACTIVE_STATES.has(document.state));
    if (!progressing) return;
    const timer = setTimeout(() => void reload(), PROGRESS_POLL_MS);
    return () => clearTimeout(timer);
  }, [visible, status?.backend.state, documents, reload]);

  const submitSearch = React.useCallback(() => {
    const trimmed = query.trim();
    searchAbort.current?.abort();
    if (!visible || !trimmed) { setResults(null); setSearchFailed(false); return; }
    const controller = new AbortController();
    searchAbort.current = controller;
    void searchKnowledgeLibrary({ query: trimmed, signal: controller.signal, intentId: crypto.randomUUID() })
      .then((next) => { if (!controller.signal.aborted) { setResults(next); setSearchFailed(false); setError(null); } })
      .catch((searchError) => {
        if (!controller.signal.aborted) { setSearchFailed(true); setError(searchError instanceof KnowledgeLibraryError ? searchError.code : 'request_failed'); }
      });
  }, [visible, query]);

  const run = React.useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await reload();
    } catch (actionError) {
      setError(actionError instanceof KnowledgeLibraryError ? actionError.code : 'request_failed');
    } finally {
      setBusy(false);
    }
  }, [reload]);

  const confirmPreview = React.useCallback((preview: KnowledgeLibraryPreview) => {
      const countMessage = preview.skipped > 0
        ? t('knowledgeLibrary.panel.addConfirm.bodyWithSkipped', {
            indexable: preview.indexable,
            total: preview.total,
            skipped: preview.skipped,
          })
        : t('knowledgeLibrary.panel.addConfirm.body', { indexable: preview.indexable, total: preview.total });
      const estimateMessages = [t('knowledgeLibrary.panel.addConfirm.costWarning')];
      if (preview.estimate) {
        const display = estimateDisplay(preview.estimate, locale);
        estimateMessages.push(t('knowledgeLibrary.panel.addConfirm.costEstimate', {
          tokensMin: display.tokensMin,
          tokensMax: display.tokensMax,
          costMin: display.costMin,
          costMax: display.costMax,
        }));
        estimateMessages.push(t(durationKeyOf(display.duration), display.duration.unit === 'underMinute' ? undefined : {
          min: display.duration.min,
          max: display.duration.max,
        }));
        if (preview.estimate.imageHeavyFiles > 0) {
          estimateMessages.push(t('knowledgeLibrary.panel.addConfirm.imageHeavy', { count: preview.estimate.imageHeavyFiles }));
        }
        estimateMessages.push(t('knowledgeLibrary.panel.addConfirm.estimateCaveat'));
      } else {
        estimateMessages.push(t('knowledgeLibrary.panel.addConfirm.costUnknown'));
        estimateMessages.push(t('knowledgeLibrary.panel.addConfirm.timeUnknown'));
      }
      return confirm({
        title: t('knowledgeLibrary.panel.addConfirm.title'),
        message: [countMessage, ...estimateMessages].join('\n\n'),
        action: t('knowledgeLibrary.panel.addConfirm.confirm'),
      });
  }, [confirm, locale, t]);

  const addFolder = React.useCallback(async () => {
    const picked = await requestDirectoryAccess('');
    const path = picked.success ? picked.path : undefined;
    if (!path) return;
    let previewId: string | undefined;
    try {
      const preview = await previewKnowledgeLibrary(path);
      previewId = preview.previewId;
      const accepted = await confirmPreview(preview);
      if (!accepted) return;
    } catch (previewError) {
      setError(previewError instanceof KnowledgeLibraryError ? previewError.code : 'request_failed');
      return;
    }
    await run(async () => { await addKnowledgeLibrary(path, previewId); });
  }, [confirmPreview, run]);

  const openDocument = React.useCallback((path: string) => {
    setError(null);
    const inApp = () => {
      if (!editor) {
        setError('open_failed');
        return;
      }
      void editor.openFile(path).catch(() => setError('open_failed'));
    };
    // The library holds files anywhere on disk, and the in-app editor only
    // reaches some of them. On the desktop the OS opens the real file; the
    // in-app viewer stays the fallback where no shell exists.
    if (isDesktopLocalOriginActive()) {
      void openDesktopPath(path).then((opened) => {
        if (!opened) inApp();
      });
      return;
    }
    inApp();
  }, [editor]);

  const rescanLibrary = React.useCallback(async (id: string) => {
    try {
    const library = libraries.find((entry) => entry.id === id);
    const preview = library ? await previewKnowledgeLibrary(library.root) : null;
    const accepted = preview?.previewId ? await confirmPreview(preview) : await confirm({
      title: t('knowledgeLibrary.panel.rescanConfirm.title'),
      message: t('knowledgeLibrary.panel.rescanConfirm.body'),
      action: t('knowledgeLibrary.panel.rescanConfirm.confirm'),
    });
    if (!accepted) return;
    await run(async () => {
      if (library && preview?.previewId) await addKnowledgeLibrary(library.root, preview.previewId);
      else await rescanKnowledgeLibrary(id);
    });
    } catch (cause) { setError(cause instanceof KnowledgeLibraryError ? cause.code : 'request_failed'); }
  }, [confirm, confirmPreview, libraries, run, t]);

  const removeDocument = React.useCallback(async (document: KnowledgeLibraryDocument) => {
    const name = document.relPath.slice(document.relPath.lastIndexOf('/') + 1);
    const accepted = await confirm({
      title: t('knowledgeLibrary.panel.document.removeTitle'),
      message: t('knowledgeLibrary.panel.document.removeConfirm', { name }),
      action: t('knowledgeLibrary.panel.document.remove'),
      destructive: true,
    });
    if (!accepted) return;
    await run(() => removeKnowledgeDocument(document.id));
  }, [confirm, run, t]);

  const toggleCollapsed = (id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const byLibrary = React.useMemo(() => {
    const map = new Map<string, KnowledgeLibraryDocument[]>();
    for (const document of documents) {
      const list = map.get(document.libraryId) ?? [];
      list.push(document);
      map.set(document.libraryId, list);
    }
    for (const list of map.values()) list.sort((left, right) => left.relPath.localeCompare(right.relPath));
    return map;
  }, [documents]);

  const supported = status?.supported !== false;
  const provisioned = status?.provisioned === true;
  const unavailable = status !== null && status.backend.state !== 'running';
  const searching = query.trim().length > 0;
  const readyCount = documents.filter((document) => document.state === 'ready').length;
  const activeCount = documents.filter((document) => ACTIVE_STATES.has(document.state)).length;
  const indexing = activeCount > 0 || status?.backend.state === 'starting';
  const showRetry = supported && status !== null && status.enabled && status.backend.state !== 'running';
  const showOpenSettings = status?.enabled === false || status?.backend.state === 'running' && !provisioned;

  let statusLine: string;
  if (loading) statusLine = t('knowledgeLibrary.panel.loading');
  else if (!supported) statusLine = t('knowledgeLibrary.status.notInstalled');
  else if (!status) statusLine = t('knowledgeLibrary.status.error');
  else if (status.backend.state === 'starting') statusLine = t('knowledgeLibrary.status.starting');
  else if (!status.enabled) statusLine = t('knowledgeLibrary.status.disabled');
  else if (status.backend.state !== 'running') statusLine = t('knowledgeLibrary.status.unavailable');
  else if (!provisioned) statusLine = t('knowledgeLibrary.panel.status.uninitialized');
  else if (activeCount > 0) statusLine = t('knowledgeLibrary.panel.status.runningIndexing', { count: activeCount });
  else statusLine = t('knowledgeLibrary.panel.status.runningReady', { ready: readyCount, total: documents.length });

  const errorText = error ? t(errorKeyOf(error), { code: error })
    : status?.backend.error ? t('knowledgeLibrary.status.failed', { code: status.backend.error }) : null;
  const failedCount = documents.filter((document) => document.state === 'failed').length;
  const statsLine = status?.stats
    ? t('knowledgeLibrary.panel.stats', {
        libraries: status.stats.libraries,
        indexable: status.stats.indexable,
        skipped: status.stats.skipped,
        failed: failedCount,
      })
    : null;

  return (
    <PauseClock paused={!visible}>
    <div className="flex h-full min-h-0 flex-col">
      <div
        role="tablist"
        aria-label={t('knowledgeLibrary.panel.tabs.label')}
        className="mx-2 mt-2 mb-1 flex items-center gap-1 rounded-lg bg-[var(--surface-muted)] p-1"
      >
        {LIBRARY_TABS.filter((entry) => entry.id !== 'experiences' || !runtime.isVSCode).map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            onClick={() => setTab(entry.id)}
            className={cn(
              'flex min-w-0 flex-1 items-center justify-center gap-1 rounded-md px-1 py-1 typography-meta transition-colors',
              tab === entry.id
                ? 'bg-[var(--card)] text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon name={entry.icon} className="size-3.5 shrink-0" />
            <span className="truncate">{t(entry.labelKey)}</span>
          </button>
        ))}
      </div>

      {tab === 'documents' ? (
      <div className="flex items-center gap-2 px-2 py-2">
        <div className="relative min-w-0 flex-1">
          <Icon name="search" className="pointer-events-none absolute inset-s-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            inputSize="compact"
            value={query}
            onChange={(event) => { searchAbort.current?.abort(); setQuery(event.target.value); }}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.repeat && !event.nativeEvent.isComposing) { event.preventDefault(); submitSearch(); } }}
            placeholder={t('knowledgeLibrary.panel.searchPlaceholder')}
            aria-label={t('knowledgeLibrary.panel.searchPlaceholder')}
            className="ps-7"
          />
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t('knowledgeLibrary.panel.addFolder')}
          title={t('knowledgeLibrary.panel.addFolder')}
          disabled={busy || unavailable || !provisioned}
          onClick={() => void addFolder()}
        >
          <Icon name="folder-add" className="size-4" />
        </Button>
      </div>
      ) : null}

      {tab !== 'experiences' ? <><div className="flex items-center gap-2 px-2 pb-2">
        {indexing ? (
          <Spinner className="size-3" aria-hidden />
        ) : (
          <span className={cn('size-1.5 shrink-0 rounded-full', statusDotClass(status, supported, provisioned))} aria-hidden />
        )}
        <span className="min-w-0 flex-1 truncate typography-meta text-muted-foreground" aria-live="polite">
          {statusLine}
        </span>
        {showRetry ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="!font-normal"
            disabled={busy}
            onClick={() => void run(reconnectKnowledgeLibrary)}
          >
            {t('knowledgeLibrary.panel.banner.retry')}
          </Button>
        ) : null}
        {showOpenSettings ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="!font-normal"
            onClick={() => {
              setSettingsPage('knowledge-library');
              setSettingsDialogOpen(true);
            }}
          >
            {t('knowledgeLibrary.panel.actions.openSettings')}
          </Button>
        ) : null}
      </div>

      {statsLine ? (
        <p className="px-2 pb-2 typography-meta text-muted-foreground">{statsLine}</p>
      ) : null}

      {errorText ? (
        <p className="px-2 pb-2 typography-meta text-muted-foreground" aria-live="polite">{errorText}</p>
      ) : null}

      {confirmDialog}
      </> : null}

      {tab === 'experiences' ? (
        <React.Suspense fallback={<p className="px-2 py-2 typography-meta text-muted-foreground">{t('conversationMemory.loading')}</p>}>
          <ConversationMemoryPanelSection visible={visible} />
        </React.Suspense>
      ) : tab === 'documents' ? (
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {loading ? (
          <p className="px-2 py-2 typography-meta text-muted-foreground">{t('knowledgeLibrary.panel.loading')}</p>
        ) : searching ? (
          <SearchResults results={results} failed={searchFailed} pending={error === 'knowledge_work_outcome_pending'} onOpen={openDocument} />
        ) : libraries.length === 0 ? (
          <div className="flex flex-col items-start gap-2 px-2 py-3">
            <p className="typography-ui-label">{t('knowledgeLibrary.panel.empty.title')}</p>
            <p className="typography-meta text-muted-foreground">{t('knowledgeLibrary.panel.empty.description')}</p>
            <p className="typography-meta text-[var(--status-warning-text)]">{t('knowledgeLibrary.panel.empty.costNotice')}</p>
            <Button type="button" size="xs" disabled={busy || unavailable || !provisioned} onClick={() => void addFolder()}>
              {t('knowledgeLibrary.panel.addFolder')}
            </Button>
          </div>
        ) : (
          libraries.map((library) => {
            const libraryDocuments = byLibrary.get(library.id) ?? [];
            const ready = libraryDocuments.filter((document) => document.state === 'ready').length;
            const isCollapsed = collapsed.has(library.id);
            return (
              <div key={library.id} className="mb-1">
                <div className="flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-[var(--interactive-hover)]">
                  <button
                    type="button"
                    onClick={() => toggleCollapsed(library.id)}
                    aria-expanded={!isCollapsed}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-start"
                  >
                    <Icon name={isCollapsed ? 'folder' : 'folder-open'} className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 truncate typography-ui-label">{library.name}</span>
                    <span className="shrink-0 typography-meta text-muted-foreground">
                      {t('knowledgeLibrary.panel.counts', { ready, total: libraryDocuments.length })}
                    </span>
                  </button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={library.enabled === false ? t('knowledgeLibrary.panel.actions.resume') : t('knowledgeLibrary.panel.actions.pause')}
                    title={library.enabled === false ? t('knowledgeLibrary.panel.actions.resume') : t('knowledgeLibrary.panel.actions.pause')}
                    disabled={busy}
                    onClick={() => void run(() => setKnowledgeLibraryWatching(library.id, library.enabled === false))}
                  >
                    <Icon name={library.enabled === false ? 'play' : 'pause'} className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t('knowledgeLibrary.panel.actions.rescan')}
                    title={t('knowledgeLibrary.panel.actions.rescan')}
                    disabled={busy}
                    onClick={() => void rescanLibrary(library.id)}
                  >
                    <Icon name="refresh" className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t('knowledgeLibrary.panel.actions.remove')}
                    title={t('knowledgeLibrary.panel.actions.remove')}
                    disabled={busy}
                    onClick={() => setPendingRemove(pendingRemove === library.id ? null : library.id)}
                  >
                    <Icon name="delete-bin" className="size-3.5" />
                  </Button>
                </div>

                {pendingRemove === library.id ? (
                  <div className="mx-1.5 mb-1 rounded-md bg-[var(--surface-muted)] px-2 py-1.5">
                    <p className="typography-meta text-muted-foreground">{t('knowledgeLibrary.panel.remove.confirm')}</p>
                    <div className="mt-1.5 flex items-center gap-2">
                      <Button
                        type="button"
                        variant="destructive"
                        size="xs"
                        disabled={busy}
                        onClick={() => void run(async () => {
                          await removeKnowledgeLibrary(library.id);
                          setPendingRemove(null);
                        })}
                      >
                        {t('knowledgeLibrary.panel.actions.remove')}
                      </Button>
                      <Button type="button" variant="ghost" size="xs" onClick={() => setPendingRemove(null)}>
                        {t('knowledgeLibrary.panel.remove.cancel')}
                      </Button>
                    </div>
                  </div>
                ) : null}

                {!isCollapsed ? (
                  libraryDocuments.length === 0 ? (
                    <p className="px-6 py-1 typography-meta text-muted-foreground">{t('knowledgeLibrary.panel.loading')}</p>
                  ) : (
                    libraryDocuments.map((document) => (
                      <div
                        key={document.id}
                        className="group flex w-full items-center gap-1 rounded-md py-1 ps-6 pe-1 hover:bg-[var(--interactive-hover)]"
                      >
                        <button
                          type="button"
                          onClick={() => openDocument(document.absPath)}
                          className="flex min-w-0 flex-1 items-center gap-2 text-start"
                          title={document.lastError?.message || t(stateKeyOf(document.state))}
                        >
                          <DocumentStateDot state={document.state} />
                          <span className="min-w-0 truncate typography-meta">{document.relPath.slice(document.relPath.lastIndexOf('/') + 1)}</span>
                          {folderOf(document.relPath) ? (
                            <span className="ms-auto min-w-0 truncate typography-meta text-muted-foreground">
                              {folderOf(document.relPath)}
                            </span>
                          ) : null}
                        </button>
                        <button
                          type="button"
                          aria-label={t('knowledgeLibrary.panel.document.remove')}
                          title={t('knowledgeLibrary.panel.document.remove')}
                          onClick={() => void removeDocument(document)}
                          className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-[var(--destructive)] focus-visible:opacity-100 group-hover:opacity-100"
                        >
                          <Icon name="delete-bin" className="size-3.5" />
                        </button>
                      </div>
                    ))
                  )
                ) : null}
              </div>
            );
          })
        )}
      </div>
      ) : tab === 'gallery' ? (
        <GalleryView active={tab === 'gallery'} onOpen={openDocument} />
      ) : tab === 'wiki' ? (
        <WikiView active={tab === 'wiki'} focusSlug={wikiFocus} onFocusConsumed={consumeWikiFocus} />
      ) : (
        <GraphView active={tab === 'graph'} onOpenPage={openWikiPage} />
      )}
    </div>
    </PauseClock>
  );
};

const SearchResults: React.FC<{
  results: KnowledgeLibrarySearchResult | null;
  failed: boolean;
  pending: boolean;
  onOpen: (path: string) => void;
}> = ({ results, failed, pending, onOpen }) => {
  const { t } = useI18n();
  const degraded = results?.availability?.state === 'degraded';
  const hasResults = Boolean(results && (results.documents.length > 0 || results.passages.length > 0));
  if (pending && !hasResults) return null;
  if (!results && !failed) {
    return <p className="px-2 py-2 typography-meta text-muted-foreground">{t('knowledgeLibrary.panel.loading')}</p>;
  }
  if (!hasResults && !failed && !degraded) {
    return <p className="px-2 py-2 typography-meta text-muted-foreground">{t('knowledgeLibrary.panel.results.empty')}</p>;
  }
  return (
    <div className="space-y-3 pb-2">
      {!pending && (failed || degraded) ? <p className="px-2 py-2 typography-meta text-[var(--status-warning-text)]" role="status">
        {t(failed ? hasResults ? 'knowledgeLibrary.panel.results.stale' : 'knowledgeLibrary.panel.results.failed' : 'knowledgeLibrary.panel.results.degraded')}
      </p> : null}
      {results && results.documents.length > 0 ? (
        <section>
          <h3 className="px-2 py-1 typography-meta font-medium text-muted-foreground">{t('knowledgeLibrary.panel.results.documents')}</h3>
          {results.documents.map((document) => (
            <button
              key={document.documentId}
              type="button"
              onClick={() => onOpen(document.path)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-start hover:bg-[var(--interactive-hover)]"
              title={document.path}
            >
              <Icon name="file" className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate typography-meta">{document.title}</span>
              <span className="ms-auto min-w-0 truncate typography-meta text-muted-foreground">{document.relPath}</span>
            </button>
          ))}
        </section>
      ) : null}

      {results && results.passages.length > 0 ? (
        <section>
          <h3 className="px-2 py-1 typography-meta font-medium text-muted-foreground">{t('knowledgeLibrary.panel.results.passages')}</h3>
          {results.passages.map((passage, index) => (
            <button
              key={`${passage.documentId}:${passage.chunkIndex}:${index}`}
              type="button"
              onClick={() => onOpen(passage.path)}
              className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-start hover:bg-[var(--interactive-hover)]"
              title={passage.path}
            >
              <span className="min-w-0 truncate typography-meta font-medium">{passage.title}</span>
              <span className="line-clamp-2 typography-meta text-muted-foreground">{passage.content}</span>
            </button>
          ))}
        </section>
      ) : null}
    </div>
  );
};

/**
 * 画廊: every image the backend extracted while parsing, with its caption.
 * Clicking a tile previews the image; only its source action opens a document.
 */
const GalleryView: React.FC<{
  active: boolean;
  onOpen: (path: string) => void;
}> = ({ active, onOpen }) => {
  const { t } = useI18n();
  const [gallery, setGallery] = React.useState<
    { status: 'loading' } | { status: 'ready'; images: KnowledgeLibraryImage[] } | { status: 'failed' }
  >({ status: 'loading' });
  const [selected, setSelected] = React.useState<KnowledgeLibraryImage | null>(null);
  const gridRef = React.useRef<HTMLDivElement>(null);
  const backRef = React.useRef<HTMLButtonElement>(null);
  const returnTarget = React.useRef<HTMLButtonElement | null>(null);
  const gridScroll = React.useRef(0);

  React.useLayoutEffect(() => {
    if (selected) {
      backRef.current?.focus({ preventScroll: true });
    } else if (returnTarget.current) {
      if (gridRef.current) gridRef.current.scrollTop = gridScroll.current;
      returnTarget.current.focus({ preventScroll: true });
    }
  }, [selected]);

  React.useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setGallery({ status: 'loading' });
    listKnowledgeImages(controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setGallery({ status: 'ready', images: next });
      })
      .catch(() => {
        if (!controller.signal.aborted) setGallery({ status: 'failed' });
      });
    return () => controller.abort();
  }, [active]);

  if (gallery.status === 'loading') {
    return <p className="px-2 py-2 typography-meta text-muted-foreground">{t('knowledgeLibrary.panel.loading')}</p>;
  }
  if (gallery.status === 'failed') {
    return <p className="px-2 py-2 typography-meta text-muted-foreground" role="alert">{t('knowledgeLibrary.panel.gallery.loadError')}</p>;
  }
  if (gallery.images.length === 0) {
    return <p className="px-2 py-2 typography-meta text-muted-foreground">{t('knowledgeLibrary.panel.gallery.empty')}</p>;
  }
  const source = selected?.source;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={gridRef} hidden={selected !== null} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <div className="grid grid-cols-2 gap-2">
          {gallery.images.map((image) => (
            <GalleryTile key={image.id} image={image} onOpen={(target) => {
              returnTarget.current = target;
              gridScroll.current = gridRef.current?.scrollTop ?? 0;
              setSelected(image);
            }} />
          ))}
        </div>
      </div>
      {selected ? (
        <section aria-label={t('knowledgeLibrary.panel.gallery.preview')} className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-2 px-2 pb-2">
            <Button ref={backRef} type="button" variant="ghost" size="sm" onClick={() => setSelected(null)}>
              <Icon name="arrow-left" className="size-3.5" />
              {t('knowledgeLibrary.panel.gallery.back')}
            </Button>
            <span className="min-w-0 flex-1 truncate typography-ui-label" dir="auto" title={selected.sourceName}>{selected.sourceName}</span>
          </div>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-2 pb-2">
            <GalleryPreviewImage image={selected} />
            <h3 className="typography-ui-label">{t('knowledgeLibrary.panel.gallery.summary')}</h3>
            <div className="break-words" dir="auto">
              {selected.caption.trim() ? (
                <React.Suspense fallback={<p className="whitespace-pre-wrap typography-meta">{selected.caption}</p>}>
                  <GallerySummary content={selected.caption} className="typography-meta" enableFileReferences={false} />
                </React.Suspense>
              ) : (
                <p className="typography-meta text-muted-foreground">{t('knowledgeLibrary.panel.gallery.noSummary')}</p>
              )}
            </div>
            <div className="min-w-0">
              <Button
                type="button"
                variant="link"
                size="sm"
                disabled={!source}
                title={source?.path}
                onClick={() => {
                  if (!source) return;
                  setSelected(null);
                  onOpen(source.path);
                }}
              >
                {t('knowledgeLibrary.panel.gallery.openSource')}
              </Button>
              <p className="truncate typography-meta text-muted-foreground" dir="auto" title={source?.relPath}>
                {source?.relPath ?? t('knowledgeLibrary.panel.gallery.sourceUnavailable')}
              </p>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
};

type KnowledgeImageState =
  | { url: string; status: 'loading' }
  | { url: string; status: 'ready'; src: string }
  | { url: string; status: 'failed' };

const useKnowledgeImage = (url: string): KnowledgeImageState => {
  const [state, setState] = React.useState<KnowledgeImageState>({ url, status: 'loading' });

  React.useEffect(() => {
    let objectUrl: string | null = null;
    const controller = new AbortController();
    setState({ url, status: 'loading' });
    loadKnowledgeImage(url, controller.signal)
      .then((loaded) => {
        if (controller.signal.aborted) {
          URL.revokeObjectURL(loaded);
          return;
        }
        objectUrl = loaded;
        setState({ url, status: 'ready', src: loaded });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ url, status: 'failed' });
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);

  return state.url === url ? state : { url, status: 'loading' };
};

const GalleryPreviewImage: React.FC<{ image: KnowledgeLibraryImage }> = ({ image }) => {
  const { t } = useI18n();
  const state = useKnowledgeImage(image.url);
  const [failedSrc, setFailedSrc] = React.useState<string | null>(null);
  const failed = state.status === 'failed' || (state.status === 'ready' && failedSrc === state.src);
  return (
    <div className="flex min-h-48 items-center justify-center overflow-hidden rounded-md bg-[var(--surface-muted)]">
      {state.status === 'ready' && !failed ? (
        <img
          src={state.src}
          alt={image.caption || image.sourceName}
          className="max-h-[65vh] w-full object-contain"
          onError={() => setFailedSrc(state.src)}
        />
      ) : (
        <p className="p-4 typography-meta text-muted-foreground" role={failed ? 'alert' : 'status'}>
          {t(failed ? 'knowledgeLibrary.panel.gallery.imageError' : 'knowledgeLibrary.panel.loading')}
        </p>
      )}
    </div>
  );
};

const GalleryTile: React.FC<{
  image: KnowledgeLibraryImage;
  onOpen: (target: HTMLButtonElement) => void;
}> = ({ image, onOpen }) => {
  const state = useKnowledgeImage(image.url);

  return (
    <button
      type="button"
      onClick={(event) => onOpen(event.currentTarget)}
      title={image.sourceName}
      className="flex flex-col overflow-hidden rounded-md border border-[var(--border)] bg-[var(--card)] text-start transition-colors hover:bg-[var(--interactive-hover)]"
    >
      <span className="flex aspect-square w-full items-center justify-center overflow-hidden bg-[var(--surface-muted)]">
        {state.status === 'ready' ? (
          <img src={state.src} alt={image.caption || image.sourceName} className="size-full object-cover" />
        ) : (
          <Icon name="image" className="size-5 text-muted-foreground" />
        )}
      </span>
      <span className="line-clamp-2 px-1.5 py-1 typography-meta text-muted-foreground">
        {image.caption || image.sourceName}
      </span>
    </button>
  );
};

/** Wiki: folder-filtered pages, each opening into its generated markdown. */
const WikiMarkdown: React.FC<{ content: string }> = ({ content }) => {
  // Wiki pages carry WeKnora's `[[slug|label]]` links and media embeds; show
  // their labels as plain text instead of raw brackets in the panel.
  const normalized = content
    .replace(/!\[\[[^\]]*\]\]/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1');
  return (
    <div className="space-y-1.5">
      {normalized.split('\n').map((line, index) => {
        const text = line.trim();
        if (!text) return <div key={index} className="h-1" />;
        if (text.startsWith('### ')) return <h4 key={index} className="typography-ui-label font-semibold">{text.slice(4)}</h4>;
        if (text.startsWith('## ')) return <h3 key={index} className="typography-ui-label font-semibold">{text.slice(3)}</h3>;
        if (text.startsWith('# ')) return <h2 key={index} className="typography-ui-label font-semibold">{text.slice(2)}</h2>;
        if (/^[-*] /.test(text)) return <p key={index} className="typography-meta ps-3">{`· ${text.slice(2)}`}</p>;
        return <p key={index} className="typography-meta">{text}</p>;
      })}
    </div>
  );
};

const WikiView: React.FC<{ active: boolean; focusSlug?: string | null; onFocusConsumed?: () => void }> = ({
  active,
  focusSlug,
  onFocusConsumed,
}) => {
  const { t } = useI18n();
  const [wiki, setWiki] = React.useState<KnowledgeLibraryWikiPages | null>(null);
  const [folders, setFolders] = React.useState<KnowledgeLibraryWikiFolders | null>(null);
  const [folder, setFolder] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [selected, setSelected] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setWiki(null);
    setSelected(null);
    Promise.all([readKnowledgeWikiPages(controller.signal), readKnowledgeWikiFolders(controller.signal)])
      .then(([pages, folderList]) => {
        if (controller.signal.aborted) return;
        setWiki(pages);
        setFolders(folderList);
      })
      .catch(() => {
        if (!controller.signal.aborted) setWiki({ enabled: false, pages: [], total: 0 });
      });
    return () => controller.abort();
  }, [active]);

  // A graph click hands us a page slug: open it after the reset above.
  React.useEffect(() => {
    if (!active || !focusSlug) return;
    setSelected(focusSlug);
    onFocusConsumed?.();
  }, [active, focusSlug, onFocusConsumed]);

  if (!wiki) {
    return <p className="px-2 py-2 typography-meta text-muted-foreground">{t('knowledgeLibrary.panel.loading')}</p>;
  }
  if (!wiki.enabled) {
    return <p className="px-2 py-2 typography-meta text-muted-foreground">{t('knowledgeLibrary.panel.wiki.disabled')}</p>;
  }
  if (wiki.pages.length === 0) {
    return <p className="px-2 py-2 typography-meta text-muted-foreground">{t('knowledgeLibrary.panel.wiki.empty')}</p>;
  }

  const page = selected ? wiki.pages.find((entry) => entry.slug === selected) : null;
  if (page) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center gap-1 ps-2 pe-3 pb-1">
          <Button type="button" variant="ghost" size="icon" aria-label={t('knowledgeLibrary.panel.wiki.back')} onClick={() => setSelected(null)}>
            <Icon name="arrow-left" className="size-3.5" />
          </Button>
          <span className="min-w-0 flex-1 truncate typography-ui-label">{page.title}</span>
          <span className="shrink-0 typography-meta text-muted-foreground">{page.pageType}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto ps-2 pe-3 pb-2">
          <WikiMarkdown content={page.content || page.summary || ''} />
        </div>
      </div>
    );
  }

  const normalized = query.trim().toLowerCase();
  const pages = wiki.pages.filter((entry) => {
    if (folder && entry.folderId !== folder) return false;
    if (!normalized) return true;
    return `${entry.title} ${entry.summary ?? ''}`.toLowerCase().includes(normalized);
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-2 pb-1">
        <div className="relative">
          <Icon name="search" className="pointer-events-none absolute inset-s-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            inputSize="compact"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('knowledgeLibrary.panel.wiki.search')}
            aria-label={t('knowledgeLibrary.panel.wiki.search')}
            className="ps-7"
          />
        </div>
      </div>
      {(folders?.folders.length ?? 0) > 0 ? (
        <div className="flex gap-1 overflow-x-auto px-2 pb-1">
          <button
            type="button"
            onClick={() => setFolder('')}
            className={cn(
              'shrink-0 rounded-full border px-2 py-0.5 typography-meta',
              folder === '' ? 'border-[var(--primary)] text-foreground' : 'border-[var(--border)] text-muted-foreground',
            )}
          >
            {t('knowledgeLibrary.panel.wiki.all')} · {wiki.total}
          </button>
          {(folders?.folders ?? []).map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setFolder(entry.id)}
              className={cn(
                'shrink-0 rounded-full border px-2 py-0.5 typography-meta',
                folder === entry.id ? 'border-[var(--primary)] text-foreground' : 'border-[var(--border)] text-muted-foreground',
              )}
            >
              {entry.name} · {entry.pageCount}
            </button>
          ))}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pe-3 pb-2">
        {pages.length === 0 ? (
          <p className="px-2 py-2 typography-meta text-muted-foreground">{t('knowledgeLibrary.panel.wiki.empty')}</p>
        ) : (
          pages.map((entry) => (
            <button
              key={entry.slug}
              type="button"
              onClick={() => setSelected(entry.slug)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-start hover:bg-[var(--interactive-hover)]"
            >
              <Icon name="book-open" className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate typography-meta">{entry.title}</span>
              <span className="min-w-0 max-w-[5.5rem] shrink-0 truncate text-end typography-meta text-muted-foreground">{folder ? entry.pageType : (entry.categoryPath?.[0] ?? entry.pageType)}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
};

/**
 * 图谱: an Obsidian-style force graph on a canvas.
 *
 * Obsidian's graph reads as a calm field of small dots with faint edges and
 * labels that appear as you zoom; the layout settles instead of drifting. The
 * geometry still comes from WeKnora's own layout module, but the drawing,
 * hover dimming, node dragging and zoom follow Obsidian's visual language.
 */
type GraphPalette = {
  background: string;
  foreground: string;
  edge: string;
  edgeActive: string;
  nodes: Map<string, string>;
};

const GRAPH_NODE_COLORS = new Map<string, string>([
  ['summary', '#6f8cff'],
  ['entity', '#63b37b'],
  ['concept', '#e0a458'],
  ['synthesis', '#56b6c2'],
  ['comparison', '#d47a7a'],
  ['index', '#8c8c8c'],
]);

const readPalette = (): GraphPalette => {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    background: read('--background', '#ffffff'),
    foreground: read('--foreground', '#1f2328'),
    edge: 'rgba(140, 150, 165, 0.26)',
    edgeActive: 'rgba(110, 130, 170, 0.85)',
    nodes: GRAPH_NODE_COLORS,
  };
};

const graphDotRadius = (linkCount: number) => Math.max(2.5, Math.min(9, 2.4 + Math.sqrt(linkCount) * 1.3));

const driftSeed = (slug: string) => {
  let hash = 0;
  for (let index = 0; index < slug.length; index += 1) hash = (hash * 31 + slug.charCodeAt(index)) >>> 0;
  return hash;
};

const GraphCanvas: React.FC<{
  graph: KnowledgeLibraryWikiGraph;
  maxNodes?: number;
  onOpenPage?: (slug: string) => void;
}> = ({ graph, maxNodes, onOpenPage }) => {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = React.useState({ width: 320, height: 360 });
  const [hovered, setHovered] = React.useState<string | null>(null);
  const [palette] = React.useState<GraphPalette>(() => readPalette());
  const viewport = React.useRef({ scale: 0.4, x: 0, y: 0 });
  const drag = React.useRef<
    | { kind: 'pan'; startX: number; startY: number; viewX: number; viewY: number }
    | { kind: 'node'; slug: string; node: ForceNode }
    | null
  >(null);
  const drawRef = React.useRef<() => void>(() => {});
  const emphasis = React.useRef(new Map<string, number>());
  const emphasisFrame = React.useRef(0);
  const press = React.useRef<{ x: number; y: number } | null>(null);
  const labelHits = React.useRef<Array<{ slug: string; left: number; right: number; top: number; bottom: number }>>([]);
  const reduceMotion = React.useMemo(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );

  // A slow per-node sway keeps the settled field alive while staying close to
  // the force layout: amplitude is a couple of screen pixels, period ~12s.
  const drift = React.useCallback(
    (slug: string, time: number) => {
      if (reduceMotion) return { dx: 0, dy: 0 };
      const seed = driftSeed(slug);
      const speed = 0.00035 + (seed % 41) * 0.000009;
      const phase = (seed % 360) * (Math.PI / 180);
      const amplitude = 2.2 + (seed % 5) * 0.4;
      return {
        dx: Math.sin(time * speed + phase) * amplitude,
        dy: Math.cos(time * speed * 0.82 + phase * 1.6) * amplitude * 0.85,
      };
    },
    [reduceMotion],
  );
  const screenPoint = React.useCallback(
    (node: ForceNode, time: number) => {
      const { scale, x, y } = viewport.current;
      const offset = drift(node.slug, time);
      return { x: node.x * scale + x + offset.dx, y: node.y * scale + y + offset.dy };
    },
    [drift],
  );
  const view = React.useMemo(() => {
    if (!maxNodes || graph.nodes.length <= maxNodes) return graph;
    const nodes = [...graph.nodes]
      .sort((left, right) => (right.link_count ?? 0) - (left.link_count ?? 0))
      .slice(0, maxNodes);
    const keep = new Set(nodes.map((node) => node.slug));
    return { ...graph, nodes, edges: graph.edges.filter((edge) => keep.has(edge.source) && keep.has(edge.target)) };
  }, [graph, maxNodes]);

  const layout = React.useMemo(() => {
    const inputs = view.nodes.map((node) => ({
      slug: node.slug,
      link_count: node.link_count ?? 0,
      page_type: node.page_type,
      title: node.title,
    }));
    const worldWidth = Math.max(1200, Math.sqrt(inputs.length) * 150);
    const worldHeight = Math.max(900, Math.sqrt(inputs.length) * 115);
    const built = buildGraphLayout(inputs, view.edges, worldWidth, worldHeight);
    const bySlug = new Map(inputs.map((node) => [node.slug, node]));
    const nodes: ForceNode[] = [];
    for (const [slug, placement] of built.placements) {
      nodes.push({
        slug,
        // Start slightly scattered around each community centre so the layout
        // settles into place instead of appearing fully formed.
        x: placement.x + (Math.random() - 0.5) * 90,
        y: placement.y + (Math.random() - 0.5) * 90,
        vx: 0,
        vy: 0,
        linkCount: bySlug.get(slug)?.link_count ?? 0,
        pinned: Boolean(placement.stationary),
      });
    }
    const adjacency = new Map<string, Set<string>>();
    for (const edge of view.edges) {
      (adjacency.get(edge.source) ?? adjacency.set(edge.source, new Set()).get(edge.source)!).add(edge.target);
      (adjacency.get(edge.target) ?? adjacency.set(edge.target, new Set()).get(edge.target)!).add(edge.source);
    }
    return { nodes, bySlug, adjacency, edges: view.edges, placements: built.placements };
  }, [view]);

  React.useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const update = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      if (width > 0 && height > 0) setSize({ width, height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    if (!layout.nodes.length) return;
    const bounds = layout.nodes.reduce(
      (acc, node) => ({
        left: Math.min(acc.left, node.x),
        right: Math.max(acc.right, node.x),
        top: Math.min(acc.top, node.y),
        bottom: Math.max(acc.bottom, node.y),
      }),
      { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity },
    );
    const fit = Math.min(
      (size.width - 60) / Math.max(100, bounds.right - bounds.left),
      (size.height - 80) / Math.max(100, bounds.bottom - bounds.top),
    );
    const scale = Math.max(0.12, Math.min(0.9, fit));
    viewport.current = {
      scale,
      x: size.width / 2 - ((bounds.left + bounds.right) / 2) * scale,
      y: size.height / 2 - ((bounds.top + bounds.bottom) / 2) * scale,
    };
  }, [layout, size.width, size.height]);

  React.useEffect(() => {
    if (!layout.nodes.length) return;
    let frame = 0;
    const total = 110;
    let raf = requestAnimationFrame(function tick() {
      stepGraphLayout(layout.nodes, layout.edges, layout.placements, Math.max(0.02, 1 - frame / total));
      drawRef.current();
      frame += 1;
      if (frame < total) raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  }, [layout]);

  const draw = React.useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = size.width;
    const height = size.height;
    if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
    }
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);

    const time = performance.now();
    const { scale } = viewport.current;
    const nodeBySlug = new Map(layout.nodes.map((node) => [node.slug, node]));
    const hoveredNeighbors = hovered ? layout.adjacency.get(hovered) ?? new Set<string>() : null;
    const emphasisOf = (slug: string) => emphasis.current.get(slug) ?? 0;

    // Edges: faint by default; edges around the hovered node light up.
    for (const edge of layout.edges) {
      const from = nodeBySlug.get(edge.source);
      const to = nodeBySlug.get(edge.target);
      if (!from || !to) continue;
      const a = screenPoint(from, time);
      const b = screenPoint(to, time);
      const active = hovered ? Math.min(emphasisOf(edge.source), emphasisOf(edge.target)) : 0;
      context.strokeStyle = active > 0.05 ? palette.edgeActive : palette.edge;
      context.lineWidth = 0.7 + active * 0.9;
      context.globalAlpha = hovered ? 0.12 + 0.88 * active : 1;
      context.beginPath();
      context.moveTo(a.x, a.y);
      context.lineTo(b.x, b.y);
      context.stroke();
    }
    context.globalAlpha = 1;

    // Nodes: small dots, slightly larger for hubs, dimmed when not related.
    const radiusOf = (node: ForceNode) => graphDotRadius(node.linkCount);
    for (const node of layout.nodes) {
      const point = screenPoint(node, time);
      const datum = layout.bySlug.get(node.slug);
      const weight = hovered ? emphasisOf(node.slug) : 0;
      const radius = radiusOf(node) * (node.slug === hovered ? 1 + 0.4 * weight : 1 + 0.16 * weight);
      context.globalAlpha = hovered ? 0.16 + 0.84 * weight : 1;
      context.beginPath();
      context.arc(point.x, point.y, radius, 0, Math.PI * 2);
      context.fillStyle = palette.nodes.get(datum?.page_type ?? '') ?? palette.nodes.get('index') ?? '#8c8c8c';
      context.fill();
      context.lineWidth = 1;
      context.strokeStyle = palette.background;
      context.stroke();
    }
    context.globalAlpha = 1;

    // Labels: only where they fit. Hovered/neighbors always get one.
    const placed: Array<{ left: number; right: number; top: number; bottom: number }> = [];
    labelHits.current = [];
    const ranked = [...layout.nodes].sort((left, right) => right.linkCount - left.linkCount);
    const candidates = ranked.filter(
      (node, index) =>
        index < 6 || scale >= 0.5 || node.slug === hovered || Boolean(hoveredNeighbors?.has(node.slug)),
    );
    context.textAlign = 'center';
    context.textBaseline = 'top';
    for (const node of candidates.slice(0, 60)) {
      const point = screenPoint(node, time);
      const weight = hovered ? emphasisOf(node.slug) : 0;
      const radius = radiusOf(node) * (node.slug === hovered ? 1 + 0.4 * weight : 1 + 0.16 * weight);
      const isHovered = node.slug === hovered;
      const rawTitle = layout.bySlug.get(node.slug)?.title ?? node.slug;
      const title = isHovered ? rawTitle.slice(0, 24) : graphLandmarkTitle(rawTitle).slice(0, 14);
      context.font = `${isHovered ? '600 12px' : '11px'} -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
      const textWidth = context.measureText(title).width;
      const box = {
        left: point.x - textWidth / 2 - 2,
        right: point.x + textWidth / 2 + 2,
        top: point.y + radius + 2,
        bottom: point.y + radius + 16,
      };
      const required = isHovered || hoveredNeighbors?.has(node.slug);
      if (!required && placed.some((other) => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top)) {
        continue;
      }
      placed.push(box);
      labelHits.current.push({ slug: node.slug, ...box });
      context.globalAlpha = hovered ? Math.max(0.18, weight) : required ? 1 : 0.78;
      context.lineWidth = 3;
      context.strokeStyle = palette.background;
      context.strokeText(title, point.x, point.y + radius + 3);
      context.fillStyle = palette.foreground;
      context.fillText(title, point.x, point.y + radius + 3);
    }
    context.globalAlpha = 1;
  }, [hovered, layout, palette, screenPoint, size.width, size.height]);

  React.useEffect(() => {
    draw();
  }, [draw]);
  drawRef.current = draw;

  // Obsidian eases the highlight in and out instead of snapping: each node
  // keeps an emphasis value that chases its target every frame.
  React.useEffect(() => {
    const targets = new Map<string, number>();
    if (hovered) {
      targets.set(hovered, 1);
      for (const neighbour of layout.adjacency.get(hovered) ?? []) targets.set(neighbour, 1);
    }
    cancelAnimationFrame(emphasisFrame.current);
    let raf = 0;
    const tick = () => {
      let moving = false;
      for (const node of layout.nodes) {
        const target = targets.get(node.slug) ?? 0;
        const current = emphasis.current.get(node.slug) ?? 0;
        const next = current + (target - current) * 0.24;
        if (Math.abs(target - next) < 0.008) {
          if (current !== target) moving = true;
          emphasis.current.set(node.slug, target);
        } else {
          emphasis.current.set(node.slug, next);
          moving = true;
        }
      }
      drawRef.current();
      if (moving) raf = requestAnimationFrame(tick);
      emphasisFrame.current = raf;
    };
    raf = requestAnimationFrame(tick);
    emphasisFrame.current = raf;
    return () => cancelAnimationFrame(raf);
  }, [hovered, layout]);

  // Redraw a few times a second so the drift is visible; pause when hidden.
  React.useEffect(() => {
    if (reduceMotion) return;
    let raf = 0;
    let last = 0;
    const loop = (now: number) => {
      if (!document.hidden && now - last > 33) {
        drawRef.current();
        last = now;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [reduceMotion]);

  const hitTest = (clientX: number, clientY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const screenX = clientX - rect.left;
    const screenY = clientY - rect.top;
    const time = performance.now();
    let best: ForceNode | null = null;
    let bestDistance = Infinity;
    for (const node of layout.nodes) {
      const point = screenPoint(node, time);
      const distance = Math.hypot(point.x - screenX, point.y - screenY);
      const radius = graphDotRadius(node.linkCount) + 12;
      if (distance < radius && distance < bestDistance) {
        best = node;
        bestDistance = distance;
      }
    }
    if (best) return best;
    // Labels are part of the target: clicking the title opens the page too.
    for (const box of labelHits.current) {
      if (screenX >= box.left && screenX <= box.right && screenY >= box.top && screenY <= box.bottom) {
        const node = layout.nodes.find((entry) => entry.slug === box.slug);
        if (node) return node;
      }
    }
    return null;
  };

  React.useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const zoomAt = (clientX: number, clientY: number, factor: number) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      const current = viewport.current;
      const scale = Math.min(4, Math.max(0.08, current.scale * factor));
      const ratio = scale / current.scale;
      viewport.current = { scale, x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio };
      draw();
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      zoomAt(event.clientX, event.clientY, event.deltaY < 0 ? 1.12 : 0.89);
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [draw]);

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden" style={{ touchAction: 'none' }}>
      <canvas
        ref={canvasRef}
        style={{ width: size.width, height: size.height }}
        className="block cursor-grab active:cursor-grabbing"
        onPointerDown={(event) => {
          const node = hitTest(event.clientX, event.clientY);
          press.current = { x: event.clientX, y: event.clientY };
          if (node) {
            node.pinned = true;
            drag.current = { kind: 'node', slug: node.slug, node };
          } else {
            drag.current = {
              kind: 'pan',
              startX: event.clientX,
              startY: event.clientY,
              viewX: viewport.current.x,
              viewY: viewport.current.y,
            };
          }
          if (event.target instanceof Element) event.target.setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={(event) => {
          const pointer = drag.current;
          if (!pointer) {
            const node = hitTest(event.clientX, event.clientY);
            const slug = node?.slug ?? null;
            if (canvasRef.current) canvasRef.current.style.cursor = slug ? 'pointer' : 'grab';
            setHovered((current) => (current === slug ? current : slug));
            return;
          }
          if (pointer.kind === 'pan') {
            viewport.current = {
              ...viewport.current,
              x: pointer.viewX + (event.clientX - pointer.startX),
              y: pointer.viewY + (event.clientY - pointer.startY),
            };
            draw();
            return;
          }
          const rect = canvasRef.current?.getBoundingClientRect();
          if (!rect) return;
          const { scale, x, y } = viewport.current;
          pointer.node.x = (event.clientX - rect.left - x) / scale;
          pointer.node.y = (event.clientY - rect.top - y) / scale;
          // Reheat around the dragged node so neighbours ease out of the way.
          stepGraphLayout(layout.nodes, layout.edges, new Map(), 0.35);
          pointer.node.x = (event.clientX - rect.left - x) / scale;
          pointer.node.y = (event.clientY - rect.top - y) / scale;
          draw();
        }}
        onPointerUp={(event) => {
          if (drag.current?.kind === 'node') drag.current.node.pinned = false;
          drag.current = null;
          const pressed = press.current;
          press.current = null;
          // A press that did not move is a click: open whatever node is under
          // the pointer, as Obsidian does.
          if (pressed && Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) < 10) {
            const target = hitTest(event.clientX, event.clientY);
            if (target) onOpenPage?.(target.slug);
          }
        }}
        onPointerLeave={() => {
          if (drag.current?.kind === 'node') drag.current.node.pinned = false;
          drag.current = null;
          press.current = null;
          setHovered(null);
        }}
        onDoubleClick={() => {
          // Double-click fits the graph, as in Obsidian.
          if (!layout.nodes.length) return;
          const bounds = layout.nodes.reduce(
            (acc, node) => ({
              left: Math.min(acc.left, node.x),
              right: Math.max(acc.right, node.x),
              top: Math.min(acc.top, node.y),
              bottom: Math.max(acc.bottom, node.y),
            }),
            { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity },
          );
          const fit = Math.min(
            (size.width - 60) / Math.max(100, bounds.right - bounds.left),
            (size.height - 80) / Math.max(100, bounds.bottom - bounds.top),
          );
          const scale = Math.max(0.12, Math.min(0.9, fit));
          viewport.current = {
            scale,
            x: size.width / 2 - ((bounds.left + bounds.right) / 2) * scale,
            y: size.height / 2 - ((bounds.top + bounds.bottom) / 2) * scale,
          };
          draw();
        }}
      />
      <div className="pointer-events-none absolute bottom-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 typography-meta text-muted-foreground" style={{ insetInlineStart: '0.5rem' }}>
        {[...new Set(view.nodes.map((node) => node.page_type).filter((type): type is string => Boolean(type)))]
          .slice(0, 6)
          .map((type) => (
            <span key={type} className="flex items-center gap-1">
              <span className="size-1.5 rounded-full" style={{ background: palette.nodes.get(type) ?? palette.nodes.get('index') ?? '#8c8c8c' }} />
              {type}
            </span>
          ))}
      </div>
    </div>
  );
};

const GraphView: React.FC<{ active: boolean; onOpenPage?: (slug: string) => void }> = ({ active, onOpenPage }) => {
  const { t } = useI18n();
  const [graph, setGraph] = React.useState<KnowledgeLibraryWikiGraph | null>(null);
  const [expanded, setExpanded] = React.useState(false);

  React.useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setGraph(null);
    readKnowledgeWikiGraph(controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setGraph(next);
      })
      .catch(() => {
        if (!controller.signal.aborted) setGraph({ enabled: false, nodes: [], edges: [] });
      });
    return () => controller.abort();
  }, [active]);

  if (!graph) {
    return <p className="px-2 py-2 typography-meta text-muted-foreground">{t('knowledgeLibrary.panel.loading')}</p>;
  }
  if (!graph.enabled) {
    return <p className="px-2 py-2 typography-meta text-muted-foreground">{t('knowledgeLibrary.panel.graph.disabled')}</p>;
  }
  if (graph.nodes.length === 0) {
    return <p className="px-2 py-2 typography-meta text-muted-foreground">{t('knowledgeLibrary.panel.graph.empty')}</p>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-2 pb-1">
        <span className="min-w-0 truncate typography-meta text-muted-foreground">
          {t('knowledgeLibrary.panel.graph.counts', { pages: graph.nodes.length, links: graph.edges.length })}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="ms-auto"
          aria-label={t('knowledgeLibrary.panel.graph.expand')}
          title={t('knowledgeLibrary.panel.graph.expand')}
          onClick={() => setExpanded(true)}
        >
          <Icon name="fullscreen" className="size-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <GraphCanvas graph={graph} maxNodes={160} onOpenPage={onOpenPage} />
      </div>
      {expanded
        ? createPortal(
            <div className="fixed inset-0 z-[120] flex flex-col bg-[var(--background)] p-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="typography-ui-label">{t('knowledgeLibrary.panel.tabs.graph')}</span>
                <span className="typography-meta text-muted-foreground">
                  {t('knowledgeLibrary.panel.graph.counts', { pages: graph.nodes.length, links: graph.edges.length })}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="ms-auto"
                  aria-label={t('knowledgeLibrary.panel.graph.collapse')}
                  onClick={() => setExpanded(false)}
                >
                  <Icon name="close" className="size-4" />
                </Button>
              </div>
              <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-[var(--border)]">
                <GraphCanvas
                  graph={graph}
                  onOpenPage={(slug) => {
                    setExpanded(false);
                    onOpenPage?.(slug);
                  }}
                />
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
};
