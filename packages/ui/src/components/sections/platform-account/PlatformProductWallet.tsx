import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SettingsChipGroup, SettingsControlGroup, SettingsFieldRow, SettingsSection, SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { formatPlatformMoney, formatPlatformPoints, updatePlatformRenewal, type PlatformProductWalletState } from '@/lib/platformCommerce';

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

export const PlatformProductWallet = ({ accountId, wallet, disabled, orderStatus, onWalletUpdated, onSaving }: {
  accountId: string;
  wallet: PlatformProductWalletState;
  disabled: boolean;
  orderStatus: (status: string) => string;
  onWalletUpdated: (wallet: PlatformProductWalletState) => void;
  onSaving: (saving: boolean) => void;
}) => {
  const { t } = useI18n();
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
  return <>
    <SettingsFieldRow label={t('platformAccount.productWallet.cash')}>
      <span dir="auto" className="tabular-nums">{t('platformAccount.cny', { amount: formatPlatformMoney(wallet.cash.available) })}</span>
    </SettingsFieldRow>
    {status && <p role={status === 'error' ? 'alert' : 'status'} className={SETTINGS_HELPER_CLASS}>{t(status === 'saving' ? 'platformAccount.loading' : status === 'saved' ? 'platformAccount.productWallet.renewalSaved' : 'platformAccount.productWallet.renewalFailed')}</p>}
    {wallet.products.map((product) => <SettingsSection key={product.product_id} title={<span dir="auto">{product.name}</span>}>
      <ProductRenewals key={JSON.stringify([product.subscription_renewal.version, product.addon_renewal.version])} product={product} disabled={disabled || !wallet.can_manage || status === 'saving'} save={(input) => void save(product.product_id, input)} />
      <SettingsControlGroup title={t('platformAccount.productWallet.purchaseHistory')}>
        {product.orders.length === 0 ? <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.noOrders')}</p> : product.orders.map((order) => <SettingsFieldRow key={order.id} label={order.offer_name}
          description={t('platformAccount.orderStates', { payment: orderStatus(order.payment_status), fulfillment: orderStatus(order.fulfillment_status), refund: order.refund_status ? orderStatus(order.refund_status) : t('platformAccount.noRefund') }) + (order.upgrade_refund_amount === undefined ? '' : ' · ' + t('platformAccount.productWallet.refundAmount', { amount: t('platformAccount.cny', { amount: formatPlatformMoney(order.upgrade_refund_amount) }) }))}>
          <span dir="auto" className="tabular-nums">{t('platformAccount.cny', { amount: formatPlatformMoney(order.amount) })} · {new Date(order.created_at).toLocaleDateString()}</span>
        </SettingsFieldRow>)}
      </SettingsControlGroup>
    </SettingsSection>)}
  </>;
};
