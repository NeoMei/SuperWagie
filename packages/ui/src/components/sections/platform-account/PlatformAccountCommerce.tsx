import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SettingsSection, SettingsFieldRow, SettingsControlGroup, SettingsChipGroup, SettingsRadioGroup, SettingsRadioOption, SettingsTwoColumn, SETTINGS_HELPER_CLASS, SETTINGS_SELECT_ROW_TRIGGER_CLASS } from '@/components/sections/shared/SettingsSection';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { PlatformAccountError, type PlatformAccountState } from '@/lib/platformAccount';
import { readPlatformCommerce, createPlatformCheckout, updatePlatformCheckout, createPlatformRecharge, purchasePlatformOffer, createPlatformUpgradeQuote, acceptPlatformUpgradeQuote, reconcilePlatformIntent, settlePlatformSandboxRecharge, formatPlatformMoney, formatPlatformPoints, parsePlatformRechargeAmount, type PlatformCommerceState, type PlatformCommerceIntent, type PlatformUpgradeQuote } from '@/lib/platformCommerce';
import { PlatformCheckoutCard } from './PlatformCheckoutCard';
import { platformAccountErrorKey } from './platformAccountErrors';
import { usePlatformAccountTabStore } from './platformAccountTabs';

type Product = 'superwagie' | 'llmrouter';
type PendingCommand = { kind: 'checkout'; offerId?: string; quoteId?: string; provider: 'wechat' | 'alipay'; productId: string; amount: string; idempotencyKey: string }
  | { kind: 'recharge'; productId: Product; amount: string; idempotencyKey: string }
  | { kind: 'purchase'; offerId: string; productId: string; amount: string; idempotencyKey: string }
  | { kind: 'upgrade'; quoteId: string; productId: string; amount: string; idempotencyKey: string };
const commandRejected = (error: PlatformAccountError, original: PendingCommand) => (original.kind !== 'recharge' && error.code === 'credit_rates_unavailable' && error.status === 409) || ['platform_account_changed', 'platform_session_changed', 'platform_billing_forbidden', 'platform_scope_required', 'platform_offer_unavailable', 'platform_membership_active', 'platform_amount_invalid', 'platform_operation_pending', 'payment_not_configured', 'platform_idempotency_conflict', 'subscription_required', 'quote_expired', 'platform_quote_expired', 'platform_quote_unavailable', 'points_runtime_unavailable', 'unsupported_plan_change'].includes(error.code);
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

export const PlatformAccountCommerce: React.FC<{
  accountId: string;
  payer: string;
  view: 'overview' | 'orders';
  hasActiveMembership: boolean;
  currentMembership?: Extract<PlatformAccountState, { status: 'signed-in' }>['membership'][number];
  membershipSummary: (actions: { openMembership: () => void; openAddon: () => void; membershipOpen: boolean; addonOpen: boolean }) => React.ReactNode;
  onAccountRefresh: () => void;
}> = ({ accountId, payer, view, hasActiveMembership, currentMembership, membershipSummary, onAccountRefresh }) => {
  const { t } = useI18n();
  const [state, setState] = React.useState<PlatformCommerceState | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<I18nKey | null>(null);
  const [offerId, setOfferId] = React.useState('');
  const [billingPeriod, setBillingPeriod] = React.useState<'month' | 'year'>('month');
  const rechargeTarget = usePlatformAccountTabStore((store) => store.rechargeTarget);
  const purchaseTarget = usePlatformAccountTabStore((store) => store.purchaseTarget);
  const [buyingTask, setBuyingTask] = React.useState<'membership' | 'addon' | 'recharge' | null>(rechargeTarget ? 'recharge' : hasActiveMembership ? null : 'membership');
  const [paymentChannel, setPaymentChannel] = React.useState<'wechat' | 'alipay' | 'wallet'>('wechat');
  const [quote, setQuote] = React.useState<PlatformUpgradeQuote | null>(null);
  const [purchaseApplied, setPurchaseApplied] = React.useState(false);
  const [productId, setProductId] = React.useState<Product>(rechargeTarget ?? 'superwagie');
  const rechargeFormRef = React.useRef<HTMLFormElement>(null);
  const revealRecharge = React.useRef(Boolean(rechargeTarget));
  const [amount, setAmount] = React.useState('');
  const [command, setCommand] = React.useState<PendingCommand | null>(null);
  const generation = React.useRef(0);
  const accountRefresh = React.useRef(onAccountRefresh);
  accountRefresh.current = onAccountRefresh;
  const observedBenefits = React.useRef('');
  const mutationActive = React.useRef(false);
  const runtimeKey = getRuntimeKey();
  React.useEffect(() => {
    if (!rechargeTarget) return;
    revealRecharge.current = true;
    setProductId(rechargeTarget);
    setBuyingTask('recharge');
    usePlatformAccountTabStore.getState().clearRechargeTarget();
  }, [rechargeTarget]);
  React.useEffect(() => {
    if (!purchaseTarget) return;
    setBuyingTask(purchaseTarget === 'funding' ? hasActiveMembership ? 'addon' : 'membership' : purchaseTarget);
    usePlatformAccountTabStore.getState().clearPurchaseTarget();
  }, [purchaseTarget, hasActiveMembership]);
  React.useLayoutEffect(() => {
    if (!revealRecharge.current || !rechargeFormRef.current) return;
    rechargeFormRef.current.scrollIntoView({ block: 'center' });
    revealRecharge.current = false;
  }, [state, view, buyingTask, rechargeTarget]);
  const refresh = React.useCallback(async () => {
    const version = ++generation.current;
    setBusy(true); setError(null); setPurchaseApplied(false);
    try {
      const next = await readPlatformCommerce();
      if (version === generation.current && runtimeKey === getRuntimeKey()) {
        if (next.accountId !== accountId) throw new PlatformAccountError('platform_account_changed');
        const fulfilled = (next.checkouts ?? []).filter((checkout) => checkout.payment_status === 'PAID' && checkout.fulfillment_status === 'FULFILLED' || checkout.refund_status === 'SUCCEEDED');
        const benefitsSignature = JSON.stringify([runtimeKey, accountId, fulfilled.sort((a, b) => a.id.localeCompare(b.id)).map((checkout) => [checkout.id, checkout.refund_status])]);
        if (fulfilled.length && observedBenefits.current !== benefitsSignature) accountRefresh.current();
        observedBenefits.current = benefitsSignature;
        setState(next);
        setCommand((previous) => previous && next.intents.some((intent) => intent.idempotencyKey === previous.idempotencyKey) ? null : previous);
      }
    } catch (cause) {
      if (version === generation.current && runtimeKey === getRuntimeKey()) { setError(platformAccountErrorKey(cause instanceof PlatformAccountError ? cause : null, 'platformAccount.commerceFailed')); }
    } finally { if (version === generation.current && runtimeKey === getRuntimeKey()) setBusy(false); }
  }, [accountId, runtimeKey]);
  React.useEffect(() => { const requestGeneration = generation; void refresh(); return () => { ++requestGeneration.current; }; }, [refresh]);

  const mutate = async (operation: () => Promise<PlatformCommerceIntent>, original?: PendingCommand) => {
    if (mutationActive.current) return;
    mutationActive.current = true;
    const version = ++generation.current;
    let confirmed = false;
    setBusy(true); setError(null); setPurchaseApplied(false);
    if (original) setCommand(original);
    try {
      const result = await operation();
      confirmed = true;
      if (result.status === 'FAILED' && result.errorCode === 'credit_rates_unavailable') {
        if (version !== generation.current || runtimeKey !== getRuntimeKey()) return;
        setCommand(null); setError('platformAccount.creditRatesUnavailable');
        const next = await readPlatformCommerce();
        if (version !== generation.current || runtimeKey !== getRuntimeKey()) return;
        if (next.accountId !== accountId) throw new PlatformAccountError('platform_account_changed');
        setState(next); return;
      }
      if (version !== generation.current || runtimeKey !== getRuntimeKey()) return;
      setCommand(null);
      if ((result.kind === 'upgrade' || result.kind === 'checkout' && !!result.quoteId) && result.status === 'FAILED' && result.errorCode === 'quote_invalidated') setQuote(null);
      const next = await readPlatformCommerce();
      if (version !== generation.current || runtimeKey !== getRuntimeKey()) return;
      if (next.accountId !== accountId) throw new PlatformAccountError('platform_account_changed');
      setState(next); onAccountRefresh();
      if (result.status === 'FAILED') setError(platformAccountErrorKey(new PlatformAccountError(result.errorCode ?? ''), 'platformAccount.commerceFailed'));
      if (result.status === 'APPLIED' && result.kind !== 'recharge') { setPurchaseApplied(true); setQuote(null); setOfferId(''); setBuyingTask(null); }
    } catch (cause) {
      if (version !== generation.current || runtimeKey !== getRuntimeKey()) return;
      const quoteInvalidated = !confirmed && (original?.kind === 'upgrade' || original?.kind === 'checkout' && !!original.quoteId) && cause instanceof PlatformAccountError && cause.code === 'quote_invalidated' && cause.status === 409;
      if (quoteInvalidated) { setQuote(null); setCommand(null); }
      else if (original && cause instanceof PlatformAccountError && commandRejected(cause, original)) setCommand(null);
      setError(platformAccountErrorKey(cause instanceof PlatformAccountError ? cause : null, original && !confirmed ? 'platformAccount.commandUnknown' : 'platformAccount.commerceFailed'));
      // A failed read never leaves a balance presented as current.
      if (!quoteInvalidated && !(original?.kind === 'purchase' && cause instanceof PlatformAccountError && cause.code === 'credit_rates_unavailable' && cause.status === 409)) setState(null);
    } finally { mutationActive.current = false; if (version === generation.current && runtimeKey === getRuntimeKey()) setBusy(false); }
  };
  const submitCommand = (original: PendingCommand) => mutate(() => original.kind === 'checkout'
    ? createPlatformCheckout({ accountId, offerId: original.offerId, quoteId: original.quoteId, provider: original.provider, idempotencyKey: original.idempotencyKey })
    : original.kind === 'recharge'
    ? createPlatformRecharge({ accountId, productId: original.productId, amount: original.amount, idempotencyKey: original.idempotencyKey })
    : original.kind === 'upgrade'
      ? acceptPlatformUpgradeQuote({ accountId, quoteId: original.quoteId, idempotencyKey: original.idempotencyKey })
      : purchasePlatformOffer({ accountId, offerId: original.offerId, idempotencyKey: original.idempotencyKey }), original);
  const recharge = (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const parsedAmount = parsePlatformRechargeAmount(amount);
      void submitCommand({ kind: 'recharge', productId, amount: parsedAmount, idempotencyKey: crypto.randomUUID() });
    } catch { setError('platformAccount.error.amount'); }
  };
  const checkoutAction = async (id: string, action: 'reconcile' | 'close' | 'refund') => {
    if (mutationActive.current) return;
    mutationActive.current = true;
    const version = ++generation.current;
    setBusy(true); setError(null);
    try {
      const result = await updatePlatformCheckout(accountId, id, action);
      if (version !== generation.current || runtimeKey !== getRuntimeKey()) return;
      if (result.account_id !== accountId) throw new PlatformAccountError('platform_account_changed');
      setState((previous) => previous ? { ...previous, checkouts: (previous.checkouts ?? []).map((item) => item.id === result.id ? result : item) } : previous);
      if (result.payment_status === 'PAID' && result.fulfillment_status === 'FULFILLED' || result.refund_status === 'SUCCEEDED') onAccountRefresh();
      const next = await readPlatformCommerce();
      if (version !== generation.current || runtimeKey !== getRuntimeKey()) return;
      if (next.accountId !== accountId) throw new PlatformAccountError('platform_account_changed');
      setState(next);
    } catch (cause) {
      if (version === generation.current && runtimeKey === getRuntimeKey()) setError(platformAccountErrorKey(cause instanceof PlatformAccountError ? cause : null, 'platformAccount.commerceFailed'));
    } finally { mutationActive.current = false; if (version === generation.current && runtimeKey === getRuntimeKey()) setBusy(false); }
  };
  const channels = state?.payments.providers ?? [];
  const external = state?.payments.mode === 'external' && paymentChannel !== 'wallet';
  const effectiveChannel = paymentChannel === 'alipay' && channels.includes('alipay') ? 'alipay' : channels.includes('wechat') ? 'wechat' : 'alipay';
  const offers = state?.offers?.filter((offer) => offer.productId === 'superwagie' || (offer.productId === 'llmrouter' && offer.kind === 'addon')) ?? [];
  const selectedOffer = offers.find((offer) => offer.id === offerId);
  const memberships = offers.filter((offer) => offer.kind === 'membership' && offer.period === billingPeriod).sort((a, b) => a.rank - b.rank);
  const addons = offers.filter((offer) => offer.kind === 'addon');
  const membershipActive = hasActiveMembership && selectedOffer?.kind === 'membership';
  const wallet = selectedOffer && state?.wallets?.find((item) => item.productId === selectedOffer.productId);
  const validQuote = quote?.offer.id === selectedOffer?.id && (quote?.paymentSource ?? 'wallet') === (external ? 'external' : 'wallet') ? quote : null;
  const purchaseAmount = validQuote?.amount ?? selectedOffer?.price ?? '0';
  const insufficient = !external && selectedOffer && state?.wallets !== null && BigInt(wallet?.amount ?? '0') < BigInt(purchaseAmount);
  const addonNeedsMembership = !hasActiveMembership && selectedOffer?.kind === 'addon' && selectedOffer.productId === 'superwagie';
  const unresolved = !!(error && error !== 'platformAccount.quoteInvalidated' && state?.checkouts?.length) || !!command || !!state?.checkouts?.some((item) => !['CLOSED'].includes(item.payment_status) && !(item.payment_status === 'PAID' && item.fulfillment_status === 'FULFILLED' && !['PENDING', 'REVIEW'].includes(item.refund_status)) && item.refund_status !== 'SUCCEEDED') || !!state?.intents.some((intent) => intent.status === 'PREPARED' || intent.status === 'UNKNOWN');
  const finance = state?.financialAccess === true;
  const sandbox = state?.payments.mode === 'sandbox';
  const walletName = (product: string) => product === 'superwagie' ? t('platformAccount.membershipWallet') : product === 'llmrouter' ? t('platformAccount.modelWallet') : product === '' ? t('platformAccount.unifiedWallet') : t('platformAccount.originalRequest');
  const purchaseName = (product: string) => t(product === 'superwagie' ? 'platformAccount.membershipPlans' : product === 'llmrouter' ? 'platformAccount.addonPlans' : 'platformAccount.originalRequest');
  const offerName = (offer: NonNullable<PlatformCommerceState['offers']>[number]) => offer.kind === 'addon' && offer.productId === 'llmrouter' ? t('platformAccount.addonPlans') : offer.name;
  const orderStatus = (status: string) => {
    const key = orderStatusKey(status);
    return key ? t(key) : t('platformAccount.order.remoteStatus', { status });
  };
  const money = (units: string) => t('platformAccount.cny', { amount: formatPlatformMoney(units) });
  const selectOffer = (id: string | null) => {
    setOfferId(id ?? ''); setQuote(null); setError(null); setPurchaseApplied(false);
    const offer = offers.find((item) => item.id === id);
    if (offer?.productId === 'superwagie' || offer?.productId === 'llmrouter') setProductId(offer.productId);
  };
  const fundSelectedOffer = () => {
    if (!selectedOffer || (selectedOffer.productId !== 'superwagie' && selectedOffer.productId !== 'llmrouter')) return;
    const shortfall = BigInt(purchaseAmount) - BigInt(wallet?.amount ?? '0');
    const wholeCents = ((shortfall + 9_999n) / 10_000n) * 10_000n;
    setBuyingTask('recharge'); setProductId(selectedOffer.productId); setAmount(formatPlatformMoney(wholeCents.toString()));
    requestAnimationFrame(() => document.getElementById('unihub-recharge-amount')?.focus());
  };
  const summary = () => membershipSummary({
    openMembership: () => setBuyingTask((task) => task === 'membership' ? null : 'membership'),
    openAddon: () => setBuyingTask((task) => task === 'addon' ? null : 'addon'),
    membershipOpen: buyingTask === 'membership',
    addonOpen: buyingTask === 'addon',
  });
  const openWallet = (product: Product) => {
    setBuyingTask((task) => task === 'recharge' && productId === product ? null : 'recharge');
    setProductId(product);
  };
  const requestUpgrade = async () => {
    if (!currentMembership || !selectedOffer || busy || unresolved) return;
    const version = ++generation.current;
    setBusy(true); setError(null); setQuote(null);
    try {
      const input: Parameters<typeof createPlatformUpgradeQuote>[0] = { accountId, subscriptionId: currentMembership.id, offerId: selectedOffer.id };
      if (external) input.paymentSource = 'external';
      const next = await createPlatformUpgradeQuote(input);
      if (version !== generation.current || runtimeKey !== getRuntimeKey()) return;
      if (next.accountId !== accountId || next.subscriptionId !== currentMembership.id || next.offer.id !== selectedOffer.id) throw new PlatformAccountError('platform_response_invalid');
      setQuote(next);
    } catch (cause) {
      if (version === generation.current && runtimeKey === getRuntimeKey()) setError(platformAccountErrorKey(cause instanceof PlatformAccountError ? cause : null, 'platformAccount.commerceFailed'));
    } finally { if (version === generation.current && runtimeKey === getRuntimeKey()) setBusy(false); }
  };
  const confirmUpgrade = () => {
    if (!validQuote) return;
    if (Date.parse(validQuote.expiresAt) <= Date.now()) { setQuote(null); setError('platformAccount.quoteExpired'); return; }
    void submitCommand({ ...(external ? { kind: 'checkout', provider: effectiveChannel } as const : { kind: 'upgrade' } as const), quoteId: validQuote.id, productId: validQuote.offer.productId, amount: validQuote.amount, idempotencyKey: crypto.randomUUID() });
  };
  const renderOffer = (offer: NonNullable<PlatformCommerceState['offers']>[number]) => <div key={offer.id} className="space-y-2">
    <SettingsRadioOption className="oc-tile h-full p-4" selected={offerId === offer.id} onSelect={() => selectOffer(offer.id)} disabled={busy || unresolved || offer.salesReadiness?.ready === false || offer.purchaseReadiness?.ready === false} ariaLabel={offerName(offer)}
      label={<span dir="auto" className="text-base font-medium">{offerName(offer)}</span>}
      description={<span className="flex flex-col gap-2 pt-2">
        <span dir="auto" className="text-2xl font-medium tabular-nums text-foreground">{t(offer.kind === 'addon' ? 'platformAccount.priceOnce' : offer.period === 'year' ? 'platformAccount.priceAnnual' : 'platformAccount.priceMonthly', { price: money(offer.price) })}</span>
        <span>{t(offer.kind === 'addon' ? 'platformAccount.addonPoints' : 'platformAccount.monthlyPoints', { points: formatPlatformPoints(offer.monthlyCredit), count: offer.validityMonths })}</span>
      </span>} />
    {offer.salesReadiness?.ready === false && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.creditRatesUnavailable')}</p>}
    {offer.purchaseReadiness?.ready === false && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.pointsRuntimeUnavailable')}</p>}
  </div>;
  const collapsedOverview = view === 'overview' && buyingTask === null;
  const commerceTitle = view === 'orders' ? t('platformAccount.history') : undefined;
  const refreshAction = <Button size="sm" variant="ghost" disabled={busy} onClick={() => void refresh()}>{t('platformAccount.refreshCommerce')}</Button>;
  const statusRow = (error || busy || purchaseApplied || collapsedOverview) && <div className="flex items-center justify-between gap-3">
    <p className={`min-h-5 min-w-0 flex-1 ${error ? 'text-[var(--status-error-text)]' : SETTINGS_HELPER_CLASS}`} role={error ? 'alert' : 'status'}>{error ? t(error) : busy ? t('platformAccount.loading') : purchaseApplied ? t('platformAccount.purchaseApplied') : null}</p>
    {collapsedOverview && refreshAction}
  </div>;
  if (!state) return <>{view === 'overview' && <SettingsTwoColumn className="gap-4 @xl:grid-cols-2 @3xl:gap-4">{summary()}</SettingsTwoColumn>}<SettingsSection title={commerceTitle} className={collapsedOverview ? 'space-y-2 py-2' : 'space-y-3 py-4'} headerAction={collapsedOverview ? undefined : refreshAction} contentClassName="space-y-3">
    {statusRow}
    {command && !busy && <SettingsControlGroup title={t('platformAccount.originalRequest')} description={t('platformAccount.commandUnknown')}>
      <p className={SETTINGS_HELPER_CLASS}>{t(command.kind === 'recharge' ? 'platformAccount.rechargeRecord' : 'platformAccount.purchaseRecord', { product: command.kind === 'recharge' ? walletName(command.productId) : purchaseName(command.productId), amount: money(command.amount) })}</p>
      <Button variant="outline" disabled={busy} onClick={() => void submitCommand(command)}>{t('platformAccount.retryOriginal')}</Button>
    </SettingsControlGroup>}
  </SettingsSection></>;

  const wallets = ['', 'superwagie', 'llmrouter'].flatMap((product) => state.wallets?.filter((item) => item.productId === product) ?? []);
  const recoverableIntents = state.intents.filter((intent) => intent.status !== 'APPLIED' && intent.status !== 'FAILED');
  const historyIntents = state.intents.filter((intent) => intent.productId === 'superwagie' || intent.productId === 'llmrouter' || (intent.status !== 'APPLIED' && intent.status !== 'FAILED'));
  const orders = state.orders?.filter((order) => order.productId === 'superwagie' || order.productId === 'llmrouter') ?? [];
  const intentRow = (intent: PlatformCommerceIntent) => <SettingsFieldRow key={intent.idempotencyKey} label={t(intent.kind === 'recharge' ? 'platformAccount.rechargeRecord' : 'platformAccount.purchaseRecord', { product: intent.kind === 'recharge' ? walletName(intent.productId) : purchaseName(intent.productId), amount: money(intent.amount) })} description={<>{t(`platformAccount.intent.${intent.status}`)}{intent.errorCode ? ` · ${t(platformAccountErrorKey(new PlatformAccountError(intent.errorCode), 'platformAccount.commerceFailed'))}` : ''}</>}>
    {intent.status !== 'APPLIED' && intent.status !== 'FAILED' && <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={() => void mutate(() => reconcilePlatformIntent(accountId, intent.idempotencyKey))}>{t('platformAccount.checkIntent')}</Button>{intent.kind === 'recharge' && intent.status === 'PENDING' && intent.resourceId && sandbox && state.payments.canRecharge && <Button variant="outline" disabled={busy} onClick={() => void mutate(() => settlePlatformSandboxRecharge(accountId, intent.idempotencyKey))}>{t('platformAccount.simulateSettlement')}</Button>}</div>}
  </SettingsFieldRow>;
  const rechargeForm = <form ref={rechargeFormRef} onSubmit={recharge} className="space-y-2">
    <SettingsFieldRow settingsItem="platform-account.model-recharge" label={t('platformAccount.walletDestination')}>
      <Select value={productId} disabled={busy || unresolved || !state.payments.canRecharge} onValueChange={(value) => { if (value === 'superwagie' || value === 'llmrouter') setProductId(value); }}>
        <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={t('platformAccount.walletDestination')}><SelectValue>{walletName(productId)}</SelectValue></SelectTrigger>
        <SelectContent>{(['superwagie', 'llmrouter'] as const).map((product) => <SelectItem key={product} value={product}>{walletName(product)}</SelectItem>)}</SelectContent>
      </Select>
    </SettingsFieldRow>
    <SettingsFieldRow settingsItem="platform-account.recharge" label={<label htmlFor="unihub-recharge-amount">{t('platformAccount.rechargeAmount')}</label>}>
      <Input id="unihub-recharge-amount" inputMode="decimal" className="max-w-48" value={amount} onChange={(event) => setAmount(event.target.value)} disabled={busy || unresolved || !state.payments.canRecharge} required />
    </SettingsFieldRow>
    <Button type="submit" disabled={busy || unresolved || !sandbox || !state.payments.canRecharge}>{t('platformAccount.createRecharge')}</Button>
  </form>;
  return <>
    {view === 'overview' && <SettingsTwoColumn className="gap-4 @xl:grid-cols-2 @3xl:gap-4">
      {summary()}
    </SettingsTwoColumn>}
    <SettingsSection title={commerceTitle} className={collapsedOverview ? 'space-y-2 py-2' : 'space-y-3 py-4'} headerAction={view === 'orders' ? refreshAction : undefined} contentClassName="space-y-3">
      {statusRow}
      {command && !busy && <SettingsControlGroup title={t('platformAccount.originalRequest')} description={t('platformAccount.commandUnknown')}>
        <p className={SETTINGS_HELPER_CLASS}>{t(command.kind === 'recharge' ? 'platformAccount.rechargeRecord' : 'platformAccount.purchaseRecord', { product: command.kind === 'recharge' ? walletName(command.productId) : purchaseName(command.productId), amount: money(command.amount) })}</p>
        <Button variant="outline" disabled={busy} onClick={() => void submitCommand(command)}>{t('platformAccount.retryOriginal')}</Button>
      </SettingsControlGroup>}
      {(sandbox || buyingTask !== null && state.payments.mode === 'unconfigured') && <p className="rounded-md bg-[var(--status-warning-background)] px-3 py-2 text-[var(--status-warning-text)]" role="status">{t(sandbox ? 'platformAccount.sandboxNotice' : 'platformAccount.paymentUnconfigured')}</p>}
      {!finance && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.memberRestricted')}</p>}
      {state.missingScopes.length > 0 && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.missingScopes')}</p>}
      {finance && view === 'overview' && recoverableIntents.length > 0 && <SettingsControlGroup title={t('platformAccount.originalRequest')}>{recoverableIntents.map(intentRow)}</SettingsControlGroup>}
      {(state.checkouts ?? []).filter((item) => view === 'orders' || item.payment_status !== 'CLOSED').map((item) => <PlatformCheckoutCard key={item.id} checkout={item} busy={busy} onAction={(action) => void checkoutAction(item.id, action)} />)}
      {view === 'overview' && buyingTask !== null && <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {buyingTask !== 'recharge' && <SettingsChipGroup value={buyingTask} onChange={(task) => { setBuyingTask(task); setQuote(null); }} aria-label={t('platformAccount.buyingTask')} options={[
          { value: 'membership', label: t('platformAccount.membershipPlans') },
          { value: 'addon', label: t('platformAccount.addonPlans') },
        ]} />}
        <div className="flex items-center gap-2">{refreshAction}<Button variant="ghost" size="sm" onClick={() => setBuyingTask(null)}>{t('dialog.common.actions.close')}</Button></div>
      </div>
      {buyingTask === 'recharge' && finance && <SettingsControlGroup title={t('platformAccount.recharge')} description={t(productId === 'llmrouter' ? 'platformAccount.modelRechargeHint' : 'platformAccount.rechargeHint')}>
        <SettingsFieldRow label={t('platformAccount.taskAccount')}><span>{payer}</span></SettingsFieldRow>
        {rechargeForm}
      </SettingsControlGroup>}
      {buyingTask === 'membership' && <SettingsControlGroup description={t('platformAccount.membershipRules')}>
        {offers.some((offer) => offer.kind === 'membership' && offer.period === 'year') && <SettingsFieldRow label={t('platformAccount.billingPeriod')}>
          <SettingsChipGroup value={billingPeriod} onChange={(period) => { setBillingPeriod(period); setQuote(null); if (selectedOffer?.kind === 'membership' && selectedOffer.period !== period) setOfferId(''); }} aria-label={t('platformAccount.billingPeriod')} options={[
            { value: 'month', label: t('platformAccount.monthly'), disabled: busy || unresolved },
            { value: 'year', label: t('platformAccount.yearly'), disabled: busy || unresolved },
          ]} />
        </SettingsFieldRow>}
        {state.offers === null ? <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.offersUnavailable')}</p>
          : memberships.length === 0 ? <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.noMembershipOffers')}</p>
          : <SettingsRadioGroup className="grid gap-3 @xl:grid-cols-2" aria-label={t('platformAccount.membershipPlans')}>
            {memberships.map(renderOffer)}
          </SettingsRadioGroup>}
        {hasActiveMembership && <p className={SETTINGS_HELPER_CLASS}>{t(currentMembership ? 'platformAccount.upgradeHint' : 'platformAccount.membershipActive')}</p>}
      </SettingsControlGroup>}
      {buyingTask === 'addon' && <SettingsControlGroup description={t('platformAccount.addonRules')}>
        {!hasActiveMembership && <p className="text-[var(--status-warning-text)]" role="status">{t('platformAccount.subscriptionRequired')}</p>}
        {state.offers === null ? <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.offersUnavailable')}</p>
          : addons.length === 0 ? <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.noAddonOffers')}</p>
          : <SettingsRadioGroup className="grid gap-3 @xl:grid-cols-2" aria-label={t('platformAccount.addonPlans')}>
            {addons.map(renderOffer)}
          </SettingsRadioGroup>}
      </SettingsControlGroup>}
      {offers.some((offer) => offer.salesReadiness === undefined) && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.salesReadinessUnknown')}</p>}
      {selectedOffer && buyingTask === selectedOffer.kind && <SettingsControlGroup title={t('platformAccount.purchaseSelection')}>
        <div className="space-y-2">
          <SettingsFieldRow label={t('platformAccount.taskAccount')}><span>{payer}</span></SettingsFieldRow>
          {channels.length > 0 && <SettingsFieldRow label={t('platformAccount.paymentChannel')}><SettingsChipGroup value={external ? effectiveChannel : 'wallet'} onChange={(channel) => { setPaymentChannel(channel); setQuote(null); }} aria-label={t('platformAccount.paymentChannel')} options={[...channels.map((channel) => ({ value: channel, label: t(channel === 'wechat' ? 'platformAccount.wechatPay' : 'platformAccount.alipay'), disabled: busy || unresolved })), { value: 'wallet' as const, label: t('platformAccount.legacyBalances'), disabled: busy || unresolved }]} /></SettingsFieldRow>}
          <SettingsFieldRow label={t('platformAccount.offer')}><span dir="auto">{offerName(selectedOffer)}</span></SettingsFieldRow>
          <SettingsFieldRow label={t(validQuote ? 'platformAccount.upgradeDifference' : 'platformAccount.price')}><span dir="auto">{money(purchaseAmount)}</span></SettingsFieldRow>
          <SettingsFieldRow label={t('platformAccount.walletDestination')}><span>{walletName(selectedOffer.productId)}</span></SettingsFieldRow>
          <SettingsFieldRow label={t(validQuote ? 'platformAccount.upgradeCredits' : selectedOffer.kind === 'membership' ? 'platformAccount.monthlyCreditGrant' : 'platformAccount.creditGrant')}><span dir="auto">{t('platformAccount.pointsAmount', { points: formatPlatformPoints(validQuote?.additionalCredits ?? selectedOffer.monthlyCredit) })}</span></SettingsFieldRow>
          {selectedOffer.kind === 'addon' ? <SettingsFieldRow label={t('platformAccount.offerValidity')}><span>{t('platformAccount.months', { count: selectedOffer.validityMonths })}</span></SettingsFieldRow> : <SettingsFieldRow label={t('platformAccount.billingPeriod')}><span>{selectedOffer.period === 'month' ? t('platformAccount.monthly') : selectedOffer.period === 'year' ? t('platformAccount.yearly') : t('platformAccount.order.remoteStatus', { status: selectedOffer.period })}</span></SettingsFieldRow>}
          {validQuote && <>
            <SettingsFieldRow label={t('platformAccount.quoteValidUntil')}><span>{new Date(validQuote.expiresAt).toLocaleString()}</span></SettingsFieldRow>
            {currentMembership && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.upgradeKeepsExpiry', { date: new Date(currentMembership.paid_through).toLocaleDateString() })}</p>}
          </>}
          {insufficient && (!membershipActive || validQuote) && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.insufficientWallet')}</p>}
          <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.oneTimePurchase')}</p>
          <div className="flex flex-wrap gap-2">
            {membershipActive ? validQuote
              ? <><Button disabled={busy || unresolved || !finance || !state.payments.canPurchase || !!insufficient || (!external && state.wallets === null) || Date.parse(validQuote.expiresAt) <= Date.now()} onClick={confirmUpgrade}>{t('platformAccount.confirmUpgrade', { price: money(validQuote.amount) })}</Button><Button variant="outline" disabled={busy || unresolved || !finance || !state.payments.canPurchase} onClick={() => void requestUpgrade()}>{t('platformAccount.getUpgradeQuote')}</Button></>
              : <Button disabled={busy || unresolved || !finance || !state.payments.canPurchase || !currentMembership || selectedOffer.salesReadiness?.ready === false || selectedOffer.purchaseReadiness?.ready === false || selectedOffer.id === currentMembership.offer.id} onClick={() => void requestUpgrade()}>{t('platformAccount.getUpgradeQuote')}</Button>
              : <Button className="max-w-full whitespace-normal text-start" disabled={busy || unresolved || selectedOffer.salesReadiness?.ready === false || selectedOffer.purchaseReadiness?.ready === false || !finance || addonNeedsMembership || !state.payments.canPurchase || !!insufficient || (!external && state.wallets === null)} onClick={() => void submitCommand({ ...(external ? { kind: 'checkout', provider: effectiveChannel } as const : { kind: 'purchase' } as const), offerId: selectedOffer.id, productId: selectedOffer.productId, amount: selectedOffer.price, idempotencyKey: crypto.randomUUID() })}>{t('platformAccount.purchase', { name: offerName(selectedOffer), price: money(selectedOffer.price) })}</Button>}
            {insufficient && (!membershipActive || validQuote) && !addonNeedsMembership && finance && sandbox && state.payments.canRecharge && <Button variant="outline" disabled={busy || unresolved} onClick={fundSelectedOffer}>{t('platformAccount.fundPurchase')}</Button>}
            {addonNeedsMembership && <Button variant="outline" onClick={() => { setBuyingTask('membership'); selectOffer(null); }}>{t('platformAccount.membershipPlans')}</Button>}
          </div>
        </div>
      </SettingsControlGroup>}
      </>}
    </SettingsSection>
      {view === 'overview' && finance && <details className="min-w-0 @xl:col-span-2" open={buyingTask === 'recharge'}>
        <summary className="cursor-pointer py-2 typography-ui-label">{t('platformAccount.legacyBalances')}</summary>
        <SettingsSection divider={false} className="min-w-0 space-y-3 py-2" contentClassName="min-w-0 space-y-3">
        <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.legacyBalancesHint')}</p>
        {state.wallets === null ? <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.walletsUnavailable')}</p> : wallets.length === 0 ? <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.noWallets')}</p> : wallets.map((item) => <div key={item.productId} className="min-w-0 space-y-1">
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-start gap-3">
              <span className="min-w-0 break-words typography-ui-label">{walletName(item.productId)}</span>
              <span dir="auto" className="min-w-0 break-all text-end font-medium tabular-nums">{money(item.amount)}</span>
            </div>
            {(item.productId === 'superwagie' || item.productId === 'llmrouter') && <div className="flex min-w-0 justify-end"><Button size="sm" variant="ghost" className="h-auto min-h-8 max-w-full whitespace-normal text-start" disabled={busy || !state.payments.canRecharge} aria-pressed={buyingTask === 'recharge' && productId === item.productId} onClick={() => openWallet(item.productId === 'superwagie' ? 'superwagie' : 'llmrouter')}>{t(item.productId === 'llmrouter' ? 'platformAccount.modelCashTopup' : 'platformAccount.recharge')}</Button></div>}
          </div>)}
        {state.wallets !== null && !wallets.some((item) => item.productId === 'llmrouter') && <Button size="sm" className="h-auto min-h-8 max-w-full whitespace-normal text-start" disabled={busy || !state.payments.canRecharge} aria-pressed={buyingTask === 'recharge' && productId === 'llmrouter'} onClick={() => openWallet('llmrouter')}>{t('platformAccount.modelCashTopup')}</Button>}
      </SettingsSection></details>}
    {finance && view === 'orders' && <SettingsSection description={t('platformAccount.historyScope')} divider={false} className="pt-0" contentClassName="space-y-4">
      {historyIntents.length === 0 && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.noIntents')}</p>}
      {historyIntents.map(intentRow)}
      {state.orders === null ? <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.ordersUnavailable')}</p> : orders.length === 0 ? <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.noOrders')}</p> : orders.map((order) => <SettingsFieldRow key={order.id} label={order.productId === 'llmrouter' ? t('platformAccount.addonPlans') : order.offerName} description={t('platformAccount.orderStates', { payment: orderStatus(order.paymentStatus), fulfillment: orderStatus(order.fulfillmentStatus), refund: order.refundStatus ? orderStatus(order.refundStatus) : t('platformAccount.noRefund') })}><span dir="auto">{money(order.amount)}</span></SettingsFieldRow>)}
    </SettingsSection>}
  </>;
};
