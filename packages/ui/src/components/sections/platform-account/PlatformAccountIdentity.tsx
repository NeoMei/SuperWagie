import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { captureRuntimeInstance } from '@/lib/runtime-switch';
import { readPlatformAvatar, readPlatformProfile, type PlatformProfile } from '@/lib/platformProfile';

export const PlatformAccountIdentity: React.FC<{
  user: { id: string; name: string; email: string };
  revision: number;
}> = ({ user, revision }) => {
  const { t } = useI18n();
  const [profile, setProfile] = React.useState<PlatformProfile | null>(null);
  const [avatarURL, setAvatarURL] = React.useState<string | null>(null);

  React.useEffect(() => {
    const runtimeCurrent = captureRuntimeInstance();
    let active = true;
    let objectURL: string | null = null;
    setProfile(null);
    setAvatarURL(null);
    void (async () => {
      try {
        const next = await readPlatformProfile();
        if (!active || !runtimeCurrent() || next.id !== user.id) return;
        setProfile(next);
        if (next.avatarAvailable) {
          const avatar = await readPlatformAvatar();
          if (!active || !runtimeCurrent()) return;
          objectURL = URL.createObjectURL(avatar);
          setAvatarURL(objectURL);
        }
      } catch { /* The signed-in identity remains available when its optional portrait cannot load. */ }
    })();
    return () => {
      active = false;
      if (objectURL) URL.revokeObjectURL(objectURL);
    };
  }, [revision, user.id]);

  const name = profile
    ? profile.displayName || profile.username || profile.email || t('platformAccount.signedIn')
    : user.name || user.email || t('platformAccount.signedIn');
  const email = profile?.email || user.email;
  const username = profile?.username;
  return <div className="flex min-w-0 items-center gap-2 @3xl/account:flex-col @3xl/account:items-start @3xl/account:gap-3" data-platform-account-identity data-settings-item="platform-account.login">
    {avatarURL
      ? <img src={avatarURL} alt={t('platformAccount.avatar')} className="size-9 shrink-0 rounded-full object-cover @3xl/account:size-16" />
      : <div className="oc-tile-inset flex size-9 shrink-0 items-center justify-center rounded-full @3xl/account:size-16" aria-label={t('platformAccount.avatar')}>
        <Icon name="user" className="size-4 text-muted-foreground @3xl/account:size-7" />
      </div>}
    <div className="min-w-0 @3xl/account:w-full @3xl/account:space-y-0.5">
      <p dir="auto" title={name} className="truncate typography-ui-label font-semibold" data-platform-account-name>{name}</p>
      {username && username !== name && <p dir="auto" className="hidden break-words typography-meta text-muted-foreground @3xl/account:block">{username}</p>}
      {email && email !== name && <p dir="auto" title={email} className="truncate typography-meta text-muted-foreground @3xl/account:whitespace-normal @3xl/account:break-all">{email}</p>}
    </div>
  </div>;
};
