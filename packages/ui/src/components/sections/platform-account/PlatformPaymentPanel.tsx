import React from 'react';
import QRCode from 'qrcode';
import { useWaitingBlink } from '@/hooks/useDurationTicker';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { SettingsChipGroup, SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import { formatPlatformMoney, type PlatformCheckout } from '@/lib/platformCommerce';

type Provider = 'wechat' | 'alipay';

const WAITING = ['CREATED', 'PENDING', 'UNKNOWN'];

/** Remaining milliseconds are rendered as a clock, so the QR keeps one place
 *  and the amount beside it while the code is still scannable. */
const useCountdown = (deadline: string | undefined): number | null => {
  const target = deadline ? Date.parse(deadline) : Number.NaN;
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!Number.isFinite(target)) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [target]);
  if (!Number.isFinite(target)) return null;
  return Math.max(0, target - now);
};

/** Time left before a code stops working: minutes, or hours once it runs long. */
const clock = (ms: number) => {
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const seconds = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${minutes}:${seconds}` : `${minutes}:${seconds}`;
};

const upgradeReturnKeys = {
  UPGRADE_PENDING: 'platformAccount.productWallet.upgradeRefundPending',
  UPGRADE_RELEASING: 'platformAccount.productWallet.upgradeRefundReleasing',
  UPGRADE_RETURNED: 'platformAccount.productWallet.upgradeRefundReturned',
  UPGRADE_REVIEW: 'platformAccount.productWallet.upgradeRefundReview',
} as const;
const statusKey = (checkout: PlatformCheckout): I18nKey => {
  if (checkout.upgrade_return_status) return upgradeReturnKeys[checkout.upgrade_return_status];
  if (checkout.refund_status === 'SUCCEEDED') return 'platformAccount.checkoutRefunded';
  if (checkout.refund_status === 'PENDING') return 'platformAccount.checkoutRefunding';
  if (checkout.refund_status === 'REVIEW' || checkout.payment_status === 'REVIEW' || checkout.fulfillment_status === 'REVIEW') return 'platformAccount.checkoutReview';
  if (checkout.payment_status === 'CLOSED') return 'platformAccount.checkoutClosed';
  if (checkout.payment_status === 'PAID') return checkout.fulfillment_status === 'FULFILLED' ? 'platformAccount.purchaseApplied' : 'platformAccount.checkoutActivating';
  if (checkout.payment_status === 'UNKNOWN') return 'platformAccount.paymentConfirming';
  return 'platformAccount.paymentWaiting';
};

const StatusDot: React.FC<{ tone: 'waiting' | 'progress' | 'done' | 'idle' }> = ({ tone }) => {
  const blink = useWaitingBlink(tone === 'waiting' || tone === 'progress');
  const fill = tone === 'waiting' ? 'bg-[var(--status-warning)]'
    : tone === 'progress' ? 'bg-[var(--status-info)]'
      : tone === 'done' ? 'bg-[var(--status-success)]'
        : 'bg-muted-foreground';
  return <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${fill} ${blink ?? ''}`} />;
};

/** History rows carry a state word, not a sentence. */
const shortStateKey = (checkout: PlatformCheckout): I18nKey => {
  if (checkout.upgrade_return_status) return upgradeReturnKeys[checkout.upgrade_return_status];
  if (checkout.refund_status === 'SUCCEEDED') return 'platformAccount.shortState.refunded';
  if (checkout.refund_status === 'PENDING') return 'platformAccount.shortState.refunding';
  if (checkout.refund_status === 'REVIEW' || checkout.payment_status === 'REVIEW' || checkout.fulfillment_status === 'REVIEW') return 'platformAccount.shortState.review';
  if (checkout.payment_status === 'CLOSED') return 'platformAccount.shortState.closed';
  if (checkout.payment_status === 'PAID') return checkout.fulfillment_status === 'FULFILLED' ? 'platformAccount.shortState.active' : 'platformAccount.shortState.activating';
  return 'platformAccount.shortState.unpaid';
};

const toneFor = (checkout: PlatformCheckout): 'waiting' | 'progress' | 'done' | 'idle' => {
  if (checkout.refund_status === 'SUCCEEDED') return 'done';
  if (checkout.payment_status === 'PAID') return checkout.fulfillment_status === 'FULFILLED' ? 'done' : 'progress';
  if (checkout.payment_status === 'CLOSED' || checkout.refund_status === 'REJECTED') return 'idle';
  return 'waiting';
};

type PlatformPaymentPanelProps = {
  checkout: PlatformCheckout;
  /** Suppress every action while another financial command is in flight. */
  busy: boolean;
  /** Channels the account may pay with; more than one renders a switch. */
  channels?: Provider[];
  /** Switches the payment channel by starting an equivalent checkout. */
  onSwitchChannel?: (provider: Provider) => void;
  channelSwitchPending?: boolean;
  /** Manual status read; the panel also polls on its own while waiting. */
  onRefresh: () => void;
  onRenew?: () => void;
  onDismiss?: () => void;
  onClose: () => void;
  onRefund: () => void;
  /** Compact one-line rendering used by payment history. */
  compact?: boolean;
};

/**
 * One payment attempt, drawn as a single card: what is being bought, the
 * exact amount and the code sit together, so paying never requires reading a
 * field list or hunting for a QR elsewhere on the page. The commerce owner polls and reconciles the original order.
 */
export const PlatformPaymentPanel: React.FC<PlatformPaymentPanelProps> = ({
  checkout, busy, channels = [], onSwitchChannel, channelSwitchPending, onRefresh, onRenew, onDismiss, onClose, onRefund, compact = false,
}) => {
  const { t } = useI18n();
  const [codeImage, setCodeImage] = React.useState<{ source: string; image: string } | null>(null);
  const [refundConfirmation, setRefundConfirmation] = React.useState(false);
  const waiting = WAITING.includes(checkout.payment_status) && !checkout.refund_status;
  const refundable = !checkout.upgrade_return_status && !checkout.walletTopUp && checkout.payment_status === 'PAID' && !checkout.refund_status;
  const checkable = checkout.upgrade_return_status === 'UPGRADE_PENDING' || checkout.upgrade_return_status === 'UPGRADE_RELEASING' || waiting || checkout.refund_status === 'PENDING' || (checkout.payment_status === 'PAID' && checkout.fulfillment_status === 'PENDING');
  const session = waiting ? checkout.session : undefined;
  const remaining = useCountdown(waiting ? session?.expires_at ?? checkout.expires_at : undefined);
  const expired = waiting && remaining === 0;
  const codeUrl = session?.kind === 'qr' && !expired && !compact ? session.url : null;
  const qr = codeUrl && codeImage?.source === codeUrl ? codeImage : null;
  const paymentProvider = checkout.provider;
  const upgrade = checkout.product_credit_upgrade;
  const appliedCreditAmount = upgrade?.applied_credit_amount;
  const returned = checkout.upgrade_refund_amount;
  const returnAmount = returned === undefined ? null : t('platformAccount.productWallet.refundAmount', { amount: t('platformAccount.cny', { amount: formatPlatformMoney(returned) }) });
  const offerName = checkout.walletTopUp ? t('platformAccount.productWallet.topUp') : checkout.offer_name;
  const scanHint = t(paymentProvider === 'wechat' ? 'platformAccount.scanWithWechat' : 'platformAccount.scanWithAlipay');
  const providerName = t(paymentProvider === 'wechat' ? 'platformAccount.wechatPay' : 'platformAccount.alipay');

  React.useEffect(() => {
    if (!codeUrl) return undefined;
    let current = true;
    void QRCode.toDataURL(codeUrl, { width: 224, margin: 4 })
      .then((image) => { if (current) setCodeImage({ source: codeUrl, image }); })
      .catch(() => { if (current) setCodeImage({ source: codeUrl, image: '' }); });
    return () => { current = false; };
  }, [codeUrl]);

  const actions = <>
    {!compact && waiting && onRenew && (expired || session?.kind !== 'qr') && <Button size="sm" disabled={busy} onClick={onRenew}>{t('platformAccount.renewPaymentCode')}</Button>}
    {onDismiss && <Button size="sm" variant="ghost" disabled={busy} onClick={onDismiss}>{t('platformAccount.returnToPurchase')}</Button>}
    {checkable && <Button size="sm" variant="ghost" disabled={busy} onClick={onRefresh}>{t('platformAccount.refreshPaymentStatus')}</Button>}
    {waiting && <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>{t('platformAccount.closeCheckout')}</Button>}
    {refundable && <Button size="sm" variant="outline" disabled={busy} onClick={() => setRefundConfirmation(true)}>{t('platformAccount.requestRefund')}</Button>}
  </>;

  if (compact) {
    return <div className="oc-tile rounded-lg px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <StatusDot tone={toneFor(checkout)} />
        <span className="min-w-0 flex-1 truncate" dir="auto">{offerName}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">¥{formatPlatformMoney(checkout.amount)}</span>
        <span className={`${SETTINGS_HELPER_CLASS} shrink-0`}>{providerName}</span>
        <span className={`${SETTINGS_HELPER_CLASS} shrink-0`}>{t(shortStateKey(checkout))}</span>
        {(refundable || checkable) && <div className="flex items-center gap-1">{actions}</div>}
      </div>
      {returnAmount && <p className={SETTINGS_HELPER_CLASS}>{returnAmount}</p>}
      {refundConfirmation && refundable && <div className="mt-2 space-y-2">
        <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.refundConfirmation')}</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="destructive" disabled={busy} onClick={() => { setRefundConfirmation(false); onRefund(); }}>{t('platformAccount.confirmRefund')}</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRefundConfirmation(false)}>{t('dialog.common.actions.close')}</Button>
        </div>
      </div>}
    </div>;
  }

  return <div className="oc-tile rounded-xl p-4" data-payment-checkout={checkout.id}>
    <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
      <div className="min-w-0">
        <p className="typography-micro uppercase tracking-wide text-muted-foreground">{t(waiting ? 'platformAccount.activePayment' : 'platformAccount.recentPayment')}</p>
        <p className="truncate typography-ui-label font-medium" dir="auto">{offerName}</p>
      </div>
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <StatusDot tone={toneFor(checkout)} />
        <span className="typography-meta" role="status">{t(statusKey(checkout))}</span>
      </span>
    </div>

    {returnAmount && <p className={SETTINGS_HELPER_CLASS}>{returnAmount}</p>}
    {upgrade && waiting && appliedCreditAmount === undefined && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.productWallet.estimatedRefund')} {t('platformAccount.cny', { amount: formatPlatformMoney(upgrade.estimated_refund_amount) })} · {t(upgrade.refund_payment_source === 'wallet' ? 'platformAccount.productWallet.walletRefund' : 'platformAccount.productWallet.originalPaymentRefund')}</p>}
    <div className="mt-3 flex flex-col gap-4 @xl:flex-row @xl:items-center @xl:justify-between @xl:gap-6">
      <div className="min-w-0 space-y-3">
        <div className="space-y-1">
          {waiting && appliedCreditAmount !== undefined && <>
            <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.productWallet.netPlanPrice')} {t('platformAccount.cny', { amount: formatPlatformMoney(String(BigInt(checkout.amount) + BigInt(appliedCreditAmount))) })}</p>
            <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.productWallet.oldPlanCredit')} {t('platformAccount.cny', { amount: formatPlatformMoney(appliedCreditAmount) })}</p>
          </>}
          <p className="typography-micro text-muted-foreground">{t(waiting ? 'platformAccount.payAmount' : checkout.payment_status === 'PAID' ? 'platformAccount.amountPaid' : 'platformAccount.price')}</p>
          <p className="flex items-baseline gap-1.5">
            <span className="text-3xl font-medium leading-none tabular-nums" dir="auto">¥{formatPlatformMoney(checkout.amount)}</span>
            <span className="typography-meta text-muted-foreground">{providerName}</span>
          </p>
        </div>
        {waiting && appliedCreditAmount !== undefined && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.productWallet.resetUpgrade')}</p>}
        {channels.length > 1 && onSwitchChannel && waiting && <div className="space-y-1">
          <p className="typography-micro text-muted-foreground">{t('platformAccount.paymentChannel')}</p>
          <SettingsChipGroup value={paymentProvider} onChange={(next) => { if (next !== paymentProvider && !busy) onSwitchChannel(next); }} aria-label={t('platformAccount.paymentChannel')} options={channels.map((channel) => ({ value: channel, label: t(channel === 'wechat' ? 'platformAccount.wechatPay' : 'platformAccount.alipay'), disabled: busy }))} />
          {channelSwitchPending && <p role="status" className={SETTINGS_HELPER_CLASS}>{t('platformAccount.error.channelSwitchPending')}</p>}
        </div>}
        {codeUrl && <p className={`${SETTINGS_HELPER_CLASS} max-w-[22rem]`}>{scanHint}</p>}
        {session?.kind === 'redirect' && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.legacyCheckoutHint')}</p>}
        {waiting && remaining !== null && <p className={`${SETTINGS_HELPER_CLASS} flex items-center gap-1.5`}>
          <Icon name="time" className="size-3.5" />
          {expired ? t(session?.kind === 'qr' ? 'platformAccount.qrExpired' : 'platformAccount.checkoutExpired') : remaining > 86_400_000
            ? t('platformAccount.qrValidUntil', { date: new Date(session?.expires_at ?? checkout.expires_at).toLocaleString() })
            : t('platformAccount.qrValidFor', { time: clock(remaining) })}
        </p>}
      </div>
      {codeUrl && <div className="flex shrink-0 flex-col items-center gap-2 self-center">
        {qr?.image
          ? <img src={qr.image} width={224} height={224} className="rounded-lg bg-white" alt={scanHint} />
          : <p className={SETTINGS_HELPER_CLASS} role={qr ? 'alert' : 'status'}>{t(qr ? 'platformAccount.commerceFailed' : 'platformAccount.loading')}</p>}
      </div>}
    </div>

    {checkout.refund_status === 'REJECTED' && <p className={`${SETTINGS_HELPER_CLASS} mt-3`}>{t('platformAccount.checkoutRefundRejected')}</p>}
    {codeUrl && <p className={`${SETTINGS_HELPER_CLASS} mt-3`}>{t('platformAccount.paymentAutoConfirm')}</p>}
    <div className="mt-2 flex flex-wrap items-center gap-2">{actions}</div>
    {refundConfirmation && refundable && <div className="mt-3 space-y-2">
      <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.refundConfirmation')}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="destructive" disabled={busy} onClick={() => { setRefundConfirmation(false); onRefund(); }}>{t('platformAccount.confirmRefund')}</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRefundConfirmation(false)}>{t('dialog.common.actions.close')}</Button>
      </div>
    </div>}
  </div>;
};
