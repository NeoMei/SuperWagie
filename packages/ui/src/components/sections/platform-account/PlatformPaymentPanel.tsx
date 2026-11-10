import React from 'react';
import QRCode from 'qrcode';
import { openExternalUrl } from '@/lib/url';
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

const statusKey = (checkout: PlatformCheckout): I18nKey => {
  if (checkout.refund_status === 'SUCCEEDED') return 'platformAccount.checkoutRefunded';
  if (checkout.refund_status === 'PENDING') return 'platformAccount.checkoutRefunding';
  if (checkout.refund_status === 'REVIEW' || checkout.payment_status === 'REVIEW' || checkout.fulfillment_status === 'REVIEW') return 'platformAccount.checkoutReview';
  if (checkout.payment_status === 'CLOSED') return 'platformAccount.checkoutClosed';
  if (checkout.payment_status === 'PAID') return checkout.fulfillment_status === 'FULFILLED' ? 'platformAccount.purchaseApplied' : 'platformAccount.checkoutActivating';
  if (checkout.payment_status === 'UNKNOWN') return 'platformAccount.paymentConfirming';
  return 'platformAccount.paymentWaiting';
};

const StatusDot: React.FC<{ tone: 'waiting' | 'progress' | 'done' | 'idle' }> = ({ tone }) => <span
  aria-hidden
  className={`size-1.5 shrink-0 rounded-full ${tone === 'waiting' ? 'animate-pulse bg-[var(--status-warning)]' : tone === 'progress' ? 'animate-pulse bg-[var(--status-info)]' : tone === 'done' ? 'bg-[var(--status-success)]' : 'bg-muted-foreground'}`}
/>;

/** History rows carry a state word, not a sentence. */
const shortStateKey = (checkout: PlatformCheckout): I18nKey => {
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

export type PlatformPaymentPanelProps = {
  checkout: PlatformCheckout;
  /** Suppress every action while another financial command is in flight. */
  busy: boolean;
  /** Channels the account may pay with; more than one renders a switch. */
  channels?: Provider[];
  /** Switches the payment channel by starting an equivalent checkout. */
  onSwitchChannel?: (provider: Provider) => void;
  /** Manual status read; the panel also polls on its own while waiting. */
  onRefresh: () => void;
  onClose: () => void;
  onRefund: () => void;
  /** Compact one-line rendering used by payment history. */
  compact?: boolean;
};

/**
 * One payment attempt, drawn as a single card: what is being bought, the
 * exact amount and the code sit together, so paying never requires reading a
 * field list or hunting for a QR elsewhere on the page. No reconciliation
 * control is exposed; the commerce owner polls the provider instead.
 */
export const PlatformPaymentPanel: React.FC<PlatformPaymentPanelProps> = ({
  checkout, busy, channels = [], onSwitchChannel, onRefresh, onClose, onRefund, compact = false,
}) => {
  const { t } = useI18n();
  const [qr, setQR] = React.useState('');
  const [qrFailed, setQRFailed] = React.useState(false);
  const [openFailed, setOpenFailed] = React.useState(false);
  const [refundConfirmation, setRefundConfirmation] = React.useState(false);
  const waiting = WAITING.includes(checkout.payment_status) && !checkout.refund_status;
  const refundable = checkout.payment_status === 'PAID' && !['SUCCEEDED', 'REJECTED'].includes(checkout.refund_status);
  const session = waiting ? checkout.session : undefined;
  const codeUrl = session?.url ?? null;
  const remaining = useCountdown(waiting ? session?.expires_at ?? checkout.expires_at : undefined);
  const expired = waiting && remaining === 0;
  const provider = checkout.provider;
  const providerName = t(provider === 'wechat' ? 'platformAccount.wechatPay' : 'platformAccount.alipay');

  React.useEffect(() => {
    let current = true;
    setQR(''); setQRFailed(false);
    if (!codeUrl) return undefined;
    // Alipay reaches the account as a gateway redirect; the same link still
    // opens from the Alipay scanner, so it is offered as a code plus a button.
    void QRCode.toDataURL(codeUrl, { width: 224, margin: 2 })
      .then((image) => { if (current) setQR(image); })
      .catch(() => { if (current) setQRFailed(true); });
    return () => { current = false; };
  }, [codeUrl]);

  const actions = <>
    {session?.kind === 'redirect' && !compact && <Button size="sm" disabled={busy || expired} onClick={() => { setOpenFailed(false); void openExternalUrl(session.url).then((opened) => { if (!opened) setOpenFailed(true); }); }}>{t(provider === 'wechat' ? 'platformAccount.openWechat' : 'platformAccount.openAlipay')}</Button>}
    {waiting && <Button size="sm" variant="ghost" disabled={busy} onClick={onRefresh}>{t('platformAccount.refreshPaymentStatus')}</Button>}
    {waiting && <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>{t('platformAccount.closeCheckout')}</Button>}
    {refundable && <Button size="sm" variant="outline" disabled={busy} onClick={() => setRefundConfirmation(true)}>{t('platformAccount.requestRefund')}</Button>}
  </>;

  if (compact) {
    return <div className="oc-tile rounded-lg px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <StatusDot tone={toneFor(checkout)} />
        <span className="min-w-0 flex-1 truncate" dir="auto">{checkout.offer_name}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">¥{formatPlatformMoney(checkout.amount)}</span>
        <span className={`${SETTINGS_HELPER_CLASS} shrink-0`}>{providerName}</span>
        <span className={`${SETTINGS_HELPER_CLASS} shrink-0`}>{t(shortStateKey(checkout))}</span>
        {(refundable || waiting) && <div className="flex items-center gap-1">{actions}</div>}
      </div>
      {refundConfirmation && refundable && <div className="mt-2 space-y-2">
        <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.refundConfirmation')}</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="destructive" disabled={busy} onClick={() => { setRefundConfirmation(false); onRefund(); }}>{t('platformAccount.confirmRefund')}</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRefundConfirmation(false)}>{t('dialog.common.actions.close')}</Button>
        </div>
      </div>}
    </div>;
  }

  return <div className="oc-tile rounded-xl p-4">
    <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
      <div className="min-w-0">
        <p className="typography-micro uppercase tracking-wide text-muted-foreground">{t(waiting ? 'platformAccount.activePayment' : 'platformAccount.recentPayment')}</p>
        <p className="truncate typography-ui-label font-medium" dir="auto">{checkout.offer_name}</p>
      </div>
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <StatusDot tone={toneFor(checkout)} />
        <span className="typography-meta">{t(statusKey(checkout))}</span>
      </span>
    </div>

    <div className="mt-3 flex flex-col gap-4 @xl:flex-row @xl:items-center @xl:justify-between @xl:gap-6">
      <div className="min-w-0 space-y-3">
        <div className="space-y-1">
          <p className="typography-micro text-muted-foreground">{t(waiting ? 'platformAccount.payAmount' : 'platformAccount.amountPaid')}</p>
          <p className="flex items-baseline gap-1.5">
            <span className="text-3xl font-medium leading-none tabular-nums" dir="auto">¥{formatPlatformMoney(checkout.amount)}</span>
            <span className="typography-meta text-muted-foreground">{providerName}</span>
          </p>
        </div>
        {channels.length > 1 && onSwitchChannel && waiting && <div className="space-y-1">
          <p className="typography-micro text-muted-foreground">{t('platformAccount.paymentChannel')}</p>
          <SettingsChipGroup value={provider} onChange={(next) => { if (next !== provider && !busy) onSwitchChannel(next); }} aria-label={t('platformAccount.paymentChannel')} options={channels.map((channel) => ({ value: channel, label: t(channel === 'wechat' ? 'platformAccount.wechatPay' : 'platformAccount.alipay'), disabled: busy }))} />
        </div>}
        {waiting && <p className={`${SETTINGS_HELPER_CLASS} max-w-[22rem]`}>{t(provider === 'wechat' ? 'platformAccount.scanWithWechat' : 'platformAccount.scanWithAlipay')}</p>}
        {waiting && remaining !== null && <p className={`${SETTINGS_HELPER_CLASS} flex items-center gap-1.5`}>
          <Icon name="time" className="size-3.5" />
          {expired ? t('platformAccount.qrExpired') : remaining > 86_400_000
            ? t('platformAccount.qrValidUntil', { date: new Date(session?.expires_at ?? checkout.expires_at).toLocaleString() })
            : t('platformAccount.qrValidFor', { time: clock(remaining) })}
        </p>}
      </div>
      {waiting && (qr || qrFailed) && <div className="flex shrink-0 flex-col items-center gap-2 self-center">
        {qr && <img src={qr} width={224} height={224} className="rounded-lg bg-white p-2 ring-1 ring-black/5" alt={t(provider === 'wechat' ? 'platformAccount.scanWithWechat' : 'platformAccount.scanWithAlipay')} />}
        {qrFailed && <p role="alert" className="text-[var(--status-error-text)]">{t('platformAccount.commerceFailed')}</p>}
      </div>}
    </div>

    {checkout.refund_status === 'REJECTED' && <p className={`${SETTINGS_HELPER_CLASS} mt-3`}>{t('platformAccount.checkoutRefundRejected')}</p>}
    {openFailed && <p role="alert" className="mt-3 text-[var(--status-error-text)]">{t('platformAccount.commerceFailed')}</p>}
    {waiting && <p className={`${SETTINGS_HELPER_CLASS} mt-3`}>{t('platformAccount.paymentAutoConfirm')}</p>}
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
