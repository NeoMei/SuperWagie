import React from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useDesktopRemoteHostActive } from '@/hooks/useDesktopRemoteHostActive';
import { useOnDemandComponent } from '@/hooks/useOnDemandComponent';
import { useUIStore } from '@/stores/useUIStore';
import { shortcutRegistry } from '@/lib/shortcuts/registry';
import { DesktopInstanceMenu } from '@/components/desktop/DesktopInstanceMenu';
import {
  getRuntimeKey,
  subscribeRuntimeEndpointChanged,
} from '@/lib/runtime-switch';
import {
  readPlatformIdentitySession,
  subscribePlatformAccountState,
  type PlatformIdentitySession,
} from '@/lib/platformAccount';
import { readPlatformAvatar, readPlatformProfile, type PlatformProfile } from '@/lib/platformProfile';

type Props = {
  onOpenSettings: () => void;
  onOpenShortcuts: () => void;
  onOpenAbout: () => void;
  onOpenUpdate: () => void;
  showRuntimeButtons?: boolean;
  showUpdateButton?: boolean;
};

const footerButtonClassName = 'w-7 px-0 has-[>svg]:px-0 text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground aria-pressed:bg-interactive-selection aria-pressed:text-interactive-selection-foreground';

const loadPlatformAccountPage = () => import('@/components/sections/platform-account/PlatformAccountPage').then((module) => module.PlatformAccountPage);

const getInitials = (name: string): string => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length > 1) {
    return parts.slice(0, 2).map((part) => part[0]).join('').toUpperCase();
  }
  return Array.from(name.trim()).slice(0, 2).join('').toUpperCase() || 'U';
};

const UserCenterButton: React.FC = () => {
  const { t } = useI18n();
  const [session, setSession] = React.useState<PlatformIdentitySession | null>(null);
  const [profile, setProfile] = React.useState<PlatformProfile | null>(null);
  const [avatarUrl, setAvatarUrl] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState(false);
  const PlatformAccountPage = useOnDemandComponent(open, loadPlatformAccountPage, () => setOpen(false));
  React.useLayoutEffect(() => {
    if (open) return shortcutRegistry.suspend();
  }, [open]);
  const signedIn = session?.status === 'signed-in';
  const signedInUserId = signedIn ? session.user.id : null;
  const refresh = React.useCallback(async () => {
    const runtimeKey = getRuntimeKey();
    try {
      const next = await readPlatformIdentitySession();
      if (runtimeKey === getRuntimeKey()) setSession(next);
    } catch {
      if (runtimeKey === getRuntimeKey()) setSession(null);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
    const unsubscribeState = subscribePlatformAccountState((next, runtimeKey) => {
      if (runtimeKey === getRuntimeKey()) setSession(next);
    });
    const unsubscribeRuntime = subscribeRuntimeEndpointChanged(() => {
      setSession(null);
      void refresh();
    });
    return () => {
      unsubscribeState();
      unsubscribeRuntime();
    };
  }, [refresh]);

  React.useEffect(() => {
    setProfile(null);
    setAvatarUrl(null);
    if (!signedInUserId) return;

    let cancelled = false;
    let objectUrl: string | null = null;
    const runtimeKey = getRuntimeKey();
    void (async () => {
      try {
        const nextProfile = await readPlatformProfile();
        if (cancelled || runtimeKey !== getRuntimeKey()) return;
        setProfile(nextProfile);
        if (!nextProfile.avatarAvailable) return;
        const avatar = await readPlatformAvatar();
        if (cancelled || runtimeKey !== getRuntimeKey()) return;
        objectUrl = URL.createObjectURL(avatar);
        setAvatarUrl(objectUrl);
      } catch {
        if (!cancelled && runtimeKey === getRuntimeKey()) setProfile(null);
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [signedInUserId, open]);

  const initials = signedIn ? getInitials(profile?.displayName || session.user.name || session.user.email) : null;
  const label = t('sessions.sidebar.footer.accountMenu.userCenter');

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DialogTrigger asChild>
            <Button variant="ghost" size="sm" aria-label={label} aria-pressed={open} className={cn(footerButtonClassName, 'rounded-full')}>
              <span className="oc-tile-inset inline-flex size-6 items-center justify-center rounded-full typography-micro">
                {avatarUrl ? <img src={avatarUrl} alt="" className="size-full rounded-full object-cover" /> : initials ?? <Icon name="user-3" className="size-4" />}
              </span>
            </Button>
          </DialogTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}><p>{label}</p></TooltipContent>
      </Tooltip>
      <DialogContent className="h-[min(48rem,85dvh)] max-w-4xl gap-0 overflow-hidden p-0 pt-5" aria-describedby={undefined}>
        <DialogTitle className="sr-only">{label}</DialogTitle>
        {open && PlatformAccountPage ? <PlatformAccountPage /> : null}
      </DialogContent>
    </Dialog>
  );
};

export function SidebarFooter({
  onOpenSettings,
  onOpenShortcuts,
  onOpenAbout,
  onOpenUpdate,
  showRuntimeButtons = true,
  showUpdateButton = true,
}: Props): React.ReactNode {
  const { t } = useI18n();
  const isUsageOpen = useUIStore((state) => state.isUsageStatsPageOpen);
  // On a remote host the button updates this app, not the server it shows.
  const isDesktopRemote = useDesktopRemoteHostActive();
  if (!showRuntimeButtons && !showUpdateButton) {
    return null;
  }

  const updateLabel = isDesktopRemote ? t('sessions.sidebar.footer.actions.updateApp') : t('sessions.sidebar.footer.actions.update');
  const updateButton = (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          onClick={onOpenUpdate}
          className={cn(footerButtonClassName, 'text-[var(--status-info)] hover:bg-[var(--status-info-background)] hover:text-[var(--status-info)]')}
          aria-label={updateLabel}
        >
          <Icon name="download" className="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}><p>{updateLabel}</p></TooltipContent>
    </Tooltip>
  );

  return (
    <div className="flex shrink-0 items-center justify-start gap-1 px-2.5 py-2">
      {showRuntimeButtons ? (
        <>
          <UserCenterButton />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" onClick={onOpenSettings} className={footerButtonClassName} aria-label={t('sessions.sidebar.footer.actions.settings')}>
                <Icon name="settings-3" className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}><p>{t('sessions.sidebar.footer.actions.settings')}</p></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" onClick={() => useUIStore.getState().setUsageStatsPageOpen(!isUsageOpen)} className={footerButtonClassName} aria-label={t('sessions.sidebar.footer.accountMenu.usage')} aria-pressed={isUsageOpen}>
                <Icon name="bar-chart" className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}><p>{t('sessions.sidebar.footer.accountMenu.usage')}</p></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" onClick={onOpenShortcuts} className={footerButtonClassName} aria-label={t('sessions.sidebar.footer.actions.shortcuts')}>
                <Icon name="command" className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}><p>{t('sessions.sidebar.footer.actions.shortcuts')}</p></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" onClick={onOpenAbout} className={footerButtonClassName} aria-label={t('sessions.sidebar.footer.actions.aboutOpenChamber')}>
                <Icon name="information" className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}><p>{t('sessions.sidebar.footer.actions.aboutOpenChamber')}</p></TooltipContent>
          </Tooltip>
          {showUpdateButton ? updateButton : null}
        </>
      ) : null}
      {!showRuntimeButtons && showUpdateButton ? updateButton : null}
      {showRuntimeButtons ? (
        <DesktopInstanceMenu className="ms-auto inline-flex h-7 min-w-0 max-w-[12rem] items-center gap-1.5 rounded-md px-2 text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground" />
      ) : null}
    </div>
  );
}
