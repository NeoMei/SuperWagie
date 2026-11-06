import React from 'react';
import { useReducedMotion } from 'motion/react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { PauseClock } from '@/components/ui/pause-clock';
import { Spinner } from '@/components/ui/spinner';
import { useWaitingPhase } from '@/hooks/useDurationTicker';
import { useI18n, type I18nKey } from '@/lib/i18n';
import type { ModelPurposeId } from '@/lib/modelConfiguration';
import { cn } from '@/lib/utils';
import { MODEL_PURPOSE_LABELS, modelTestErrorKey } from './modelConfigurationView';

type ModelTestStatus = 'queued' | 'testing' | 'verified' | 'failed' | 'unknown';
const STATUS_LABELS = {
  queued: 'modelConfiguration.testFeedback.queued',
  testing: 'modelConfiguration.testFeedback.testing',
  verified: 'modelConfiguration.testFeedback.verified',
  failed: 'modelConfiguration.testFeedback.failed',
  unknown: 'modelConfiguration.testFeedback.unknown',
} as const satisfies Record<ModelTestStatus, I18nKey>;
const STATUS_ICONS = {
  queued: 'time', verified: 'checkbox-circle', failed: 'close-circle', unknown: 'question',
} as const satisfies Record<Exclude<ModelTestStatus, 'testing'>, IconName>;

// A travelling highlight is an activity indicator, not a completed fraction.
// Only this leaf subscribes to the shared clock; the form and labels stay still.
const WaitingBar: React.FC = () => {
  const phase = useWaitingPhase(true, 8);
  return <div aria-hidden="true" className="flex h-1.5 gap-1" data-model-test-activity="">
    {Array.from({ length: 8 }, (_, index) => <span key={index} className="min-w-0 flex-1 rounded-full bg-current" style={{ opacity: index === phase ? 0.9 : 0.18 }} />)}
  </div>;
};

/** Keeps every model-test indicator still when motion is reduced or the page is hidden. */
export const ModelTestMotion: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const initialReducedMotion = useReducedMotion();
  const [reduceMotion, setReduceMotion] = React.useState(initialReducedMotion ?? false);
  const [hidden, setHidden] = React.useState(false);
  React.useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updateMotion = () => setReduceMotion(preference.matches);
    const updateVisibility = () => setHidden(document.hidden);
    updateMotion(); updateVisibility();
    preference.addEventListener('change', updateMotion);
    document.addEventListener('visibilitychange', updateVisibility);
    return () => {
      preference.removeEventListener('change', updateMotion);
      document.removeEventListener('visibilitychange', updateVisibility);
    };
  }, []);
  return <PauseClock paused={reduceMotion || hidden}>{children}</PauseClock>;
};

export const ModelTestFeedback: React.FC<{
  purpose: ModelPurposeId;
  model?: string;
  status: ModelTestStatus;
  errorCode?: string;
  testedAt?: string;
}> = ({ purpose, model, status, errorCode, testedAt }) => {
  const { t, locale } = useI18n();
  const label = t('modelConfiguration.testFeedback.region', { purpose: t(MODEL_PURPOSE_LABELS[purpose]) });
  const testing = status === 'testing';
  const resultDate = testedAt && status !== 'queued' && !testing ? new Date(testedAt) : null;
  const timestamp = resultDate && Number.isFinite(resultDate.getTime()) ? resultDate.toLocaleString(locale) : null;
  const hint = status === 'unknown' ? t('modelConfiguration.testFeedback.unknownHint')
    : status === 'queued' ? t('modelConfiguration.testFeedback.queuedHint')
      : testing ? t(purpose === 'image-generation' || purpose === 'image-editing' ? 'modelConfiguration.testFeedback.imageWaiting' : 'modelConfiguration.testFeedback.waiting')
        : status === 'failed' ? t(errorCode === 'enterprise_mode' ? 'modelConfiguration.enterprise' : modelTestErrorKey(errorCode ?? 'test_failed'))
          : t('modelConfiguration.connectionVerified');
  return <section role="region" aria-label={label} className={cn('min-w-0 space-y-3 rounded-lg p-4',
    status === 'verified' ? 'bg-[var(--status-success-background)] text-[var(--status-success)]'
      : status === 'failed' ? 'bg-[var(--status-error-background)] text-[var(--status-error)]'
        : status === 'unknown' ? 'bg-[var(--status-warning-background)] text-[var(--status-warning)]'
          : 'bg-[var(--status-info-background)] text-[var(--status-info)]')}>
    <ModelTestMotion>
      <div role={status === 'failed' || status === 'unknown' ? 'alert' : 'status'} aria-live="polite" aria-atomic="true" className="min-w-0 space-y-2">
        <p className="flex items-center gap-2 typography-ui-label">
          {testing ? <Spinner aria-hidden="true" /> : <Icon name={STATUS_ICONS[status]} className="size-4 shrink-0" />}
          <span>{t(STATUS_LABELS[status])}</span>
        </p>
        <p className="break-words typography-meta">{t(MODEL_PURPOSE_LABELS[purpose])}{model?.trim() ? <> · <bdi className="break-all" dir="auto">{model}</bdi></> : null}</p>
        <p className="typography-meta">{hint}</p>
        {status === 'unknown' && errorCode && modelTestErrorKey(errorCode) !== 'modelConfiguration.overview.error.request' ? <p className="typography-meta">{t(modelTestErrorKey(errorCode))}</p> : null}
        <p className="min-h-5 typography-meta">{timestamp ? t('modelConfiguration.overview.testedAt', { date: timestamp }) : null}</p>
      </div>
      <div className="h-1.5" role={testing ? 'progressbar' : undefined} aria-label={testing ? label : undefined}>
        {testing ? <WaitingBar /> : null}
      </div>
    </ModelTestMotion>
  </section>;
};
