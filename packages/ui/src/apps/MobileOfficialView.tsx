import React from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { subscribePlatformAccountState } from '@/lib/platformAccount';
import { isCapacitorApp } from '@/lib/platform';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { readOfficialSelections, readOfficialContent, type OfficialSelection } from '@/lib/guests/mobile-official';

type Load = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; selections: OfficialSelection[] };
const SelectedPreview: React.FC<{ selection: OfficialSelection; authority: 'full' | 'pilot' }> = ({ selection, authority }) => {
  const { t } = useI18n();
  const [content, setContent] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    if (selection.preview.kind === 'unavailable') return;
    let active = true;
    let imageUrl: string | null = null;
    setContent(null); setFailed(false);
    void readOfficialContent(selection, authority).then((result) => {
      if (selection.preview.kind === 'image') imageUrl = result;
      if (active) setContent(result);
      else if (imageUrl) URL.revokeObjectURL(imageUrl);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; if (imageUrl) URL.revokeObjectURL(imageUrl); };
  }, [selection, authority]);
  if (selection.preview.kind === 'unavailable') return <p className="typography-meta text-muted-foreground">{t('mobile.official.previewUnavailable')}</p>;
  if (failed) return <p role="status" className="typography-meta text-[var(--status-error-text)]">{t('mobile.official.readFailed')}</p>;
  if (content === null) return <p role="status" className="typography-meta text-muted-foreground">{t('common.loading')}</p>;
  return selection.preview.kind === 'image'
    ? <img src={content} onError={() => setFailed(true)} alt={selection.card.title} className="max-h-96 max-w-full object-contain" />
    : <pre dir="auto" className="typography-code whitespace-pre-wrap break-words">{content}</pre>;
};

/** Hosted-phone projection. No iframe, file API, prompt, service or write effect. */
export const MobileOfficialView: React.FC<{ visible: boolean; projectId: string | null; ownerKey?: string; authority?: 'full' | 'pilot' }> = ({ visible, projectId, ownerKey = '', authority = 'full' }) => {
  const { t } = useI18n();
  const [ownerEpoch, setOwnerEpoch] = React.useState(0);
  React.useEffect(() => subscribePlatformAccountState((_state, key) => { if (key === getRuntimeKey()) setOwnerEpoch((value) => value + 1); }), []);
  const [runtimeKey, setRuntimeKey] = React.useState(getRuntimeKey);
  React.useEffect(() => subscribeRuntimeEndpointChanged(() => setRuntimeKey(getRuntimeKey())), []);
  const [load, setLoad] = React.useState<Load>({ kind: 'loading' });
  const [revision, setRevision] = React.useState(0);
  const [opened, setOpened] = React.useState<string | null>(null);
  const native = isCapacitorApp();
  const context = JSON.stringify([runtimeKey, projectId, ownerEpoch, ownerKey, authority]);
  const [loadedContext, setLoadedContext] = React.useState('');
  React.useEffect(() => {
    setLoad({ kind: 'loading' }); setOpened(null); setLoadedContext('');
    if (!visible || !projectId || native) return;
    let active = true;
    void readOfficialSelections(projectId, authority).then((selections) => {
      if (!active) return;
      setLoad({ kind: 'ready', selections }); setLoadedContext(context);
    }).catch(() => { if (active) { setLoad({ kind: 'error' }); setLoadedContext(context); } });
    return () => { active = false; };
  }, [context, projectId, native, revision, visible, authority]);
  if (native) return <p className="p-4 typography-meta text-muted-foreground">{t('mobile.official.hostedOnly')}</p>;
  if (!projectId) return <p className="p-4 typography-meta text-muted-foreground">{t('mobile.official.projectRequired')}</p>;
  const current = loadedContext === context ? load : { kind: 'loading' as const };
  return (
    <div className="h-full overflow-auto p-4">
      <div className="flex items-center justify-between gap-2 pb-3">
        <span className="typography-meta text-muted-foreground">{t('mobile.official.readOnly')}</span>
        <Button size="sm" variant="ghost" onClick={() => setRevision((value) => value + 1)}>{t('mobile.official.refresh')}</Button>
      </div>
      {current.kind === 'loading' ? <p role="status">{t('common.loading')}</p> : null}
      {current.kind === 'error' ? <p role="status">{t('mobile.official.readFailed')}</p> : null}
      {current.kind === 'ready' && current.selections.length === 0 ? <p>{t('mobile.official.empty')}</p> : null}
      {current.kind === 'ready' ? current.selections.map((selection) => (
        <section key={selection.id} className="oc-tile mb-3 rounded-lg p-3">
          <div dir="auto" className="typography-ui-label text-foreground">{selection.card.title}</div>
          {selection.card.version ? <div dir="auto" className="typography-meta text-muted-foreground">{selection.card.version}</div> : null}
          {selection.card.text ? <p dir="auto" className="typography-meta whitespace-pre-wrap">{selection.card.text}</p> : null}
          {selection.card.path ? <div dir="ltr" className="typography-code break-all text-muted-foreground">{selection.card.path}</div> : null}
          <p dir="auto" className="typography-micro text-muted-foreground">{t('mobile.official.sourceProject', { project: selection.projectName })}</p>
          {selection.sessionId ? <p dir="ltr" className="typography-micro text-muted-foreground">{t('mobile.official.sourceSession', { session: selection.sessionId })}</p> : null}
          <p className="typography-micro text-muted-foreground">{t('mobile.official.snapshot', { date: new Date(selection.createdAt).toLocaleString() })}</p>
          <div dir="ltr" className="typography-micro break-all text-muted-foreground">SHA-256 {selection.revision}</div>
          {selection.source.kind === 'artifact' ? <Button size="sm" variant="ghost" aria-pressed={opened === selection.id} onClick={() => setOpened((current) => current === selection.id ? null : selection.id)}>{t('mobile.official.preview')}</Button> : null}
          {opened === selection.id ? <SelectedPreview selection={selection} authority={authority} /> : null}
        </section>
      )) : null}
    </div>
  );
};


