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
  return <div className="flex min-w-0 items-center gap-4 @3xl/account:flex-col @3xl/account:items-start @3xl/account:gap-5" data-settings-item="platform-account.login">
    {avatarURL
      ? <img src={avatarURL} alt={t('platformAccount.avatar')} className="size-20 shrink-0 rounded-full object-cover @3xl/account:aspect-square @3xl/account:size-auto @3xl/account:w-full" />
      : <div className="oc-tile-inset flex size-20 shrink-0 items-center justify-center rounded-full @3xl/account:aspect-square @3xl/account:size-auto @3xl/account:w-full" aria-label={t('platformAccount.avatar')}>
        <Icon name="user" className="size-9 text-muted-foreground @3xl/account:size-20" />
      </div>}
    <div className="min-w-0 w-full space-y-1">
      <p dir="auto" title={name} className="break-words text-xl font-semibold tracking-tight @3xl/account:text-2xl" data-platform-account-name>{name}</p>
      {profile?.username && <p dir="auto" title={profile.username} className="truncate text-base text-muted-foreground">{profile.username}</p>}
      {(profile?.email || user.email) && <p dir="auto" title={profile?.email || user.email} className="flex min-w-0 items-center gap-2 pt-2 typography-meta text-muted-foreground"><Icon name="mail" className="size-4 shrink-0" /><span className="truncate">{profile?.email || user.email}</span></p>}
    </div>
  </div>;
};
