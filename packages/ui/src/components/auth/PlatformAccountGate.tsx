import React from 'react';
import { Button } from '@/components/ui/button';
import { SuperWagieWordmark } from '@/components/ui/SuperWagieWordmark';
import { DesktopHostSwitcherInline } from '@/components/desktop/DesktopHostSwitcher';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { syncDesktopSettings, initializeAppearancePreferences } from '@/lib/persistence';
import { applyPersistedDirectoryPreferences } from '@/lib/directoryPersistence';
import { ensureHomeDirectoryResolved } from '@/stores/useDirectoryStore';
import { PlatformAccountAuth } from '@/components/sections/platform-account/PlatformAccountAuth';
import { platformAccountErrorKey } from '@/components/sections/platform-account/platformAccountErrors';
import {
  readPlatformIdentitySession,
  PlatformAccountError,
  subscribePlatformAccountState,
  type PlatformIdentitySession,
} from '@/lib/platformAccount';

const unexpiredState = (state: PlatformIdentitySession): PlatformIdentitySession => state.status === 'signed-in' && !(Date.parse(state.expiresAt) > Date.now())
  ? { status: 'expired' }
  : state;

const AuthenticatedRuntimeBootstrap: React.FC<React.PropsWithChildren<{ bootstrap: boolean; onBootstrap: () => void }>> = ({ children, bootstrap, onBootstrap }) => {
  const { t } = useI18n();
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => {
    const runtimeKey = getRuntimeKey();
    let cancelled = false;
    const isActive = () => !cancelled && runtimeKey === getRuntimeKey();
    const settle = () => { if (isActive()) setReady(true); };
    const timeout = setTimeout(settle, 10_000);
    void (async () => {
      await initializeAppearancePreferences();
      if (!isActive()) return;
      await syncDesktopSettings({ bootstrap });
      if (!isActive()) return;
      if (bootstrap) {
        await applyPersistedDirectoryPreferences();
        if (!isActive()) return;
        onBootstrap();
      }
      await ensureHomeDirectoryResolved();
    })().catch(() => undefined).finally(settle);
    return () => { cancelled = true; clearTimeout(timeout); };
  }, [bootstrap, onBootstrap]);
  return ready ? <>{children}</> : <div className="flex h-full items-center justify-center bg-background text-muted-foreground" role="status">{t('platformAccount.loading')}</div>;
};

export const PlatformAccountGate: React.FC<React.PropsWithChildren<{ bootstrapRuntime?: boolean; unsupported?: boolean }>> = ({ children, bootstrapRuntime = false, unsupported = false }) => {
  const { t } = useI18n();
  const [state, setState] = React.useState<PlatformIdentitySession | null>(unsupported ? { status: 'unsupported' } : null);
  const [error, setError] = React.useState<I18nKey | null>(null);
  const [busy, setBusy] = React.useState(false);
  const generation = React.useRef(0);
  const invalidatePendingRead = React.useCallback(() => { generation.current += 1; }, []);
  const hasBootstrapped = React.useRef(false);
  const markBootstrapped = React.useCallback(() => { hasBootstrapped.current = true; }, []);

  const refresh = React.useCallback(async () => {
    const runtimeKey = getRuntimeKey();
    const revision = ++generation.current;
    setBusy(true);
    setError(null);
    try {
      const next = await readPlatformIdentitySession();
      if (runtimeKey === getRuntimeKey() && revision === generation.current) setState(unexpiredState(next));
    } catch (cause) {
      if (runtimeKey === getRuntimeKey() && revision === generation.current) {
        const recoverableSession = cause instanceof PlatformAccountError && ['platform_session_changed', 'platform_session_expired', 'unauthenticated'].includes(cause.code);
        setState(recoverableSession ? { status: 'signed-out' } : null);
        setError(platformAccountErrorKey(cause instanceof PlatformAccountError ? cause : null, 'platformAccount.failed'));
      }
    } finally {
      if (runtimeKey === getRuntimeKey() && revision === generation.current) setBusy(false);
    }
  }, []);

  React.useEffect(() => {
    if (unsupported) return;
    void refresh();
    const unsubscribeState = subscribePlatformAccountState((next, runtimeKey) => {
      if (runtimeKey === getRuntimeKey()) {
        invalidatePendingRead();
        setState(unexpiredState(next));
        setError(null);
        setBusy(false);
      }
    });
    const unsubscribeRuntime = subscribeRuntimeEndpointChanged(() => {
      invalidatePendingRead();
      setState(null);
      setError(null);
      hasBootstrapped.current = false;
      void refresh();
    });
    const focus = () => { void refresh(); };
    window.addEventListener('focus', focus);
    return () => {
      invalidatePendingRead();
      unsubscribeState();
      unsubscribeRuntime();
      window.removeEventListener('focus', focus);
    };
  }, [invalidatePendingRead, refresh, unsupported]);

  React.useEffect(() => {
    if (state?.status !== 'signed-in') return;
    const timeout = setTimeout(() => setState({ status: 'expired' }), Math.min(Math.max(0, Date.parse(state.expiresAt) - Date.now()), 2_147_483_647));
    return () => clearTimeout(timeout);
  }, [state]);

  React.useEffect(() => { document.getElementById('initial-loading')?.remove(); }, []);

  if (!unsupported && state?.status === 'signed-in') return bootstrapRuntime
    ? <AuthenticatedRuntimeBootstrap bootstrap={!hasBootstrapped.current} onBootstrap={markBootstrapped}>{children}</AuthenticatedRuntimeBootstrap>
    : <>{children}</>;

  const titleId = 'platform-account-gate-title';
  const unavailable = state?.status === 'unconfigured' || state?.status === 'unsupported';
  return (
    <section className="app-region-drag flex h-full min-h-0 items-center justify-center overflow-y-auto bg-background px-6 py-10 text-foreground" aria-labelledby={titleId}>
      <div className="app-region-no-drag flex w-full max-w-md flex-col items-center text-center">
        <SuperWagieWordmark width={140} />
        <h1 id={titleId} className="mt-6 text-xl font-semibold tracking-tight">{t('platformAccount.loginRequired')}</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground text-balance">
          {unavailable ? t(state.status === 'unsupported' ? 'platformAccount.unsupported' : 'platformAccount.unconfigured') : t('platformAccount.loginRequiredDescription')}
        </p>
        {error && <p className="mt-5 rounded-md bg-[var(--status-error-background)] px-3 py-2 text-sm text-[var(--status-error-text)]" role="alert">{t(error)}</p>}
        {!unavailable && state && <div className="mt-6 w-full max-w-sm"><PlatformAccountAuth onSignedIn={(next) => setState(unexpiredState(next))} /></div>}
        {!unsupported && <Button className="mt-6" variant="outline" disabled={busy} onClick={() => void refresh()}>{t('platformAccount.refresh')}</Button>}
        <div className="mt-5 w-full"><DesktopHostSwitcherInline /></div>
      </div>
    </section>
  );
};
