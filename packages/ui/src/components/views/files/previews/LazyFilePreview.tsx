import React from 'react';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/lib/i18n';

/** A rejected lazy module must be recreated on retry; React.lazy retains rejections. */
export function LazyFilePreview<Props extends object>({ load, previewProps, resolved }: {
  load: () => Promise<{ default: React.ComponentType<Props> }>;
  previewProps: Props;
  resolved?: React.ComponentType<Props>;
}) {
  const { t } = useI18n();
  const [attempt, retry] = React.useReducer((value: number) => value + 1, 0);
  const Preview = React.useMemo(() => resolved ?? React.lazy(load), [load, attempt, resolved]);
  return (
    <ErrorBoundary key={attempt} fallback={(
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4 typography-ui text-muted-foreground">
        <div>{t('filesView.error.previewUnavailable')}</div>
        <Button variant="outline" size="sm" onClick={retry}>{t('filesView.artifact.office.retry')}</Button>
      </div>
    )}>
      <React.Suspense fallback={(
        <div className="flex h-full items-center justify-center gap-2 typography-ui text-muted-foreground">
          <Spinner className="size-4" />{t('filesView.state.loading')}
        </div>
      )}>
        <Preview {...previewProps} />
      </React.Suspense>
    </ErrorBoundary>
  );
}
