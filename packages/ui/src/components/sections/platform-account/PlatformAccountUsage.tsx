import React from 'react';
import { SettingsFieldRow, SettingsSection, SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useI18n } from '@/lib/i18n';
import { formatPlatformQuantity, PlatformAccountError, readPlatformUsageSummary } from '@/lib/platformAccount';
import { formatPlatformMoney, formatPlatformPoints } from '@/lib/platformCommerce';
import { getRuntimeKey } from '@/lib/runtime-switch';

type Report<T> = { status: 'loading' | 'denied' | 'failed' } | { status: 'ready'; data: T };
type Summary = Awaited<ReturnType<typeof readPlatformUsageSummary>>;

const tokenRows = [
  ['input', 'platformAccount.usageInput'], ['output', 'platformAccount.usageOutput'],
  ['cache_read', 'platformAccount.usageCacheRead'], ['cache_write', 'platformAccount.usageCacheWrite'],
  ['reasoning', 'platformAccount.usageReasoning'],
] as const;
const nativeOperationKeys = {
  chat: 'platformAccount.operation.chat',
  responses: 'platformAccount.operation.responses',
  embedding: 'platformAccount.operation.embedding',
  rerank: 'platformAccount.operation.rerank',
  speech: 'platformAccount.operation.speech',
  transcription: 'platformAccount.operation.transcription',
  image_generation: 'platformAccount.operation.image_generation',
  image_edit: 'platformAccount.operation.image_edit',
  ocr: 'platformAccount.operation.ocr',
  video: 'platformAccount.operation.video',
} as const;
const nativeUnitKeys = {
  token: 'platformAccount.unit.token', character: 'platformAccount.unit.character',
  audio_second: 'platformAccount.unit.audioSecond', image: 'platformAccount.unit.image',
  request: 'platformAccount.unit.request', video_second: 'platformAccount.unit.videoSecond',
  provider_unit: 'platformAccount.unit.provider',
} as const;
const assets = ['CREDIT/6', 'CNY/6', 'LR_QUOTA/0'] as const;

const UsageReport = ({ accountId, details }: { accountId: string; details: boolean }) => {
  const { t } = useI18n();
  const metricClass = "oc-tile min-w-0 space-y-1 rounded-lg px-4 py-3";
  const metricValueClass = "break-words text-xl font-semibold tabular-nums";
  const [revision, setRevision] = React.useState(0);
  const [summary, setSummary] = React.useState<Report<Summary>>({ status: 'loading' });
  React.useEffect(() => {
    const runtimeKey = getRuntimeKey();
    let active = true;
    setSummary({ status: 'loading' });
    void readPlatformUsageSummary(accountId, 'superwagie').then(
      (data) => {
        if (active && runtimeKey === getRuntimeKey()) setSummary({ status: 'ready', data });
      },
      (error) => {
        if (active && runtimeKey === getRuntimeKey()) {
          setSummary({ status: error instanceof PlatformAccountError && error.status === 403 ? 'denied' : 'failed' });
        }
      },
    );
    return () => { active = false; };
  }, [accountId, revision]);

  const dimensionLabel = (key: string, unit: string) => {
    if (unit === 'image') return key;
    switch (key) {
      case 'input': return t('platformAccount.dimension.input');
      case 'output': return t('platformAccount.dimension.output');
      case 'cache_read': return t('platformAccount.dimension.cache_read');
      case 'cache_write': return t('platformAccount.dimension.cache_write');
      case 'reasoning': return t('platformAccount.dimension.reasoning');
      case 'requests': return t('platformAccount.dimension.requests');
      case 'characters': return t('platformAccount.dimension.characters');
      case 'audio': return t('platformAccount.dimension.audio');
      case 'video': return t('platformAccount.dimension.video');
      case 'provider': return t('platformAccount.dimension.provider');
      default: return key;
    }
  };
  const charge = (asset: typeof assets[number], amount: string) => asset === 'CNY/6'
    ? t('platformAccount.cny', { amount: formatPlatformMoney(amount) })
    : asset === 'CREDIT/6' ? t('platformAccount.usageCreditAmount', { amount: formatPlatformPoints(amount) })
      : t('platformAccount.usageQuotaAmount', { amount });
  const creditsUsed = summary.status === 'ready' && summary.data.visibility === 'account' && summary.data.charges_by_asset !== undefined
    ? summary.data.charges_by_asset['CREDIT/6'] ?? '0' : undefined;
  const billingAssets = summary.status === 'ready' && summary.data.visibility === 'account' ? assets.filter((asset) => {
    const amount = summary.data.charges_by_asset?.[asset];
    const refund = summary.data.refunds_by_asset?.[asset];
    return (asset !== 'CREDIT/6' && amount !== undefined && amount !== '0') || (refund !== undefined && refund !== '0');
  }) : [];
  const message = (status: 'loading' | 'denied' | 'failed') => <p className={SETTINGS_HELPER_CLASS} role="status">{t(status === 'loading'
    ? 'platformAccount.loading' : status === 'denied' ? 'platformAccount.usageDenied' : 'platformAccount.usageFailed')}</p>;

  return (
    <SettingsSection title={t('platformAccount.usageSuperWagie')} divider={false} className="pb-5" contentClassName="space-y-3" headerAction={
      <Button size="sm" variant="ghost" disabled={summary.status === 'loading'} onClick={() => {
        setSummary({ status: 'loading' }); setRevision((value) => value + 1);
      }}>{t('platformAccount.usageRefresh')}</Button>
    }>
      <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.usageScope')}</p>
      {summary.status !== 'ready' ? message(summary.status) : <>
        {summary.data.visibility === 'actor' && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.usageActorScope')}</p>}
        {summary.data.calls_total === '0' ? <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.usageEmpty')}</p> : <>
          <dl className="grid min-w-0 grid-cols-2 gap-2.5 @xl:grid-cols-3">
            <div className={`${metricClass} col-span-2 @xl:col-span-1`}><dt className={SETTINGS_HELPER_CLASS}>{t('platformAccount.usageCreditsUsed')}</dt><dd dir="auto" className={metricValueClass}>{creditsUsed === undefined ? t('platformAccount.usageAmountUnavailable') : charge('CREDIT/6', creditsUsed)}</dd></div>
            <div className={metricClass}><dt className={SETTINGS_HELPER_CLASS}>{t('platformAccount.usageCalls')}</dt><dd dir="auto" className={metricValueClass}>{summary.data.calls_total}</dd></div>
            <div className={metricClass}><dt className={SETTINGS_HELPER_CLASS}>{t('platformAccount.usageSettledCalls')}</dt><dd dir="auto" className={metricValueClass}>{summary.data.settled_calls}</dd></div>
          </dl>
          {(!summary.data.usage_complete || summary.data.pending_calls !== '0' || summary.data.missing_usage_calls !== '0' || summary.data.unknown_calls !== '0') && <>
            <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.usageIncomplete')}</p>
            <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.usageUnconfirmedCalls', { pending: summary.data.pending_calls, missing: summary.data.missing_usage_calls, unknown: summary.data.unknown_calls })}</p>
          </>}
          {details && billingAssets.length > 0 && <Collapsible>
            <CollapsibleTrigger className="rounded-md border border-border/60 px-3 py-2 typography-ui-label">{t('platformAccount.usageBillingDetails')}</CollapsibleTrigger>
            <CollapsibleContent className="pt-3">
              {billingAssets.map((asset) => {
                const amount = summary.data.charges_by_asset?.[asset];
                const refund = summary.data.refunds_by_asset?.[asset];
                return <React.Fragment key={asset}>
                  {asset !== 'CREDIT/6' && amount !== undefined && amount !== '0' && <SettingsFieldRow label={t('platformAccount.usageCharge')}><span dir="auto">{charge(asset, amount)}</span></SettingsFieldRow>}
                  {refund !== undefined && refund !== '0' && <SettingsFieldRow label={t('platformAccount.usageRefund')}><span dir="auto">{charge(asset, refund)}</span></SettingsFieldRow>}
                </React.Fragment>;
              })}
            </CollapsibleContent>
          </Collapsible>}
          {details && <Collapsible>
            <CollapsibleTrigger className="rounded-md border border-border/60 px-3 py-2 typography-ui-label">{t('platformAccount.usageMeasurements')}</CollapsibleTrigger>
            <CollapsibleContent className="space-y-3 pt-3">
              <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.usageRecordingHint')}</p>
              {summary.data.usage_coverage ? <>
                <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.usageCoverage', { legacy: summary.data.usage_coverage.legacy_token_calls, native: summary.data.usage_coverage.native_metered_calls })}</p>
                {summary.data.usage_coverage.legacy_token_calls === '0' && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.usageTokensUnrecorded')}</p>}
              </> : <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.usageCoverageUnknown')}</p>}
              {summary.data.native_usage?.flatMap((group) => group.measurements.map((measurement) => <SettingsFieldRow
                key={JSON.stringify([group.operation, measurement.key, measurement.unit, measurement.provider_unit])}
                label={<span dir="auto">{t(nativeOperationKeys[group.operation])} · <span className="whitespace-pre-wrap break-all">{dimensionLabel(measurement.key, measurement.unit)}</span></span>}>
                <span dir="auto">{formatPlatformQuantity(measurement.quantity)} {t(nativeUnitKeys[measurement.unit])}{measurement.provider_unit && <> · <span className="whitespace-pre-wrap break-all">{measurement.provider_unit}</span></>}</span>
              </SettingsFieldRow>))}
              {summary.data.usage_coverage && summary.data.usage_coverage.legacy_token_calls !== '0' ? <div>{tokenRows.map(([field, label]) => {
                const count = summary.data.usage[field];
                return count === undefined ? null : <SettingsFieldRow key={field} label={t(label)}><span dir="auto">{count}</span></SettingsFieldRow>;
              })}</div> : null}
            </CollapsibleContent>
          </Collapsible>}
        </>}
        {summary.data.unknown_time !== '0' && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.usageUnknownTime', { count: summary.data.unknown_time })}</p>}
      </>}
    </SettingsSection>
  );
};

export const PlatformAccountUsageSummary = ({ accountId }: { accountId: string }) => <UsageReport
  key={JSON.stringify([getRuntimeKey(), accountId])} accountId={accountId} details={false} />;

export const PlatformAccountUsage = ({ accountId }: { accountId: string }) => <UsageReport
  key={JSON.stringify([getRuntimeKey(), accountId])} accountId={accountId} details />;
