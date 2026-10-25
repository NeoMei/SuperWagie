import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SettingsFieldRow, SettingsSection, SettingsStackedField, SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { reportSettingsSaveState } from '@/lib/persistence';
import { platformAccountErrorKey } from './platformAccountErrors';
import { PlatformAccountError } from '@/lib/platformAccount';
import {
  changePlatformPassword,
  readPlatformAvatar,
  readPlatformProfile,
  updatePlatformAvatar,
  updatePlatformProfile,
  type PlatformProfile,
} from '@/lib/platformProfile';

const MAX_AVATAR_BYTES = 512 * 1024;

const fileBase64 = async (file: File): Promise<string> => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

export const PlatformAccountProfile: React.FC = () => {
  const { t } = useI18n();
  const runtimeKey = getRuntimeKey();
  const [profile, setProfile] = React.useState<PlatformProfile | null>(null);
  const [displayName, setDisplayName] = React.useState('');
  const [avatarURL, setAvatarURL] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<I18nKey | null>(null);
  const [currentPassword, setCurrentPassword] = React.useState('');
  const [newPassword, setNewPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');
  const avatarURLRef = React.useRef<string | null>(null);
  const revision = React.useRef(0);

  const replaceAvatarURL = React.useCallback((next: string | null) => {
    if (avatarURLRef.current) URL.revokeObjectURL(avatarURLRef.current);
    avatarURLRef.current = next;
    setAvatarURL(next);
  }, []);
  React.useEffect(() => () => { if (avatarURLRef.current) URL.revokeObjectURL(avatarURLRef.current); }, []);

  const refresh = React.useCallback(async () => {
    const current = ++revision.current;
    setLoading(true); setError(null);
    try {
      const next = await readPlatformProfile();
      if (current !== revision.current || runtimeKey !== getRuntimeKey()) return;
      setProfile(next); setDisplayName(next.displayName);
      replaceAvatarURL(null);
      if (next.avatarAvailable) {
        try {
          const avatar = await readPlatformAvatar();
          if (current === revision.current && runtimeKey === getRuntimeKey()) replaceAvatarURL(URL.createObjectURL(avatar));
        } catch { if (current === revision.current && runtimeKey === getRuntimeKey()) setError('platformAccount.profileAvatarFailed'); }
      }
    } catch (cause) {
      if (current === revision.current && runtimeKey === getRuntimeKey()) { setProfile(null); setError(platformAccountErrorKey(cause instanceof PlatformAccountError ? cause : null, 'platformAccount.profileFailed')); }
    } finally { if (current === revision.current && runtimeKey === getRuntimeKey()) setLoading(false); }
  }, [replaceAvatarURL, runtimeKey]);
  React.useEffect(() => { void refresh(); return () => { revision.current += 1; }; }, [refresh]);

  const saveProfile = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!profile || busy) return;
    const current = ++revision.current;
    setBusy(true); setError(null); reportSettingsSaveState('saving');
    try {
      const next = await updatePlatformProfile({ displayName: displayName.trim() });
      if (current !== revision.current || runtimeKey !== getRuntimeKey()) return;
      setProfile(next); setDisplayName(next.displayName); reportSettingsSaveState('saved');
    } catch (cause) { if (current === revision.current && runtimeKey === getRuntimeKey()) { setError(platformAccountErrorKey(cause instanceof PlatformAccountError ? cause : null, 'platformAccount.profileFailed')); reportSettingsSaveState('error'); } }
    finally { if (current === revision.current && runtimeKey === getRuntimeKey()) setBusy(false); }
  };

  const uploadAvatar = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || busy) return;
    if ((file.type !== 'image/png' && file.type !== 'image/jpeg') || file.size > MAX_AVATAR_BYTES) { setError('platformAccount.profileAvatarInvalid'); return; }
    const contentType = file.type;
    const current = ++revision.current;
    setBusy(true); setError(null); reportSettingsSaveState('saving');
    try {
      const dataBase64 = await fileBase64(file);
      if (current !== revision.current || runtimeKey !== getRuntimeKey()) return;
      const next = await updatePlatformAvatar({ contentType, dataBase64 });
      if (current !== revision.current || runtimeKey !== getRuntimeKey()) return;
      setProfile(next);
      const avatar = await readPlatformAvatar();
      if (current !== revision.current || runtimeKey !== getRuntimeKey()) return;
      replaceAvatarURL(URL.createObjectURL(avatar)); reportSettingsSaveState('saved');
    } catch (cause) { if (current === revision.current && runtimeKey === getRuntimeKey()) { setError(platformAccountErrorKey(cause instanceof PlatformAccountError ? cause : null, 'platformAccount.profileAvatarFailed')); reportSettingsSaveState('error'); } }
    finally { if (current === revision.current && runtimeKey === getRuntimeKey()) setBusy(false); }
  };

  const changePassword = async (event: React.FormEvent) => {
    event.preventDefault();
    const old = currentPassword; const next = newPassword; const confirm = confirmPassword;
    setCurrentPassword(''); setNewPassword(''); setConfirmPassword(''); setError(null);
    if (next !== confirm) { setError('platformAccount.profilePasswordMismatch'); return; }
    if (busy) return;
    const current = ++revision.current;
    setBusy(true);
    try { await changePlatformPassword({ currentPassword: old, newPassword: next }); }
    catch (cause) { if (current === revision.current && runtimeKey === getRuntimeKey()) setError(platformAccountErrorKey(cause instanceof PlatformAccountError ? cause : null, 'platformAccount.profilePasswordFailed')); }
    finally { if (current === revision.current && runtimeKey === getRuntimeKey()) setBusy(false); }
  };

  if (loading && !profile) return <SettingsSection title={t('platformAccount.profile')} divider={false}><p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.loading')}</p></SettingsSection>;
  if (!profile) return <SettingsSection title={t('platformAccount.profile')} divider={false} contentClassName="space-y-3"><p className="text-[var(--status-error-text)]" role="alert">{error ? t(error) : t('platformAccount.profileFailed')}</p><Button variant="outline" onClick={() => void refresh()}>{t('platformAccount.refresh')}</Button></SettingsSection>;

  return <>
    <SettingsSection title={t('platformAccount.profile')} divider={false} contentClassName="space-y-5" headerAction={<Button variant="ghost" disabled={busy} onClick={() => void refresh()}>{t('platformAccount.refresh')}</Button>}>
      <p className="min-h-5 text-[var(--status-error-text)]" role={error ? 'alert' : 'status'}>{error ? t(error) : null}</p>
      <SettingsFieldRow label={t('platformAccount.avatar')} description={t('platformAccount.avatarHint')} settingsItem="platform-account.avatar">
        <div className="flex items-center gap-3">
          {avatarURL ? <img src={avatarURL} alt={t('platformAccount.avatar')} className="size-12 rounded-full object-cover" /> : <div aria-hidden className="size-12 rounded-full bg-[var(--surface-elevated)]" />}
          <Input type="file" aria-label={t('platformAccount.avatarUpload')} accept="image/png,image/jpeg" onChange={(event) => void uploadAvatar(event)} disabled={busy} className="max-w-[16rem]" />
        </div>
      </SettingsFieldRow>
      <form onSubmit={(event) => void saveProfile(event)} className="space-y-4">
        <SettingsStackedField label={<label htmlFor="unihub-profile-username">{t('platformAccount.username')}</label>} description={t('platformAccount.usernameFixed')}><Input id="unihub-profile-username" value={profile.username} readOnly /></SettingsStackedField>
        <SettingsStackedField label={<label htmlFor="unihub-profile-display-name">{t('platformAccount.profileName')}</label>} settingsItem="platform-account.profile"><Input id="unihub-profile-display-name" value={displayName} maxLength={160} onChange={(event) => setDisplayName(Array.from(event.target.value).slice(0, 80).join(''))} disabled={busy} /></SettingsStackedField>
        <SettingsStackedField label={<label htmlFor="unihub-profile-email">{t('platformAccount.profileEmail')}</label>}><Input id="unihub-profile-email" value={profile.email} readOnly /></SettingsStackedField>
        <Button type="submit" disabled={busy || displayName.trim() === profile.displayName}>{t('platformAccount.saveProfile')}</Button>
      </form>
    </SettingsSection>
    <SettingsSection title={t('platformAccount.security')} contentClassName="space-y-4" settingsItem="platform-account.password">
      <form onSubmit={(event) => void changePassword(event)} className="max-w-[24rem] space-y-4">
        <SettingsStackedField label={<label htmlFor="unihub-current-password">{t('platformAccount.currentPassword')}</label>}><Input id="unihub-current-password" type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} disabled={busy} required /></SettingsStackedField>
        <SettingsStackedField label={<label htmlFor="unihub-new-password">{t('platformAccount.newPassword')}</label>}><Input id="unihub-new-password" type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} disabled={busy} minLength={12} maxLength={128} required /></SettingsStackedField>
        <SettingsStackedField label={<label htmlFor="unihub-confirm-password">{t('platformAccount.confirmPassword')}</label>}><Input id="unihub-confirm-password" type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} disabled={busy} minLength={12} maxLength={128} required /></SettingsStackedField>
        <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.passwordChangeHint')}</p>
        <Button type="submit" disabled={busy}>{t('platformAccount.changePassword')}</Button>
      </form>
    </SettingsSection>
  </>;
};
