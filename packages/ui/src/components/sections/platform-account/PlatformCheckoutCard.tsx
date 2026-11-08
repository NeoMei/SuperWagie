import React from 'react';
import QRCode from 'qrcode';
import { openExternalUrl } from '@/lib/url';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { SettingsControlGroup, SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import { formatPlatformMoney, type PlatformCheckout } from '@/lib/platformCommerce';

export const PlatformCheckoutCard: React.FC<{ checkout: PlatformCheckout; busy: boolean; onAction: (action: 'reconcile' | 'close' | 'refund') => void }> = ({ checkout, busy, onAction }) => {
  const { t } = useI18n();
  const [qr, setQR] = React.useState('');
  const [error, setError] = React.useState(false);
  const [refundConfirmation, setRefundConfirmation] = React.useState(false);
  const waiting = ['CREATED', 'PENDING', 'UNKNOWN'].includes(checkout.payment_status) && !checkout.refund_status;
  const canRefund = checkout.payment_status === 'PAID' && !['SUCCEEDED', 'REJECTED'].includes(checkout.refund_status);
  const session = waiting ? checkout.session : undefined;
  const qrUrl = session?.kind === 'qr' ? session.url : null;
  React.useEffect(() => {
    let current = true;
    setQR(''); setError(false);
    if (qrUrl) void QRCode.toDataURL(qrUrl, { width: 224, margin: 2 }).then((image) => { if (current) setQR(image); }).catch(() => { if (current) setError(true); });
    return () => { current = false; };
  }, [qrUrl]);
  const status = checkout.refund_status === 'SUCCEEDED' ? 'platformAccount.checkoutRefunded'
    : checkout.refund_status === 'PENDING' ? 'platformAccount.checkoutRefunding'
      : checkout.refund_status === 'REVIEW' || checkout.payment_status === 'REVIEW' || checkout.fulfillment_status === 'REVIEW' ? 'platformAccount.checkoutReview'
        : checkout.payment_status === 'CLOSED' ? 'platformAccount.checkoutClosed'
          : checkout.payment_status === 'PAID' ? checkout.fulfillment_status === 'FULFILLED' ? 'platformAccount.purchaseApplied' : 'platformAccount.checkoutActivating'
            : checkout.payment_status === 'UNKNOWN' ? 'platformAccount.commandUnknown' : 'platformAccount.checkoutWaiting';
  return <SettingsControlGroup title={checkout.offer_name} description={t(status)}>
    {checkout.refund_status === 'REJECTED' && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.checkoutRefundRejected')}</p>}
    <p dir="auto">{t('platformAccount.cny', { amount: formatPlatformMoney(checkout.amount) })} · {t(checkout.provider === 'wechat' ? 'platformAccount.wechatPay' : 'platformAccount.alipay')}</p>
    {qr && <img src={qr} width={224} height={224} alt={t('platformAccount.checkoutQR')} />}
    {session && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.quoteValidUntil')} · {new Date(checkout.expires_at).toLocaleString()}</p>}
    {error && <p role="alert" className="text-[var(--status-error-text)]">{t('platformAccount.commerceFailed')}</p>}
    <div className="flex flex-wrap gap-2">
      {session?.kind === 'redirect' && <Button disabled={busy} onClick={() => { setError(false); void openExternalUrl(session.url).then((opened) => { if (!opened) setError(true); }); }}>{t('platformAccount.openAlipay')}</Button>}
      <Button variant="outline" disabled={busy} onClick={() => onAction('reconcile')}>{t('platformAccount.checkIntent')}</Button>
      {waiting && <Button variant="outline" disabled={busy} onClick={() => onAction('close')}>{t('platformAccount.closeCheckout')}</Button>}
      {canRefund && <Button variant="outline" disabled={busy} onClick={() => setRefundConfirmation(true)}>{t('platformAccount.requestRefund')}</Button>}
    </div>
    {refundConfirmation && canRefund && <div className="space-y-2"><p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.refundConfirmation')}</p><Button variant="destructive" disabled={busy} onClick={() => { setRefundConfirmation(false); onAction('refund'); }}>{t('platformAccount.confirmRefund')}</Button><Button variant="ghost" disabled={busy} onClick={() => setRefundConfirmation(false)}>{t('dialog.common.actions.close')}</Button></div>}
  </SettingsControlGroup>;
};
