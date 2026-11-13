import React from 'react';
import { Button } from '@/components/ui/button';
import { MatchHighlight } from '@/components/ui/MatchHighlight';
import { useMessageSearch } from '@/hooks/useMessageSearch';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { splitSnippet } from '@/lib/messageSearch';
import { openMessageSearchHit } from '@/lib/messageSearchNavigation';
import { captureRuntimeInstance } from '@/lib/runtime-switch';
import { useUIStore } from '@/stores/useUIStore';

/** Body matches share lifecycle filtering, pagination and source labels. */
export function SessionContentSearch({ query, lifecycle, active = true, onNavigate }: {
  query: string;
  lifecycle: 'active' | 'archived';
  active?: boolean;
  onNavigate: () => void;
}) {
  const { t } = useI18n();
  const indexed = useUIStore(state => state.messageSearchEnabled);
  const reasoning = useUIStore(state => state.messageSearchReasoningEnabled && state.showReasoningTraces);
  const supported = !isVSCodeRuntime();
  const ownerCurrent = captureRuntimeInstance();
  const { state, loadMore } = useMessageSearch({ query, lifecycle, enabled: active && indexed && supported && !query.trim().toLowerCase().startsWith('ses_'), limit: 20, includeReasoning: reasoning, groupBySession: true });
  if (!active || !query.trim() || query.trim().toLowerCase().startsWith('ses_')) return null;
  const hits = 'hits' in state ? state.hits : [];
  const status = !supported ? t('sessions.search.body.unsupported')
    : !indexed ? t('sessions.search.body.off')
      : state.status === 'too-short' ? t('sessions.search.body.tooShort')
        : state.status === 'error' || (state.status === 'ready' && state.pageError) ? t('commandPalette.messages.error')
          : state.status === 'unavailable' ? t('commandPalette.messages.unavailable')
            : state.status === 'loading' || state.status === 'idle' ? t('commandPalette.messages.searching')
              : state.index?.lifecycleComplete === false || state.index?.backfill.state === 'running' ? t('sessions.search.body.indexing')
                : hits.length === 0 ? t('commandPalette.messages.empty') : null;
  return (
    <section aria-label={t('sessions.search.body.label')} className="px-2.5 py-1">
      <p className="typography-micro text-muted-foreground">{t(lifecycle === 'archived' ? 'sessions.search.body.archived' : 'sessions.search.body.active')}</p>
      <div className="max-h-64 overflow-y-auto">
        {hits.map(hit => (
          <Button key={hit.sessionId} variant="ghost" size="sm" className="h-auto w-full min-w-0 justify-start py-1.5 text-start" onClick={() => {
            if (!ownerCurrent()) return;
            openMessageSearchHit(hit);
            onNavigate();
          }}>
            <span className="min-w-0 flex-1">
              <span dir="auto" className="block truncate oc-ui-start-align">{hit.sessionTitle || t('commandPalette.session.untitled')}</span>
              <span className="block truncate typography-micro text-muted-foreground"><MatchHighlight segments={splitSnippet(hit.snippet)} /></span>
              <span className="block truncate typography-micro text-muted-foreground">{t(hit.role === 'reasoning' ? 'commandPalette.messages.inReasoning' : 'sessions.search.body.label')}</span>
            </span>
          </Button>
        ))}
        {state.status === 'ready' && state.next ? <Button variant="ghost" size="sm" disabled={state.loadingMore} onClick={loadMore}>{t('commandPalette.messages.loadMore')}</Button> : null}
      </div>
      <p role="status" className="min-h-4 truncate typography-micro text-muted-foreground" title={status ?? undefined}>{status}</p>
      <p className="typography-micro text-muted-foreground">{t('sessions.search.titles.label')}</p>
    </section>
  );
}
