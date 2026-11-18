import React from 'react';
import { Button } from '@/components/ui/button';
import { DialogTrigger } from '@/components/ui/dialog';
import { PlatformAccountDialog } from '@/components/sections/platform-account/PlatformAccountDialog';
import { preparePlatformAccountTarget } from '@/components/sections/platform-account/platformAccountTabs';
import { useI18n } from '@/lib/i18n';

export const ManagedModelFundingNotice = ({ membershipExpired = false }: { membershipExpired?: boolean }) => {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  return (
    <PlatformAccountDialog open={open} onOpenChange={setOpen}>
      <div role="status" className="mt-2 rounded-lg bg-[var(--status-warning-background)] px-3 py-2">
        <p className="typography-meta text-foreground">{t(membershipExpired ? 'platformAccount.productWallet.modelMembershipExpired' : 'platformAccount.creditsFundingRequired')}</p>
        <DialogTrigger asChild>
          <Button variant="link" size="xs" onClick={() => preparePlatformAccountTarget(membershipExpired ? 'platform-account.membership' : 'platform-account.funding')}>
            {t(membershipExpired ? 'platformAccount.productWallet.renewMembership' : 'platformAccount.openCreditBilling')}
          </Button>
        </DialogTrigger>
      </div>
    </PlatformAccountDialog>
  );
};
