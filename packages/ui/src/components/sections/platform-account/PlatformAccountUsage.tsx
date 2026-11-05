import React from 'react';
import { SettingsFieldRow, SettingsSection, SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { formatPlatformCredits, PlatformAccountError, readPlatformUsageCalls, readPlatformUsageSummary } from '@/lib/platformAccount';
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
const assets = ['CREDIT/6', 'CNY/6', 'LR_QUOTA/0'] as const;

const UsageReport = ({ accountId, product }: { accountId: string; product: 'superwagie' | 'llmrouter' }) => {
  const { t } = useI18n();
  const [revision, setRevision] = React.useState(0);
  const [summary, setSummary] = React.useState<Report<Summary>>({ status: 'loading' });
  const [calls, setCalls] = React.useState<Report<Calls>>({ status: 'loading' });
  React.useEffect(() => {
    const runtimeKey = getRuntimeKey();
    let active = true;
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
          {product === 'llmrouter' && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.usageRouterNoTokens')}</p>}
          {product === 'superwagie' && summary.data.settled_calls !== '0' && tokenRows.map(([field, label]) => {
            const count = summary.data.usage[field];
            return count === undefined ? null : <SettingsFieldRow key={field} label={t(label)}><span dir="auto">{count}</span></SettingsFieldRow>;
          })}
          {assets.map((asset) => {
            const amount = summary.data.charges_by_asset?.[asset];
            const refund = summary.data.refunds_by_asset?.[asset];
            return <React.Fragment key={asset}>
              {amount !== undefined && <SettingsFieldRow label={t('platformAccount.usageCharge')}><span dir="auto">{charge(asset, amount)}</span></SettingsFieldRow>}
              {refund !== undefined && <SettingsFieldRow label={t('platformAccount.usageRefund')}><span dir="auto">{charge(asset, refund)}</span></SettingsFieldRow>}
            </React.Fragment>;
          })}
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
