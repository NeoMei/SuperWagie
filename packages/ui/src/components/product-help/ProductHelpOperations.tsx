import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { loadDesktopSettings, updateDesktopSettings } from '@/lib/persistence';
import type { ProductHelpAction, ProductHelpOperation } from '@/lib/product-help/client';
import { useProductHelpGuidanceStore } from '@/lib/product-help/guidance-store';
import { runProductHelpOperation } from '@/lib/product-help/operations';
import { useProductHelpStore } from '@/lib/product-help/store';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';

const OPERATION_LABELS = {
  'language-en': 'productHelp.operation.languageEn',
  'language-zh-CN': 'productHelp.operation.languageZh',
  'theme-light': 'productHelp.operation.themeLight',
  'theme-dark': 'productHelp.operation.themeDark',
  'theme-system': 'productHelp.operation.themeSystem',
} satisfies Record<ProductHelpOperation, I18nKey>;

export function ProductHelpOperations({ messageId, actions }: { messageId: number; actions: ProductHelpAction[] }) {
  const { t, setLocale } = useI18n();
  const theme = useThemeSystem();
  const latestTheme = useRef(theme);
  useEffect(() => { latestTheme.current = theme; }, [theme]);
  const operation = useProductHelpStore(state => state.operation);
  const executable = actions.filter(action => action.kind === 'execute');
  if (executable.length === 0) return null;
  const busy = operation?.status === 'running';
  const status = operation?.messageId === messageId ? operation.status : null;
  const execute = (actionId: string) => {
    const runtimeKey = getRuntimeKey();
    useProductHelpGuidanceStore.getState().stop();
    void useProductHelpStore.getState().execute(messageId, actionId, (operation, isCurrent) => runProductHelpOperation(operation, {
      isCurrent: () => isCurrent() && runtimeKey === getRuntimeKey(),
      isSupported: () => !isVSCodeRuntime() && !isMobileSurfaceRuntime(),
      theme: {
        lightThemeId: theme.lightThemeId,
        darkThemeId: theme.darkThemeId,
        systemVariant: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      },
      save: updateDesktopSettings,
      read: loadDesktopSettings,
      applyLanguage: setLocale,
      applyTheme: mode => latestTheme.current.setThemeMode(mode),
    }));
  };
  const statusKey: I18nKey | null = status === 'running' ? 'productHelp.operation.running'
    : status === 'completed' ? 'productHelp.operation.completed'
      : status === 'failed' ? 'productHelp.operation.failed'
        : status === 'unsupported' ? 'productHelp.operation.unsupported' : null;

  return <section className="space-y-2" aria-label={t('productHelp.operation.title')}>
    <p className="typography-micro text-muted-foreground">{t('productHelp.operation.title')}</p>
    <div className="flex flex-wrap gap-2">
      {executable.map(action => <Button key={action.id} size="sm" variant="outline"
        disabled={busy} onClick={() => execute(action.id)}>{t(OPERATION_LABELS[action.operation])}</Button>)}
    </div>
    <div className="flex min-h-5 items-center gap-2 text-sm" role={status === 'failed' || status === 'unsupported' ? 'alert' : 'status'}>
      {status === 'running' && <Spinner className="size-4" />}
      {statusKey && <span className={status === 'failed' ? 'text-[var(--status-error-text)]' : 'text-muted-foreground'}>{t(statusKey)}</span>}
    </div>
  </section>;
}
