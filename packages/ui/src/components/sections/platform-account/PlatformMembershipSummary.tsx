import React from 'react';
import { Button } from '@/components/ui/button';
import { SettingsSection, SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import type { PlatformAccountState } from '@/lib/platformAccount';
import { formatPlatformPoints } from '@/lib/platformCommerce';

type SignedInAccount = Extract<PlatformAccountState, { status: 'signed-in' }>;

export const PlatformMembershipSummary: React.FC<{
  account: SignedInAccount;
  actions: {
    openMembership: () => void;
    openAddon: () => void;
    membershipOpen: boolean;
    addonOpen: boolean;
    disabled: boolean;
  } | null;
}> = ({ account, actions }) => {
  const { t } = useI18n();
  const now = Date.now();
  const memberships = account.membership.filter((membership) => membership.product_id === 'superwagie');
  const active = memberships.find((membership) => membership.status === 'active' && Date.parse(membership.paid_through) > now);
  const availableBatches = account.credits.batches?.filter((batch) => !batch.frozen && Date.parse(batch.startsAt) <= now && Date.parse(batch.expiresAt) > now);
  const kinds = ['subscription', 'addon', 'other'] as const;
  const showPoints = Boolean(active) || BigInt(account.credits.available) !== 0n || BigInt(account.credits.reserved) !== 0n;

  if (memberships.length === 0 && !showPoints) return null;

  return <SettingsSection className="min-w-0 space-y-4 py-2 @xl:col-span-2" divider={false} contentClassName="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 space-y-1">
        {memberships.length === 0 ? <p className="typography-ui-label">{t('platformAccount.noMembership')}</p> : memberships.map((membership) => <div key={membership.id} className="space-y-1">
          <p dir="auto" className="break-words text-lg font-medium">{membership.offer.name}</p>
          <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.paidThrough', { date: new Date(membership.paid_through).toLocaleDateString() })}{` · ${membership.status === 'refunded' ? t('platformAccount.membershipStatusRefunded') : membership.status === 'active' && Date.parse(membership.paid_through) > now ? t('platformAccount.membershipStatusActive') : Date.parse(membership.paid_through) <= now ? t('platformAccount.membershipExpired') : t('platformAccount.membershipStatusOther', { status: membership.status })}`}</p>
        </div>)}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={actions.disabled} aria-pressed={actions.membershipOpen} onClick={actions.openMembership}>{t(active ? 'platformAccount.manageMembership' : 'platformAccount.membershipPlans')}</Button>
        {showPoints && <Button size="sm" disabled={actions.disabled} aria-pressed={actions.addonOpen} onClick={actions.openAddon}>{t('platformAccount.addonPlans')}</Button>}
      </div>}
    </div>
    {showPoints && <>
    <dl className={`grid gap-3 ${availableBatches === undefined ? 'grid-cols-1' : 'grid-cols-2 @3xl:grid-cols-4'}`} aria-label={t('platformAccount.remainingPoints')}>
      <div className="oc-tile flex min-h-36 min-w-0 flex-col rounded-lg p-4">
        <dt className="typography-ui-label text-muted-foreground">{t('platformAccount.remainingPoints')}</dt>
        <dd dir="auto" className="mt-3 break-all text-3xl font-semibold tracking-tight tabular-nums">{formatPlatformPoints(account.credits.available)}</dd>
        <dd className={`mt-auto pt-3 ${SETTINGS_HELPER_CLASS}`}>{t('platformAccount.pointsUseOrder')}</dd>
      </div>
      {availableBatches !== undefined && kinds.map((kind) => {
        const batches = availableBatches.filter((batch) => batch.kind === kind);
        const available = batches.reduce((sum, batch) => sum + BigInt(batch.available), 0n);
        const nextExpiry = batches.filter((batch) => BigInt(batch.available) > 0n).map((batch) => batch.expiresAt).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
        return <div key={kind} className="oc-tile flex min-h-36 min-w-0 flex-col rounded-lg p-4">
          <dt className="typography-ui-label text-muted-foreground">{t(`platformAccount.pointsSource.${kind}`)}</dt>
          <dd dir="auto" className="mt-3 break-all text-2xl font-medium tracking-tight tabular-nums">{formatPlatformPoints(available.toString())}</dd>
          {nextExpiry && <dd className={`mt-auto pt-3 ${SETTINGS_HELPER_CLASS}`}>{t('platformAccount.pointsExpire', { date: new Date(nextExpiry).toLocaleDateString() })}</dd>}
        </div>;
      })}
    </dl>
    {availableBatches === undefined && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.batchDetailsUnavailable')}</p>}
    {!active && BigInt(account.credits.available) > 0n && <p role="status" className="rounded-md bg-[var(--status-warning-background)] px-3 py-2 text-[var(--status-warning-text)]">{t('platformAccount.pointsNeedSubscription')}</p>}
    </>}
  </SettingsSection>;
};
