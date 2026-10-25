import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import { Spinner } from '@/components/ui/spinner';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useProductHelpStore } from '@/lib/product-help/store';
import { useProductHelpGuidanceStore } from '@/lib/product-help/guidance-store';
import { getGuidanceStep, getGuidanceStepCount } from '@/lib/product-help/guidance';
import type { ProductHelpAction, ProductHelpArticle, ProductHelpNavigationAction, ProductHelpRequest } from '@/lib/product-help/client';
import { ProductHelpOperations } from './ProductHelpOperations';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';

const EXAMPLES: I18nKey[] = ['productHelp.example.models', 'productHelp.example.knowledge', 'productHelp.example.appearance', 'productHelp.example.theme'];
const TARGET_LABELS = {
  models: 'productHelp.models', knowledge: 'productHelp.knowledge', appearance: 'productHelp.language', theme: 'productHelp.theme', shortcuts: 'productHelp.shortcuts',
} satisfies Record<ProductHelpNavigationAction['target'], I18nKey>;

function HelpActions({ actions }: { actions: ProductHelpAction[] }) {
  const { t } = useI18n();
  const start = useProductHelpGuidanceStore(s => s.start);
  return <div className="flex flex-wrap gap-2">
    {actions.filter(action => action.kind !== 'execute').map(action => <Button key={action.id} size="sm" variant="outline" onClick={() => start(action.target, action.kind)}
      aria-label={`${t(action.kind === 'guide' ? 'productHelp.guide' : 'productHelp.locate')} · ${t(action.kind === 'guide' && action.target === 'models' ? 'productHelp.connectionGuide' : TARGET_LABELS[action.target])}`}>
      <Icon name={action.kind === 'guide' ? 'play' : 'focus-3'} className="me-1 size-4" />
      {t(action.kind === 'guide' ? 'productHelp.guide' : 'productHelp.locate')}
      <span className="text-muted-foreground">{t(action.kind === 'guide' && action.target === 'models' ? 'productHelp.connectionGuide' : TARGET_LABELS[action.target])}</span>
    </Button>)}
  </div>;
}

function HelpArticle({ article }: { article: ProductHelpArticle }) {
  return <details className="py-2">
    <summary className="cursor-pointer text-sm">{article.title}</summary>
    <p className="my-3 whitespace-pre-wrap text-sm leading-relaxed">{article.text}</p>
    <HelpActions actions={article.actions} />
  </details>;
}

function GuidanceSteps() {
  const { t } = useI18n();
  const session = useProductHelpGuidanceStore(s => s.session);
  const back = useProductHelpGuidanceStore(s => s.back);
  const stop = useProductHelpGuidanceStore(s => s.stop);
  const retry = useProductHelpGuidanceStore(s => s.retry);
  if (!session) return null;
  const step = getGuidanceStep(session);
  const count = session.mode === 'guide' ? getGuidanceStepCount(session.target) : 1;
  const failureKey: I18nKey = session.reason === 'unsupported'
    ? session.target === 'knowledge' ? 'productHelp.guidance.knowledgeUnsupported' : 'productHelp.guidance.unsupported'
    : session.reason === 'hidden' ? 'productHelp.guidance.hidden' : 'productHelp.guidance.notFound';
  const statusKey: I18nKey = session.status === 'completed'
    ? session.target === 'models' ? 'productHelp.guidance.connectionComplete' : 'productHelp.guidance.languageComplete'
    : session.status === 'working' ? 'productHelp.guidance.working'
      : session.status === 'failed' ? 'productHelp.guidance.actionFailed'
        : session.status === 'locating' ? 'productHelp.guidance.locating'
          : session.status === 'ready' ? session.mode === 'guide' ? 'productHelp.guidance.awaitingAction' : 'productHelp.guidance.ready' : failureKey;
  return <section aria-live="polite" className="space-y-3 px-4 py-4">
    <p className="typography-micro text-muted-foreground">{t('productHelp.guidance.progress', { step: session.stepIndex + 1, total: count })}</p>
    <h3 className="text-sm font-medium">{t(step.titleKey)}</h3>
    <p className="text-sm leading-relaxed">{t(step.descriptionKey)}</p>
    <p className="min-h-10 text-sm text-muted-foreground" role={session.status === 'unavailable' || session.status === 'failed' ? 'alert' : undefined}>
      {t(statusKey)}
    </p>
    <div className="flex flex-wrap gap-2">
      {session.stepIndex > 0 && !(session.target === 'models' && session.stepIndex === 1) && <Button variant="outline" size="sm" onClick={back}>{t('productHelp.guidance.back')}</Button>}
      {session.status === 'unavailable' && <Button variant="outline" size="sm" onClick={retry}>{t('productHelp.guidance.retry')}</Button>}
      <Button variant="ghost" size="sm" onClick={stop}>{t('productHelp.guidance.stop')}</Button>
    </div>
  </section>;
}

export function ProductHelpPanel({ visible, embedded = false }: { visible: boolean; embedded?: boolean }) {
  const { t, locale } = useI18n();
  const directory = useEffectiveDirectory();
  const messages = useProductHelpStore(s => s.messages);
  const draft = useProductHelpStore(s => s.draft);
  const pending = useProductHelpStore(s => s.pending);
  const failure = useProductHelpStore(s => s.failure);
  const articles = useProductHelpStore(s => s.articles);
  const articlesPending = useProductHelpStore(s => s.articlesPending);
  const articlesFailure = useProductHelpStore(s => s.articlesFailure);
  const runtimeKey = useProductHelpStore(s => s.runtimeKey);
  const guide = useProductHelpGuidanceStore(s => s.session);
  const [search, setSearch] = React.useState('');
  const endRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const store = useProductHelpStore.getState();
    store.syncRuntime(getRuntimeKey());
    return subscribeRuntimeEndpointChanged(({ runtimeKey }) => useProductHelpStore.getState().syncRuntime(runtimeKey));
  }, []);
  React.useEffect(() => {
    if (visible) void useProductHelpStore.getState().loadArticles(locale);
  }, [visible, locale, runtimeKey]);
  React.useEffect(() => { if (visible && messages.length) endRef.current?.scrollIntoView({ block: 'nearest' }); }, [messages, pending, visible]);

  const ask = (question: string) => {
    if (!question.trim() || pending) return;
    useProductHelpGuidanceStore.getState().stop();
    const config = useConfigStore.getState();
    const ui = useUIStore.getState();
    const page = ui.isSettingsDialogOpen ? `settings:${ui.settingsPage}` : ui.openGuestPageId ? 'workbench' : 'chat';
    const request: Omit<ProductHelpRequest, 'history'> = { question, locale, context: { page } };
    if (config.currentProviderId && config.currentModelId) {
      request.providerID = config.currentProviderId;
      request.modelID = config.currentModelId;
    }
    if (directory) request.directory = directory;
    void useProductHelpStore.getState().ask(request);
  };
  const normalizedSearch = search.trim().toLocaleLowerCase(locale);
  const matches = articles.filter(article => `${article.title}\n${article.text}`.toLocaleLowerCase(locale).includes(normalizedSearch));

  return <section className="flex h-full min-h-0 flex-col text-foreground" aria-label={t('productHelp.title')}>
    <div className="flex min-h-10 shrink-0 items-center gap-2 px-3">
      {embedded && <span className="text-sm font-medium">{t('productHelp.title')}</span>}
      <Button variant="ghost" size="sm" className="ms-auto" aria-label={t('productHelp.new')} onClick={() => { useProductHelpStore.getState().clear(); useProductHelpGuidanceStore.getState().stop(); }}>
        <Icon name="add" className="size-4" />
      </Button>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      {guide ? <GuidanceSteps /> : <>
        {messages.length === 0 && <div className="space-y-4 px-4 py-5">
          <h3 className="text-base font-medium">{t('productHelp.welcome')}</h3>
          <p className="text-sm text-muted-foreground">{t('productHelp.intro')}</p>
          <div className="flex flex-col items-start gap-2">{EXAMPLES.map(key => <Button key={key} variant="outline" size="sm" disabled={pending} onClick={() => ask(t(key))}>{t(key)}</Button>)}</div>
        </div>}
        <div className="space-y-5 px-4 py-3" aria-live="polite">
          {messages.map(message => message.role === 'user'
            ? <p key={message.id} dir="auto" className="oc-tile ms-6 whitespace-pre-wrap rounded-lg px-3 py-2 text-sm">{message.text}</p>
            : <article key={message.id} className="space-y-3 text-sm">
              <p dir="auto" className="whitespace-pre-wrap leading-relaxed">{message.answer.text}</p>
              {message.answer.mode === 'local' && message.answer.modelStatus !== 'not-used' && <p className="typography-micro text-muted-foreground">{t(message.answer.modelStatus === 'unconfigured' ? 'productHelp.unconfigured' : 'productHelp.modelUnavailable')}</p>}
              <HelpActions actions={message.answer.actions} />
              <ProductHelpOperations messageId={message.id} actions={message.answer.actions} />
              {message.answer.sources.length > 0 && <details><summary className="cursor-pointer typography-micro text-muted-foreground">{t('productHelp.sources')}</summary>
                {message.answer.sources.map(source => { const article = articles.find(item => item.id === source.id); return article ? <HelpArticle key={source.id} article={article} /> : <p key={source.id} className="py-2">{source.title}</p>; })}
              </details>}
            </article>)}
          {pending && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="size-4" />{t('productHelp.pending')}</div>}
          {failure && <p role="alert" className="text-sm text-[var(--status-error-text)]">{t(failure === 'unsupported' ? 'productHelp.unsupported' : 'productHelp.error')}</p>}
          <div ref={endRef} />
        </div>
        <details className="px-4 py-3">
          <summary className="cursor-pointer text-sm">{t('productHelp.browse')}</summary>
          <div className="mt-3 space-y-2"><Input inputSize="compact" aria-label={t('productHelp.search')} placeholder={t('productHelp.search')} value={search} onChange={event => setSearch(event.target.value)} />
            {articlesPending && <Spinner className="size-4" />}
            {articlesFailure && <div role="alert"><p className="text-sm">{t(articlesFailure === 'unsupported' ? 'productHelp.unsupported' : 'productHelp.error')}</p><Button size="sm" variant="ghost" onClick={() => void useProductHelpStore.getState().loadArticles(locale)}>{t('productHelp.guidance.retry')}</Button></div>}
            {!articlesPending && !articlesFailure && matches.length === 0 && <p className="text-sm text-muted-foreground">{t('productHelp.emptySearch')}</p>}
            {matches.map(article => <HelpArticle key={article.id} article={article} />)}
          </div>
        </details>
      </>}
    </div>
    <form className="shrink-0 space-y-2 p-3" onSubmit={event => { event.preventDefault(); ask(draft); }}>
      <div className="oc-raised oc-field flex items-end gap-2 rounded-lg p-2">
        <textarea className="max-h-32 min-h-12 min-w-0 flex-1 resize-none bg-transparent text-sm" rows={2} maxLength={2000}
          aria-label={t('productHelp.placeholder')} placeholder={t('productHelp.placeholder')} value={draft}
          onChange={event => useProductHelpStore.getState().setDraft(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!pending) ask(draft); } }} />
        {pending ? <Button type="button" size="sm" variant="ghost" onClick={() => useProductHelpStore.getState().cancel()} aria-label={t('productHelp.cancel')}><Icon name="stop" className="size-4" /></Button>
          : <Button type="submit" size="sm" disabled={!draft.trim()} aria-label={t('productHelp.send')}><Icon name="arrow-up" className="size-4" /></Button>}
      </div>
      <p className="typography-micro text-muted-foreground">{t('productHelp.scope')}</p>
    </form>
  </section>;
}
