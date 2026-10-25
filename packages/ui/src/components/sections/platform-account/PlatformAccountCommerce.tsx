import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SettingsSection, SettingsFieldRow, SettingsControlGroup, SettingsChipGroup, SettingsRadioGroup, SettingsRadioOption, SETTINGS_HELPER_CLASS, SETTINGS_SELECT_ROW_TRIGGER_CLASS } from '@/components/sections/shared/SettingsSection';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { formatPlatformCredits, PlatformAccountError } from '@/lib/platformAccount';
import { readPlatformCommerce, createPlatformRecharge, purchasePlatformOffer, reconcilePlatformIntent, settlePlatformSandboxRecharge, formatPlatformMoney, parsePlatformRechargeAmount, type PlatformCommerceState, type PlatformCommerceIntent } from '@/lib/platformCommerce';
import { platformAccountErrorKey } from './platformAccountErrors';

type Product = 'superwagie' | 'llmrouter';
type PendingCommand = { kind: 'recharge'; productId: Product; amount: string; idempotencyKey: string }
  | { kind: 'purchase'; offerId: string; productId: string; amount: string; idempotencyKey: string };
const commandRejected = (error: PlatformAccountError) => ['platform_account_changed', 'platform_session_changed', 'platform_billing_forbidden', 'platform_scope_required', 'platform_offer_unavailable', 'platform_membership_active', 'platform_amount_invalid', 'platform_operation_pending', 'payment_not_configured', 'platform_idempotency_conflict'].includes(error.code);
const orderStatusKey = (status: string): I18nKey | null => {
  switch (status.toUpperCase()) {
    case 'UNPAID': return 'platformAccount.order.unpaid';
    case 'PAID': return 'platformAccount.order.paid';
    case 'PENDING': return 'platformAccount.order.pending';
    case 'FULFILLED': return 'platformAccount.order.fulfilled';
    case 'FAILED': return 'platformAccount.order.failed';
    case 'NONE': return 'platformAccount.noRefund';
    case 'REFUNDED': return 'platformAccount.order.refunded';
    case 'PARTIALLY_REFUNDED': return 'platformAccount.order.partiallyRefunded';
    case 'PROCESSING': return 'platformAccount.order.processing';
    case 'CANCELLED': return 'platformAccount.order.cancelled';
    case 'REJECTED': return 'platformAccount.order.rejected';
    default: return null;
  }
};

export const PlatformAccountCommerce: React.FC<{ accountId: string; hasActiveMembership: boolean; onAccountRefresh: () => void }> = ({ accountId, hasActiveMembership, onAccountRefresh }) => {
  const { t } = useI18n();
  const [state, setState] = React.useState<PlatformCommerceState | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<I18nKey | null>(null);
  const [offerId, setOfferId] = React.useState('');
  const [billingPeriod, setBillingPeriod] = React.useState<'month' | 'year'>('month');
  const [productId, setProductId] = React.useState<Product>('superwagie');
  const [amount, setAmount] = React.useState('');
  const [command, setCommand] = React.useState<PendingCommand | null>(null);
  const generation = React.useRef(0);
  const mutationActive = React.useRef(false);
  const runtimeKey = getRuntimeKey();
  const refresh = React.useCallback(async () => {
    const version = ++generation.current;
    setBusy(true); setError(null);
    try {
      const next = await readPlatformCommerce();
      if (version === generation.current && runtimeKey === getRuntimeKey()) {
        if (next.accountId !== accountId) throw new PlatformAccountError('platform_account_changed');
        setState(next);
        setCommand((previous) => previous && next.intents.some((intent) => intent.idempotencyKey === previous.idempotencyKey) ? null : previous);
      }
    } catch (cause) {
      if (version === generation.current && runtimeKey === getRuntimeKey()) { setError(platformAccountErrorKey(cause instanceof PlatformAccountError ? cause : null, 'platformAccount.commerceFailed')); setState(null); }
    } finally { if (version === generation.current && runtimeKey === getRuntimeKey()) setBusy(false); }
  }, [accountId, runtimeKey]);
  React.useEffect(() => { const requestGeneration = generation; void refresh(); return () => { ++requestGeneration.current; }; }, [refresh]);

  const mutate = async (operation: () => Promise<PlatformCommerceIntent>, original?: PendingCommand) => {
    if (mutationActive.current) return;
    mutationActive.current = true;
    const version = ++generation.current;
    let confirmed = false;
    setBusy(true); setError(null);
    if (original) setCommand(original);
    try {
      await operation();
      confirmed = true;
      if (version !== generation.current || runtimeKey !== getRuntimeKey()) return;
      setCommand(null);
      const next = await readPlatformCommerce();
      if (version !== generation.current || runtimeKey !== getRuntimeKey()) return;
      if (next.accountId !== accountId) throw new PlatformAccountError('platform_account_changed');
      setState(next); onAccountRefresh();
    } catch (cause) {
      if (version !== generation.current || runtimeKey !== getRuntimeKey()) return;
      if (original && cause instanceof PlatformAccountError && commandRejected(cause)) setCommand(null);
      setError(platformAccountErrorKey(cause instanceof PlatformAccountError ? cause : null, original && !confirmed ? 'platformAccount.commandUnknown' : 'platformAccount.commerceFailed'));
      // A failed read never leaves a balance presented as current.
      setState(null);
    } finally { mutationActive.current = false; if (version === generation.current && runtimeKey === getRuntimeKey()) setBusy(false); }
  };
  const submitCommand = (original: PendingCommand) => mutate(() => original.kind === 'recharge'
    ? createPlatformRecharge({ accountId, productId: original.productId, amount: original.amount, idempotencyKey: original.idempotencyKey })
    : purchasePlatformOffer({ accountId, offerId: original.offerId, idempotencyKey: original.idempotencyKey }), original);
  const recharge = (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const parsedAmount = parsePlatformRechargeAmount(amount);
      void submitCommand({ kind: 'recharge', productId, amount: parsedAmount, idempotencyKey: crypto.randomUUID() });
    } catch { setError('platformAccount.error.amount'); }
  };
  const selectedOffer = state?.offers?.find((offer) => offer.id === offerId);
  const memberships = state?.offers?.filter((offer) => offer.kind === 'membership' && offer.period === billingPeriod).sort((a, b) => a.rank - b.rank) ?? [];
  const addons = state?.offers?.filter((offer) => offer.kind === 'addon') ?? [];
  const membershipActive = hasActiveMembership && selectedOffer?.kind === 'membership';
  const wallet = selectedOffer && state?.wallets?.find((item) => item.productId === selectedOffer.productId);
  const insufficient = selectedOffer && state?.wallets !== null && BigInt(wallet?.amount ?? '0') < BigInt(selectedOffer.price);
  const unresolved = !!command || !!state?.intents.some((intent) => intent.status === 'PREPARED' || intent.status === 'UNKNOWN');
  const finance = state?.financialAccess === true;
  const sandbox = state?.payments.mode === 'sandbox';
  const productName = (product: string) => product === 'superwagie' ? 'SuperWagie' : product === 'llmrouter' ? 'llmrouter' : product;
  const walletName = (product: string) => product ? t('platformAccount.productWallet', { product: productName(product) }) : t('platformAccount.unifiedWallet');
  const orderStatus = (status: string) => {
    const key = orderStatusKey(status);
    return key ? t(key) : t('platformAccount.order.remoteStatus', { status });
  };
  const money = (units: string) => t('platformAccount.cny', { amount: formatPlatformMoney(units) });
  const selectOffer = (id: string | null) => {
    setOfferId(id ?? ''); setError(null);
    const offer = state?.offers?.find((item) => item.id === id);
    if (offer?.productId === 'superwagie' || offer?.productId === 'llmrouter') setProductId(offer.productId);
  };
  const fundSelectedOffer = () => {
    if (!selectedOffer || (selectedOffer.productId !== 'superwagie' && selectedOffer.productId !== 'llmrouter')) return;
    const shortfall = BigInt(selectedOffer.price) - BigInt(wallet?.amount ?? '0');
    const wholeCents = ((shortfall + 9_999n) / 10_000n) * 10_000n;
    setProductId(selectedOffer.productId); setAmount(formatPlatformMoney(wholeCents.toString()));
    document.getElementById('unihub-recharge-amount')?.focus();
  };
  return <SettingsSection title={t('platformAccount.commerce')} headerAction={<Button variant="ghost" disabled={busy} onClick={() => void refresh()}>{t('platformAccount.refreshCommerce')}</Button>} contentClassName="space-y-6">
    <p className={`min-h-5 ${error ? 'text-[var(--status-error-text)]' : SETTINGS_HELPER_CLASS}`} role={error ? 'alert' : 'status'}>{error ? t(error) : busy ? t('platformAccount.loading') : null}</p>
    {command && !busy && <SettingsControlGroup title={t('platformAccount.originalRequest')} description={t('platformAccount.commandUnknown')}>
      <p className={SETTINGS_HELPER_CLASS}>{t(command.kind === 'recharge' ? 'platformAccount.rechargeRecord' : 'platformAccount.purchaseRecord', { product: productName(command.productId), amount: money(command.amount) })}</p>
      <Button variant="outline" disabled={busy} onClick={() => void submitCommand(command)}>{t('platformAccount.retryOriginal')}</Button>
    </SettingsControlGroup>}
    {state && <>
      <p className="rounded-md bg-[var(--status-warning-background)] p-3 text-[var(--status-warning-text)]" role="status">{t(sandbox ? 'platformAccount.sandboxNotice' : 'platformAccount.paymentUnconfigured')}</p>
      {!finance && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.memberRestricted')}</p>}
      {state.missingScopes.length > 0 && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.missingScopes', { scopes: state.missingScopes.join(', ') })}</p>}
      <SettingsControlGroup title={t('platformAccount.membershipPlans')} description={t('platformAccount.membershipRules')}>
        <SettingsFieldRow label={t('platformAccount.billingPeriod')}>
          <SettingsChipGroup value={billingPeriod} onChange={(period) => {
            setBillingPeriod(period);
            if (selectedOffer?.kind === 'membership' && selectedOffer.period !== period) setOfferId('');
          }} aria-label={t('platformAccount.billingPeriod')} options={[
            { value: 'month', label: t('platformAccount.monthly'), disabled: busy || unresolved },
            { value: 'year', label: t('platformAccount.yearly'), disabled: busy || unresolved },
          ]} />
        </SettingsFieldRow>
        {state.offers === null ? <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.offersUnavailable')}</p>
          : memberships.length === 0 ? <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.noMembershipOffers')}</p>
          : <SettingsRadioGroup aria-label={t('platformAccount.membershipPlans')}>
            {memberships.map((offer) => <SettingsRadioOption key={offer.id} selected={offerId === offer.id} onSelect={() => selectOffer(offer.id)} disabled={busy || unresolved}
              ariaLabel={offer.name} label={<span dir="auto">{offer.name}</span>}
              description={t(billingPeriod === 'year' ? 'platformAccount.annualOfferSummary' : 'platformAccount.monthlyOfferSummary', { price: money(offer.price), credits: formatPlatformCredits(offer.monthlyCredit) })} />)}
          </SettingsRadioGroup>}
        {hasActiveMembership && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.membershipActive')}</p>}
      </SettingsControlGroup>
      <SettingsControlGroup title={t('platformAccount.addonPlans')} description={t('platformAccount.addonRules')}>
        {state.offers === null ? <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.offersUnavailable')}</p>
          : addons.length === 0 ? <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.noAddonOffers')}</p>
          : <SettingsRadioGroup aria-label={t('platformAccount.addonPlans')}>
            {addons.map((offer) => <SettingsRadioOption key={offer.id} selected={offerId === offer.id} onSelect={() => selectOffer(offer.id)} disabled={busy || unresolved}
              ariaLabel={offer.name} label={<span dir="auto">{offer.name}</span>}
              description={t('platformAccount.addonOfferSummary', { price: money(offer.price), credits: formatPlatformCredits(offer.monthlyCredit), count: offer.validityMonths })} />)}
          </SettingsRadioGroup>}
      </SettingsControlGroup>
      <SettingsControlGroup title={t('platformAccount.purchaseSelection')}>
        {!selectedOffer && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.choosePurchase')}</p>}
          {selectedOffer && <div className="space-y-2">
            <SettingsFieldRow label={t('platformAccount.offer')}><span dir="auto">{selectedOffer.name}</span></SettingsFieldRow>
            <SettingsFieldRow label={t('platformAccount.price')}><span dir="auto">{money(selectedOffer.price)}</span></SettingsFieldRow>
            <SettingsFieldRow label={t('platformAccount.walletDestination')}><span>{walletName(selectedOffer.productId)}</span></SettingsFieldRow>
            <SettingsFieldRow label={t(selectedOffer.kind === 'membership' ? 'platformAccount.monthlyCreditGrant' : 'platformAccount.creditGrant')}><span dir="auto">{formatPlatformCredits(selectedOffer.monthlyCredit)}</span></SettingsFieldRow>
            {selectedOffer.kind === 'addon' ? <SettingsFieldRow label={t('platformAccount.offerValidity')}><span>{t('platformAccount.months', { count: selectedOffer.validityMonths })}</span></SettingsFieldRow>
              : <SettingsFieldRow label={t('platformAccount.billingPeriod')}><span>{selectedOffer.period === 'month' ? t('platformAccount.monthly') : selectedOffer.period === 'year' ? t('platformAccount.yearly') : t('platformAccount.order.remoteStatus', { status: selectedOffer.period })}</span></SettingsFieldRow>}
            {insufficient && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.insufficientWallet')}</p>}
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy || unresolved || !finance || !sandbox || !selectedOffer.sandbox || membershipActive || !state.payments.canPurchase || !!insufficient || state.wallets === null} onClick={() => void submitCommand({ kind: 'purchase', offerId: selectedOffer.id, productId: selectedOffer.productId, amount: selectedOffer.price, idempotencyKey: crypto.randomUUID() })}>{t('platformAccount.purchase', { name: selectedOffer.name, price: money(selectedOffer.price) })}</Button>
              {insufficient && !membershipActive && finance && sandbox && state.payments.canRecharge && <Button variant="outline" disabled={busy || unresolved} onClick={fundSelectedOffer}>{t('platformAccount.fundPurchase')}</Button>}
            </div>
          </div>}
      </SettingsControlGroup>
      {finance && <SettingsControlGroup title={t('platformAccount.wallets')}>
        {state.wallets === null ? <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.walletsUnavailable')}</p> : state.wallets.length === 0 ? <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.noWallets')}</p> : state.wallets.map((item) => <SettingsFieldRow key={item.productId} label={walletName(item.productId)}><span dir="auto">{money(item.amount)}</span></SettingsFieldRow>)}
      </SettingsControlGroup>}
      {finance && <SettingsControlGroup title={t('platformAccount.recharge')} description={t('platformAccount.rechargeHint')}>
        <form onSubmit={recharge} className="space-y-2">
          <SettingsFieldRow label={t('platformAccount.walletDestination')}>
            <Select value={productId} disabled={busy || unresolved || !state.payments.canRecharge} onValueChange={(value) => { if (value === 'superwagie' || value === 'llmrouter') setProductId(value); }}>
              <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={t('platformAccount.walletDestination')}><SelectValue>{t('platformAccount.productWallet', { product: productName(productId) })}</SelectValue></SelectTrigger>
              <SelectContent>{(['superwagie', 'llmrouter'] as const).map((product) => <SelectItem key={product} value={product}>{t('platformAccount.productWallet', { product: productName(product) })}</SelectItem>)}</SelectContent>
            </Select>
          </SettingsFieldRow>
          <SettingsFieldRow label={<label htmlFor="unihub-recharge-amount">{t('platformAccount.rechargeAmount')}</label>}>
            <Input id="unihub-recharge-amount" inputMode="decimal" className="max-w-48" value={amount} onChange={(event) => setAmount(event.target.value)} disabled={busy || unresolved || !state.payments.canRecharge} required />
          </SettingsFieldRow>
          <Button type="submit" disabled={busy || unresolved || !sandbox || !state.payments.canRecharge}>{t('platformAccount.createRecharge')}</Button>
        </form>
      </SettingsControlGroup>}
      {finance && <SettingsControlGroup title={t('platformAccount.history')} description={t('platformAccount.historyScope')} contentClassName="space-y-4">
        {state.intents.length === 0 && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.noIntents')}</p>}
        {state.intents.map((intent) => <SettingsFieldRow key={intent.idempotencyKey} label={t(intent.kind === 'recharge' ? 'platformAccount.rechargeRecord' : 'platformAccount.purchaseRecord', { product: productName(intent.productId), amount: money(intent.amount) })} description={<>{t(`platformAccount.intent.${intent.status}`)}{intent.errorCode ? ` · ${t(platformAccountErrorKey(new PlatformAccountError(intent.errorCode), 'platformAccount.commerceFailed'))}` : ''}</>}>
          {intent.status !== 'APPLIED' && intent.status !== 'FAILED' && <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={busy} onClick={() => void mutate(() => reconcilePlatformIntent(accountId, intent.idempotencyKey))}>{t('platformAccount.checkIntent')}</Button>
            {intent.kind === 'recharge' && intent.status === 'PENDING' && intent.resourceId && sandbox && state.payments.canRecharge && <Button variant="outline" disabled={busy} onClick={() => void mutate(() => settlePlatformSandboxRecharge(accountId, intent.idempotencyKey))}>{t('platformAccount.simulateSettlement')}</Button>}
          </div>}
        </SettingsFieldRow>)}
        {state.orders === null ? <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.ordersUnavailable')}</p> : state.orders.length === 0 ? <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.noOrders')}</p> : state.orders.map((order) => <SettingsFieldRow key={order.id} label={order.offerName} description={t('platformAccount.orderStates', { payment: orderStatus(order.paymentStatus), fulfillment: orderStatus(order.fulfillmentStatus), refund: order.refundStatus ? orderStatus(order.refundStatus) : t('platformAccount.noRefund') })}><span dir="auto">{money(order.amount)}</span></SettingsFieldRow>)}
      </SettingsControlGroup>}
    </>}
  </SettingsSection>;
};
