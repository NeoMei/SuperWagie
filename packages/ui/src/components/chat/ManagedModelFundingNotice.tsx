import React from 'react';
import { Button } from '@/components/ui/button';
import { DialogTrigger } from '@/components/ui/dialog';
import { PlatformAccountDialog } from '@/components/sections/platform-account/PlatformAccountDialog';
import { preparePlatformAccountTarget } from '@/components/sections/platform-account/platformAccountTabs';
import { useI18n } from '@/lib/i18n';

export const ManagedModelFundingNotice = () => {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  return (
    <PlatformAccountDialog open={open} onOpenChange={setOpen}>
      <div role="status" className="mt-2 rounded-lg bg-[var(--status-warning-background)] px-3 py-2">
        <p className="typography-meta text-foreground">{t('platformAccount.fundingRequired')}</p>
        <DialogTrigger asChild>
          <Button variant="link" size="xs" onClick={() => preparePlatformAccountTarget('platform-account.model-recharge')}>
            {t('platformAccount.openBilling')}
          </Button>
        </DialogTrigger>
      </div>
    </PlatformAccountDialog>
  );
};
