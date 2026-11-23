import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SettingsChipGroup, SettingsControlGroup, SettingsFieldRow, SettingsSection, SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { formatPlatformMoney, formatPlatformPoints, formatProductBillingDate, updatePlatformRenewal, type PlatformProductWalletState } from '@/lib/platformCommerce';

type WalletProduct = PlatformProductWalletState['products'][number];
type RenewalInput = Parameters<typeof updatePlatformRenewal>[2];

const creditUnits = (input: string) => {
  if (!/^\d{1,12}(?:\.\d{1,6})?$/.test(input.trim())) return null;
  const [whole, fraction = ''] = input.trim().split('.');
  return (BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))).toString();
};

const ProductRenewals = ({ product, disabled, save }: {
  product: WalletProduct;
  disabled: boolean;
  save: (input: RenewalInput) => void;
}) => {
  const { t } = useI18n();
  const subscription = product.subscription_renewal;
  const renewalDescription = subscription.offer_name && subscription.price !== undefined
    ? t('platformAccount.productWallet.subscriptionRenewalPrice', { name: subscription.offer_name, price: t('platformAccount.cny', { amount: formatPlatformMoney(subscription.price) }) })
    : null;
  const addon = product.addon_renewal;
  const [offerId, setOfferId] = React.useState(addon.offer_id ?? '');
  const [trigger, setTrigger] = React.useState<'exhausted' | 'threshold'>(addon.trigger ?? 'exhausted');
  const [threshold, setThreshold] = React.useState(addon.threshold === undefined ? '' : formatPlatformPoints(addon.threshold));
  const selected = product.addon_offers.find((offer) => offer.id === offerId);
  const limit = trigger === 'threshold' ? creditUnits(threshold) : null;
  return <>
    <SettingsFieldRow label={t('platformAccount.productWallet.subscriptionRenewal')} description={renewalDescription ?? t('platformAccount.productWallet.subscriptionRenewalRequiresPlan')}>
      <Button size="sm" variant="outline" disabled={disabled || (!subscription.enabled && renewalDescription === null)} onClick={() => save({ kind: 'subscription', enabled: !subscription.enabled, expectedVersion: subscription.version })}>
        {t(subscription.enabled ? 'platformAccount.productWallet.disableSubscription' : 'platformAccount.productWallet.enableSubscription')}
      </Button>
    </SettingsFieldRow>
    {(product.addon_offers.length > 0 || addon.enabled) && <SettingsControlGroup title={t('platformAccount.productWallet.addonRenewal')} description={t('platformAccount.productWallet.addonRenewalConsent')}>
      <SettingsFieldRow label={t('platformAccount.productWallet.addonOffer')}>
        <Select value={offerId} onValueChange={(value) => setOfferId(value ?? '')} disabled={disabled}>
          <SelectTrigger aria-label={t('platformAccount.productWallet.addonOffer')}><SelectValue placeholder={t('platformAccount.productWallet.choosePack')}>{selected?.name}</SelectValue></SelectTrigger>
          <SelectContent>
            {product.addon_offers.map((offer) => <SelectItem key={offer.id} value={offer.id}><span dir="auto">{offer.name} · {t('platformAccount.cny', { amount: formatPlatformMoney(offer.price) })}</span></SelectItem>)}
          </SelectContent>
        </Select>
      </SettingsFieldRow>
      <SettingsFieldRow label={t('platformAccount.productWallet.addonTrigger')}>
        <SettingsChipGroup value={trigger} onChange={setTrigger} aria-label={t('platformAccount.productWallet.addonTrigger')} options={[
          { value: 'exhausted', label: t('platformAccount.productWallet.exhausted'), disabled },
          { value: 'threshold', label: t('platformAccount.productWallet.threshold'), disabled },
        ]} />
      </SettingsFieldRow>
      {trigger === 'threshold' && <SettingsFieldRow label={t('platformAccount.productWallet.creditThreshold')}>
        <Input inputMode="decimal" dir="ltr" disabled={disabled} aria-label={t('platformAccount.productWallet.creditThreshold')} value={threshold} onChange={(event) => setThreshold(event.target.value)} />
      </SettingsFieldRow>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={disabled || !selected || trigger === 'threshold' && (limit === null || limit === '0')} onClick={() => {
          if (selected) save({ kind: 'addon', enabled: true, expectedVersion: addon.version, offerId: selected.id, trigger, threshold: limit ?? undefined });
        }}>{t(addon.enabled ? 'platformAccount.productWallet.updateAddon' : 'platformAccount.productWallet.enableAddon')}</Button>
        {addon.enabled && <Button size="sm" variant="ghost" disabled={disabled} onClick={() => save({ kind: 'addon', enabled: false, expectedVersion: addon.version })}>
          {t('platformAccount.productWallet.disableAddon')}
        </Button>}
      </div>
    </SettingsControlGroup>}
  </>;
};

export const PlatformProductWallet = ({ accountId, wallet, disabled, orderStatus, topUps, onWalletUpdated, onSaving }: {
  accountId: string;
  wallet: PlatformProductWalletState;
  disabled: boolean;
  orderStatus: (status: string) => string;
  topUps: React.ReactNode[];
  onWalletUpdated: (wallet: PlatformProductWalletState) => void;
  onSaving: (saving: boolean) => void;
}) => {
  const { t, locale } = useI18n();
  const [status, setStatus] = React.useState<'saving' | 'saved' | 'error' | null>(null);
  const mounted = React.useRef(false);
  const saving = React.useRef(false);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const save = async (productId: string, input: RenewalInput) => {
    if (disabled || saving.current || !wallet.can_manage) return;
    const runtime = getRuntimeKey();
    saving.current = true; onSaving(true); setStatus('saving');
    const current = () => mounted.current && getRuntimeKey() === runtime;
    try {
      const updated = await updatePlatformRenewal(accountId, productId, input);
      if (!current()) return;
      if (updated.account_id !== accountId) { setStatus('error'); return; }
      onWalletUpdated(updated);
      setStatus('saved');
    } catch {
      if (current()) setStatus('error');
    } finally {
      saving.current = false;
      if (getRuntimeKey() === runtime) onSaving(false);
    }
  };
  const disclosure = 'flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 typography-ui-label font-semibold [&::-webkit-details-marker]:hidden';
  const indicator = <Icon name="arrow-down-s" className="size-4 shrink-0 text-muted-foreground group-open:rotate-180" />;
  return <div className="divide-y divide-border/60 border-t border-border/60">
    {wallet.products.length > 0 && <details className="group">
      <summary className={disclosure}>{t('platformAccount.productWallet.renewals')}{indicator}</summary>
      <div className="pb-4">
        {status && <p role={status === 'error' ? 'alert' : 'status'} className={SETTINGS_HELPER_CLASS}>{t(status === 'saving' ? 'platformAccount.loading' : status === 'saved' ? 'platformAccount.productWallet.renewalSaved' : 'platformAccount.productWallet.renewalFailed')}</p>}
        {wallet.products.map((product) => <SettingsSection key={product.product_id} title={<span dir="auto">{product.name}</span>}>
          <ProductRenewals key={JSON.stringify([product.subscription_renewal.version, product.addon_renewal.version])} product={product} disabled={disabled || !wallet.can_manage || status === 'saving'} save={(input) => void save(product.product_id, input)} />
        </SettingsSection>)}
      </div>
    </details>}
    <details className="group" open>
      <summary className={disclosure}>{t('platformAccount.productWallet.transactions')}{indicator}</summary>
      <div className="space-y-4 pb-4">
        {topUps.length > 0 && <section className="space-y-1">
          <h3 className={SETTINGS_HELPER_CLASS}>{t('platformAccount.productWallet.topUp')}</h3>
          <div className="divide-y divide-border/60">{topUps}</div>
        </section>}
        <section className="space-y-1">
          <h3 className={SETTINGS_HELPER_CLASS}>{t('platformAccount.productWallet.purchaseHistory')}</h3>
          {!wallet.products.some((product) => product.orders.length > 0) && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.noOrders')}</p>}
          {wallet.products.filter((product) => product.orders.length > 0).map((product) => <div key={product.product_id} className="divide-y divide-border/60">
            {wallet.products.length > 1 && <h4 className="typography-meta py-2" dir="auto">{product.name}</h4>}
            {product.orders.map((order) => <div key={order.id} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-3 py-2.5">
              <div className="min-w-0 space-y-0.5">
                <p className="typography-ui-label break-words" dir="auto">{order.offer_name}</p>
                <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.orderStates', { payment: orderStatus(order.payment_status), fulfillment: orderStatus(order.fulfillment_status), refund: order.refund_status ? orderStatus(order.refund_status) : t('platformAccount.noRefund') })}</p>
                {order.upgrade_refund_amount !== undefined && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.productWallet.refundAmount', { amount: t('platformAccount.cny', { amount: formatPlatformMoney(order.upgrade_refund_amount) }) })}</p>}
              </div>
              <div className="space-y-0.5 text-end">
                <p dir="ltr" className="typography-ui-label tabular-nums">¥{formatPlatformMoney(order.amount)}</p>
                <time dateTime={order.created_at} className={SETTINGS_HELPER_CLASS}>{formatProductBillingDate(order.created_at, locale)}</time>
              </div>
            </div>)}
          </div>)}
        </section>
      </div>
    </details>
  </div>;
};
