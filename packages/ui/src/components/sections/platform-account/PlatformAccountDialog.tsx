import React from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useOnDemandComponent } from '@/hooks/useOnDemandComponent';
import { useI18n } from '@/lib/i18n';
import { shortcutRegistry } from '@/lib/shortcuts/registry';

const loadPlatformAccountPage = () => import('./PlatformAccountPage').then((module) => module.PlatformAccountPage);

export const PlatformAccountDialog: React.FC<React.PropsWithChildren<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
}>> = ({ open, onOpenChange, children }) => {
  const { t } = useI18n();
  const PlatformAccountPage = useOnDemandComponent(open, loadPlatformAccountPage, () => onOpenChange(false));
  React.useLayoutEffect(() => {
    if (open) return shortcutRegistry.suspend();
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {children}
      <DialogContent className="h-[min(52rem,90dvh)] max-w-6xl gap-0 overflow-hidden p-0 pt-5" aria-describedby={undefined}>
        <DialogTitle className="sr-only">{t('sessions.sidebar.footer.accountMenu.userCenter')}</DialogTitle>
        {open && PlatformAccountPage ? <PlatformAccountPage /> : null}
      </DialogContent>
    </Dialog>
  );
};
