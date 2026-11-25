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
  return <div className="min-w-0 space-y-1 @xl/account:space-y-1.5" data-platform-account-identity data-settings-item="platform-account.login">
    <div className="flex min-w-0 items-center gap-2.5">
      {avatarURL
        ? <img src={avatarURL} alt={t('platformAccount.avatar')} className="size-8 shrink-0 rounded-full object-cover @xl/account:size-11" />
        : <div className="oc-tile-inset flex size-8 shrink-0 items-center justify-center rounded-full @xl/account:size-11" aria-label={t('platformAccount.avatar')}>
          <Icon name="user" className="size-4 text-muted-foreground @xl/account:size-5" />
        </div>}
      <div className="min-w-0">
        <p dir="auto" title={name} className="truncate typography-ui-label font-semibold" data-platform-account-name>{name}</p>
        {username && username !== name && <p dir="auto" title={username} className="truncate typography-meta text-muted-foreground">{username}</p>}
      </div>
    </div>
    {email && email !== name && <p dir="auto" title={email} className="truncate typography-meta text-muted-foreground @xl/account:whitespace-normal @xl/account:wrap-anywhere">{email}</p>}
  </div>;
};
