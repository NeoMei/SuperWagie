import React from 'react';
import type { GuestResultCard, GuestResultCardsRequest } from '@openchamber/sdk';
import { isDesktopShell } from '@/lib/desktop';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { subscribePlatformAccountState } from '@/lib/platformAccount';
import { captureRuntimeInstance, getRuntimeKey, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { readOfficialSelections, type OfficialSelection, selectOfficialResult, revokeOfficialSelection } from '@/lib/guests/mobile-official';

const ResultCard: React.FC<{ card: GuestResultCard; directory: string; guestId: string; sessionId: string | null; onChanged: () => void }> = ({ card, directory, guestId, sessionId, onChanged }) => {
  const { t } = useI18n();
  const projectId = useProjectsStore((state) => state.projects.find((project) => project.path === directory)?.id ?? null);
  const [status, setStatus] = React.useState<'idle' | 'saving' | 'failed'>('idle');
  const [selectionId, setSelectionId] = React.useState<string | null>(null);
  const active = React.useRef(true);
  const pending = React.useRef<AbortController | null>(null);
  React.useEffect(() => { active.current = true; return () => { active.current = false; pending.current?.abort(); }; }, []);
  const select = async (): Promise<void> => {
    if (!projectId || status === 'saving') return;
    const isCurrentRuntime = captureRuntimeInstance();
    const operation = new AbortController();
    pending.current = operation;
    setStatus('saving');
    try {
      if (selectionId) {
        await revokeOfficialSelection(selectionId, operation.signal);
        if (active.current && isCurrentRuntime()) setSelectionId(null);
      } else {
        const selection = await selectOfficialResult({ extensionId: guestId, projectId, sessionId, card }, operation.signal);
        if (active.current && isCurrentRuntime()) setSelectionId(selection.id);
      }
      if (active.current && isCurrentRuntime()) { setStatus('idle'); onChanged(); }
    } catch { if (active.current && isCurrentRuntime()) setStatus('failed'); }
    finally { if (pending.current === operation) pending.current = null; }
  };
  return (
    <section className="oc-tile rounded-lg p-3">
      <div dir="auto" className="typography-ui-label text-foreground">{card.title}</div>
      {card.version ? <div dir="auto" className="typography-micro text-muted-foreground">{card.version}</div> : null}
      {card.text ? <p dir="auto" className="typography-meta whitespace-pre-wrap text-foreground">{card.text}</p> : null}
      {card.path ? <div dir="ltr" className="typography-code break-all text-muted-foreground">{card.path}</div> : null}
      {isDesktopShell() && projectId && (card.path || card.taskId) ? (
        <Button size="sm" variant="ghost" disabled={status === 'saving'} onClick={() => void select()}>
          {status === 'saving' ? t('mobile.official.sharing') : t(selectionId ? 'mobile.official.revoke' : 'mobile.official.share')}
        </Button>
      ) : null}
      {!isDesktopShell() && (card.path || card.taskId) ? <p className="typography-micro text-muted-foreground">{t('mobile.official.desktopSelectionOnly')}</p> : null}
      <div role="status" className="h-5 truncate typography-micro text-[var(--status-error-text)]" title={status === 'failed' ? t('mobile.official.selectFailed') : undefined}>
        {status === 'failed' ? t('mobile.official.selectFailed') : ''}
      </div>
    </section>
  );
};

const SelectedGrant: React.FC<{ selection: OfficialSelection; onChanged: () => void }> = ({ selection, onChanged }) => {
  const { t } = useI18n();
  const [status, setStatus] = React.useState<'idle' | 'saving' | 'failed'>('idle');
  const pending = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => pending.current?.abort(), []);
  const revoke = async (): Promise<void> => {
    if (status === 'saving') return;
    const operation = new AbortController();
    pending.current = operation;
    setStatus('saving');
    try { await revokeOfficialSelection(selection.id, operation.signal); if (!operation.signal.aborted) onChanged(); }
    catch { if (!operation.signal.aborted) setStatus('failed'); }
    finally { if (pending.current === operation) pending.current = null; }
  };
  return <div className="flex items-center gap-2 py-1">
    <span dir="auto" className="min-w-0 flex-1 truncate typography-meta" title={`${selection.card.title} · ${new Date(selection.createdAt).toLocaleString()}`}>{selection.card.title}</span>
    <Button size="sm" variant="ghost" disabled={status === 'saving'} onClick={() => void revoke()}>{t('mobile.official.revoke')}</Button>
    {status === 'failed' ? <span role="status" className="typography-micro text-[var(--status-error-text)]">{t('mobile.official.revokeFailed')}</span> : null}
  </div>;
};

/** The host draws plain text and owns every control. Result data grants no authority. */
export const GuestResultCards: React.FC<{ request: GuestResultCardsRequest; guestId: string; sessionId: string | null }> = ({ request, guestId, sessionId }) => {
  const { t } = useI18n();
  const projectId = useProjectsStore((state) => state.projects.find((project) => project.path === request.directory)?.id ?? null);
  const [selectionLoad, setSelectionLoad] = React.useState<{ context: string; kind: 'loading' | 'failed' } | { context: string; kind: 'ready'; selections: OfficialSelection[] }>({ context: '', kind: 'loading' });
  const [revision, setRevision] = React.useState(0);
  const refresh = React.useCallback(() => setRevision((value) => value + 1), []);
  const [ownerEpoch, setOwnerEpoch] = React.useState(0);
  React.useEffect(() => {
    const retire = () => setOwnerEpoch((value) => value + 1);
    const account = subscribePlatformAccountState((_state, key) => { if (key === getRuntimeKey()) retire(); });
    const runtime = subscribeRuntimeEndpointWillChange(retire);
    return () => { account(); runtime(); };
  }, []);
  const context = JSON.stringify([getRuntimeKey(), projectId, ownerEpoch]);
  const currentLoad = selectionLoad.context === context ? selectionLoad : { kind: 'loading' as const };
  React.useEffect(() => {
    setSelectionLoad({ context, kind: 'loading' });
    if (!projectId || !isDesktopShell()) return;
    let active = true;
    const isCurrentRuntime = captureRuntimeInstance();
    void readOfficialSelections(projectId).then((selections) => { if (active && isCurrentRuntime()) setSelectionLoad({ context, kind: 'ready', selections }); }).catch(() => { if (active && isCurrentRuntime()) setSelectionLoad({ context, kind: 'failed' }); });
    return () => { active = false; };
  }, [context, projectId, revision]);
  return (
  <div className="flex shrink-0 flex-col gap-2 overflow-auto p-3" style={{ maxHeight: '40%' }}>
    {request.cards.map((card, index) => <ResultCard key={JSON.stringify([request.directory, sessionId, ownerEpoch, card, index])} card={card} directory={request.directory} guestId={guestId} sessionId={sessionId} onChanged={refresh} />)}
    {isDesktopShell() && projectId ? <details className="typography-meta">
      <summary>{t('mobile.official.manage')}</summary>
      {currentLoad.kind === 'ready' ? currentLoad.selections.map((selection) => <SelectedGrant key={`${context}:${selection.id}`} selection={selection} onChanged={refresh} />) : currentLoad.kind === 'failed' ? <p role="status">{t('mobile.official.readFailed')}</p> : <p role="status">{t('common.loading')}</p>}
    </details> : null}
  </div>
  );
};
