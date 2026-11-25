import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SettingsSection, SettingsFieldRow, SettingsControlGroup, SettingsChipGroup, SettingsTwoColumn, SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { PlatformAccountError, type PlatformAccountState } from '@/lib/platformAccount';
import { readPlatformCommerce, readPlatformOrders, createPlatformCheckout, updatePlatformCheckout, purchasePlatformOffer, createPlatformUpgradeQuote, acceptPlatformUpgradeQuote, reconcilePlatformIntent, formatPlatformMoney, formatPlatformPoints, formatProductBillingDate, isRefundableCheckout, type PlatformCommerceState, type PlatformCommerceIntent, type PlatformUpgradeQuote, type PlatformCheckout } from '@/lib/platformCommerce';
import { PlatformProductWallet } from './PlatformProductWallet';
import { PlatformPaymentPanel } from './PlatformPaymentPanel';
import { platformAccountErrorKey } from './platformAccountErrors';
import { usePlatformAccountTabStore } from './platformAccountTabs';

type BuyingTask = 'membership' | 'addon';
type Offer = NonNullable<PlatformCommerceState['offers']>[number];

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
const preserveCheckoutResult = (state: PlatformCommerceState, result: PlatformCheckout): PlatformCommerceState => {
  const observed = state.checkouts?.find((checkout) => checkout.id === result.id);
  if (observed && (!waitingCheckout(observed) || observed.close_pending && waitingCheckout(result))) return state;
  return { ...state, checkouts: [result, ...(state.checkouts ?? []).filter((checkout) => checkout.id !== result.id)] };
};
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
  view: 'overview' | 'orders' | 'wallet';
  hasActiveMembership: boolean;
  currentMembership?: Extract<PlatformAccountState, { status: 'signed-in' }>['membership'][number];
  membershipSummary: (actions: { openMembership: () => void; openAddon: () => void; membershipOpen: boolean; addonOpen: boolean; disabled: boolean }) => React.ReactNode;
  overviewFooter?: React.ReactNode;
  onAccountRefresh: () => void;
}> = ({ accountId, payer, view, hasActiveMembership, currentMembership, membershipSummary, overviewFooter, onAccountRefresh }) => {
  const { t, locale } = useI18n();
  const [state, setState] = React.useState<PlatformCommerceState | null>(null);
  const [orderHistory, setOrderHistory] = React.useState<PlatformCommerceState['orders']>(null);
  const [orderReadStatus, setOrderReadStatus] = React.useState<'loading' | 'ready' | 'denied' | 'failed'>('loading');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<I18nKey | null>(null);
  const [commerceReadFailed, setCommerceReadFailed] = React.useState(false);
  const [topUp, setTopUp] = React.useState('');
  const [offerId, setOfferId] = React.useState('');
  const [billingPeriod, setBillingPeriod] = React.useState<'month' | 'year'>(currentMembership?.offer.period === 'year' ? 'year' : 'month');
  const purchaseTarget = usePlatformAccountTabStore((store) => store.purchaseTarget);
  const [buyingTask, setBuyingTask] = React.useState<BuyingTask | null>(hasActiveMembership ? null : 'membership');
  const [offerSwitch, setOfferSwitch] = React.useState<{ offerId: string; checkoutId: string } | null>(null);
  const [paymentChannel, setPaymentChannel] = React.useState<'wechat' | 'alipay' | 'wallet'>('wechat');
  const [quote, setQuote] = React.useState<PlatformUpgradeQuote | null>(null);
  const [purchaseApplied, setPurchaseApplied] = React.useState(false);
  const [visibleCheckoutId, setVisibleCheckoutId] = React.useState('');
  const catalogRegion = React.useRef<HTMLDivElement>(null);
  const scrollToCatalog = React.useRef(false);
  const checkoutRegion = React.useRef<HTMLDivElement>(null);
  const offerDescriptionPrefix = React.useId();
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
  const refresh = React.useCallback(async (result?: PlatformCheckout) => {
    const version = ++generation.current;
    setBusy(true); setError(null); setPurchaseApplied(false);
    try {
      const commerce = await readPlatformCommerce(true);
      if (version === generation.current && runtimeKey === getRuntimeKey()) {
        if (commerce.accountId !== accountId) throw new PlatformAccountError('platform_account_changed');
        const next = result ? preserveCheckoutResult(commerce, result) : commerce;
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
    setOrderReadStatus('loading');
    void readPlatformOrders(accountId).then((orders) => {
      if (current && runtimeKey === getRuntimeKey()) {
        setOrderHistory(orders);
        setOrderReadStatus('ready');
      }
    }).catch((cause) => {
      if (current && runtimeKey === getRuntimeKey()) {
        setOrderHistory(null);
        setOrderReadStatus(cause instanceof PlatformAccountError && cause.status === 403 ? 'denied' : 'failed');
      }
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
  const awaitingOfferClosure = activeCheckout?.close_pending === true && activeCheckoutId === offerSwitch?.checkoutId;
  const activeCheckoutDeadline = Date.parse(activeCheckout?.session?.expires_at ?? activeCheckout?.expires_at ?? '');
  React.useEffect(() => {
    if (!activeCheckoutId) return undefined;
    let stopped = false;
    const tick = async () => {
      if (stopped || mutationActive.current || paymentPollActive.current || document.hidden) return;
      if (!awaitingOfferClosure && activeCheckoutStatus !== 'PAID' && Number.isFinite(activeCheckoutDeadline) && Date.now() > activeCheckoutDeadline + 120_000) return;
      const version = generation.current;
      paymentPollActive.current = true;
      try {
        const result = await updatePlatformCheckout(accountId, activeCheckoutId, 'reconcile');
        if (stopped || version !== generation.current || runtimeKey !== getRuntimeKey()) return;
        applyCheckout(result, activeCheckoutId);
        if (!pollableCheckout(result)) void refresh(result);
      } catch { /* the next tick asks again; a manual refresh stays available */ }
      finally { paymentPollActive.current = false; }
    };
    const timer = window.setInterval(() => void tick(), PAYMENT_POLL_MS);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [accountId, activeCheckoutId, activeCheckoutStatus, activeCheckoutDeadline, awaitingOfferClosure, runtimeKey, applyCheckout, refresh]);

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
        setCommand(null); setOfferId(''); setError('platformAccount.creditRatesUnavailable');
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
      const ratesUnavailable = !confirmed && error?.code === 'credit_rates_unavailable' && error.status === 409;
      if (ratesUnavailable) setOfferId('');
      if (readStarted && error && isCommerceReadFailure(error)) applyReadFailure(platformAccountErrorKey(error, 'platformAccount.commerceFailed'));
      else setError(platformAccountErrorKey(error, original && !confirmed ? 'platformAccount.commandUnknown' : 'platformAccount.commerceFailed'));
      // Keep the last authoritative balance when an operation itself fails; a
      // failed follow-up read is handled above.
      if (!quoteInvalidated && !ratesUnavailable) { setState(lastCommerceState.current); }
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
      const receiptConfirmed = action !== 'refund' && (result.close_pending || !pollableCheckout(result) || action === 'close' && result.payment_status === 'PAID');
      const observed = receiptConfirmed ? preserveCheckoutResult(next, result) : next;
      setState(observed); lastCommerceState.current = observed; setCommerceReadFailed(false);
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
  const external = state?.payments.mode === 'external' && channels.length > 0 && paymentChannel !== 'wallet';
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
  const membershipRestriction = (offer: Offer): I18nKey | undefined => {
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
  const unresolvedIntents = state?.intents.filter((intent) => intent.status === 'PREPARED' || intent.status === 'UNKNOWN') ?? [];
  const unresolved = !!command || !!unresolvedCheckout || unresolvedIntents.length > 0;
  const finance = state?.financialAccess === true;
  const purchaseName = (product: string, walletTopUp?: true) => walletTopUp ? t('platformAccount.productWallet.topUp') : t(product === 'superwagie' ? 'platformAccount.membershipPlans' : product === 'llmrouter' ? 'platformAccount.addonPlans' : 'platformAccount.originalRequest');
  const offerName = (offer: Offer) => offer.kind === 'addon' && offer.productId === 'llmrouter' ? t('platformAccount.addonPlans') : offer.name;
  const orderStatus = (status: string) => {
    const key = orderStatusKey(status);
    return key ? t(key) : t('platformAccount.order.remoteStatus', { status });
  };
  const money = (units: string) => t('platformAccount.cny', { amount: formatPlatformMoney(units) });
  const checkoutOpen = view === 'overview'
    && Boolean(payment ? !payment.walletTopUp : !commerceReadFailed && buyingTask !== null && (selectedOffer || offerId && command));
  const paymentIntent = payment && state?.intents.find((intent) => intent.kind === 'checkout' && intent.resourceId === payment.id);
  const recoveredTask = paymentIntent?.quoteId ? 'membership' : offers.find((offer) => offer.id === paymentIntent?.offerId)?.kind;
  const visibleCategory = buyingTask ?? (checkoutOpen ? recoveredTask : undefined) ?? (hasActiveMembership ? 'addon' : 'membership');
  const activeOfferId = payment && checkoutOpen ? paymentIntent?.offerId || offerId : offerId;
  const replaceableCheckout = checkoutOpen && payment && waitingCheckout(payment) && !command
    && !state?.checkouts?.some((checkout) => checkout.id !== payment.id && unresolvedPayment(checkout))
    && unresolvedIntents.every((intent) => intent.resourceId === payment.id) ? payment : null;
  React.useLayoutEffect(() => {
    if (!checkoutOpen) return;
    checkoutRegion.current?.focus({ preventScroll: true });
    checkoutRegion.current?.querySelector('h3')?.scrollIntoView?.({ block: 'nearest' });
  }, [checkoutOpen]);
  React.useLayoutEffect(() => {
    if (!scrollToCatalog.current || !catalogRegion.current) return;
    scrollToCatalog.current = false;
    catalogRegion.current.focus({ preventScroll: true });
    catalogRegion.current.scrollIntoView?.({ block: 'start' });
  }, [buyingTask]);
  const toggleCatalog = (task: BuyingTask) => {
    if (!state || commerceReadFailed) return;
    const next = task === buyingTask ? null : task;
    scrollToCatalog.current = next !== null;
    setOfferId('');
    setQuote(null);
    setBuyingTask(next);
  };
  const summary = () => membershipSummary({
    openMembership: () => toggleCatalog('membership'),
    openAddon: () => toggleCatalog('addon'),
    membershipOpen: buyingTask === 'membership',
    addonOpen: buyingTask === 'addon',
    disabled: !state || busy || commerceReadFailed,
  });
  const purchasingUnavailable = !state?.payments.canPurchase || !finance || busy || commerceReadFailed;
  const purchaseBlocked = purchasingUnavailable || unresolved;
  const offerUnavailable = (offer: Offer) => offer.salesReadiness?.ready === false || offer.purchaseReadiness?.ready === false;
  const offerRestricted = (offer: Offer) => !!membershipRestriction(offer) || offerUnavailable(offer)
    || (offer.kind === 'addon' ? offer.productId === 'superwagie' && !hasActiveMembership : hasActiveMembership && !currentMembership);
  const offerDisabled = (offer: Offer) => purchasingUnavailable || !!offerSwitch || offerRestricted(offer)
    || (unresolved && (!replaceableCheckout || activeOfferId === offer.id));
  const requestUpgrade = async (offer: Offer) => {
    if (mutationActive.current || !currentMembership || membershipRestriction(offer) || purchaseBlocked || offerUnavailable(offer)) return;
    mutationActive.current = true;
    const version = ++generation.current;
    setBusy(true); setError(null); setQuote(null);
    try {
      const input: Parameters<typeof createPlatformUpgradeQuote>[0] = { accountId, subscriptionId: currentMembership.id, offerId: offer.id };
      if (external) input.paymentSource = 'external';
      const next = await createPlatformUpgradeQuote(input);
      if (version !== generation.current || runtimeKey !== getRuntimeKey()) return;
      if (next.accountId !== accountId || next.subscriptionId !== currentMembership.id || next.offer.id !== offer.id) throw new PlatformAccountError('platform_response_invalid');
      setQuote(next);
    } catch (cause) {
      if (version === generation.current && runtimeKey === getRuntimeKey()) setError(platformAccountErrorKey(cause instanceof PlatformAccountError ? cause : null, 'platformAccount.commerceFailed'));
    } finally { mutationActive.current = false; if (version === generation.current && runtimeKey === getRuntimeKey()) setBusy(false); }
  };
  const confirmUpgrade = () => {
    if (!validQuote || !selectedOffer || selectedOfferRestriction || purchaseBlocked || offerUnavailable(selectedOffer) || insufficient || (!external && state?.wallets === null)) return;
    if (Date.parse(validQuote.expiresAt) <= Date.now()) { setQuote(null); setError('platformAccount.quoteExpired'); return; }
    void submitCommand({ ...(external ? { kind: 'checkout', provider: effectiveChannel } as const : { kind: 'upgrade' } as const), quoteId: validQuote.id, productId: validQuote.offer.productId, amount: validQuote.amount, idempotencyKey: crypto.randomUUID() });
  };
  const startOfferPayment = (offer: Offer) => void submitCommand({
    ...(external ? { kind: 'checkout', provider: effectiveChannel } as const : { kind: 'purchase' } as const),
    offerId: offer.id, productId: offer.productId, amount: offer.price, idempotencyKey: crypto.randomUUID(),
  });
  const beginOffer = (offer: Offer) => {
    setVisibleCheckoutId('');
    setOfferId(offer.id);
    setBuyingTask(offer.kind);
    setQuote(null);
    setError(null);
    setPurchaseApplied(false);
    if (offer.kind === 'membership' && hasActiveMembership) void requestUpgrade(offer);
    else if (external) startOfferPayment(offer);
  };
  const selectOffer = (offer: Offer) => {
    if (mutationActive.current || offerDisabled(offer)) return;
    if (!replaceableCheckout) {
      beginOffer(offer);
      return;
    }
    setOfferSwitch({ offerId: offer.id, checkoutId: replaceableCheckout.id });
    setPaymentChannel(replaceableCheckout.provider);
    if (!replaceableCheckout.close_pending) void checkoutAction(replaceableCheckout.id, 'close');
  };
  const switchedCheckout = offerSwitch && state?.checkouts?.find((checkout) => checkout.id === offerSwitch.checkoutId);
  const switchStatus = switchedCheckout?.payment_status;
  const switchClosePending = switchedCheckout?.close_pending;
  const finishOfferSwitch = React.useEffectEvent((nextOfferId: string) => {
    setOfferSwitch(null);
    const offer = offers.find((item) => item.id === nextOfferId);
    if (!offer || offerRestricted(offer) || purchaseBlocked || mutationActive.current) {
      setVisibleCheckoutId('');
      setOfferId('');
      setError('platformAccount.error.operationPending');
      return;
    }
    beginOffer(offer);
  });
  React.useEffect(() => {
    if (!offerSwitch || busy || commerceReadFailed || view !== 'overview') return;
    if (switchStatus === 'CLOSED') finishOfferSwitch(offerSwitch.offerId);
    else if (switchStatus && !switchClosePending) setOfferSwitch(null);
  }, [busy, offerSwitch, commerceReadFailed, switchClosePending, switchStatus, view]);
  const paymentChoices = <SettingsChipGroup value={external ? effectiveChannel : 'wallet'} onChange={(channel) => { setPaymentChannel(channel); setQuote(null); }}
    aria-label={t('platformAccount.paymentChannel')} options={[
      ...channels.map((channel) => ({ value: channel, label: t(channel === 'wechat' ? 'platformAccount.wechatPay' : 'platformAccount.alipay'), disabled: busy || unresolved })),
      { value: 'wallet' as const, label: t(scopedWallet ? 'platformAccount.productWallet.cash' : 'platformAccount.legacyBalances'), disabled: busy || unresolved },
    ]} />;
  const renderOffer = (offer: Offer) => {
    const restriction = membershipRestriction(offer);
    const currentPlan = scopedWallet && restriction === 'platformAccount.currentPlan' ? currentMembership : undefined;
    const isAddon = offer.kind === 'addon';
    const isUpgrade = !isAddon && hasActiveMembership;
    const disabled = offerDisabled(offer);
    const price = checkoutOpen ? `¥${formatPlatformMoney(offer.price)}` : money(offer.price);
    const selected = (offerSwitch?.offerId ?? activeOfferId) === offer.id;
    const shortExpiry = isAddon && scopedWallet && offer.validityMonths === 1;
    const descriptionId = `${offerDescriptionPrefix}-${encodeURIComponent(offer.id)}`;
    const action = t(isUpgrade ? 'platformAccount.getUpgradeQuote' : external ? 'platformAccount.scanToBuy' : 'platformAccount.continueToPurchase');
    return <div key={offer.id} className="flex min-w-0 flex-col gap-2">
      <Button variant="outline" data-platform-offer aria-label={offerName(offer)} aria-describedby={descriptionId} aria-current={selected || undefined} disabled={disabled}
        className={`h-auto min-w-0 flex-1 flex-col items-start justify-start rounded-xl border border-border/60 text-start whitespace-normal disabled:opacity-75 aria-current:border-[var(--primary-base)] ${checkoutOpen ? 'gap-1.5 p-3' : 'gap-2 p-4'}`}
        onClick={() => selectOffer(offer)}>
        <span dir="auto" className="wrap-anywhere text-base font-semibold">{offerName(offer)}{currentPlan && <span className="ms-2 text-sm font-normal text-muted-foreground">{t('platformAccount.productWallet.currentPlan')}</span>}</span>
        <span id={descriptionId} className={`flex w-full min-w-0 flex-1 flex-col ${checkoutOpen ? 'gap-1' : 'gap-2'}`}>
          <span dir="auto" className={`wrap-anywhere font-semibold tabular-nums ${checkoutOpen ? 'text-lg' : 'text-2xl'}`}>{t(isAddon ? 'platformAccount.priceOnce' : offer.period === 'year' ? 'platformAccount.priceAnnual' : 'platformAccount.priceMonthly', { price })}</span>
          <span className={SETTINGS_HELPER_CLASS}>{t(isAddon ? shortExpiry ? 'platformAccount.pointsAmount' : 'platformAccount.addonPoints' : 'platformAccount.monthlyPoints', { points: formatPlatformPoints(offer.monthlyCredit), count: offer.validityMonths })}</span>
          {shortExpiry && <span className={SETTINGS_HELPER_CLASS}>{t('platformAccount.productWallet.addonExpiry')}</span>}
          {currentPlan && <time className={SETTINGS_HELPER_CLASS} dateTime={currentPlan.paid_through}>{t(renewalEnabled ? 'platformAccount.productWallet.nextRenewal' : 'platformAccount.paidThrough', { date: formatProductBillingDate(currentPlan.paid_through, locale) })}</time>}
          {!isUpgrade && <span className={SETTINGS_HELPER_CLASS}>{t('platformAccount.oneTimePurchase')}</span>}
          {!disabled && <span className={`mt-auto typography-ui-label font-semibold text-[var(--primary-text)] ${checkoutOpen ? 'pt-1' : 'pt-2'}`}>{action}</span>}
        </span>
      </Button>
      {restriction && !currentPlan && <p className={SETTINGS_HELPER_CLASS}>{t(restriction)}</p>}
      {offer.salesReadiness?.ready === false && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.creditRatesUnavailable')}</p>}
      {offer.purchaseReadiness?.ready === false && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.pointsRuntimeUnavailable')}</p>}
    </div>;
  };
  const offerGridClass = checkoutOpen
    ? "grid gap-2 @xs/catalog:grid-cols-2 @2xl/purchase:grid-cols-1"
    : scopedWallet ? "grid gap-3 @xl/catalog:grid-cols-2 @4xl/catalog:grid-cols-3" : "grid gap-3 @xl/catalog:grid-cols-2";
  const collapsedOverview = view === 'overview' && !checkoutOpen && buyingTask === null;
  const commerceTitle = view === 'orders' ? t('platformAccount.history') : undefined;
  // A recovered summary may omit a checkout whose closure we already confirmed.
  const switchReceipt = switchedCheckout && !waitingCheckout(switchedCheckout) ? switchedCheckout : undefined;
  const refreshAction = <Button size="sm" variant="ghost" disabled={busy} onClick={() => void refresh(switchReceipt)}>{t('platformAccount.refreshCommerce')}</Button>;
  const commerceUnavailable = !state || commerceReadFailed;
  const channelSwitchPending = error === 'platformAccount.error.channelSwitchPending';
  const summaryError = channelSwitchPending ? null : error;
  const statusRow = (summaryError || busy || purchaseApplied || collapsedOverview) && <div className="flex items-center justify-between gap-3">
    <p className={`min-h-5 min-w-0 flex-1 ${summaryError ? 'text-[var(--status-error-text)]' : SETTINGS_HELPER_CLASS}`} role={summaryError ? 'alert' : 'status'}>{summaryError ? t(summaryError) : busy ? t('platformAccount.loading') : purchaseApplied ? t('platformAccount.purchaseApplied') : null}</p>
    {view === 'overview' && (collapsedOverview || commerceUnavailable || checkoutOpen && Boolean(summaryError)) && refreshAction}
  </div>;
  if (!state) return <>{view === 'overview' && <SettingsTwoColumn className="gap-4 @xl:grid-cols-2 @3xl:gap-4">{summary()}</SettingsTwoColumn>}<SettingsSection title={commerceTitle} className={collapsedOverview ? 'space-y-2 py-2' : 'space-y-3 py-4'} headerAction={collapsedOverview ? undefined : refreshAction} contentClassName="space-y-3">
    {statusRow}
    {command && !busy && <SettingsControlGroup title={t('platformAccount.pendingCommand')} description={t('platformAccount.commandUnknown')}>
      <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.purchaseRecord', { product: purchaseName(command.productId, command.kind === 'checkout' ? command.walletTopUp : undefined), amount: money(command.amount) })}</p>
      <Button variant="outline" disabled={busy || commerceUnavailable} onClick={() => void submitCommand(command)}>{t('platformAccount.retryOriginal')}</Button>
    </SettingsControlGroup>}
  </SettingsSection>{view === 'overview' && overviewFooter}</>;

  const checkouts = state.checkouts ?? [];
  const pastPayments = checkouts.filter((item) => item.id !== payment?.id);
  const orders = canReadOrderHistory ? orderHistory?.filter((order) => order.productId === 'superwagie' || order.productId === 'llmrouter') ?? [] : [];
  let orderNotice: I18nKey | null = null;
  if (!canReadOrderHistory || orderReadStatus === 'denied') orderNotice = 'platformAccount.ordersUnavailable';
  else if (orderReadStatus === 'failed') orderNotice = 'platformAccount.ordersReadFailed';
  else if (orderHistory === null) orderNotice = 'platformAccount.loading';
  else if (orders.length === 0) orderNotice = 'platformAccount.noOrders';
  const needsPaymentFollowUp = (checkout: PlatformCheckout) => unresolvedPayment(checkout) || isRefundableCheckout(checkout)
    || checkout.upgrade_return_status === 'UPGRADE_PENDING' || checkout.upgrade_return_status === 'UPGRADE_RELEASING';
  const activeOrderPayments = view === 'orders' ? pastPayments.filter(needsPaymentFollowUp) : [];
  const archivedPayments = view === 'orders' ? pastPayments.filter((checkout) => !needsPaymentFollowUp(checkout)) : [];
  const recoverableIntents = state.intents.filter((intent) => intent.status !== 'APPLIED' && intent.status !== 'FAILED'
    && intent.idempotencyKey !== command?.idempotencyKey && (!payment || intent.resourceId !== payment.id));
  const recordedResources = new Set([...checkouts.map((item) => item.id), ...orders.map((item) => item.id)]);
  const historyIntents = state.intents.filter((intent) => (intent.productId === 'superwagie' || intent.productId === 'llmrouter')
    && (intent.status === 'APPLIED' || intent.status === 'FAILED')
    && (!intent.resourceId || !recordedResources.has(intent.resourceId)));
  const intentRow = (intent: PlatformCommerceIntent) => {
    const errorKey = intentErrorKey(intent.errorCode);
    return <SettingsFieldRow key={intent.idempotencyKey} label={t('platformAccount.purchaseRecord', { product: purchaseName(intent.productId, intent.walletTopUp), amount: money(intent.amount) })} description={<>{t(`platformAccount.intent.${intent.status}`)}{errorKey ? ` · ${t(errorKey)}` : ''}</>}>
    {intent.status !== 'APPLIED' && intent.status !== 'FAILED' && <Button size="sm" variant="ghost" disabled={busy || commerceUnavailable} onClick={() => void mutate(() => reconcilePlatformIntent(accountId, intent.idempotencyKey))}>{t(intent.resourceId ? 'platformAccount.recheckIntent' : 'platformAccount.retryOriginal')}</Button>}
  </SettingsFieldRow>;
  };
  const paymentPanel = (checkout: PlatformCheckout, active: boolean) => {
    const switchingOffer = checkoutOpen && offerSwitch?.checkoutId === checkout.id;
    const canReplace = active && !command && !switchingOffer && state.intents.some((intent) => intent.kind === 'checkout' && intent.resourceId === checkout.id && (intent.offerId || intent.quoteId || intent.walletTopUp));
    const walletLayout = active && view === 'wallet';
    return <PlatformPaymentPanel key={checkout.id} checkout={checkout} payer={active && checkoutOpen ? payer : undefined} switchingOffer={switchingOffer} busy={busy} compact={!active} walletLayout={walletLayout}
      walletHistory={!active && view === 'wallet'}
      channels={canReplace ? channels : []} onSwitchChannel={canReplace ? (provider) => void switchChannel(checkout, provider) : undefined}
      channelSwitchPending={active && channelSwitchPending}
      onRenew={canReplace && channels.includes(checkout.provider) ? () => void switchChannel(checkout, checkout.provider) : undefined}
      onDismiss={active && view !== 'orders' && !checkoutOpen && !unresolvedPayment(checkout) ? () => { setVisibleCheckoutId(''); setPurchaseApplied(false); } : undefined}
      onRefresh={() => void checkoutAction(checkout.id, 'reconcile')}
      onClose={checkoutOpen ? undefined : () => void checkoutAction(checkout.id, 'close')}
      onRefund={() => void checkoutAction(checkout.id, 'refund')} />;
  };
  if (view === 'wallet') {
    const topUpDisabled = busy || unresolved || commerceUnavailable;
    const showTopUp = state.payments.canTopUp && channels.length > 0;
    const topUps = pastPayments.filter((item) => item.walletTopUp);
    return <section className="@container/wallet space-y-6" data-wallet-page>
      <div className="grid items-start gap-4 @2xl/wallet:grid-cols-[minmax(12rem,2fr)_minmax(0,3fr)]">
        <section className="oc-tile min-w-0 space-y-2 rounded-xl p-4 @2xl/wallet:p-5">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <h3 className="typography-ui-label font-medium">{t('platformAccount.productWallet.cash')}</h3>
            {refreshAction}
          </div>
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
    {view === 'overview' && !checkoutOpen && <SettingsTwoColumn className="gap-4 @xl:grid-cols-2 @3xl:gap-4">
      {summary()}
    </SettingsTwoColumn>}
    <SettingsSection title={commerceTitle} className={collapsedOverview ? 'space-y-2 py-2' : 'space-y-3 py-4'} headerAction={view === 'orders' ? refreshAction : undefined} contentClassName="space-y-3">
      {statusRow}
      {command && !busy && <SettingsControlGroup title={t('platformAccount.pendingCommand')} description={t('platformAccount.commandUnknown')}>
        <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.purchaseRecord', { product: purchaseName(command.productId, command.kind === 'checkout' ? command.walletTopUp : undefined), amount: money(command.amount) })}</p>
      <Button variant="outline" disabled={busy || commerceUnavailable} onClick={() => void submitCommand(command)}>{t('platformAccount.retryOriginal')}</Button>
      </SettingsControlGroup>}
      {view === 'overview' && !checkoutOpen && buyingTask !== null && !commerceReadFailed && state.payments.mode === 'unconfigured' && <p className="rounded-md bg-[var(--status-warning-background)] px-3 py-2 text-[var(--status-warning-text)]" role="status">{t('platformAccount.paymentUnconfigured')}</p>}
      {!finance && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.memberRestricted')}</p>}
      {state.missingScopes.length > 0 && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.missingScopes')}</p>}
      {finance && recoverableIntents.length > 0 && <SettingsControlGroup title={t('platformAccount.pendingCommand')}>{recoverableIntents.map(intentRow)}</SettingsControlGroup>}
      {payment && !checkoutOpen && paymentPanel(payment, true)}
      {view === 'overview' && (checkoutOpen || !commerceReadFailed && buyingTask !== null) && <div ref={catalogRegion} tabIndex={-1} className="@container/purchase scroll-mt-4 space-y-4 outline-none">
        <div className="flex flex-wrap items-center justify-between gap-2" data-purchase-categories>
          <SettingsChipGroup<BuyingTask> value={visibleCategory} onChange={setBuyingTask} aria-label={t('platformAccount.buyingTask')} options={[
            { value: 'membership', label: t('platformAccount.membershipPlans') },
            { value: 'addon', label: t('platformAccount.addonPlans') },
          ]} />
          {!checkoutOpen && <div className="flex items-center gap-2">{refreshAction}<Button variant="ghost" size="sm" onClick={() => setBuyingTask(null)}>{t('dialog.common.actions.close')}</Button></div>}
        </div>
        <div className={checkoutOpen ? "grid min-w-0 items-start gap-4 @2xl/purchase:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]" : undefined}>
          <div className="@container/catalog min-w-0 space-y-4" data-purchase-catalog>
            {(!checkoutOpen || !payment || !unresolvedPayment(payment)) && state.payments.mode === 'external' && channels.length > 0 && finance && state.payments.canPurchase && <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className={SETTINGS_HELPER_CLASS}>{t('platformAccount.paymentChannel')}</span>
              {paymentChoices}
            </div>}
            {visibleCategory === 'membership' && <SettingsControlGroup description={t(state.productCreditWallet ? 'platformAccount.productWallet.membershipRules' : 'platformAccount.membershipRules')}>
              {availableTerms.length > 1 && <SettingsFieldRow label={t('platformAccount.billingPeriod')}>
                <SettingsChipGroup value={visibleTerm} onChange={setBillingPeriod} aria-label={t('platformAccount.billingPeriod')} options={availableTerms.map((term) => ({
                  value: term, label: t(term === 'month' ? 'platformAccount.monthly' : 'platformAccount.yearly'),
                }))} />
              </SettingsFieldRow>}
              {state.offers === null ? <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.offersUnavailable')}</p>
                : memberships.length === 0 ? <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.noMembershipOffers')}</p>
                : <div role="group" className={offerGridClass} aria-label={t('platformAccount.membershipPlans')}>
                  {memberships.map(renderOffer)}
                </div>}
              {hasActiveMembership && (currentMembership ? <>
                {!scopedWallet && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.currentMembershipTerm', { plan: currentMembership.offer.name, date: new Date(currentMembership.paid_through).toLocaleDateString() })}</p>}
                {otherTerm && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.productWallet.otherTermAfterExpiry')}</p>}
                {canUpgradeVisibleTier && <p className={SETTINGS_HELPER_CLASS}>{t(scopedWallet ? 'platformAccount.productWallet.upgradeHint' : 'platformAccount.upgradeHint')}</p>}
              </> : <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.membershipActive')}</p>)}
            </SettingsControlGroup>}
            {visibleCategory === 'addon' && <SettingsControlGroup description={t(scopedWallet ? 'platformAccount.productWallet.addonRules' : 'platformAccount.addonRules')}>
              {!hasActiveMembership && <p className="text-[var(--status-warning-text)]" role="status">{t('platformAccount.subscriptionRequired')}</p>}
              {state.offers === null ? <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.offersUnavailable')}</p>
                : addons.length === 0 ? <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.noAddonOffers')}</p>
                : <div role="group" className={offerGridClass} aria-label={t('platformAccount.addonPlans')}>
                  {addons.map(renderOffer)}
                </div>}
            </SettingsControlGroup>}
            {offers.some((offer) => offer.salesReadiness === undefined) && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.salesReadinessUnknown')}</p>}
          </div>
          {checkoutOpen && <div ref={checkoutRegion} tabIndex={-1} role="region" aria-label={t('platformAccount.activePayment')} data-purchase-checkout className="@container min-w-0 scroll-mt-4 outline-none">
            {payment ? paymentPanel(payment, true) : selectedOffer && <section className="oc-tile space-y-4 rounded-xl p-4">
              <div className="min-w-0 space-y-1">
                <h3 dir="auto" className="wrap-anywhere text-base font-semibold">{offerName(selectedOffer)}</h3>
                <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.taskAccount')} · <bdi>{payer}</bdi></p>
              </div>
              {validQuote && appliedCreditAmount !== undefined && <div className={SETTINGS_HELPER_CLASS}>
                <p>{t('platformAccount.productWallet.netPlanPrice')} · {money(validQuote.offer.price)}</p>
                <p>{t('platformAccount.productWallet.oldPlanCredit')} · {money(appliedCreditAmount)}</p>
              </div>}
              <div>
                <p className={SETTINGS_HELPER_CLASS}>{t(validQuote || !membershipActive ? 'platformAccount.payAmount' : 'platformAccount.price')}</p>
                <p className="text-2xl font-semibold tabular-nums" dir="auto">{money(purchaseAmount)}</p>
              </div>
              {validQuote && <>
                <p className={SETTINGS_HELPER_CLASS}>{t(resetQuote ? 'platformAccount.productWallet.newPeriodCredits' : 'platformAccount.upgradeCredits')} · {t('platformAccount.pointsAmount', { points: formatPlatformPoints(validQuote.additionalCredits) })}</p>
                <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.quoteValidUntil')} · <time dateTime={validQuote.expiresAt}>{new Date(validQuote.expiresAt).toLocaleString(locale)}</time></p>
                {resetQuote ? <>
                  {appliedCreditAmount === undefined && <p className={SETTINGS_HELPER_CLASS}>
                    {t('platformAccount.productWallet.estimatedRefund')} · {money(resetQuote.estimatedRefundAmount)} · {t(resetQuote.refundPaymentSource === 'wallet' ? 'platformAccount.productWallet.walletRefund' : 'platformAccount.productWallet.originalPaymentRefund')}
                  </p>}
                  <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.productWallet.resetUpgrade')}</p>
                </> : currentMembership && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.upgradeKeepsExpiry', { date: new Date(currentMembership.paid_through).toLocaleDateString(locale) })}</p>}
              </>}
              {insufficient && (!membershipActive || validQuote) && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.insufficientWallet')}</p>}
              {!busy && !unresolved && <div className="flex flex-wrap gap-2">
                {membershipActive ? <>
                  {validQuote && <Button disabled={purchaseBlocked || !!insufficient || (!external && state.wallets === null) || !!selectedOfferRestriction || offerUnavailable(selectedOffer) || Date.parse(validQuote.expiresAt) <= Date.now()} onClick={confirmUpgrade}>
                    {t('platformAccount.confirmUpgrade', { price: money(validQuote.amount) })}
                  </Button>}
                  <Button variant={validQuote ? 'outline' : 'default'} disabled={purchaseBlocked || !currentMembership || !!selectedOfferRestriction || offerUnavailable(selectedOffer)} onClick={() => void requestUpgrade(selectedOffer)}>
                    {t(scopedWallet ? 'platformAccount.productWallet.upgradeQuote' : 'platformAccount.getUpgradeQuote')}
                  </Button>
                </> : <Button className="h-auto max-w-full whitespace-normal text-start" disabled={purchaseBlocked || offerUnavailable(selectedOffer) || !!insufficient || (!external && state.wallets === null)}
                  onClick={() => startOfferPayment(selectedOffer)}>
                  {external ? t('platformAccount.createPaymentCode') : t('platformAccount.purchase', { name: offerName(selectedOffer), price: money(selectedOffer.price) })}
                </Button>}
              </div>}
            </section>}
          </div>}
        </div>
      </div>}
      {view === 'overview' && !checkoutOpen && pastPayments.length > 0 && <details className="group">
        <summary className="cursor-pointer list-none typography-meta text-muted-foreground select-none">
          {t('platformAccount.pastPayments', { count: pastPayments.length })}
        </summary>
        <div className="mt-2 space-y-1.5">{pastPayments.map((item) => paymentPanel(item, false))}</div>
      </details>}
    </SettingsSection>
    {view === 'overview' && !checkoutOpen && overviewFooter}
    {finance && view === 'orders' && <SettingsSection divider={false} className="pt-0" contentClassName="space-y-4">
      {orderNotice
        ? <p role={orderReadStatus === 'failed' ? 'alert' : 'status'} className="oc-tile rounded-lg p-4 typography-ui-label">{t(orderNotice)}</p>
        : <ul className="divide-y divide-border/50 rounded-lg border border-border/60">
          {orders.map((order) => <li key={order.id} className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 px-4 py-3">
            <div className="min-w-0 flex-1 basis-56 space-y-1">
              <p dir="auto" className="break-words typography-ui-label font-semibold">{order.productId === 'llmrouter' ? t('platformAccount.addonPlans') : order.offerName}</p>
              <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.orderStates', { payment: orderStatus(order.paymentStatus), fulfillment: orderStatus(order.fulfillmentStatus), refund: order.refundStatus ? orderStatus(order.refundStatus) : t('platformAccount.noRefund') })}</p>
            </div>
            <div className="space-y-1 @xl:text-end">
              <p dir="auto" className="typography-ui-label font-medium tabular-nums">{money(order.amount)}</p>
              {order.createdAt && <time dateTime={order.createdAt} className={SETTINGS_HELPER_CLASS}>{formatProductBillingDate(order.createdAt, locale)}</time>}
            </div>
          </li>)}
        </ul>}
      {activeOrderPayments.length > 0 && <SettingsControlGroup title={t('platformAccount.paymentActions')}>
        {activeOrderPayments.map((item) => paymentPanel(item, false))}
      </SettingsControlGroup>}
      {(archivedPayments.length > 0 || historyIntents.length > 0) && <details className="rounded-lg border border-border/60 px-4 py-3">
        <summary className="cursor-pointer typography-ui-label font-medium">{t('platformAccount.pastPayments', { count: archivedPayments.length + historyIntents.length })}</summary>
        <div className="mt-3 space-y-2">
          <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.historyScope')}</p>
          {archivedPayments.map((item) => paymentPanel(item, false))}
          {historyIntents.map(intentRow)}
        </div>
      </details>}
    </SettingsSection>}
  </>;
};
