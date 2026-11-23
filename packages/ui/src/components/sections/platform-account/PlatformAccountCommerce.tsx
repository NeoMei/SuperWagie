import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SettingsSection, SettingsFieldRow, SettingsControlGroup, SettingsChipGroup, SettingsRadioGroup, SettingsRadioOption, SettingsTwoColumn, SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { PlatformAccountError, type PlatformAccountState } from '@/lib/platformAccount';
import { readPlatformCommerce, readPlatformOrders, createPlatformCheckout, updatePlatformCheckout, purchasePlatformOffer, createPlatformUpgradeQuote, acceptPlatformUpgradeQuote, reconcilePlatformIntent, formatPlatformMoney, formatPlatformPoints, formatProductBillingDate, type PlatformCommerceState, type PlatformCommerceIntent, type PlatformUpgradeQuote, type PlatformCheckout } from '@/lib/platformCommerce';
import { PlatformProductWallet } from './PlatformProductWallet';
import { PlatformPaymentPanel } from './PlatformPaymentPanel';
import { platformAccountErrorKey } from './platformAccountErrors';
import { usePlatformAccountTabStore } from './platformAccountTabs';

type PendingCommand = { kind: 'checkout'; walletTopUp?: true; offerId?: string; quoteId?: string; provider: 'wechat' | 'alipay'; productId: string; amount: string; idempotencyKey: string }
  | { kind: 'purchase'; offerId: string; productId: string; amount: string; idempotencyKey: string }
  | { kind: 'upgrade'; quoteId: string; productId: string; amount: string; idempotencyKey: string };
/** A payment attempt the account has not settled yet. */
const cashTopUpUnits = (input: string): string | null => {
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(input.trim())) return null;
  const [whole, fraction = ''] = input.trim().split('.');
  const amount = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  return amount > 0n && amount <= 1_000_000_000_000_000n ? amount.toString() : null;
};
const WAITING_PAYMENT = ['CREATED', 'PENDING', 'UNKNOWN'];
const waitingCheckout = (checkout: { payment_status: string; refund_status: string }) => WAITING_PAYMENT.includes(checkout.payment_status) && !checkout.refund_status;
const pollableCheckout = (checkout: PlatformCheckout) => waitingCheckout(checkout)
  || (checkout.payment_status === 'PAID' && checkout.fulfillment_status === 'PENDING' && !checkout.refund_status);
const settledCheckout = (checkout: PlatformCheckout) => checkout.refund_status === 'SUCCEEDED'
  || (checkout.payment_status === 'PAID' && checkout.fulfillment_status === 'FULFILLED' && !['PENDING', 'REVIEW'].includes(checkout.refund_status));
const unresolvedPayment = (checkout: PlatformCheckout) => !settledCheckout(checkout)
  && (waitingCheckout(checkout) || checkout.payment_status === 'REVIEW' || checkout.payment_status === 'PAID'
    || ['PENDING', 'REVIEW'].includes(checkout.refund_status));
/** The provider is queried on this cadence while a code is on screen. */
const PAYMENT_POLL_MS = 4000;
const commandRejected = (error: PlatformAccountError) => (error.code === 'credit_rates_unavailable' && error.status === 409) || ['platform_account_changed', 'platform_session_changed', 'platform_billing_forbidden', 'platform_scope_required', 'platform_offer_unavailable', 'platform_product_wallet_unavailable', 'platform_membership_active', 'platform_amount_invalid', 'platform_operation_pending', 'payment_not_configured', 'platform_idempotency_conflict', 'subscription_required', 'quote_expired', 'platform_quote_expired', 'platform_quote_unavailable', 'points_runtime_unavailable', 'unsupported_plan_change'].includes(error.code);
const isCommerceReadFailure = (error: PlatformAccountError) => error.status >= 500 || ['platform_unavailable', 'platform_response_invalid', 'platform_commerce_unavailable', 'service_unavailable'].includes(error.code);
/** A saved intent error describes the attempt, not the commerce read that returned it. */
const intentErrorKey = (errorCode?: string): I18nKey | null => errorCode ? platformAccountErrorKey(new PlatformAccountError(errorCode), 'platformAccount.commandUnknown') : null;
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
    case 'UPGRADE_PENDING': return 'platformAccount.productWallet.upgradeRefundPending';
    case 'UPGRADE_RELEASING': return 'platformAccount.productWallet.upgradeRefundReleasing';
    case 'UPGRADE_RETURNED': return 'platformAccount.productWallet.upgradeRefundReturned';
    case 'UPGRADE_REVIEW': return 'platformAccount.productWallet.upgradeRefundReview';
    case 'PROCESSING': return 'platformAccount.order.processing';
    case 'CANCELED':
    case 'CANCELLED': return 'platformAccount.order.cancelled';
    case 'REJECTED': return 'platformAccount.order.rejected';
    default: return null;
  }
};

export const PlatformAccountCommerce: React.FC<{
  accountId: string;
  payer: string;
  walletAccountPicker?: React.ReactNode;
  view: 'overview' | 'orders' | 'wallet';
  hasActiveMembership: boolean;
  currentMembership?: Extract<PlatformAccountState, { status: 'signed-in' }>['membership'][number];
  membershipSummary: (actions: { openMembership: () => void; openAddon: () => void; membershipOpen: boolean; addonOpen: boolean; disabled: boolean }) => React.ReactNode;
  onAccountRefresh: () => void;
}> = ({ accountId, payer, walletAccountPicker, view, hasActiveMembership, currentMembership, membershipSummary, onAccountRefresh }) => {
  const { t, locale } = useI18n();
  const [state, setState] = React.useState<PlatformCommerceState | null>(null);
  const [orderHistory, setOrderHistory] = React.useState<PlatformCommerceState['orders']>(null);
  const [ordersLoading, setOrdersLoading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<I18nKey | null>(null);
  const [commerceReadFailed, setCommerceReadFailed] = React.useState(false);
  const [topUp, setTopUp] = React.useState('');
  const [offerId, setOfferId] = React.useState('');
  const [billingPeriod, setBillingPeriod] = React.useState<'month' | 'year'>(currentMembership?.offer.period === 'year' ? 'year' : 'month');
  const purchaseTarget = usePlatformAccountTabStore((store) => store.purchaseTarget);
  const [buyingTask, setBuyingTask] = React.useState<'membership' | 'addon' | null>(hasActiveMembership ? null : 'membership');
  const [paymentChannel, setPaymentChannel] = React.useState<'wechat' | 'alipay' | 'wallet'>('wechat');
  const [quote, setQuote] = React.useState<PlatformUpgradeQuote | null>(null);
  const [purchaseApplied, setPurchaseApplied] = React.useState(false);
  const [visibleCheckoutId, setVisibleCheckoutId] = React.useState('');
  const checkoutRegion = React.useRef<HTMLDivElement>(null);
  const walletPaymentRegion = React.useRef<HTMLDivElement>(null);
  const [command, setCommand] = React.useState<PendingCommand | null>(null);
  const generation = React.useRef(0);
  const lastCommerceState = React.useRef<PlatformCommerceState | null>(null);
  const accountRefresh = React.useRef(onAccountRefresh);
  accountRefresh.current = onAccountRefresh;
  const observedBenefits = React.useRef('');
  const mutationActive = React.useRef(false);
  const paymentPollActive = React.useRef(false);
  const runtimeKey = getRuntimeKey();
  React.useEffect(() => {
    if (!purchaseTarget) return;
    if (commerceReadFailed) { usePlatformAccountTabStore.getState().clearPurchaseTarget(); return; }
    setBuyingTask(purchaseTarget === 'funding' ? hasActiveMembership ? 'addon' : 'membership' : purchaseTarget);
    usePlatformAccountTabStore.getState().clearPurchaseTarget();
  }, [purchaseTarget, hasActiveMembership, commerceReadFailed]);
  const applyReadFailure = React.useCallback((error: I18nKey) => {
    setError(error); setCommerceReadFailed(true); setBuyingTask(null);
    if (!lastCommerceState.current) setState(null);
  }, []);
  const refresh = React.useCallback(async () => {
    const version = ++generation.current;
    setBusy(true); setError(null); setPurchaseApplied(false);
    try {
      const next = await readPlatformCommerce(true);
      if (version === generation.current && runtimeKey === getRuntimeKey()) {
        if (next.accountId !== accountId) throw new PlatformAccountError('platform_account_changed');
        const fulfilled = (next.checkouts ?? []).filter((checkout) => checkout.payment_status === 'PAID' && checkout.fulfillment_status === 'FULFILLED' || checkout.refund_status === 'SUCCEEDED');
        const benefitsSignature = JSON.stringify([runtimeKey, accountId, fulfilled.sort((a, b) => a.id.localeCompare(b.id)).map((checkout) => [checkout.id, checkout.refund_status])]);
        if (fulfilled.length && observedBenefits.current !== benefitsSignature) accountRefresh.current();
        observedBenefits.current = benefitsSignature;
        setState(next);
        lastCommerceState.current = next; setCommerceReadFailed(false);
        setCommand((previous) => previous && next.intents.some((intent) => intent.idempotencyKey === previous.idempotencyKey) ? null : previous);
      }
    } catch (cause) {
      if (version === generation.current && runtimeKey === getRuntimeKey()) applyReadFailure(platformAccountErrorKey(cause instanceof PlatformAccountError ? cause : null, 'platformAccount.commerceFailed'));
    } finally { if (version === generation.current && runtimeKey === getRuntimeKey()) setBusy(false); }
  }, [accountId, runtimeKey, applyReadFailure]);
  React.useEffect(() => { const requestGeneration = generation; void refresh(); return () => { ++requestGeneration.current; }; }, [refresh]);

  const canReadOrderHistory = state?.financialAccess === true && !state.missingScopes.includes('orders:read');
  React.useEffect(() => {
    if (view !== 'orders' || !canReadOrderHistory || busy) return undefined;
    let current = true;
    setOrdersLoading(true);
    void readPlatformOrders(accountId).then((orders) => {
      if (current && runtimeKey === getRuntimeKey()) setOrderHistory(orders);
    }).catch(() => {
      if (current && runtimeKey === getRuntimeKey()) setOrderHistory(null);
    }).finally(() => {
      if (current && runtimeKey === getRuntimeKey()) setOrdersLoading(false);
    });
    return () => { current = false; };
  }, [accountId, view, canReadOrderHistory, busy, runtimeKey]);

  const unresolvedCheckout = state?.checkouts?.find(unresolvedPayment);
  const unresolvedCheckoutId = unresolvedCheckout?.id;
  const payment = unresolvedCheckout ?? state?.checkouts?.find((checkout) => checkout.id === visibleCheckoutId);
  React.useEffect(() => {
    if (unresolvedCheckoutId) setVisibleCheckoutId(unresolvedCheckoutId);
  }, [unresolvedCheckoutId]);
  React.useEffect(() => {
    if (payment?.id && view === 'overview') checkoutRegion.current?.scrollIntoView?.({ block: 'nearest' });
  }, [payment?.id, view]);
  React.useEffect(() => {
    if (!payment?.id || view !== 'wallet') return;
    const region = walletPaymentRegion.current;
    region?.focus({ preventScroll: true });
    region?.scrollIntoView?.({ block: 'nearest' });
  }, [payment?.id, view]);

  const applyCheckout = React.useCallback((checkout: PlatformCheckout, id: string, intent?: PlatformCommerceIntent) => {
    if (checkout.account_id !== accountId || checkout.id !== id) throw new PlatformAccountError('platform_response_invalid');
    const previous = lastCommerceState.current;
    if (!previous) return;
    const next = {
      ...previous,
      checkouts: [checkout, ...(previous.checkouts ?? []).filter((item) => item.id !== id)],
      intents: intent ? [intent, ...previous.intents.filter((item) => item.idempotencyKey !== intent.idempotencyKey)] : previous.intents,
    };
    lastCommerceState.current = next;
    setState(next);
  }, [accountId]);
  const showSubmittedCheckout = (intent: PlatformCommerceIntent) => {
    if (intent.kind !== 'checkout' || !intent.resourceId) return;
    if (intent.checkout) applyCheckout(intent.checkout, intent.resourceId, intent);
    setVisibleCheckoutId(intent.resourceId);
  };

  const activeCheckout = state?.checkouts?.find(pollableCheckout);
  const activeCheckoutId = activeCheckout?.id ?? '';
  const activeCheckoutStatus = activeCheckout?.payment_status;
  const activeCheckoutDeadline = Date.parse(activeCheckout?.session?.expires_at ?? activeCheckout?.expires_at ?? '');
  React.useEffect(() => {
    if (!activeCheckoutId) return undefined;
    let stopped = false;
    const tick = async () => {
      if (stopped || mutationActive.current || paymentPollActive.current || document.hidden) return;
      if (activeCheckoutStatus !== 'PAID' && Number.isFinite(activeCheckoutDeadline) && Date.now() > activeCheckoutDeadline + 120_000) return;
      const version = generation.current;
      paymentPollActive.current = true;
      try {
        const result = await updatePlatformCheckout(accountId, activeCheckoutId, 'reconcile');
        if (stopped || version !== generation.current || runtimeKey !== getRuntimeKey()) return;
        applyCheckout(result, activeCheckoutId);
        if (!pollableCheckout(result)) void refresh();
      } catch { /* the next tick asks again; a manual refresh stays available */ }
      finally { paymentPollActive.current = false; }
    };
    const timer = window.setInterval(() => void tick(), PAYMENT_POLL_MS);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [accountId, activeCheckoutId, activeCheckoutStatus, activeCheckoutDeadline, runtimeKey, applyCheckout, refresh]);

  const mutate = async (operation: () => Promise<PlatformCommerceIntent>, original?: PendingCommand) => {
    if (mutationActive.current) return;
    mutationActive.current = true;
    const version = ++generation.current;
    let confirmed = false;
    let readStarted = false;
    setBusy(true); setError(null); setPurchaseApplied(false);
    if (original) setCommand(original);
    try {
      const result = await operation();
      confirmed = true;
      if (result.status === 'FAILED' && result.errorCode === 'credit_rates_unavailable') {
        if (version !== generation.current || runtimeKey !== getRuntimeKey()) return;
        setCommand(null); setError('platformAccount.creditRatesUnavailable');
        readStarted = true; const next = await readPlatformCommerce(true);
        if (version !== generation.current || runtimeKey !== getRuntimeKey()) return;
        if (next.accountId !== accountId) throw new PlatformAccountError('platform_account_changed');
        setState(next); lastCommerceState.current = next; setCommerceReadFailed(false); return;
      }
      if (version !== generation.current || runtimeKey !== getRuntimeKey()) return;
      setCommand(null);
      showSubmittedCheckout(result);
      if ((result.kind === 'upgrade' || result.kind === 'checkout' && !!result.quoteId) && result.status === 'FAILED' && result.errorCode === 'quote_invalidated') setQuote(null);
      readStarted = true; const next = await readPlatformCommerce(true);
      if (version !== generation.current || runtimeKey !== getRuntimeKey()) return;
      if (next.accountId !== accountId) throw new PlatformAccountError('platform_account_changed');
      setState(next); lastCommerceState.current = next; setCommerceReadFailed(false); onAccountRefresh();
      if (result.status === 'FAILED' || result.status === 'UNKNOWN') setError(intentErrorKey(result.errorCode) ?? (result.status === 'FAILED' ? 'platformAccount.commerceFailed' : 'platformAccount.commandUnknown'));
      if (result.status === 'APPLIED') {
        setQuote(null);
        if (result.kind !== 'checkout') { setPurchaseApplied(true); setOfferId(''); setBuyingTask(null); }
      }
    } catch (cause) {
      if (version !== generation.current || runtimeKey !== getRuntimeKey()) return;
      const quoteInvalidated = !confirmed && (original?.kind === 'upgrade' || original?.kind === 'checkout' && !!original.quoteId) && cause instanceof PlatformAccountError && cause.code === 'quote_invalidated' && cause.status === 409;
      if (quoteInvalidated) { setQuote(null); setCommand(null); }
      else if (original && cause instanceof PlatformAccountError && commandRejected(cause)) setCommand(null);
      const error = cause instanceof PlatformAccountError ? cause : null;
      if (readStarted && error && isCommerceReadFailure(error)) applyReadFailure(platformAccountErrorKey(error, 'platformAccount.commerceFailed'));
      else setError(platformAccountErrorKey(error, original && !confirmed ? 'platformAccount.commandUnknown' : 'platformAccount.commerceFailed'));
      // Keep the last authoritative balance when an operation itself fails; a
      // failed follow-up read is handled above.
      if (!quoteInvalidated && !(original?.kind === 'purchase' && error?.code === 'credit_rates_unavailable' && error.status === 409)) { setState(lastCommerceState.current); }
    } finally { mutationActive.current = false; if (version === generation.current && runtimeKey === getRuntimeKey()) setBusy(false); }
  };
  const submitCommand = (original: PendingCommand) => {
    return mutate(() => original.kind === 'checkout'
      ? createPlatformCheckout({ accountId, offerId: original.offerId, quoteId: original.quoteId, amount: original.walletTopUp ? original.amount : undefined, provider: original.provider, idempotencyKey: original.idempotencyKey })
      : original.kind === 'upgrade'
        ? acceptPlatformUpgradeQuote({ accountId, quoteId: original.quoteId, idempotencyKey: original.idempotencyKey })
        : purchasePlatformOffer({ accountId, offerId: original.offerId, idempotencyKey: original.idempotencyKey }), original);
  };
  const switchChannel = async (checkout: PlatformCheckout, provider: 'wechat' | 'alipay') => {
    if (mutationActive.current || command) return;
    const intent = state?.intents.find((item) => item.kind === 'checkout' && item.resourceId === checkout.id);
    if (!intent || (!intent.offerId && !intent.quoteId && !intent.walletTopUp)) {
      setError('platformAccount.commerceFailed');
      return;
    }
    mutationActive.current = true;
    const version = ++generation.current;
    const isCurrent = () => version === generation.current && runtimeKey === getRuntimeKey();
    let readStarted = false;
    setBusy(true); setError(null); setPurchaseApplied(false);
    try {
      const previous = await updatePlatformCheckout(accountId, checkout.id, 'close');
      if (!isCurrent()) return;
      applyCheckout(previous, checkout.id);
      if (previous.payment_status !== 'CLOSED') {
        if (settledCheckout(previous)) {
          accountRefresh.current();
        } else if (waitingCheckout(previous)) {
          setError(provider === checkout.provider ? 'platformAccount.error.operationPending' : 'platformAccount.error.channelSwitchPending');
        }
        return;
      }

      const replacement: PendingCommand = {
        kind: 'checkout', offerId: intent.quoteId ? undefined : intent.offerId, quoteId: intent.quoteId,
        provider, walletTopUp: intent.walletTopUp, productId: intent.productId, amount: intent.amount, idempotencyKey: crypto.randomUUID(),
      };
      setCommand(replacement);
      let result;
      try {
        result = await createPlatformCheckout({ accountId, offerId: replacement.offerId, quoteId: replacement.quoteId, amount: replacement.walletTopUp ? replacement.amount : undefined, provider, idempotencyKey: replacement.idempotencyKey });
      } catch (cause) {
        if (isCurrent() && cause instanceof PlatformAccountError) {
          if (commandRejected(cause) || cause.code === 'quote_invalidated') setCommand(null);
          if (['quote_invalidated', 'platform_quote_expired'].includes(cause.code)) setQuote(null);
        }
        throw cause;
      }
      if (!isCurrent()) return;
      setCommand(null);
      showSubmittedCheckout(result);
      if (result.status === 'FAILED' || result.status === 'UNKNOWN') {
        setError(intentErrorKey(result.errorCode) ?? (result.status === 'FAILED' ? 'platformAccount.commerceFailed' : 'platformAccount.commandUnknown'));
      } else {
        setPaymentChannel(provider);
        if (result.status === 'APPLIED') accountRefresh.current();
      }
      if (result.status === 'APPLIED' || result.errorCode === 'quote_invalidated') setQuote(null);
      readStarted = true;
      const next = await readPlatformCommerce(true);
      if (!isCurrent()) return;
      if (next.accountId !== accountId) throw new PlatformAccountError('platform_account_changed');
      setState(next); lastCommerceState.current = next; setCommerceReadFailed(false);
    } catch (cause) {
      if (isCurrent()) {
        const error = cause instanceof PlatformAccountError ? cause : null;
        if (readStarted && error && isCommerceReadFailure(error)) applyReadFailure(platformAccountErrorKey(error, 'platformAccount.commerceFailed'));
        else setError(platformAccountErrorKey(error, 'platformAccount.commerceFailed'));
      }
    } finally { mutationActive.current = false; if (isCurrent()) setBusy(false); }
  };
  const checkoutAction = async (id: string, action: 'reconcile' | 'close' | 'refund') => {
    if (mutationActive.current) return;
    mutationActive.current = true;
    const version = ++generation.current;
    let readStarted = false;
    setBusy(true); setError(null);
    try {
      const result = await updatePlatformCheckout(accountId, id, action);
      if (version !== generation.current || runtimeKey !== getRuntimeKey()) return;
      applyCheckout(result, id);
      if (settledCheckout(result)) onAccountRefresh();
      if (action === 'close' && waitingCheckout(result) && !result.close_pending) setError('platformAccount.error.operationPending');
      readStarted = true; const next = await readPlatformCommerce(true);
      if (version !== generation.current || runtimeKey !== getRuntimeKey()) return;
      if (next.accountId !== accountId) throw new PlatformAccountError('platform_account_changed');
      setState(next); lastCommerceState.current = next; setCommerceReadFailed(false);
    } catch (cause) {
      if (version === generation.current && runtimeKey === getRuntimeKey()) {
        const error = cause instanceof PlatformAccountError ? cause : null;
        if (readStarted && error && isCommerceReadFailure(error)) applyReadFailure(platformAccountErrorKey(error, 'platformAccount.commerceFailed'));
        else setError(platformAccountErrorKey(error, 'platformAccount.commerceFailed'));
      }
    } finally { mutationActive.current = false; if (version === generation.current && runtimeKey === getRuntimeKey()) setBusy(false); }
  };
  const channels = state?.payments.providers ?? [];
  const topUpAmount = cashTopUpUnits(topUp);
  const external = state?.payments.mode === 'external' && paymentChannel !== 'wallet';
  const effectiveChannel = paymentChannel === 'alipay' && channels.includes('alipay') ? 'alipay' : channels.includes('wechat') ? 'wechat' : 'alipay';
  const scopedWallet = state?.productCreditWallet === true;
  const offers = state?.offers?.filter((offer) => offer.productId === 'superwagie' || (!scopedWallet && offer.productId === 'llmrouter' && offer.kind === 'addon')) ?? [];
  const selectedOffer = offers.find((offer) => offer.id === offerId);
  const membershipOffers = offers.filter((offer) => offer.kind === 'membership');
  const availableTerms = (['month', 'year'] as const).filter((term) => membershipOffers.some((offer) => offer.period === term));
  const visibleTerm = availableTerms.includes(billingPeriod) ? billingPeriod : availableTerms[0] ?? billingPeriod;
  const memberships = membershipOffers.filter((offer) => offer.period === visibleTerm).sort((a, b) => a.rank - b.rank);
  const currentOffer = membershipOffers.find((offer) => offer.id === currentMembership?.offer.id);
  const currentTerm = currentMembership?.offer.period ?? currentOffer?.period;
  const currentRank = currentMembership?.offer.rank ?? currentOffer?.rank;
  const membershipRestriction = (offer: NonNullable<PlatformCommerceState['offers']>[number]): I18nKey | undefined => {
    if (offer.kind !== 'membership' || !hasActiveMembership) return;
    if (!currentMembership) return scopedWallet ? 'platformAccount.membershipActive' : undefined;
    if (offer.id === currentMembership.offer.id) return 'platformAccount.currentPlan';
    if (currentTerm !== undefined && offer.period !== currentTerm) return 'platformAccount.upgradeSamePeriod';
    if (currentRank === undefined ? scopedWallet : offer.rank <= currentRank) return 'platformAccount.upgradeHigherTier';
  };
  const selectedOfferRestriction = selectedOffer && membershipRestriction(selectedOffer);
  const otherTerm = scopedWallet && hasActiveMembership && currentTerm !== undefined && visibleTerm !== currentTerm;
  const canUpgradeVisibleTier = memberships.some((offer) => !membershipRestriction(offer) && offer.salesReadiness?.ready !== false && offer.purchaseReadiness?.ready !== false);
  const renewalEnabled = scopedWallet && state?.productWallet?.products.find((item) => item.product_id === 'superwagie')?.subscription_renewal.enabled === true;
  const addons = offers.filter((offer) => offer.kind === 'addon');
  const membershipActive = hasActiveMembership && selectedOffer?.kind === 'membership';
  const walletProduct = state?.productCreditWallet ? '' : selectedOffer?.productId;
  const wallet = selectedOffer && state?.wallets?.find((item) => item.productId === walletProduct);
  const validQuote = quote?.offer.id === selectedOffer?.id && (quote?.paymentSource ?? 'wallet') === (external ? 'external' : 'wallet') ? quote : null;
  const resetQuote = validQuote?.productCreditUpgrade;
  const appliedCreditAmount = resetQuote?.appliedCreditAmount;
  const purchaseAmount = validQuote?.amount ?? selectedOffer?.price ?? '0';
  const insufficient = !external && selectedOffer && state?.wallets !== null && BigInt(wallet?.amount ?? '0') < BigInt(purchaseAmount);
  const addonNeedsMembership = !hasActiveMembership && selectedOffer?.kind === 'addon' && selectedOffer.productId === 'superwagie';
  const unresolved = !!command || !!state?.checkouts?.some(unresolvedPayment) || !!state?.intents.some((intent) => intent.status === 'PREPARED' || intent.status === 'UNKNOWN');
  const finance = state?.financialAccess === true;
  const walletName = (product: string) => product === 'superwagie' ? t('platformAccount.membershipWallet') : product === 'llmrouter' ? t('platformAccount.modelWallet') : product === '' ? t('platformAccount.unifiedWallet') : t('platformAccount.originalRequest');
  const purchaseName = (product: string, walletTopUp?: true) => walletTopUp ? t('platformAccount.productWallet.topUp') : t(product === 'superwagie' ? 'platformAccount.membershipPlans' : product === 'llmrouter' ? 'platformAccount.addonPlans' : 'platformAccount.originalRequest');
  const offerName = (offer: NonNullable<PlatformCommerceState['offers']>[number]) => offer.kind === 'addon' && offer.productId === 'llmrouter' ? t('platformAccount.addonPlans') : offer.name;
  const orderStatus = (status: string) => {
    const key = orderStatusKey(status);
    return key ? t(key) : t('platformAccount.order.remoteStatus', { status });
  };
  const money = (units: string) => t('platformAccount.cny', { amount: formatPlatformMoney(units) });
  const selectOffer = (id: string | null) => {
    setOfferId(id ?? ''); setQuote(null); setError(null); setPurchaseApplied(false);
  };
  const summary = () => membershipSummary({
    openMembership: () => { if (state && !commerceReadFailed) setBuyingTask((task) => task === 'membership' ? null : 'membership'); },
    openAddon: () => { if (state && !commerceReadFailed) setBuyingTask((task) => task === 'addon' ? null : 'addon'); },
    membershipOpen: buyingTask === 'membership',
    addonOpen: buyingTask === 'addon',
    disabled: !state || busy || commerceReadFailed,
  });
  const requestUpgrade = async () => {
    if (!currentMembership || !selectedOffer || selectedOfferRestriction || busy || unresolved) return;
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
    if (!validQuote || selectedOfferRestriction) return;
    if (Date.parse(validQuote.expiresAt) <= Date.now()) { setQuote(null); setError('platformAccount.quoteExpired'); return; }
    void submitCommand({ ...(external ? { kind: 'checkout', provider: effectiveChannel } as const : { kind: 'upgrade' } as const), quoteId: validQuote.id, productId: validQuote.offer.productId, amount: validQuote.amount, idempotencyKey: crypto.randomUUID() });
  };
  const renderOffer = (offer: NonNullable<PlatformCommerceState['offers']>[number]) => {
    const restriction = membershipRestriction(offer);
    const currentPlan = scopedWallet && restriction === 'platformAccount.currentPlan' ? currentMembership : undefined;
    return <div key={offer.id} className="space-y-2">
      <SettingsRadioOption className="oc-tile h-full p-4" selected={!restriction && offerId === offer.id} onSelect={() => selectOffer(offer.id)} disabled={busy || unresolved || !!restriction || offer.salesReadiness?.ready === false || offer.purchaseReadiness?.ready === false} ariaLabel={offerName(offer)}
        label={<span dir="auto" className="text-base font-medium">{offerName(offer)}{currentPlan && <span className="ms-2 text-sm font-normal text-muted-foreground">{t('platformAccount.productWallet.currentPlan')}</span>}</span>}
        description={<span className="flex flex-col gap-2 pt-2">
          <span dir="auto" className="text-2xl font-medium tabular-nums text-foreground">{t(offer.kind === 'addon' ? 'platformAccount.priceOnce' : offer.period === 'year' ? 'platformAccount.priceAnnual' : 'platformAccount.priceMonthly', { price: money(offer.price) })}</span>
          <span>{t(offer.kind === 'addon' ? scopedWallet ? 'platformAccount.pointsAmount' : 'platformAccount.addonPoints' : 'platformAccount.monthlyPoints', { points: formatPlatformPoints(offer.monthlyCredit), count: offer.validityMonths })}</span>
          {currentPlan && <time dateTime={currentPlan.paid_through}>{t(renewalEnabled ? 'platformAccount.productWallet.nextRenewal' : 'platformAccount.paidThrough', { date: formatProductBillingDate(currentPlan.paid_through, locale) })}</time>}
        </span>} />
      {restriction && !currentPlan && <p className={SETTINGS_HELPER_CLASS}>{t(restriction)}</p>}
      {offer.salesReadiness?.ready === false && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.creditRatesUnavailable')}</p>}
      {offer.purchaseReadiness?.ready === false && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.pointsRuntimeUnavailable')}</p>}
    </div>;
  };
  const collapsedOverview = view === 'overview' && buyingTask === null;
  const commerceTitle = view === 'orders' ? t('platformAccount.history') : view === 'wallet' ? t('platformAccount.productWallet.tab') : undefined;
  const refreshAction = <Button size="sm" variant="ghost" disabled={busy} onClick={() => void refresh()}>{t('platformAccount.refreshCommerce')}</Button>;
  const commerceUnavailable = !state || commerceReadFailed;
  const channelSwitchPending = error === 'platformAccount.error.channelSwitchPending';
  const summaryError = channelSwitchPending ? null : error;
  const statusRow = (summaryError || busy || purchaseApplied || collapsedOverview) && <div className="flex items-center justify-between gap-3">
    <p className={`min-h-5 min-w-0 flex-1 ${summaryError ? 'text-[var(--status-error-text)]' : SETTINGS_HELPER_CLASS}`} role={summaryError ? 'alert' : 'status'}>{summaryError ? t(summaryError) : busy ? t('platformAccount.loading') : purchaseApplied ? t('platformAccount.purchaseApplied') : null}</p>
    {view === 'overview' && (collapsedOverview || commerceUnavailable || Boolean(summaryError)) && refreshAction}
  </div>;
  if (!state) return <>{view === 'overview' && <SettingsTwoColumn className="gap-4 @xl:grid-cols-2 @3xl:gap-4">{summary()}</SettingsTwoColumn>}<SettingsSection title={commerceTitle} className={collapsedOverview ? 'space-y-2 py-2' : 'space-y-3 py-4'} headerAction={collapsedOverview ? undefined : refreshAction} contentClassName="space-y-3">
    {statusRow}
    {command && !busy && <SettingsControlGroup title={t('platformAccount.pendingCommand')} description={t('platformAccount.commandUnknown')}>
      <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.purchaseRecord', { product: purchaseName(command.productId, command.kind === 'checkout' ? command.walletTopUp : undefined), amount: money(command.amount) })}</p>
      <Button variant="outline" disabled={busy || commerceUnavailable} onClick={() => void submitCommand(command)}>{t('platformAccount.retryOriginal')}</Button>
    </SettingsControlGroup>}
  </SettingsSection></>;

  const checkouts = state.checkouts ?? [];
  const inlinePayment = view === 'overview' && buyingTask === selectedOffer?.kind && !commerceReadFailed && (!selectedOfferRestriction || !!payment);
  const pastPayments = checkouts.filter((item) => item.id !== payment?.id);
  const recoverableIntents = state.intents.filter((intent) => intent.status !== 'APPLIED' && intent.status !== 'FAILED' && (!payment || intent.resourceId !== payment.id));
  const historyIntents = state.intents.filter((intent) => intent.productId === 'superwagie' || intent.productId === 'llmrouter' || (intent.status !== 'APPLIED' && intent.status !== 'FAILED'));
  const orders = orderHistory?.filter((order) => order.productId === 'superwagie' || order.productId === 'llmrouter') ?? [];
  const intentRow = (intent: PlatformCommerceIntent) => {
    const errorKey = intentErrorKey(intent.errorCode);
    return <SettingsFieldRow key={intent.idempotencyKey} label={t('platformAccount.purchaseRecord', { product: purchaseName(intent.productId, intent.walletTopUp), amount: money(intent.amount) })} description={<>{t(`platformAccount.intent.${intent.status}`)}{errorKey ? ` · ${t(errorKey)}` : ''}</>}>
    {intent.status !== 'APPLIED' && intent.status !== 'FAILED' && <Button size="sm" variant="ghost" disabled={busy || commerceUnavailable} onClick={() => void mutate(() => reconcilePlatformIntent(accountId, intent.idempotencyKey))}>{t(intent.resourceId ? 'platformAccount.recheckIntent' : 'platformAccount.retryOriginal')}</Button>}
  </SettingsFieldRow>;
  };
  const paymentPanel = (checkout: PlatformCheckout, active: boolean) => {
    const canReplace = active && !command && state.intents.some((intent) => intent.kind === 'checkout' && intent.resourceId === checkout.id && (intent.offerId || intent.quoteId || intent.walletTopUp));
    const walletLayout = active && view === 'wallet';
    return <PlatformPaymentPanel key={checkout.id} checkout={checkout} busy={busy} compact={!active} walletLayout={walletLayout}
      walletHistory={!active && view === 'wallet'}
      channels={canReplace ? channels : []} onSwitchChannel={canReplace ? (provider) => void switchChannel(checkout, provider) : undefined}
      channelSwitchPending={active && channelSwitchPending}
      onRenew={canReplace && channels.includes(checkout.provider) ? () => void switchChannel(checkout, checkout.provider) : undefined}
      onDismiss={active && view !== 'orders' && !unresolvedPayment(checkout) ? () => { setVisibleCheckoutId(''); setPurchaseApplied(false); } : undefined}
      onRefresh={() => void checkoutAction(checkout.id, 'reconcile')} onClose={() => void checkoutAction(checkout.id, 'close')} onRefund={() => void checkoutAction(checkout.id, 'refund')} />;
  };
  if (view === 'wallet') {
    const topUpDisabled = busy || unresolved || commerceUnavailable;
    const showTopUp = state.payments.canTopUp && channels.length > 0;
    const topUps = pastPayments.filter((item) => item.walletTopUp);
    return <section className="@container/wallet space-y-6" data-wallet-page>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">{t('platformAccount.productWallet.tab')}</h2>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {walletAccountPicker}
          {refreshAction}
        </div>
      </div>
      <div className="grid items-start gap-4 @2xl/wallet:grid-cols-[minmax(12rem,2fr)_minmax(0,3fr)]">
        <section className="oc-tile min-w-0 space-y-2 rounded-xl p-4 @2xl/wallet:p-5">
          <h3 className="typography-ui-label font-medium">{t('platformAccount.productWallet.cash')}</h3>
          {state.productWallet
            ? <p className="break-all text-3xl leading-tight font-semibold tabular-nums"><bdi dir="ltr">¥{formatPlatformMoney(state.productWallet.cash.available)}</bdi></p>
            : <p className={SETTINGS_HELPER_CLASS}>{t(finance ? 'platformAccount.commerceFailed' : 'platformAccount.memberRestricted')}</p>}
        </section>
        <div ref={walletPaymentRegion} tabIndex={-1} className="min-w-0 scroll-my-4 space-y-3 outline-none" data-wallet-recharge>
          {statusRow}
          {payment ? paymentPanel(payment, true) : showTopUp ? (
            <form className="oc-tile grid min-w-0 gap-3 rounded-xl p-4 @2xl/wallet:p-5" onSubmit={(event) => {
              event.preventDefault();
              if (!topUpAmount || topUpDisabled) return;
              void submitCommand({ kind: 'checkout', walletTopUp: true, provider: effectiveChannel, productId: 'superwagie', amount: topUpAmount, idempotencyKey: crypto.randomUUID() });
            }}>
              <h3 className="typography-ui-label font-semibold">{t('platformAccount.productWallet.topUp')}</h3>
              <label className="grid gap-1.5 typography-meta">
                {t('platformAccount.productWallet.topUpAmount')}
                <Input dir="ltr" inputMode="decimal" value={topUp} onChange={(event) => setTopUp(event.target.value)} disabled={topUpDisabled} />
              </label>
              <SettingsChipGroup className="justify-self-start" value={effectiveChannel} onChange={setPaymentChannel} aria-label={t('platformAccount.paymentChannel')} options={channels.map((channel) => ({
                value: channel, label: t(channel === 'wechat' ? 'platformAccount.wechatPay' : 'platformAccount.alipay'), disabled: topUpDisabled,
              }))} />
              <Button type="submit" className="h-auto min-h-9 whitespace-normal" disabled={topUpDisabled || !topUpAmount}>
                {topUpAmount ? t('platformAccount.productWallet.confirmTopUp', { amount: money(topUpAmount) }) : t('platformAccount.productWallet.topUp')}
              </Button>
            </form>
          ) : finance && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.paymentUnconfigured')}</p>}
          {command && !busy && <SettingsControlGroup title={t('platformAccount.pendingCommand')} description={t('platformAccount.commandUnknown')}>
            <Button variant="outline" disabled={commerceUnavailable} onClick={() => void submitCommand(command)}>{t('platformAccount.retryOriginal')}</Button>
          </SettingsControlGroup>}
          {finance && recoverableIntents.length > 0 && <SettingsControlGroup title={t('platformAccount.pendingCommand')}>{recoverableIntents.map(intentRow)}</SettingsControlGroup>}
          {state.missingScopes.length > 0 && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.missingScopes')}</p>}
        </div>
      </div>
      {state.productWallet && <PlatformProductWallet accountId={accountId} wallet={state.productWallet} orderStatus={orderStatus} disabled={busy || commerceUnavailable}
        topUps={topUps.map((item) => paymentPanel(item, false))}
        onSaving={(saving) => {
          mutationActive.current = saving;
          if (saving) ++generation.current;
          setBusy(saving);
        }}
        onWalletUpdated={(next) => {
          const value = { ...(lastCommerceState.current ?? state), productWallet: next, wallets: [{ productId: '', asset: next.cash.asset, amount: next.cash.available }] };
          setState(value);
          lastCommerceState.current = value;
        }} />}
    </section>;
  }
  return <>
    {view === 'overview' && <SettingsTwoColumn className="gap-4 @xl:grid-cols-2 @3xl:gap-4">
      {summary()}
    </SettingsTwoColumn>}
    <SettingsSection title={commerceTitle} className={collapsedOverview ? 'space-y-2 py-2' : 'space-y-3 py-4'} headerAction={view === 'orders' ? refreshAction : undefined} contentClassName="space-y-3">
      {statusRow}
      {command && !busy && <SettingsControlGroup title={t('platformAccount.pendingCommand')} description={t('platformAccount.commandUnknown')}>
        <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.purchaseRecord', { product: purchaseName(command.productId, command.kind === 'checkout' ? command.walletTopUp : undefined), amount: money(command.amount) })}</p>
      <Button variant="outline" disabled={busy || commerceUnavailable} onClick={() => void submitCommand(command)}>{t('platformAccount.retryOriginal')}</Button>
      </SettingsControlGroup>}
      {buyingTask !== null && !commerceReadFailed && state.payments.mode === 'unconfigured' && <p className="rounded-md bg-[var(--status-warning-background)] px-3 py-2 text-[var(--status-warning-text)]" role="status">{t('platformAccount.paymentUnconfigured')}</p>}
      {!finance && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.memberRestricted')}</p>}
      {state.missingScopes.length > 0 && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.missingScopes')}</p>}
      {finance && recoverableIntents.length > 0 && <SettingsControlGroup title={t('platformAccount.pendingCommand')}>{recoverableIntents.map(intentRow)}</SettingsControlGroup>}
      {payment && !inlinePayment && paymentPanel(payment, true)}
      {view === 'orders' && pastPayments.map((item) => paymentPanel(item, false))}
      {view === 'overview' && !commerceReadFailed && buyingTask !== null && <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SettingsChipGroup value={buyingTask} onChange={(task) => { setBuyingTask(task); setQuote(null); }} aria-label={t('platformAccount.buyingTask')} options={[
          { value: 'membership', label: t('platformAccount.membershipPlans') },
          { value: 'addon', label: t('platformAccount.addonPlans') },
        ]} />
        <div className="flex items-center gap-2">{refreshAction}<Button variant="ghost" size="sm" onClick={() => setBuyingTask(null)}>{t('dialog.common.actions.close')}</Button></div>
      </div>
      {buyingTask === 'membership' && <SettingsControlGroup description={t(state.productCreditWallet ? 'platformAccount.productWallet.membershipRules' : 'platformAccount.membershipRules')}>
        {availableTerms.length > 1 && <SettingsFieldRow label={t('platformAccount.billingPeriod')}>
          <SettingsChipGroup value={visibleTerm} onChange={(period) => { setBillingPeriod(period); setQuote(null); if (selectedOffer?.kind === 'membership' && selectedOffer.period !== period) setOfferId(''); }} aria-label={t('platformAccount.billingPeriod')} options={availableTerms.map((term) => ({
            value: term, label: t(term === 'month' ? 'platformAccount.monthly' : 'platformAccount.yearly'), disabled: busy || unresolved,
          }))} />
        </SettingsFieldRow>}
        {state.offers === null ? <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.offersUnavailable')}</p>
          : memberships.length === 0 ? <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.noMembershipOffers')}</p>
          : <SettingsRadioGroup className={scopedWallet ? "grid gap-3 @xl:grid-cols-2 @4xl:grid-cols-3" : "grid gap-3 @xl:grid-cols-2"} aria-label={t('platformAccount.membershipPlans')}>
            {memberships.map(renderOffer)}
          </SettingsRadioGroup>}
        {hasActiveMembership && (currentMembership ? <>
          {!scopedWallet && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.currentMembershipTerm', { plan: currentMembership.offer.name, date: new Date(currentMembership.paid_through).toLocaleDateString() })}</p>}
          {otherTerm && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.productWallet.otherTermAfterExpiry')}</p>}
          {canUpgradeVisibleTier && <p className={SETTINGS_HELPER_CLASS}>{t(scopedWallet ? 'platformAccount.productWallet.upgradeHint' : 'platformAccount.upgradeHint')}</p>}
        </> : <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.membershipActive')}</p>)}
      </SettingsControlGroup>}
      {buyingTask === 'addon' && <SettingsControlGroup description={t(scopedWallet ? 'platformAccount.productWallet.addonRules' : 'platformAccount.addonRules')}>
        {!hasActiveMembership && <p className="text-[var(--status-warning-text)]" role="status">{t('platformAccount.subscriptionRequired')}</p>}
        {state.offers === null ? <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.offersUnavailable')}</p>
          : addons.length === 0 ? <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.noAddonOffers')}</p>
          : <SettingsRadioGroup className={scopedWallet ? "grid gap-3 @xl:grid-cols-2 @4xl:grid-cols-3" : "grid gap-3 @xl:grid-cols-2"} aria-label={t('platformAccount.addonPlans')}>
            {addons.map(renderOffer)}
          </SettingsRadioGroup>}
      </SettingsControlGroup>}
      {offers.some((offer) => offer.salesReadiness === undefined) && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.salesReadinessUnknown')}</p>}
      {inlinePayment && selectedOffer && <div ref={checkoutRegion} data-purchase-confirmation>{payment ? paymentPanel(payment, true) : <SettingsControlGroup title={t('platformAccount.purchaseSelection')}>
        <div className="space-y-2">
          <SettingsFieldRow label={t('platformAccount.taskAccount')}><span>{payer}</span></SettingsFieldRow>
          {channels.length > 0 && <SettingsFieldRow label={t('platformAccount.paymentChannel')}><SettingsChipGroup value={external ? effectiveChannel : 'wallet'} onChange={(channel) => { setPaymentChannel(channel); setQuote(null); }} aria-label={t('platformAccount.paymentChannel')} options={[...channels.map((channel) => ({ value: channel, label: t(channel === 'wechat' ? 'platformAccount.wechatPay' : 'platformAccount.alipay'), disabled: busy || unresolved })), { value: 'wallet' as const, label: t(state.productCreditWallet ? 'platformAccount.productWallet.cash' : 'platformAccount.legacyBalances'), disabled: busy || unresolved }]} /></SettingsFieldRow>}
          <SettingsFieldRow label={t('platformAccount.offer')}><span dir="auto">{offerName(selectedOffer)}</span></SettingsFieldRow>
          {validQuote && appliedCreditAmount !== undefined ? <>
            <SettingsFieldRow label={t('platformAccount.productWallet.netPlanPrice')}><span dir="auto">{money(validQuote.offer.price)}</span></SettingsFieldRow>
            <SettingsFieldRow label={t('platformAccount.productWallet.oldPlanCredit')}><span dir="auto">{money(appliedCreditAmount)}</span></SettingsFieldRow>
            <SettingsFieldRow label={t('platformAccount.payAmount')}><span dir="auto">{money(purchaseAmount)}</span></SettingsFieldRow>
          </> : <SettingsFieldRow label={t(validQuote && !resetQuote ? 'platformAccount.upgradeDifference' : 'platformAccount.price')}><span dir="auto">{money(purchaseAmount)}</span></SettingsFieldRow>}
          <SettingsFieldRow label={t(scopedWallet ? 'platformAccount.productWallet.creditsDestination' : 'platformAccount.walletDestination')}><span>{state.productCreditWallet ? t('platformAccount.productWallet.productCredit') : walletName(selectedOffer.productId)}</span></SettingsFieldRow>
          <SettingsFieldRow label={t(resetQuote ? 'platformAccount.productWallet.newPeriodCredits' : validQuote ? 'platformAccount.upgradeCredits' : selectedOffer.kind === 'membership' ? 'platformAccount.monthlyCreditGrant' : 'platformAccount.creditGrant')}><span dir="auto">{t('platformAccount.pointsAmount', { points: formatPlatformPoints(validQuote?.additionalCredits ?? selectedOffer.monthlyCredit) })}</span></SettingsFieldRow>
          {selectedOffer.kind === 'addon' ? <SettingsFieldRow label={t('platformAccount.offerValidity')}><span>{scopedWallet && selectedOffer.validityMonths === 1 ? t('platformAccount.productWallet.addonExpiry') : t('platformAccount.months', { count: selectedOffer.validityMonths })}</span></SettingsFieldRow> : <SettingsFieldRow label={t('platformAccount.billingPeriod')}><span>{selectedOffer.period === 'month' ? t('platformAccount.monthly') : selectedOffer.period === 'year' ? t('platformAccount.yearly') : t('platformAccount.order.remoteStatus', { status: selectedOffer.period })}</span></SettingsFieldRow>}
          {validQuote && <>
            <SettingsFieldRow label={t('platformAccount.quoteValidUntil')}><span>{new Date(validQuote.expiresAt).toLocaleString()}</span></SettingsFieldRow>
            {resetQuote ? <>
              {appliedCreditAmount === undefined && <SettingsFieldRow label={t('platformAccount.productWallet.estimatedRefund')} description={t(resetQuote.refundPaymentSource === 'wallet' ? 'platformAccount.productWallet.walletRefund' : 'platformAccount.productWallet.originalPaymentRefund')}>
                <span dir="auto">{money(resetQuote.estimatedRefundAmount)}</span>
              </SettingsFieldRow>}
              <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.productWallet.resetUpgrade')}</p>
            </> : currentMembership && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.upgradeKeepsExpiry', { date: new Date(currentMembership.paid_through).toLocaleDateString() })}</p>}
          </>}
          {insufficient && (!membershipActive || validQuote) && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.insufficientWallet')}</p>}
          <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.oneTimePurchase')}</p>
          <div className="flex flex-wrap gap-2">
            {membershipActive ? validQuote
              ? <><Button disabled={busy || unresolved || !finance || !state.payments.canPurchase || !!insufficient || (!external && state.wallets === null) || !!selectedOfferRestriction || Date.parse(validQuote.expiresAt) <= Date.now()} onClick={confirmUpgrade}>{t('platformAccount.confirmUpgrade', { price: money(validQuote.amount) })}</Button><Button variant="outline" disabled={busy || unresolved || !finance || !state.payments.canPurchase} onClick={() => void requestUpgrade()}>{t(scopedWallet ? 'platformAccount.productWallet.upgradeQuote' : 'platformAccount.getUpgradeQuote')}</Button></>
              : <Button disabled={busy || unresolved || !finance || !state.payments.canPurchase || !currentMembership || !!selectedOfferRestriction || selectedOffer.salesReadiness?.ready === false || selectedOffer.purchaseReadiness?.ready === false} onClick={() => void requestUpgrade()}>{t(scopedWallet ? 'platformAccount.productWallet.upgradeQuote' : 'platformAccount.getUpgradeQuote')}</Button>
              : <Button className="max-w-full whitespace-normal text-start" disabled={busy || unresolved || selectedOffer.salesReadiness?.ready === false || selectedOffer.purchaseReadiness?.ready === false || !finance || addonNeedsMembership || !state.payments.canPurchase || !!insufficient || (!external && state.wallets === null)} onClick={() => void submitCommand({ ...(external ? { kind: 'checkout', provider: effectiveChannel } as const : { kind: 'purchase' } as const), offerId: selectedOffer.id, productId: selectedOffer.productId, amount: selectedOffer.price, idempotencyKey: crypto.randomUUID() })}>{t('platformAccount.purchase', { name: offerName(selectedOffer), price: money(selectedOffer.price) })}</Button>}
            {addonNeedsMembership && <Button variant="outline" onClick={() => { setBuyingTask('membership'); selectOffer(null); }}>{t('platformAccount.membershipPlans')}</Button>}
          </div>
        </div>
      </SettingsControlGroup>}</div>}
      </>}
      {view === 'overview' && pastPayments.length > 0 && <details className="group">
        <summary className="cursor-pointer list-none typography-meta text-muted-foreground select-none">
          {t('platformAccount.pastPayments', { count: pastPayments.length })}
        </summary>
        <div className="mt-2 space-y-1.5">{pastPayments.map((item) => paymentPanel(item, false))}</div>
      </details>}
    </SettingsSection>
    {finance && view === 'orders' && <SettingsSection description={t('platformAccount.historyScope')} divider={false} className="pt-0" contentClassName="space-y-4">
      {historyIntents.length === 0 && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.noIntents')}</p>}
      {historyIntents.map(intentRow)}
      {(ordersLoading || busy) && orderHistory === null ? <p role="status" className={SETTINGS_HELPER_CLASS}>{t('platformAccount.loading')}</p> : orderHistory === null ? <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.ordersUnavailable')}</p> : orders.length === 0 ? <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.noOrders')}</p> : orders.map((order) => <SettingsFieldRow key={order.id} label={order.productId === 'llmrouter' ? t('platformAccount.addonPlans') : order.offerName} description={t('platformAccount.orderStates', { payment: orderStatus(order.paymentStatus), fulfillment: orderStatus(order.fulfillmentStatus), refund: order.refundStatus ? orderStatus(order.refundStatus) : t('platformAccount.noRefund') })}><span dir="auto">{money(order.amount)}</span></SettingsFieldRow>)}
    </SettingsSection>}
  </>;
};
