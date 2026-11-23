import React from 'react';
import { Button } from '@/components/ui/button';
import { SettingsSection, SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import type { PlatformAccountState } from '@/lib/platformAccount';
import { formatPlatformPoints, formatProductBillingDate } from '@/lib/platformCommerce';

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
  const { t, locale } = useI18n();
  const displayDate = (value: string) => account.productCreditWallet ? formatProductBillingDate(value, locale) : new Date(value).toLocaleDateString();
  const now = Date.now();
  const memberships = account.membership.filter((membership) => membership.product_id === 'superwagie');
  const legacyActive = memberships.find((membership) => membership.status === 'active' && Date.parse(membership.paid_through) > now);
  const active = account.credits.activeMembership ?? Boolean(legacyActive);
  const shownMemberships = !account.productCreditWallet ? memberships : legacyActive && active
    ? [legacyActive] : memberships.sort((a, b) => Date.parse(b.paid_through) - Date.parse(a.paid_through)).slice(0, 1);
  const ownedBatches = account.productCreditWallet ? account.credits.batches?.filter((batch) => batch.productId === 'superwagie' && Date.parse(batch.expiresAt) > now) : undefined;
  const hasRetainedPacks = !active && ownedBatches?.some((batch) => batch.kind === 'addon' && BigInt(batch.available) > 0n);
  const availableBatches = account.credits.batches?.filter((batch) => !batch.frozen && Date.parse(batch.startsAt) <= now && Date.parse(batch.expiresAt) > now);
  const kinds = account.productCreditWallet ? ['subscription', 'addon'] as const : ['subscription', 'addon', 'other'] as const;
  const showPoints = active || hasRetainedPacks || BigInt(account.credits.available) !== 0n || BigInt(account.credits.reserved) !== 0n;

  if (memberships.length === 0 && !showPoints && (!actions || actions.membershipOpen)) return null;

  return <SettingsSection className="min-w-0 py-0 @xl:col-span-2" divider={false} contentClassName="space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 space-y-1">
        {memberships.length === 0 ? <div>
          <p className="typography-ui-label">{t(account.credits.membershipPaidThrough ? 'platformAccount.membershipExpired' : 'platformAccount.noMembership')}</p>
          {account.credits.membershipPaidThrough && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.paidThrough', { date: displayDate(account.credits.membershipPaidThrough) })}</p>}
        </div> : shownMemberships.map((membership) => <div key={membership.id} className="space-y-1">
          <p dir="auto" className="break-words text-lg font-medium">{membership.offer.name}</p>
          <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.paidThrough', { date: displayDate(membership.paid_through) })}{` · ${membership.status === 'refunded' ? t('platformAccount.membershipStatusRefunded') : membership.status === 'active' && Date.parse(membership.paid_through) > now ? t('platformAccount.membershipStatusActive') : Date.parse(membership.paid_through) <= now ? t('platformAccount.membershipExpired') : t('platformAccount.membershipStatusOther', { status: membership.status })}`}</p>
        </div>)}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={actions.disabled} aria-pressed={actions.membershipOpen} onClick={actions.openMembership}>{t(active ? 'platformAccount.manageMembership' : 'platformAccount.membershipPlans')}</Button>
        {showPoints && <Button size="sm" disabled={actions.disabled} aria-pressed={actions.addonOpen} onClick={actions.openAddon}>{t('platformAccount.addonPlans')}</Button>}
      </div>}
    </div>
    {showPoints && <>
    <dl className={`grid gap-3 ${availableBatches === undefined ? 'grid-cols-1' : account.productCreditWallet ? 'grid-cols-2 @xl:grid-cols-3' : 'grid-cols-2 @3xl:grid-cols-4'}`} aria-label={t('platformAccount.remainingPoints')}>
      <div className={`oc-tile flex min-h-24 min-w-0 flex-col rounded-lg p-4 ${account.productCreditWallet && availableBatches !== undefined ? 'col-span-2 @xl:col-span-1' : ''}`}>
        <dt className="typography-ui-label text-muted-foreground">{t('platformAccount.remainingPoints')}</dt>
        <dd dir="auto" className="mt-1 break-words text-3xl font-semibold tracking-tight tabular-nums">{formatPlatformPoints(account.credits.available)}</dd>
        <dd className={`mt-auto pt-2 ${SETTINGS_HELPER_CLASS}`}>{t(account.productCreditWallet ? 'platformAccount.productWallet.pointsUseOrder' : 'platformAccount.pointsUseOrder')}</dd>
      </div>
      {availableBatches !== undefined && kinds.map((kind) => {
        const relevantBatches = hasRetainedPacks && kind === 'addon' ? ownedBatches ?? [] : availableBatches;
        const batches = relevantBatches.filter((batch) => batch.kind === kind);
        const available = batches.reduce((sum, batch) => sum + BigInt(batch.available), 0n);
        const nextExpiry = batches.filter((batch) => BigInt(batch.available) > 0n).map((batch) => batch.expiresAt).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
        return <div key={kind} className="oc-tile flex min-h-24 min-w-0 flex-col rounded-lg p-4">
          <dt className="typography-ui-label text-muted-foreground">{t(hasRetainedPacks && kind === 'addon' ? 'platformAccount.productWallet.retainedPackCredits' : `platformAccount.pointsSource.${kind}`)}</dt>
          <dd dir="auto" className="mt-1 break-words text-2xl font-medium tracking-tight tabular-nums">{formatPlatformPoints(available.toString())}</dd>
          {nextExpiry && <dd className={`mt-auto pt-2 ${SETTINGS_HELPER_CLASS}`}>{t('platformAccount.pointsExpire', { date: displayDate(nextExpiry) })}</dd>}
        </div>;
      })}
    </dl>
    {availableBatches === undefined && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.batchDetailsUnavailable')}</p>}
    {!active && (hasRetainedPacks || BigInt(account.credits.available) > 0n) && <p role="status" className="rounded-md bg-[var(--status-warning-background)] px-3 py-2 text-[var(--status-warning-text)]">{t('platformAccount.pointsNeedSubscription')}</p>}
    {ownedBatches?.some((batch) => BigInt(batch.available) > 0n) && <details className="rounded-lg border border-border/60 px-4 py-2.5">
      <summary className="cursor-pointer typography-ui-label">{t('platformAccount.creditExpiryDetails')}</summary>
      <ul className="mt-2 space-y-1.5">
        {ownedBatches.filter((batch) => BigInt(batch.available) > 0n).map((batch) => <li key={batch.id} className={SETTINGS_HELPER_CLASS}>{t(batch.kind === 'addon' ? 'platformAccount.productWallet.packExpiry' : 'platformAccount.productWallet.subscriptionCreditExpiry', {
          points: formatPlatformPoints(batch.available), date: displayDate(batch.expiresAt),
        })}</li>)}
      </ul>
    </details>}
    </>}
  </SettingsSection>;
};
