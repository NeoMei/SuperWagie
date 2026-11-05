import React from 'react';
import { SettingsFieldRow, SettingsSection, SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useI18n } from '@/lib/i18n';
import { formatPlatformCredits, formatPlatformQuantity, PlatformAccountError, readPlatformUsageCalls, readPlatformUsageSummary } from '@/lib/platformAccount';
import { formatPlatformMoney } from '@/lib/platformCommerce';
import { getRuntimeKey } from '@/lib/runtime-switch';

type Report<T> = { status: 'loading' | 'denied' | 'failed' } | { status: 'ready'; data: T };
type Summary = Awaited<ReturnType<typeof readPlatformUsageSummary>>;
type Calls = Awaited<ReturnType<typeof readPlatformUsageCalls>>;

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

const UsageReport = ({ accountId, product }: { accountId: string; product: 'superwagie' | 'llmrouter' }) => {
  const { t } = useI18n();
  const [revision, setRevision] = React.useState(0);
  const [summary, setSummary] = React.useState<Report<Summary>>({ status: 'loading' });
  const [calls, setCalls] = React.useState<Report<Calls>>({ status: 'loading' });
  React.useEffect(() => {
    const runtimeKey = getRuntimeKey();
    let active = true;
    setSummary({ status: 'loading' }); setCalls({ status: 'loading' });
    const load = async <T,>(read: (id: string, product: 'superwagie' | 'llmrouter') => Promise<T>, publish: (report: Report<T>) => void) => {
      try {
        const data = await read(accountId, product);
        if (active && runtimeKey === getRuntimeKey()) publish({ status: 'ready', data });
      } catch (error) {
        if (active && runtimeKey === getRuntimeKey()) publish({ status: error instanceof PlatformAccountError && error.status === 403 ? 'denied' : 'failed' });
      }
    };
    void load(readPlatformUsageSummary, setSummary);
    void load(readPlatformUsageCalls, setCalls);
    return () => { active = false; };
  }, [accountId, product, revision]);

  const dimensionLabel = (key: string) => {
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
      case 'images': return t('platformAccount.dimension.images');
      default: return key;
    }
  };
  const charge = (asset: typeof assets[number], amount: string) => asset === 'CNY/6'
    ? t('platformAccount.cny', { amount: formatPlatformMoney(amount) })
    : asset === 'CREDIT/6' ? t('platformAccount.usageCreditAmount', { amount: formatPlatformCredits(amount) })
      : t('platformAccount.usageQuotaAmount', { amount });
  const message = (status: 'loading' | 'denied' | 'failed') => <p className={SETTINGS_HELPER_CLASS} role="status">{t(status === 'loading'
    ? 'platformAccount.loading' : status === 'denied' ? 'platformAccount.usageDenied' : 'platformAccount.usageFailed')}</p>;

  return <>
    <SettingsSection title={t(product === 'superwagie' ? 'platformAccount.usageSuperWagie' : 'platformAccount.usageLLMRouter')} contentClassName="space-y-3" headerAction={
      <Button variant="ghost" disabled={summary.status === 'loading' || calls.status === 'loading'} onClick={() => {
        setSummary({ status: 'loading' }); setCalls({ status: 'loading' }); setRevision((value) => value + 1);
      }}>{t(product === 'superwagie' ? 'platformAccount.usageRefresh' : 'platformAccount.usageRefreshRouter')}</Button>
    }>
      <p className={SETTINGS_HELPER_CLASS}>{t(product === 'superwagie' ? 'platformAccount.usageScope' : 'platformAccount.usageRouterScope')}</p>
      {summary.status !== 'ready' ? message(summary.status) : <>
        {summary.data.visibility === 'actor' && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.usageActorScope')}</p>}
        {summary.data.calls_total === '0' ? <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.usageEmpty')}</p> : <>
          <SettingsFieldRow label={t('platformAccount.usageCalls')}><span dir="auto">{summary.data.calls_total}</span></SettingsFieldRow>
          <SettingsFieldRow label={t('platformAccount.usageSettledCalls')}><span dir="auto">{summary.data.settled_calls}</span></SettingsFieldRow>
          {!summary.data.usage_complete && <>
            <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.usageIncomplete')}</p>
            <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.usageUnconfirmedCalls', { pending: summary.data.pending_calls, missing: summary.data.missing_usage_calls, unknown: summary.data.unknown_calls })}</p>
          </>}
          {product === 'llmrouter' && !summary.data.native_usage?.some((group) => group.measurements.some((measurement) => measurement.unit === 'token')) && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.usageRouterNoTokens')}</p>}
          {assets.map((asset) => {
            const amount = summary.data.charges_by_asset?.[asset];
            const refund = summary.data.refunds_by_asset?.[asset];
            return <React.Fragment key={asset}>
              {amount !== undefined && <SettingsFieldRow label={t('platformAccount.usageCharge')}><span dir="auto">{charge(asset, amount)}</span></SettingsFieldRow>}
              {refund !== undefined && <SettingsFieldRow label={t('platformAccount.usageRefund')}><span dir="auto">{charge(asset, refund)}</span></SettingsFieldRow>}
            </React.Fragment>;
          })}
          <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.usageRecordingHint')}</p>
          {summary.data.usage_coverage ? <>
            <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.usageCoverage', { legacy: summary.data.usage_coverage.legacy_token_calls, native: summary.data.usage_coverage.native_metered_calls })}</p>
            {summary.data.usage_coverage.legacy_token_calls === '0' && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.usageTokensUnrecorded')}</p>}
          </> : <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.usageCoverageUnknown')}</p>}
          {summary.data.native_usage?.flatMap((group) => group.measurements.map((measurement) => <SettingsFieldRow
            key={JSON.stringify([group.operation, measurement.key, measurement.unit, measurement.provider_unit])}
            label={<span dir="auto">{t(nativeOperationKeys[group.operation])} · {dimensionLabel(measurement.key)}</span>}>
            <span dir="auto">{formatPlatformQuantity(measurement.quantity)} {t(nativeUnitKeys[measurement.unit])}{measurement.provider_unit ? ` · ${measurement.provider_unit}` : ''}</span>
          </SettingsFieldRow>))}
          {product === 'superwagie' && summary.data.usage_coverage && summary.data.usage_coverage.legacy_token_calls !== '0' ? <Collapsible>
            <CollapsibleTrigger className="w-auto typography-meta">{t('platformAccount.usageTokenDetails')}</CollapsibleTrigger>
            <CollapsibleContent>{tokenRows.map(([field, label]) => {
              const count = summary.data.usage[field];
              return count === undefined ? null : <SettingsFieldRow key={field} label={t(label)}><span dir="auto">{count}</span></SettingsFieldRow>;
            })}</CollapsibleContent>
          </Collapsible> : null}
        </>}
        {summary.data.unknown_time !== '0' && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.usageUnknownTime', { count: summary.data.unknown_time })}</p>}
      </>}
    </SettingsSection>
    <SettingsSection title={t(product === 'superwagie' ? 'platformAccount.usageRecentCalls' : 'platformAccount.usageRecentRouterCalls')}>
      {calls.status !== 'ready' ? message(calls.status) : <>
        {calls.data.items.length === 0 && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.usageEmpty')}</p>}
        {calls.data.items.map((call) => <SettingsFieldRow key={call.call_id} label={<span dir="auto">{call.model}</span>}
          description={`${call.created_at ? new Date(call.created_at).toLocaleString() : t('platformAccount.usageNoTime')} · ${t('platformAccount.usageStatus', { status: call.status })}`}>
          {call.usage_status === 'unavailable' && <span>{t('platformAccount.usageRouterNoTokens')}</span>}
          {call.charged !== undefined && <span dir="auto">{t('platformAccount.usageCharge')}: {charge(call.asset, call.charged)}</span>}
          {call.held !== undefined && !['SETTLED', 'RELEASED', 'REJECTED', 'CANCELED'].includes(call.status) && <span dir="auto">{t('platformAccount.usageHeld')}: {charge(call.asset, call.held)}</span>}
          {call.refunded !== undefined && <span dir="auto">{t('platformAccount.usageRefund')}: {charge(call.asset, call.refunded)}</span>}
        </SettingsFieldRow>)}
        {calls.data.has_more && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.usageRecentLimit')}</p>}
      </>}
    </SettingsSection>
  </>;
};

export const PlatformAccountUsage = ({ accountId }: { accountId: string }) => <>
  <UsageReport accountId={accountId} product="superwagie" />
  <UsageReport accountId={accountId} product="llmrouter" />
</>;
