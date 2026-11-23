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
  return <div className="flex min-w-0 items-center gap-2" data-platform-account-identity data-settings-item="platform-account.login">
    {avatarURL
      ? <img src={avatarURL} alt={t('platformAccount.avatar')} className="size-8 shrink-0 rounded-full object-cover" />
      : <div className="oc-tile-inset flex size-8 shrink-0 items-center justify-center rounded-full" aria-label={t('platformAccount.avatar')}>
        <Icon name="user" className="size-4 text-muted-foreground" />
      </div>}
    <span dir="auto" title={name} className="truncate typography-meta font-medium" data-platform-account-name>{name}</span>
  </div>;
};
