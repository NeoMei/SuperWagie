import React from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useDesktopRemoteHostActive } from '@/hooks/useDesktopRemoteHostActive';
import { useUIStore } from '@/stores/useUIStore';
import { DesktopInstanceMenu } from '@/components/desktop/DesktopInstanceMenu';
import {
  getRuntimeKey,
  subscribeRuntimeEndpointChanged,
} from '@/lib/runtime-switch';
import {
  logoutPlatformAccount,
  readPlatformIdentitySession,
  subscribePlatformAccountState,
  type PlatformIdentitySession,
} from '@/lib/platformAccount';
import { readPlatformAvatar, readPlatformProfile, type PlatformProfile } from '@/lib/platformProfile';

type Props = {
  onOpenSettings: () => void;
  onOpenUserCenter: () => void;
  onOpenShortcuts: () => void;
  onOpenAbout: () => void;
  onOpenUpdate: () => void;
  showRuntimeButtons?: boolean;
  showUpdateButton?: boolean;
};

const footerButtonClassName = 'inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

const getInitials = (name: string): string => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length > 1) {
    return parts.slice(0, 2).map((part) => part[0]).join('').toUpperCase();
  }
  return Array.from(name.trim()).slice(0, 2).join('').toUpperCase() || 'U';
};

const AccountMenu: React.FC<Pick<Props, 'onOpenSettings' | 'onOpenUserCenter' | 'onOpenShortcuts' | 'onOpenAbout'>> = ({
  onOpenSettings,
  onOpenUserCenter,
  onOpenShortcuts,
  onOpenAbout,
}) => {
  const { t } = useI18n();
  const [session, setSession] = React.useState<PlatformIdentitySession | null>(null);
  const [profile, setProfile] = React.useState<PlatformProfile | null>(null);
  const [avatarUrl, setAvatarUrl] = React.useState<string | null>(null);
  const avatarUrlRef = React.useRef<string | null>(null);
  const [open, setOpen] = React.useState(false);
  const [signingOut, setSigningOut] = React.useState(false);
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
    if (!signedInUserId) {
      setProfile(null);
      if (avatarUrlRef.current) URL.revokeObjectURL(avatarUrlRef.current);
      avatarUrlRef.current = null;
      setAvatarUrl(null);
      return;
    }

    let cancelled = false;
    const runtimeKey = getRuntimeKey();
    void (async () => {
      try {
        const nextProfile = await readPlatformProfile();
        if (cancelled || runtimeKey !== getRuntimeKey()) return;
        setProfile(nextProfile);
        if (!nextProfile.avatarAvailable) return;
        const avatar = await readPlatformAvatar();
        if (cancelled || runtimeKey !== getRuntimeKey()) return;
        const nextUrl = URL.createObjectURL(avatar);
        if (avatarUrlRef.current) URL.revokeObjectURL(avatarUrlRef.current);
        avatarUrlRef.current = nextUrl;
        setAvatarUrl(nextUrl);
      } catch {
        if (!cancelled && runtimeKey === getRuntimeKey()) setProfile(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [signedInUserId]);

  React.useEffect(() => () => {
    if (avatarUrlRef.current) URL.revokeObjectURL(avatarUrlRef.current);
  }, []);

  const displayName = signedIn ? profile?.displayName || session.user.name || session.user.email : t('sessions.sidebar.footer.accountMenu.signedOut');
  const identityLabel = signedIn ? session.user.email : t('platformAccount.loginRequiredDescription');
  const initials = signedIn ? getInitials(profile?.displayName || session.user.name || session.user.email) : null;
  const isUsageOpen = useUIStore((state) => state.isUsageStatsPageOpen);
  const handleSignOut = React.useCallback(async () => {
    if (!signedIn || signingOut) return;
    setSigningOut(true);
    try {
      await logoutPlatformAccount();
      setSession({ status: 'signed-out' });
    } catch {
      toast.error(t('platformAccount.signOutFailed'));
    } finally {
      setSigningOut(false);
    }
  }, [signedIn, signingOut, t]);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('sessions.sidebar.footer.accountMenu.open')}
          aria-expanded={open}
          className={cn(
            'inline-flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            'bg-[var(--primary-base)] text-[var(--primary-foreground)] hover:opacity-90',
          )}
        >
          {avatarUrl ? <img src={avatarUrl} alt="" className="size-full rounded-full object-cover" /> : initials ?? <Icon name="user-3" className="size-4" />}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-64 p-2">
        <div className="mb-1 flex items-center gap-2.5 rounded-lg bg-interactive-hover/50 px-2.5 py-2.5">
          <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--primary-base)] text-xs font-medium text-[var(--primary-foreground)]">
            {avatarUrl ? <img src={avatarUrl} alt="" className="size-full rounded-full object-cover" /> : initials ?? <Icon name="user-3" className="size-4" />}
          </span>
          <div className="min-w-0">
            <div className="truncate typography-ui-label font-medium text-foreground" dir="auto">{displayName}</div>
            <div className="truncate typography-micro text-muted-foreground" dir="auto">{identityLabel}</div>
          </div>
        </div>
        <DropdownMenuItem onClick={onOpenUserCenter}>
          <Icon name="user-3" className="size-4" />
          {signedIn ? t('sessions.sidebar.footer.accountMenu.userCenter') : t('platformAccount.signIn')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => useUIStore.getState().setUsageStatsPageOpen(!isUsageOpen)}>
          <Icon name="bar-chart" className="size-4" />
          {t('sessions.sidebar.footer.accountMenu.usage')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onOpenSettings}>
          <Icon name="settings-3" className="size-4" />
          {t('sessions.sidebar.footer.actions.settings')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onOpenShortcuts}>
          <Icon name="command" className="size-4" />
          {t('sessions.sidebar.footer.actions.shortcuts')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onOpenAbout}>
          <Icon name="information" className="size-4" />
          {t('sessions.sidebar.footer.actions.aboutOpenChamber')}
        </DropdownMenuItem>
        {signedIn && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" disabled={signingOut} onClick={() => { void handleSignOut(); }}>
              <Icon name="logout-box-r" className="size-4" />
              {t('platformAccount.signOut')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export function SidebarFooter({
  onOpenSettings,
  onOpenUserCenter,
  onOpenShortcuts,
  onOpenAbout,
  onOpenUpdate,
  showRuntimeButtons = true,
  showUpdateButton = true,
}: Props): React.ReactNode {
  const { t } = useI18n();
  // On a remote host the button updates this app, not the server it shows.
  const isDesktopRemote = useDesktopRemoteHostActive();
  if (!showRuntimeButtons && !showUpdateButton) {
    return null;
  }

  const updateLabel = isDesktopRemote ? t('sessions.sidebar.footer.actions.updateApp') : t('sessions.sidebar.footer.actions.update');
  const updateButton = (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onOpenUpdate}
          className={cn(footerButtonClassName, 'text-[var(--status-info)] hover:bg-[var(--status-info-background)] hover:text-[var(--status-info)]')}
          aria-label={updateLabel}
        >
          <Icon name="download" className="h-4 w-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}><p>{updateLabel}</p></TooltipContent>
    </Tooltip>
  );

  return (
    <div className="flex shrink-0 items-center justify-start gap-1 px-2.5 py-2">
      {showRuntimeButtons ? (
        <>
          <AccountMenu
            onOpenSettings={onOpenSettings}
            onOpenUserCenter={onOpenUserCenter}
            onOpenShortcuts={onOpenShortcuts}
            onOpenAbout={onOpenAbout}
          />
          {showUpdateButton ? updateButton : null}
        </>
      ) : null}
      {!showRuntimeButtons && showUpdateButton ? updateButton : null}
      {showRuntimeButtons ? (
        <DesktopInstanceMenu className="ms-auto inline-flex h-6 min-w-0 max-w-[12rem] items-center gap-1.5 rounded-md px-2 text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
      ) : null}
    </div>
  );
}
