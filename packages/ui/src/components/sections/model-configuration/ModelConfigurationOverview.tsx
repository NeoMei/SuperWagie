import React from 'react';
import { Button } from '@/components/ui/button';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { useI18n, type I18nKey } from '@/lib/i18n';
import type { ModelPurposeId } from '@/lib/modelConfiguration';
import { cn } from '@/lib/utils';
import type { ModelOverviewRow } from './modelOverviewRows';
import { MODEL_PURPOSE_LABELS } from './modelConfigurationView';

type ModelConfigurationOverviewProps = {
  rows: ModelOverviewRow[];
  pending: boolean;
  testingPurpose: ModelPurposeId | null;
  onConfigure: (purpose: ModelPurposeId) => void;
  onTest: (purpose: ModelPurposeId) => void;
  error?: { purpose: ModelPurposeId; code: string } | null;
};

const CONFIGURATION_LABELS = {
  missing: 'modelConfiguration.overview.configuration.missing',
  configured: 'modelConfiguration.overview.configuration.configured',
  inherited: 'modelConfiguration.overview.configuration.inherited',
  local: 'modelConfiguration.overview.configuration.local',
  native: 'modelConfiguration.overview.configuration.native',
  planned: 'modelConfiguration.planned',
  unknown: 'modelConfiguration.overview.unknown',
} as const satisfies Record<ModelOverviewRow['configuration'], I18nKey>;

const TEST_LABELS = {
  untested: 'modelConfiguration.overview.test.untested',
  verified: 'modelConfiguration.overview.test.verified',
  failed: 'modelConfiguration.overview.test.failed',
  component: 'modelConfiguration.overview.test.component',
  unsupported: 'modelConfiguration.overview.test.unsupported',
  blocked: 'modelConfiguration.overview.test.blocked',
  unknown: 'modelConfiguration.overview.unknown',
} as const satisfies Record<ModelOverviewRow['test'], I18nKey>;

const REASON_LABELS = {
  credentials: 'modelConfiguration.overview.reason.credentials',
  policy: 'modelConfiguration.overview.reason.policy',
  adapter: 'modelConfiguration.overview.reason.adapter',
  runtime: 'modelConfiguration.overview.reason.runtime',
  component: 'modelConfiguration.verifyInComponent',
} as const satisfies Record<NonNullable<ModelOverviewRow['reason']>, I18nKey>;

function errorLabel(code: string): I18nKey {
  if (['model_configuration_provider_http_401', 'model_configuration_credential_missing', 'model_configuration_credential_unavailable'].includes(code)) return 'modelConfiguration.overview.error.credentials';
  if (code === 'model_configuration_provider_http_403') return 'modelConfiguration.overview.error.permission';
  if (code === 'model_configuration_provider_http_404') return 'modelConfiguration.overview.error.model';
  if (code === 'model_configuration_provider_http_429') return 'modelConfiguration.overview.error.limit';
  if (code === 'model_configuration_provider_unreachable') return 'modelConfiguration.overview.error.network';
  if (code === 'model_configuration_revision_conflict' || code === 'model_configuration_credential_changed') return 'modelConfiguration.revisionConflict';
  if (code === 'model_configuration_dimension_mismatch') return 'modelConfiguration.overview.error.dimensions';
  if (code === 'model_configuration_invalid_provider_response') return 'modelConfiguration.overview.error.response';
  return 'modelConfiguration.overview.error.request';
}

export const ModelConfigurationOverview: React.FC<ModelConfigurationOverviewProps> = ({
  rows, pending, testingPurpose, onConfigure, onTest, error,
}) => {
  const { t, locale } = useI18n();
  const busy = pending || testingPurpose !== null;
  const counts = {
    missing: rows.filter((row) => row.configuration === 'missing').length,
    untested: rows.filter((row) => row.configuration === 'configured' && row.test === 'untested').length,
    passed: rows.filter((row) => row.test === 'verified').length,
    failed: rows.filter((row) => row.test === 'failed').length,
    component: rows.filter((row) => row.test === 'component').length,
    planned: rows.filter((row) => row.configuration === 'planned').length,
    unavailable: rows.filter((row) => row.configuration !== 'planned' && (row.test === 'unsupported' || row.test === 'blocked')).length,
    unknown: rows.filter((row) => row.configuration === 'unknown' || row.test === 'unknown').length,
  };
  const summary: Array<{ id: string; label: I18nKey; count: number; color?: string }> = [
    { id: 'missing', label: 'modelConfiguration.overview.summary.missing', count: counts.missing, color: 'text-[var(--status-warning-text)]' },
    { id: 'untested', label: 'modelConfiguration.overview.summary.untested', count: counts.untested },
    { id: 'passed', label: 'modelConfiguration.overview.summary.passed', count: counts.passed, color: 'text-[var(--status-success-text)]' },
    { id: 'failed', label: 'modelConfiguration.overview.summary.failed', count: counts.failed, color: 'text-[var(--status-error-text)]' },
    { id: 'component', label: 'modelConfiguration.overview.summary.component', count: counts.component },
    { id: 'planned', label: 'modelConfiguration.planned', count: counts.planned },
    { id: 'unavailable', label: 'modelConfiguration.overview.summary.unavailable', count: counts.unavailable },
    { id: 'unknown', label: 'modelConfiguration.overview.unknown', count: counts.unknown },
  ];
  const alert = error ? t('modelConfiguration.overview.testError', { purpose: t(MODEL_PURPOSE_LABELS[error.purpose]), message: t(errorLabel(error.code)) }) : null;

  return <SettingsSection settingsItem="models.overview" divider={false} className="pb-0">
    <div className="flex min-w-0 items-start gap-1.5 pb-2">
      <dl aria-label={t('modelConfiguration.overview.summary')} className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1 typography-meta text-muted-foreground">
        {summary.filter((item, index) => index < 4 || item.count > 0).map((item) => <div key={item.id} className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
          <dt>{t(item.label)}</dt><dd className={cn('font-medium tabular-nums', item.color)}>{item.count}</dd>
        </div>)}
      </dl>
      <SettingsInfoHint>{t('modelConfiguration.overview.hint')}</SettingsInfoHint>
    </div>
    <div role="table" aria-label={t('modelConfiguration.overview.list')} aria-busy={busy} className="min-w-0">
      <div role="row" className="sr-only @xl:not-sr-only @xl:grid @xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1.4fr)_6rem_7rem_7.5rem] @xl:items-center @xl:gap-x-2 @xl:pb-1 typography-meta text-muted-foreground">
        <span role="columnheader">{t('modelConfiguration.purpose')}</span>
        <span role="columnheader">{t('modelConfiguration.overview.model')}</span>
        <span role="columnheader">{t('modelConfiguration.overview.configuration')}</span>
        <span role="columnheader">{t('modelConfiguration.overview.lastTest')}</span>
        <span role="columnheader" className="text-end">{t('modelConfiguration.overview.actions')}</span>
      </div>
      <div role="rowgroup">
        {rows.map((row) => {
          const purpose = t(MODEL_PURPOSE_LABELS[row.purpose]);
          const model = row.model ?? t(row.configuration === 'local' ? 'modelConfiguration.overview.systemDefault' : row.configuration === 'inherited' ? 'modelConfiguration.overview.automatic' : row.configuration === 'unknown' ? 'modelConfiguration.overview.unavailable' : 'modelConfiguration.overview.noModel');
          const modelDescription = row.connectionName ? `${model} · ${row.connectionName}` : model;
          const testLabel = t(TEST_LABELS[row.test]);
          const checked = row.testedAt ? new Date(row.testedAt) : null;
          const testedAt = checked && Number.isFinite(checked.getTime()) ? t('modelConfiguration.overview.testedAt', { date: checked.toLocaleString(locale) }) : null;
          const testDetails = [testedAt, row.errorCode ? t(errorLabel(row.errorCode)) : row.reason ? t(REASON_LABELS[row.reason]) : null].filter(Boolean).join(' ');
          const viewOnly = !row.canConfigure && (row.configuration === 'planned' || row.test === 'unsupported');
          const configuring = t(viewOnly ? 'modelConfiguration.overview.viewAria' : 'modelConfiguration.overview.configureAria', { purpose });
          const testing = testingPurpose === row.purpose;
          return <div role="row" key={row.purpose} data-model-purpose={row.purpose} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 py-2 @xl:min-h-8 @xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1.4fr)_6rem_7rem_7.5rem] @xl:gap-y-0 @xl:py-0 typography-meta">
            <div role="cell" className="col-start-1 row-start-1 flex min-w-0 items-center gap-1 @xl:col-auto @xl:row-auto">
              <span className="truncate text-foreground" title={purpose}>{purpose}</span>
              {row.required ? <span aria-label={t('modelConfiguration.required')} title={t('modelConfiguration.required')} className="shrink-0 text-muted-foreground">*</span> : null}
            </div>
            <div role="cell" className="col-start-1 row-start-2 flex min-w-0 items-center gap-1 text-muted-foreground @xl:col-auto @xl:row-auto" title={modelDescription}>
              <span dir="auto" className="max-w-full shrink-0 truncate">{model}</span>
              {row.connectionName ? <span className="hidden min-w-0 truncate @3xl:inline">· {row.connectionName}</span> : null}
            </div>
            <span role="cell" className={cn('col-start-1 row-start-3 min-w-0 truncate @xl:col-auto @xl:row-auto', row.configuration === 'missing' ? 'text-[var(--status-warning-text)]' : 'text-muted-foreground')}>{t(CONFIGURATION_LABELS[row.configuration])}</span>
            <span role="cell" data-model-test={row.purpose} title={testDetails || undefined} className={cn('col-start-2 row-start-1 min-w-0 truncate text-end @xl:col-auto @xl:row-auto @xl:text-start', row.test === 'verified' ? 'text-[var(--status-success-text)]' : row.test === 'failed' ? 'text-[var(--status-error-text)]' : row.test === 'blocked' ? 'text-[var(--status-warning-text)]' : 'text-muted-foreground')}>{testLabel}</span>
            <div role="cell" className="col-start-2 row-span-2 row-start-2 flex items-center justify-end gap-1 @xl:col-auto @xl:row-span-1 @xl:row-auto">
              <Button variant="ghost" size="xs" className="min-w-[3.5rem]" aria-label={configuring} disabled={busy || !row.canConfigure && !viewOnly} onClick={() => onConfigure(row.purpose)}>{t(viewOnly ? 'modelConfiguration.overview.view' : 'modelConfiguration.overview.configure')}</Button>
              <Button variant="outline" size="xs" className="min-w-[3.5rem]" aria-label={t('modelConfiguration.overview.testAria', { purpose })} disabled={busy || !row.canTest} onClick={() => onTest(row.purpose)}>{t(testing ? 'modelConfiguration.overview.testing' : 'modelConfiguration.overview.test')}</Button>
            </div>
          </div>;
        })}
      </div>
    </div>
    <p role={alert ? 'alert' : undefined} className="min-h-5 truncate typography-meta text-[var(--status-error-text)]" title={alert ?? undefined}>{alert}</p>
  </SettingsSection>;
};
