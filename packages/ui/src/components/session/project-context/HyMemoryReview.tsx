import React from 'react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { ConversationMemoryError } from '@/lib/conversationMemory';
import { useIsVSCodeRuntime } from '@/hooks/useRuntimeAPIs';
import { isSpaceDirectory } from '@/lib/spaces/space-route';
import { subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import {
  previewHyMemoryTidy, readHyMemoryRevisions, applyHyMemoryTidy, undoHyMemoryTidy,
  previewHyMemoryExport, confirmHyMemoryExport,
  type HyTidyPreview, type HyTidyRevision, type HyTidyExport, type HyTidyItem,
} from '@/lib/hyMemoryTidy';

const errorSchema = z.instanceof(ConversationMemoryError).transform((error) => error.code).catch('request_failed');
type Outcome = 'applied' | 'undone' | 'conflict' | 'source_changed' | 'written';
const typeKeys = {
  fact: 'rightSidebar.contextNotesTodo.memory.type.fact',
  preference: 'rightSidebar.contextNotesTodo.memory.type.preference',
  reference: 'rightSidebar.contextNotesTodo.memory.type.reference',
  segment: 'conversationMemory.kind.segment',
  experience: 'conversationMemory.kind.experience',
  methodology: 'conversationMemory.kind.methodology',
} satisfies Record<HyTidyItem['type'], I18nKey>;


export const HyMemoryReview: React.FC<{ projectPath: string | null }> = ({ projectPath }) => {
  const { t } = useI18n();
  const isVSCode = useIsVSCodeRuntime();
  const unsupported = isVSCode || isSpaceDirectory(projectPath);
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [preview, setPreview] = React.useState<HyTidyPreview | null>(null);
  const [revisions, setRevisions] = React.useState<HyTidyRevision[]>([]);
  const [historyUnavailable, setHistoryUnavailable] = React.useState(0);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [exportPreview, setExportPreview] = React.useState<HyTidyExport | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [outcomes, setOutcomes] = React.useState<Array<{ id: string; state: Outcome }>>([]);
  const owner = React.useRef<AbortController | null>(null);
  const clear = React.useCallback(() => {
    owner.current?.abort(); owner.current = null;
    setOpen(false); setBusy(false); setPreview(null); setRevisions([]); setHistoryUnavailable(0); setSelected(new Set()); setExportPreview(null); setError(null); setOutcomes([]);
  }, []);
  React.useEffect(() => { clear(); return () => owner.current?.abort(); }, [clear, projectPath]);
  React.useEffect(() => subscribeRuntimeEndpointWillChange(clear), [clear]);

  const run = async (operation: (directory: string, signal: AbortSignal) => Promise<void>) => {
    if (!projectPath || owner.current) return;
    const controller = new AbortController(); owner.current = controller;
    setBusy(true); setError(null);
    try { await operation(projectPath, controller.signal); }
    catch (failure) { if (!controller.signal.aborted) setError(errorSchema.parse(failure)); }
    finally { if (owner.current === controller) { owner.current = null; setBusy(false); } }
  };
  const refresh = async (directory: string, signal: AbortSignal) => {
    const [next, history] = await Promise.all([previewHyMemoryTidy(directory, signal), readHyMemoryRevisions(directory, signal)]);
    if (signal.aborted) return;
    setPreview(next); setRevisions(history.revisions); setHistoryUnavailable(history.unavailable); setSelected(new Set()); setExportPreview(null);
  };
  const chosen = preview?.items.filter((item) => selected.has(`${item.kind}:${item.id}`)) ?? [];
  const changed = chosen.filter((item) => item.reasons.length > 0);
  const openReview = () => {
    setOpen(true); setOutcomes([]);
    void run(refresh);
  };

  return <>
    <Button variant="outline" size="xs" disabled={!projectPath || unsupported} title={unsupported ? t('hyTidy.unsupported') : undefined} onClick={openReview}>
      {t('hyTidy.open')}
    </Button>
    <Dialog open={open} onOpenChange={(next) => { if (!next) clear(); }}>
      <DialogContent className="max-h-[85dvh] max-w-3xl overflow-y-auto">
        <DialogHeader><DialogTitle>{t('hyTidy.open')}</DialogTitle></DialogHeader>
        <p className="typography-meta text-muted-foreground" dir="ltr">{projectPath}</p>
        <p className="typography-meta text-muted-foreground">{t('hyTidy.description')}</p>
        {error && <p role="alert" className="typography-meta text-[var(--status-error)]">{error === 'hy_tidy_export_conflict' ? t('hyTidy.exportChanged') : t('conversationMemory.error', { code: error })}</p>}
        {outcomes.length > 0 && <ul aria-live="polite" className="typography-meta">{outcomes.map((outcome) =>
          <li key={outcome.id}><bdi>{outcome.id}</bdi>{' · '}{t(`hyTidy.result.${outcome.state}`)}</li>)}</ul>}
        {busy && <p role="status" className="typography-meta">{t('conversationMemory.working')}</p>}
        {exportPreview ? <section className="space-y-3">
          <p className="typography-ui-label" dir="ltr">{exportPreview.target}</p>
          <p className="typography-meta text-muted-foreground">{t('hyTidy.exportDescription')}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div><p className="typography-ui-label">{t('hyTidy.before')}</p><pre className="whitespace-pre-wrap break-words typography-meta" dir="auto">{exportPreview.before}</pre></div>
            <div><p className="typography-ui-label">{t('hyTidy.after')}</p><pre className="whitespace-pre-wrap break-words typography-meta" dir="auto">{exportPreview.after}</pre></div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={() => void run(async (directory, signal) => {
              try {
                const result = await confirmHyMemoryExport(directory, exportPreview.exportId, signal);
                if (signal.aborted) return;
                setOutcomes([{ id: result.target, state: 'written' }]); setExportPreview(null);
              } catch (failure) {
                if (errorSchema.parse(failure) === 'hy_tidy_export_conflict') {
                  const next = await previewHyMemoryExport(directory, chosen.map(({ id, kind }) => ({ id, kind })), signal);
                  if (!signal.aborted) setExportPreview(next);
                }
                throw failure;
              }
            })}>{t('hyTidy.confirmExport')}</Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => setExportPreview(null)}>{t('hyTidy.cancelExport')}</Button>
          </div>
        </section> : <>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy || changed.length === 0} onClick={() => void run(async (directory, signal) => {
              if (!preview) return;
              const result = await applyHyMemoryTidy(directory, preview.previewId, changed.map((item) => `${item.kind}:${item.id}`), signal);
              if (signal.aborted) return;
              setOutcomes(result.results.map((item) => ({ id: item.id, state: item.state })));
              await refresh(directory, signal);
            })}>{t('hyTidy.apply')}</Button>
            <Button size="sm" variant="outline" disabled={busy || chosen.length === 0 || chosen.length > 30} onClick={() => void run(async (directory, signal) => {
              const result = await previewHyMemoryExport(directory, chosen.map(({ id, kind }) => ({ id, kind })), signal);
              if (!signal.aborted) setExportPreview(result);
            })}>{t('hyTidy.export')}</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(refresh)}>{t('conversationMemory.refresh')}</Button>
          </div>
          {preview?.unavailable ? <p role="status" className="typography-meta text-[var(--status-warning)]">{t('hyTidy.unavailable', { count: preview.unavailable })}</p> : null}
          {preview?.truncated && <p className="typography-meta text-muted-foreground">{t('hyTidy.bounded')}</p>}
          {preview?.items.length === 0 && <p className="typography-meta">{t('hyTidy.empty')}</p>}
          <ul className="space-y-4">{preview?.items.map((item) => {
            const key = `${item.kind}:${item.id}`;
            return <li key={key} className="space-y-2">
              <div className="flex items-center gap-2 typography-ui-label">
                <Checkbox disabled={busy} ariaLabel={item.before.title} checked={selected.has(key)} onChange={(checked) => setSelected((current) => {
                  const next = new Set(current); if (checked) next.add(key); else next.delete(key); return next;
                })} />
                <span dir="auto">{item.before.title}</span>
              </div>
              <p className="typography-meta text-muted-foreground">{t(item.kind === 'manual' ? 'hyTidy.manual' : 'hyTidy.inference')}{' · '}<bdi>{item.id}</bdi>{' · '}<span>{t(typeKeys[item.type])}</span></p>
              <p className="typography-meta text-muted-foreground">{t(`conversationMemory.verification.${item.verification}`)}</p>
              {item.sourceReferences.map(({ sessionId, messageId }) => <p key={`${sessionId}:${messageId}`} className="typography-meta text-muted-foreground">{t('conversationMemory.source', { id: `${sessionId}/${messageId}` })}</p>)}
              <p className="typography-meta">{item.reasons.length ? item.reasons.map((reason) => t(`hyTidy.reason.${reason}`)).join(' · ') : t('hyTidy.reason.unchanged')}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div><p className="typography-meta text-muted-foreground">{t('hyTidy.before')}</p><pre className="whitespace-pre-wrap break-words typography-meta" dir="auto">{item.before.title}{'\n'}{item.before.body}</pre></div>
                <div><p className="typography-meta text-muted-foreground">{t('hyTidy.after')}</p><pre className="whitespace-pre-wrap break-words typography-meta" dir="auto">{item.after.title}{'\n'}{item.after.body}</pre></div>
              </div>
            </li>;
          })}</ul>
          {historyUnavailable > 0 && <p role="status" className="typography-meta text-[var(--status-warning)]">{t('hyTidy.historyUnavailable')}</p>}
          {revisions.length > 0 && <section className="space-y-2">
            <p className="typography-ui-header">{t('hyTidy.history')}</p>
            {revisions.map((revision) => <div key={revision.revisionId} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate typography-meta" dir="auto">{revision.after.title}</span>
              <Button size="xs" variant="outline" disabled={busy} onClick={() => void run(async (directory, signal) => {
                const result = await undoHyMemoryTidy(directory, [revision.revisionId], signal);
                if (signal.aborted) return;
                setOutcomes(result.results.map((item) => ({ id: revision.id, state: item.state })));
                await refresh(directory, signal);
              })}>{t('hyTidy.undo')}</Button>
            </div>)}
          </section>}
        </>}
      </DialogContent>
    </Dialog>
  </>;
};
