import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';

export const ManagedModelFundingNotice = () => {
  const { t } = useI18n();
  return <div role="status" className="mt-2 rounded-lg bg-[var(--status-warning-background)] px-3 py-2">
    <p className="typography-meta text-foreground">{t('platformAccount.fundingRequired')}</p>
    <Button variant="link" size="xs" onClick={() => {
      const ui = useUIStore.getState();
      ui.requestSettingsJump('platform-account', 'platform-account.model-recharge');
      ui.setSettingsDialogOpen(true);
    }}>{t('platformAccount.openBilling')}</Button>
  </div>;
};
