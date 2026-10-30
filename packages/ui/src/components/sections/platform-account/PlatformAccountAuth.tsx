import React from 'react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SettingsChipGroup, SettingsStackedField, SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { openExternalUrl } from '@/lib/url';
import { loginPlatformAccount, passwordLoginPlatformAccount, readPlatformAuthMethods, readPlatformLoginUsername, registerPlatformAccount, PlatformAccountError, type PlatformIdentitySession } from '@/lib/platformAccount';
import { platformAccountErrorKey } from './platformAccountErrors';

const recoverySchema = z.object({
  idempotencyKey: z.string().uuid(), username: z.string().min(1), email: z.string().optional(), displayName: z.string().optional(),
}).strict();
type RegistrationRecovery = z.infer<typeof recoverySchema>;
type RecoveryState = { status: 'ready'; pending: RegistrationRecovery | null } | { status: 'unavailable' };
const storageKey = (runtimeKey: string) => `superwagie.unihub.registration.v1:${encodeURIComponent(runtimeKey)}`;
const registrationDisplayName = (value: string) => Array.from(value).slice(0, 80).join('');
const registrationPasswordBytes = (value: string) => new TextEncoder().encode(value).byteLength;
const readRecovery = (runtimeKey: string): RecoveryState => {
  try {
    const stored = localStorage.getItem(storageKey(runtimeKey));
    return { status: 'ready', pending: stored ? recoverySchema.parse(JSON.parse(stored)) : null };
  } catch { return { status: 'unavailable' }; }
};
const definitiveRegistrationError = (error: PlatformAccountError) => ['invalid_request', 'platform_request_invalid', 'registration_conflict', 'invalid_password', 'forbidden', 'rate_limited', 'interaction_required', 'platform_headless_unconfigured', 'client_not_enabled'].includes(error.code);

export const PlatformAccountAuth: React.FC<{ onSignedIn: (state: PlatformIdentitySession) => void }> = ({ onSignedIn }) => {
  const { t } = useI18n();
  const runtimeKey = getRuntimeKey();
  const [recovery, setRecovery] = React.useState(() => readRecovery(runtimeKey));
  const pending = recovery.status === 'ready' ? recovery.pending : null;
  const [mode, setMode] = React.useState<'login' | 'register'>(pending ? 'register' : 'login');
  const [methods, setMethods] = React.useState<Awaited<ReturnType<typeof readPlatformAuthMethods>> | null>(null);
  const [username, setUsername] = React.useState(() => pending?.username ?? readPlatformLoginUsername(runtimeKey));
  const [password, setPassword] = React.useState('');
  const [passwordRequired, setPasswordRequired] = React.useState(false);
  const [email, setEmail] = React.useState(pending?.email ?? '');
  const [displayName, setDisplayName] = React.useState(pending?.displayName ?? '');
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<I18nKey | null>(null);
  const [error, setError] = React.useState<I18nKey | null>(null);
  const generation = React.useRef(0);
  const submissionActive = React.useRef(false);
  const current = (version: number) => generation.current === version && runtimeKey === getRuntimeKey();
  const clearRecovery = () => {
    try { localStorage.removeItem(storageKey(runtimeKey)); setRecovery({ status: 'ready', pending: null }); setPasswordRequired(false); }
    catch { setRecovery({ status: 'unavailable' }); }
  };
  React.useEffect(() => {
    const requestGeneration = generation;
    const version = ++requestGeneration.current;
    void readPlatformAuthMethods().then((value) => { if (requestGeneration.current === version && runtimeKey === getRuntimeKey()) { setMethods(value); if (!value.passwordLogin && value.registration) setMode('register'); } })
      .catch(() => { if (requestGeneration.current === version && runtimeKey === getRuntimeKey()) setError('platformAccount.error.methods'); });
    return () => { ++requestGeneration.current; };
  }, [runtimeKey]);

  const submit = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (submissionActive.current) return;
    submissionActive.current = true;
    const submittedPassword = password;
    setPassword(''); setError(null); setMessage(null);
    const version = ++generation.current;
    setBusy(true);
    try {
      if (mode === 'login') {
        const state = await passwordLoginPlatformAccount({ username: username.trim(), password: submittedPassword });
        if (!current(version)) return;
        if (state.status === 'signed-in' && pending?.username === username.trim()) clearRecovery();
        onSignedIn(state);
      } else {
        if (recovery.status !== 'ready') { setError('platformAccount.error.recoveryStorage'); return; }
        if ((passwordRequired || !pending) && registrationPasswordBytes(submittedPassword) > 72) {
          setError('platformAccount.error.registrationPassword');
          return;
        }
        const intent: RegistrationRecovery = pending ?? { idempotencyKey: crypto.randomUUID(), username: username.trim() };
        if (!pending && email.trim()) intent.email = email.trim();
        if (!pending && displayName.trim()) intent.displayName = displayName.trim();
        // Persist safe intent before the request so a lost response cannot start another registration.
        try { localStorage.setItem(storageKey(runtimeKey), JSON.stringify(intent)); }
        catch { setError('platformAccount.error.recoveryStorage'); return; }
        setRecovery({ status: 'ready', pending: intent });
        const registration: RegistrationRecovery & { password?: string } = { ...intent };
        if (!pending || passwordRequired) registration.password = submittedPassword;
        const result = await registerPlatformAccount(registration);
        if (!current(version)) return;
        if (result.status === 'CREATED') {
          clearRecovery(); setMode('login'); setMessage('platformAccount.registrationCreated');
        } else setMessage('platformAccount.registrationUnknown');
      }
    } catch (cause) {
      if (!current(version)) return;
      if (mode === 'register' && !pending && cause instanceof PlatformAccountError && definitiveRegistrationError(cause)) {
        clearRecovery();
      }
      if (mode === 'register' && cause instanceof PlatformAccountError && cause.code === 'platform_registration_password_required') {
        setPasswordRequired(true);
        setError('platformAccount.registrationPasswordRequired');
      } else {
        setError(mode === 'register' && cause instanceof PlatformAccountError && cause.code === 'invalid_password'
          ? 'platformAccount.error.registrationPassword'
          : platformAccountErrorKey(cause instanceof PlatformAccountError ? cause : null, mode === 'register' ? 'platformAccount.registrationUnknown' : 'platformAccount.error.login'));
      }
    } finally { submissionActive.current = false; if (current(version)) setBusy(false); }
  };
  const browserLogin = async () => {
    if (submissionActive.current) return;
    submissionActive.current = true;
    setPassword(''); setError(null); setMessage(null); setBusy(true);
    const version = ++generation.current;
    try {
      const result = await loginPlatformAccount();
      if (!current(version)) return;
      if (!await openExternalUrl(result.authorizationUrl)) throw new Error('browser');
      if (current(version)) setMessage('platformAccount.pending');
    } catch (cause) { if (current(version)) setError(platformAccountErrorKey(cause instanceof PlatformAccountError ? cause : null, 'platformAccount.error.login')); }
    finally { submissionActive.current = false; if (current(version)) setBusy(false); }
  };
  const passwordForm = methods && (mode === 'login' ? methods.passwordLogin : methods.registration);
  return <div className="space-y-4">
    {methods?.passwordLogin && methods.registration && <SettingsChipGroup value={mode} onChange={(value) => { setMode(value); setPassword(''); setPasswordRequired(false); setError(null); setMessage(null); }} aria-label={t('platformAccount.authMode')} options={[
      { value: 'login', label: t('platformAccount.signIn'), disabled: busy }, { value: 'register', label: t('platformAccount.register'), disabled: busy },
    ]} />}
    {passwordForm && <form onSubmit={(event) => void submit(event)} className="max-w-[24rem] space-y-4">
      <SettingsStackedField label={<label htmlFor="unihub-username">{t('platformAccount.username')}</label>} description={mode === 'register' ? t('platformAccount.usernameHint') : undefined}>
        <Input id="unihub-username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} disabled={busy || (mode === 'register' && !!pending)} required minLength={mode === 'register' ? 2 : undefined} maxLength={64} pattern={mode === 'register' ? '[a-z][a-z0-9_\\-]{1,63}' : undefined} />
      </SettingsStackedField>
      {mode === 'register' && <>
        <SettingsStackedField label={<label htmlFor="unihub-display-name">{t('platformAccount.displayName')}</label>}>
          <Input id="unihub-display-name" autoComplete="nickname" value={displayName} onChange={(event) => setDisplayName(registrationDisplayName(event.target.value))} disabled={busy || !!pending} maxLength={160} />
        </SettingsStackedField>
        <SettingsStackedField label={<label htmlFor="unihub-email">{t('platformAccount.email')}</label>}>
          <Input id="unihub-email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} disabled={busy || !!pending} maxLength={254} />
        </SettingsStackedField>
      </>}
      <SettingsStackedField label={<label htmlFor="unihub-password">{t('platformAccount.password')}</label>} description={mode === 'register' ? t('platformAccount.passwordHint') : undefined}>
        <Input id="unihub-password" type="password" autoComplete={mode === 'register' ? 'new-password' : 'current-password'} value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy || (mode === 'register' && !!pending && !passwordRequired)} required={mode === 'login' || !pending || passwordRequired} minLength={mode === 'register' ? 12 : undefined} maxLength={128} />
      </SettingsStackedField>
      {mode === 'register' && pending && !busy && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.registrationUnknown')}</p>}
      <Button type="submit" disabled={busy || (mode === 'register' && recovery.status !== 'ready')}>{t(mode === 'login' ? 'platformAccount.signIn' : pending && !passwordRequired ? 'platformAccount.checkRegistration' : 'platformAccount.register')}</Button>
    </form>}
    {mode === 'login' && methods?.passwordRecoveryUrl && <Button
      type="button"
      variant="link"
      size="sm"
      className="h-auto p-0"
      disabled={busy}
      onClick={() => void openExternalUrl(methods.passwordRecoveryUrl ?? '')}
    >{t('platformAccount.forgotPassword')}</Button>}
    {methods?.browserLogin && <Button variant="outline" disabled={busy} onClick={() => void browserLogin()}>{t('platformAccount.browserSignIn')}</Button>}
    <p className={`min-h-5 ${error || recovery.status === 'unavailable' ? 'text-[var(--status-error-text)]' : SETTINGS_HELPER_CLASS}`} role={error || recovery.status === 'unavailable' ? 'alert' : 'status'}>
      {error ? t(error) : recovery.status === 'unavailable' ? t('platformAccount.error.recoveryStorage') : busy || !methods ? t('platformAccount.loading') : message ? t(message) : null}
    </p>
  </div>;
};
