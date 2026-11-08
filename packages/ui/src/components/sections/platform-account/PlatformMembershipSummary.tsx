import React from 'react';
import { Button } from '@/components/ui/button';
import { SettingsSection, SettingsFieldRow, SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
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
      {actions && <Button size="sm" variant="outline" aria-pressed={actions.membershipOpen} onClick={actions.openMembership}>{t(active ? 'platformAccount.manageMembership' : 'platformAccount.membershipPlans')}</Button>}
    </div>
    {showPoints && <><div className="flex flex-wrap items-center justify-between gap-4">
      <div className="min-w-0 space-y-1">
        <p className="typography-ui-label">{t('platformAccount.available')}</p>
        <p dir="auto" className="break-all text-3xl font-medium tabular-nums">{formatPlatformPoints(account.credits.available)}</p>
        <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.pointsUseOrder')}</p>
      </div>
      {actions && <Button aria-pressed={actions.addonOpen} onClick={actions.openAddon}>{t('platformAccount.addonPlans')}</Button>}
    </div>
    {!active && BigInt(account.credits.available) > 0n && <p role="status" className="rounded-md bg-[var(--status-warning-background)] px-3 py-2 text-[var(--status-warning-text)]">{t('platformAccount.pointsNeedSubscription')}</p>}
    <div>
      {availableBatches === undefined ? <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.batchDetailsUnavailable')}</p> : kinds.map((kind) => {
        const batches = availableBatches.filter((batch) => batch.kind === kind);
        const available = batches.reduce((sum, batch) => sum + BigInt(batch.available), 0n);
        const nextExpiry = batches.filter((batch) => BigInt(batch.available) > 0n).map((batch) => batch.expiresAt).sort()[0];
        return <SettingsFieldRow key={kind} label={t(`platformAccount.pointsSource.${kind}`)} description={nextExpiry ? t('platformAccount.pointsExpire', { date: new Date(nextExpiry).toLocaleDateString() }) : undefined}>
          <span dir="auto" className="tabular-nums">{t('platformAccount.pointsAmount', { points: formatPlatformPoints(available.toString()) })}</span>
        </SettingsFieldRow>;
      })}
      <SettingsFieldRow label={t('platformAccount.reserved')} info={t('platformAccount.creditBenefitHint')}><span dir="auto" className="tabular-nums">{formatPlatformPoints(account.credits.reserved)}</span></SettingsFieldRow>
    </div>
    {availableBatches && availableBatches.some((batch) => BigInt(batch.available) > 0n) && <details>
      <summary className="cursor-pointer typography-ui-label">{t('platformAccount.pointBatches')}</summary>
      <div className="pt-2">{availableBatches.filter((batch) => BigInt(batch.available) > 0n).map((batch) => <SettingsFieldRow key={batch.id} label={t(`platformAccount.pointsSource.${batch.kind}`)} description={t('platformAccount.pointsExpire', { date: new Date(batch.expiresAt).toLocaleDateString() })}>
        <span dir="auto" className="tabular-nums">{t('platformAccount.pointsAmount', { points: formatPlatformPoints(batch.available) })}</span>
      </SettingsFieldRow>)}</div>
    </details>}</>}
  </SettingsSection>;
};
