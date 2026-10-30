import React from 'react';
import { z } from 'zod';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  SETTINGS_HELPER_CLASS,
  SettingsCheckboxRow,
  SettingsControlGroup,
  SettingsFieldRow,
  SettingsSection,
  SettingsStackedField,
} from '@/components/sections/shared/SettingsSection';
import { useIsVSCodeRuntime } from '@/hooks/useRuntimeAPIs';
import { useDirectoryStore, isDirectoryUnknown } from '@/stores/useDirectoryStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import {
  captureConversationMemory,
  confirmConversationMemoryEntry,
  consolidateConversationMemory,
  ConversationMemoryError,
  forgetConversationMemoryEntry,
  listConversationMemoryEntries,
  readConversationMemoryStatus,
  retryConversationMemoryEntry,
  updateConversationMemorySettings,
  type ConversationMemoryEntry,
  type ConversationMemoryStatus,
} from '@/lib/conversationMemory';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { reportSettingsSaveState } from '@/lib/persistence';
import { openSessionLink } from '@/lib/router/openSessionFromRoute';
import { subscribeRuntimeEndpointChanged, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';

interface ConversationMemorySectionProps {
  directory: string | null;
  sessionId: string | null;
  captureDirectory?: string | null;
  visible?: boolean;
  settings?: boolean;
  divider?: boolean;
}

type Notice = 'captureQueued' | 'captureUnchanged' | 'retryQueued' | 'retryUnchanged' | 'forgotten' | 'methodologyQueued';
const errorCodeSchema = z.instanceof(ConversationMemoryError).transform((error) => error.code).catch('request_failed');
const statusKeys = {
  off: 'conversationMemory.state.off', ready: 'conversationMemory.state.ready',
  processing: 'conversationMemory.state.processing', unavailable: 'conversationMemory.state.unavailable',
} satisfies Record<ConversationMemoryStatus['state'], I18nKey>;
const engineStateKeys = {
  stopped: 'conversationMemory.engine.stopped', starting: 'conversationMemory.engine.starting',
  ready: 'conversationMemory.state.ready', unavailable: 'conversationMemory.state.unavailable',
} satisfies Record<NonNullable<ConversationMemoryStatus['engine']>['state'], I18nKey>;
const errorKeyOf = (code: string): I18nKey => {
  if (code === 'managed_derivation_scope_unavailable') return 'conversationMemory.error.projectScope';
  if (code === 'hy_runtime_not_installed') return 'conversationMemory.error.engineMissing';
  if (code === 'hy_worker_exited') return 'conversationMemory.error.engineStopped';
  if (code.startsWith('embedding')) return 'conversationMemory.error.embedding';
  if (code === 'source_changed' || code === 'conversation_memory_source_changed' || code === 'hy_source_invalid') return 'conversationMemory.error.sourceChanged';
  return 'conversationMemory.error';
};
const kindKeys = {
  segment: 'conversationMemory.kind.segment', experience: 'conversationMemory.kind.experience', methodology: 'conversationMemory.kind.methodology',
} satisfies Record<ConversationMemoryEntry['kind'], I18nKey>;
const entryKeys = {
  candidate: 'conversationMemory.entry.candidate', active: 'conversationMemory.entry.active', superseded: 'conversationMemory.entry.superseded', forgotten: 'conversationMemory.forgotten',
} satisfies Record<ConversationMemoryEntry['status'], I18nKey>;
const indexKeys = {
  pending: 'conversationMemory.index.pending', ready: 'conversationMemory.index.ready', failed: 'conversationMemory.index.failed',
} satisfies Record<ConversationMemoryEntry['indexState'], I18nKey>;
const noticeKeys = {
  captureQueued: 'conversationMemory.captureQueued', captureUnchanged: 'conversationMemory.captureUnchanged',
  retryQueued: 'conversationMemory.retryQueued', retryUnchanged: 'conversationMemory.retryUnchanged', forgotten: 'conversationMemory.forgotten', methodologyQueued: 'conversationMemory.methodologyQueued',
} satisfies Record<Notice, I18nKey>;

export const ConversationMemoryPanelSection: React.FC<{ visible?: boolean }> = ({ visible }) => {
  const sessionId = useSessionUIStore((state) => state.currentSessionId);
  const sessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const isHomeReady = useDirectoryStore((state) => state.isHomeReady);
  const directory = sessionDirectory || (isDirectoryUnknown({ currentDirectory, isHomeReady }) ? null : currentDirectory);
  return <ConversationMemorySection directory={directory} sessionId={sessionId} visible={visible} />;
};

/** A runtime or project switch discards pending reads, mutations and local selection. */
export const ConversationMemorySection: React.FC<ConversationMemorySectionProps> = (props) => {
  const isVSCode = useIsVSCodeRuntime();
  const [runtimeEpoch, setRuntimeEpoch] = React.useState(0);
  React.useEffect(() => subscribeRuntimeEndpointChanged(() => setRuntimeEpoch((epoch) => epoch + 1)), []);
  if (isVSCode) return null;
  return <ConversationMemoryContent key={`${runtimeEpoch}:${props.directory ?? ''}:${props.sessionId ?? ''}:${props.captureDirectory ?? ''}`} {...props} />;
};

const ConversationMemoryContent: React.FC<ConversationMemorySectionProps> = ({ directory, sessionId, captureDirectory = directory, visible = true, settings = false, divider = true }) => {
  const { t } = useI18n();
  const { confirm, dialog } = useConfirmDialog();
  const [status, setStatus] = React.useState<ConversationMemoryStatus | null>(null);
  const [entries, setEntries] = React.useState<ConversationMemoryEntry[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<Notice | null>(null);
  const [query, setQuery] = React.useState('');
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const lifecycle = React.useRef<AbortController | null>(null);
  const revision = React.useRef(0);
  const mutating = React.useRef(false);
  const pendingSetting = React.useRef<AbortController | null>(null);

  const load = React.useCallback(async (signal: AbortSignal) => {
    if (signal.aborted || mutating.current) return;
    const readRevision = ++revision.current;
    const [nextStatus, nextEntries] = await Promise.allSettled([
      readConversationMemoryStatus(signal),
      directory ? listConversationMemoryEntries({ directory, query, signal }) : Promise.resolve([]),
    ]);
    if (signal.aborted || readRevision !== revision.current) return;
    if (nextStatus.status === 'fulfilled') setStatus(nextStatus.value);
    if (nextEntries.status === 'fulfilled') setEntries(nextEntries.value);
    setError(nextStatus.status === 'rejected' ? errorCodeSchema.parse(nextStatus.reason)
      : nextEntries.status === 'rejected' ? errorCodeSchema.parse(nextEntries.reason) : null);
    setLoaded(true);
  }, [directory, query]);

  React.useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    lifecycle.current = controller;
    mutating.current = false;
    setBusy(false);
    const unsubscribe = subscribeRuntimeEndpointWillChange(() => controller.abort());
    return () => {
      controller.abort();
      if (pendingSetting.current === controller) {
        pendingSetting.current = null;
        reportSettingsSaveState('saved');
      }
      lifecycle.current = null;
      unsubscribe();
    };
  }, [visible]);

  React.useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    const abort = () => controller.abort();
    const owner = lifecycle.current;
    owner?.signal.addEventListener('abort', abort, { once: true });
    const timer = query.trim() ? setTimeout(() => void load(controller.signal), 250) : undefined;
    if (!query.trim()) void load(controller.signal);
    return () => {
      controller.abort();
      clearTimeout(timer);
      owner?.signal.removeEventListener('abort', abort);
    };
  }, [load, query, visible]);

  // A semantic search runs only on a user's query or refresh. Polling a job
  // reads its cheap status and refreshes the list once work settles.
  React.useEffect(() => {
    if (!visible || busy || !status || status.state !== 'processing' && status.pending === 0) return;
    const controller = lifecycle.current;
    if (!controller) return;
    const pollRevision = revision.current;
    const timer = setTimeout(() => {
      void readConversationMemoryStatus(controller.signal).then((next) => {
        if (controller.signal.aborted || revision.current !== pollRevision) return;
        setStatus(next);
        if (next.state !== 'processing' && next.pending === 0) void load(controller.signal);
      }).catch((pollError) => {
        if (!controller.signal.aborted) setError(errorCodeSchema.parse(pollError));
      });
    }, 2_000);
    return () => clearTimeout(timer);
  }, [busy, load, status, visible]);

  const run = async (work: (signal: AbortSignal) => Promise<void>, setting = false) => {
    const controller = lifecycle.current;
    if (!controller || controller.signal.aborted || mutating.current) return;
    mutating.current = true;
    ++revision.current;
    setBusy(true);
    setError(null);
    setNotice(null);
    if (setting) {
      pendingSetting.current = controller;
      reportSettingsSaveState('saving');
    }
    try {
      await work(controller.signal);
      if (controller.signal.aborted) return;
      if (setting) {
        pendingSetting.current = null;
        reportSettingsSaveState('saved');
      }
      mutating.current = false;
      await load(controller.signal);
    } catch (actionError) {
      if (controller.signal.aborted) return;
      setError(errorCodeSchema.parse(actionError));
      if (setting) {
        pendingSetting.current = null;
        reportSettingsSaveState('error');
      }
    } finally {
      if (controller === lifecycle.current) {
        mutating.current = false;
        if (!controller.signal.aborted) setBusy(false);
      }
    }
  };

  const forget = async (entry: ConversationMemoryEntry) => {
    const controller = lifecycle.current;
    const accepted = await confirm({
      title: t('conversationMemory.forgetTitle'), message: t('conversationMemory.forgetDescription'),
      action: t('conversationMemory.forgetConfirm'), destructive: true,
    });
    if (!accepted || controller?.signal.aborted || controller !== lifecycle.current || !directory) return;
    await run(async (signal) => {
      const result = await forgetConversationMemoryEntry({ id: entry.id, directory, signal });
      if (signal.aborted) return;
      setEntries((current) => current.flatMap((item) => item.id !== entry.id ? [item]
        : result.pendingCleanup ? [{ ...item, status: 'forgotten', indexState: 'pending' }] : []));
      setExpanded(null);
      setNotice('forgotten');
    });
  };

  const statusText = status ? t(statusKeys[status.state]) : t(loaded ? 'conversationMemory.state.unavailable' : 'conversationMemory.loading');
  const engineText = status?.engine ? status.engine.version
    ? t('conversationMemory.engine.withVersion', { name: status.engine.name, version: status.engine.version, state: t(engineStateKeys[status.engine.state]) })
    : t('conversationMemory.engine.status', { name: status.engine.name, state: t(engineStateKeys[status.engine.state]) }) : '';
  const failure = error ?? status?.engine?.error ?? status?.lastError;
  const feedback = failure ? t(errorKeyOf(failure), { code: failure })
    : notice ? t(noticeKeys[notice]) : '';
  const counts = status ? status.candidates !== undefined && status.blocked !== undefined
    ? t('conversationMemory.diagnosticCounts', { entries: status.entries, candidates: status.candidates, pending: status.pending, blocked: status.blocked, failed: status.failed, unknown: status.unknown })
    : t('conversationMemory.counts', { entries: status.entries, pending: status.pending, failed: status.failed, unknown: status.unknown }) : '';
  const normalEntries = entries.filter((entry) => entry.status !== 'forgotten');
  const cleanups = entries.filter((entry) => entry.status === 'forgotten');
  const supportingExperiences: ConversationMemoryEntry[] = [];
  const supportSessions = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== 'experience' || entry.status !== 'active' || supportSessions.has(entry.sessionId)) continue;
    supportSessions.add(entry.sessionId);
    supportingExperiences.push(entry);
    if (supportingExperiences.length === 10) break;
  }
  const canProposeMethodology = supportingExperiences.length >= 2;

  const content = <div className="space-y-3">
    <SettingsCheckboxRow
      settingsItem="knowledge-library.conversation-memory-enabled"
      checked={status?.enabled ?? false}
      disabled={!status || busy}
      onChange={(enabled) => void run(async (signal) => {
        const next = await updateConversationMemorySettings(enabled, signal);
        if (!signal.aborted) setStatus(next);
      }, true)}
      label={t('conversationMemory.enabled')}
      ariaLabel={t('conversationMemory.enabled')}
      info={t('conversationMemory.info')}
    />
    <div className="flex min-h-7 items-center gap-2">
      {status?.state === 'processing' ? <Spinner className="size-3 shrink-0" aria-hidden /> : null}
      <span className="min-w-0 flex-1 truncate typography-meta text-muted-foreground" aria-live="polite" title={statusText}>{statusText}</span>
      <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => {
        const controller = lifecycle.current;
        if (controller) void load(controller.signal);
      }}>{t('conversationMemory.refresh')}</Button>
    </div>
    {engineText ? <p className={`${SETTINGS_HELPER_CLASS} truncate`} title={engineText} dir="auto">{engineText}</p> : null}
    <p className={SETTINGS_HELPER_CLASS} dir="auto">{counts || '\u00a0'}</p>
    <SettingsFieldRow
      settingsItem="knowledge-library.conversation-memory-history"
      label={t('conversationMemory.history')}
      info={t('conversationMemory.historyInfo')}
      description={!sessionId ? t('conversationMemory.noSession') : undefined}
    >
      <Button type="button" variant="outline" size="sm" disabled={busy || !status?.enabled || status.state === 'unavailable' || !sessionId || !captureDirectory}
        onClick={() => void run(async (signal) => {
          if (!sessionId || !captureDirectory) return;
          const result = await captureConversationMemory({ sessionId, directory: captureDirectory, signal });
          if (!signal.aborted) setNotice(result.queued ? 'captureQueued' : 'captureUnchanged');
        })}>{t('conversationMemory.capture')}</Button>
    </SettingsFieldRow>
    {canProposeMethodology ? <SettingsFieldRow
      settingsItem="knowledge-library.conversation-memory-methodology"
      label={t('conversationMemory.kind.methodology')} info={t('conversationMemory.methodologyInfo')}
    >
      <Button type="button" variant="outline" size="sm" disabled={busy || !status?.enabled || status.state === 'unavailable'}
        onClick={() => void run(async (signal) => {
          if (!directory) return;
          await consolidateConversationMemory({ directory, entryIds: supportingExperiences.map((entry) => entry.id), signal });
          if (!signal.aborted) setNotice('methodologyQueued');
        })}>{t('conversationMemory.proposeMethodology')}</Button>
    </SettingsFieldRow> : null}
    <SettingsStackedField label={t('conversationMemory.search')} settingsItem="knowledge-library.conversation-memory-search">
      <Input inputSize={settings ? 'default' : 'compact'} type="search" value={query} disabled={busy || !directory}
        aria-label={t('conversationMemory.search')} placeholder={t('conversationMemory.search')}
        onChange={(event) => setQuery(event.target.value)} />
    </SettingsStackedField>
    <p className={`min-h-5 truncate typography-meta ${failure ? 'text-[var(--status-error-text)]' : 'text-muted-foreground'}`} aria-live="polite" title={feedback}>{feedback || '\u00a0'}</p>
    <div className="space-y-2">
      {!directory ? <p className={SETTINGS_HELPER_CLASS}>{t('conversationMemory.noDirectory')}</p>
        : !loaded ? <p className={SETTINGS_HELPER_CLASS}>{t('conversationMemory.loading')}</p>
        : normalEntries.length === 0 && !failure ? <p className={SETTINGS_HELPER_CLASS}>{t(query.trim() ? 'conversationMemory.noMatches' : 'conversationMemory.empty')}</p> : null}
      {normalEntries.map((entry) => <div key={entry.id} className="py-1">
        <Button type="button" variant="ghost" size="sm" className="max-w-full justify-start" aria-expanded={expanded === entry.id}
          onClick={() => setExpanded((current) => current === entry.id ? null : entry.id)}>
          <Icon name="file-text" className="size-3.5 shrink-0" />
          <span className="truncate" dir="auto" title={entry.title}>{entry.title}</span>
        </Button>
        <div className="flex flex-wrap gap-x-1 typography-meta text-muted-foreground">
          <span>{t(kindKeys[entry.kind])}</span><span aria-hidden>·</span>
          <span>{t(entryKeys[entry.status])}</span><span aria-hidden>·</span>
          <span>{t(indexKeys[entry.indexState])}</span><span aria-hidden>·</span>
          <span>{t(entry.verification === 'observed' ? 'conversationMemory.verification.observed' : 'conversationMemory.verification.unverified')}</span>
        </div>
        {entry.error ? <p className="truncate typography-meta text-[var(--status-error-text)]" title={t(errorKeyOf(entry.error), { code: entry.error })}>
          {t(errorKeyOf(entry.error), { code: entry.error })}
        </p> : null}
        {expanded === entry.id ? <div className="space-y-2 pt-2">
          <p className="whitespace-pre-wrap break-words typography-ui-label" dir="auto">{entry.body}</p>
          {entry.limitations.length ? <div>
            <p className="typography-meta text-muted-foreground">{t('conversationMemory.limitations')}</p>
            <ul className="list-disc space-y-1 ps-4 typography-meta">{entry.limitations.map((limitation, index) => <li key={index} dir="auto">{limitation}</li>)}</ul>
          </div> : null}
          <div className="flex flex-wrap items-center gap-1">
            {entry.sourceReferences?.length || entry.sourceMessageIds.length ? (entry.sourceReferences?.length
              ? entry.sourceReferences : entry.sourceMessageIds.map((messageId) => ({ sessionId: entry.sessionId, messageId })))
              .map((source) => <Button key={`${source.sessionId}:${source.messageId}`} type="button" variant="link" size="xs" className="min-w-0 max-w-full"
                title={t('conversationMemory.source', { id: source.messageId })}
                onClick={() => void openSessionLink(source.sessionId, source.messageId).catch(() => setError('source_unavailable'))}>
                <span className="truncate">{t('conversationMemory.source', { id: source.messageId })}</span>
              </Button>) : <Button type="button" variant="link" size="xs" onClick={() => void openSessionLink(entry.sessionId, null).catch(() => setError('source_unavailable'))}>{t('conversationMemory.openSession')}</Button>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {entry.status === 'candidate' ? <Button type="button" variant="outline" size="sm" disabled={busy} title={t('conversationMemory.confirmInfo')}
              onClick={() => void run(async (signal) => {
                if (!directory) return;
                const next = await confirmConversationMemoryEntry({ id: entry.id, directory, signal });
                if (!signal.aborted) setEntries((current) => current.map((item) => item.id === next.id ? next : item));
              })}>{t('conversationMemory.confirm')}</Button> : null}
            {entry.indexState === 'failed' ? <Button type="button" variant="outline" size="sm" disabled={busy || !status?.enabled}
              onClick={() => void run(async (signal) => {
                if (!directory) return;
                const result = await retryConversationMemoryEntry({ id: entry.id, directory, signal });
                if (!signal.aborted) setNotice(result.queued ? 'retryQueued' : 'retryUnchanged');
              })}>{t('conversationMemory.retry')}</Button> : null}
            <Button type="button" variant="destructive" size="sm" disabled={busy} onClick={() => void forget(entry)}>{t('conversationMemory.forget')}</Button>
          </div>
        </div> : null}
      </div>)}
      {cleanups.map((entry) => <div key={entry.id} className="flex items-center gap-2 py-1">
        <span className="min-w-0 flex-1 truncate typography-meta text-muted-foreground" dir="auto" title={entry.title}>
          {entry.title} · {t(entry.indexState === 'failed' ? 'conversationMemory.cleanupFailed' : 'conversationMemory.cleanup')}
        </span>
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void run(async (signal) => {
          if (!directory) return;
          const result = await retryConversationMemoryEntry({ id: entry.id, directory, signal });
          if (!signal.aborted) setNotice(result.queued ? 'retryQueued' : 'retryUnchanged');
        })}>{t('conversationMemory.retryCleanup')}</Button>
      </div>)}
    </div>
    {dialog}
  </div>;

  return settings
    ? <SettingsSection title={t('conversationMemory.title')} divider={divider} settingsItem="knowledge-library.conversation-memory">{content}</SettingsSection>
    : <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2"><SettingsControlGroup settingsItem="knowledge-library.conversation-memory">{content}</SettingsControlGroup></div>;
};
