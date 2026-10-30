import React from 'react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection, SettingsFieldRow, SETTINGS_HELPER_CLASS, SETTINGS_SELECT_ROW_TRIGGER_CLASS } from '@/components/sections/shared/SettingsSection';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useI18n } from '@/lib/i18n';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { openExternalUrl } from '@/lib/url';
import { PlatformAccountAuth } from './PlatformAccountAuth';
import { PlatformAccountCommerce } from './PlatformAccountCommerce';
import { PlatformAccountProfile } from './PlatformAccountProfile';
import { usePlatformAccountTabStore } from './platformAccountTabs';
import { SortableTabsStrip, type SortableTabsStripItem } from '@/components/ui/sortable-tabs-strip';
import { platformAccountErrorKey } from './platformAccountErrors';
import type { I18nKey } from '@/lib/i18n';
import { PlatformAccountError, readPlatformAccount, readPlatformIdentitySession, selectPlatformAccount, logoutPlatformAccount, readPlatformModelTask, readPlatformMediaHistory, reconcilePlatformModelTask, formatPlatformCredits, type PlatformModelTask, type PlatformMediaHistory, type PlatformAccountState, type PlatformIdentitySession } from '@/lib/platformAccount';

const recoverableSessionError = (error: PlatformAccountError | null): error is PlatformAccountError => error instanceof PlatformAccountError
  && ['platform_session_changed', 'platform_session_expired', 'unauthenticated'].includes(error.code);

const PlatformTaskStatus: React.FC<{ sessionID: string; accounts: Extract<PlatformAccountState, { status: 'signed-in' }>['accounts']; mediaModel?: string }> = ({ sessionID, accounts, mediaModel }) => {
  const { t } = useI18n();
  const [task, setTask] = React.useState<PlatformModelTask | null>(null);
  const [failed, setFailed] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const version = React.useRef(0);
  const refresh = React.useCallback(async (reconcile = false) => {
    const current = ++version.current; const runtimeKey = getRuntimeKey();
    setBusy(true); setFailed(null);
    try {
      const result = await (reconcile ? reconcilePlatformModelTask(sessionID) : readPlatformModelTask(sessionID));
      if (current === version.current && runtimeKey === getRuntimeKey()) setTask(result);
    } catch (error) {
      if (current === version.current && runtimeKey === getRuntimeKey()) {
        setTask(null);
        setFailed(error instanceof PlatformAccountError ? error.code : 'unknown');
      }
    }
    finally { if (current === version.current && runtimeKey === getRuntimeKey()) setBusy(false); }
  }, [sessionID]);
  React.useEffect(() => { setTask(null); void refresh(); return () => { version.current = -1; }; }, [refresh]);
  if (!task && !failed) return null;
  const payer = accounts.find((account) => account.id === task?.accountID);
  return <SettingsSection title={mediaModel ? t('platformAccount.mediaTask', { model: mediaModel }) : t('platformAccount.modelStatus')}>
    {task && <>
      <SettingsFieldRow label={t('platformAccount.taskAccount')}><span>{payer ? t('platformAccount.accountName', { name: payer.name, kind: t(payer.kind === 'team' ? 'platformAccount.team' : 'platformAccount.personal') }) : t('platformAccount.taskAccountUnavailable')}</span></SettingsFieldRow>
      <SettingsFieldRow label={t('platformAccount.taskModel')}><span>{task.model}</span></SettingsFieldRow>
      {task.blocked && <p className={SETTINGS_HELPER_CLASS} role="status">{t(task.calls.some((call) => call.status === 'UNKNOWN') ? 'platformAccount.taskUnknown' : 'platformAccount.taskBlocked')}</p>}
      {task.calls.map((call) => <SettingsFieldRow key={call.callID} label={t(`platformAccount.call.${call.status}`)}>{call.charged !== undefined && <span>{t('platformAccount.charged', { credits: formatPlatformCredits(call.charged) })}</span>}</SettingsFieldRow>)}
    </>}
    {failed && <p className="text-[var(--status-error-text)]" role="alert">{t(failed === 'platform_model_scope_restart_required' ? 'platformAccount.modelRestartRequired' : 'platformAccount.taskFailed')}</p>}
    <Button variant="outline" disabled={busy} onClick={() => void refresh(true)}>{t('platformAccount.taskReconcile')}</Button>
  </SettingsSection>;
};

const PlatformMediaHistory: React.FC<{ accounts: Extract<PlatformAccountState, { status: 'signed-in' }>['accounts'] }> = ({ accounts }) => {
  const { t } = useI18n();
  const [pages, setPages] = React.useState<PlatformMediaHistory>({ tasks: [], nextCursor: null });
  const [failed, setFailed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const version = React.useRef(0);
  const load = React.useCallback(async (after?: string) => {
    const current = ++version.current; const runtimeKey = getRuntimeKey();
    setBusy(true); setFailed(false);
    try {
      const result = await readPlatformMediaHistory(after);
      if (current === version.current && runtimeKey === getRuntimeKey()) setPages((previous) => ({ tasks: after ? [...previous.tasks, ...result.tasks] : result.tasks, nextCursor: result.nextCursor }));
    } catch {
      if (current === version.current && runtimeKey === getRuntimeKey()) setFailed(true);
    } finally { if (current === version.current && runtimeKey === getRuntimeKey()) setBusy(false); }
  }, []);
  React.useEffect(() => { void load(); return () => { version.current = -1; }; }, [load]);
  return <>
    {pages.tasks.map((task) => <PlatformTaskStatus key={task.sessionID} sessionID={task.sessionID} accounts={accounts} mediaModel={task.model} />)}
    {(failed || pages.nextCursor) && <SettingsSection title={t('platformAccount.mediaHistory')}>
      {failed && <p role="alert" className={SETTINGS_HELPER_CLASS}>{t('platformAccount.taskFailed')}</p>}
      <Button variant="outline" disabled={busy} onClick={() => void load(failed ? undefined : pages.nextCursor ?? undefined)}>{t(failed ? 'platformAccount.refresh' : 'platformAccount.loadMore')}</Button>
    </SettingsSection>}
  </>;
};

export const PlatformAccountPage: React.FC = () => {
  const { t } = useI18n();
  const { runtime } = useRuntimeAPIs();
  const sessionID = useSessionUIStore((store) => store.currentSessionId);
  const unsupported = runtime.isVSCode || isMobileSurfaceRuntime();
  const [state, setState] = React.useState<PlatformAccountState | null>(null);
  const [identity, setIdentity] = React.useState<PlatformIdentitySession | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<I18nKey | null>(null);
  const tab = usePlatformAccountTabStore((store) => store.tab);
  const setTab = usePlatformAccountTabStore((store) => store.setTab);
  const generation = React.useRef(0);
  const identityGeneration = React.useRef(0);
  const refreshIdentity = React.useCallback(async () => {
    const key = getRuntimeKey(); const current = ++identityGeneration.current;
    try {
      const next = await readPlatformIdentitySession();
      if (key === getRuntimeKey() && current === identityGeneration.current) setIdentity(next);
    } catch (cause) {
      if (key === getRuntimeKey() && current === identityGeneration.current) {
        setIdentity(cause instanceof PlatformAccountError && recoverableSessionError(cause) ? { status: 'signed-out' } : null);
        setError(platformAccountErrorKey(cause instanceof PlatformAccountError ? cause : null));
      }
    }
  }, []);
  const perform = React.useCallback(async (operation: () => Promise<PlatformAccountState>) => {
    const key = getRuntimeKey(); const current = ++generation.current;
    setBusy(true); setError(null);
    try {
      const next = await operation();
      if (key === getRuntimeKey() && current === generation.current) setState(next);
    } catch (cause) {
      if (key === getRuntimeKey() && current === generation.current) {
        setError(platformAccountErrorKey(cause instanceof PlatformAccountError ? cause : null));
        setState(cause instanceof PlatformAccountError && recoverableSessionError(cause) ? { status: 'signed-out' } : null);
      }
    }
    finally { if (key === getRuntimeKey() && current === generation.current) setBusy(false); }
  }, []);
  React.useEffect(() => {
    if (!unsupported) { void refreshIdentity(); void perform(readPlatformAccount); }
    return subscribeRuntimeEndpointChanged(() => {
      ++generation.current; ++identityGeneration.current; setState(null); setIdentity(null); setError(null); setBusy(false);
      if (!unsupported) { void refreshIdentity(); void perform(readPlatformAccount); }
    });
  }, [unsupported, perform, refreshIdentity]);
  React.useEffect(() => () => { ++generation.current; ++identityGeneration.current; }, []);
  const signedIn = state?.status === 'signed-in' ? state : null;
  const modelLockError = signedIn?.modelService === 'unavailable' && (signedIn.modelUnavailableReason === 'platform_store_busy' || signedIn.modelUnavailableReason === 'platform_store_lock_unavailable') ? signedIn.modelUnavailableReason : null;
  const signedInIdentity = identity?.status === 'signed-in' ? identity : null;
  const selectedAccount = signedIn?.accounts.find((account) => account.id === signedIn.accountId);
  const tabs = React.useMemo<SortableTabsStripItem[]>(() => [
    { id: 'profile', label: t('platformAccount.profileTab') },
    { id: 'billing', label: t('platformAccount.billingTab') },
    { id: 'usage', label: t('platformAccount.usageTab') },
  ], [t]);
  const statusText = unsupported || identity?.status === 'unsupported' ? t('platformAccount.unsupported')
    : identity?.status === 'unconfigured' ? t('platformAccount.unconfigured')
    : identity?.status === 'expired' ? t('platformAccount.expired')
    : identity === null ? t(busy ? 'platformAccount.loading' : 'platformAccount.failed')
    : t('platformAccount.signedOut');
  const signOut = async () => {
    const key = getRuntimeKey(); const current = ++identityGeneration.current;
    ++generation.current;
    setIdentity(null); setState(null); setBusy(true); setError(null);
    try {
      const next = await logoutPlatformAccount();
      if (key === getRuntimeKey() && current === identityGeneration.current) setIdentity(next);
    } catch (cause) {
      if (key === getRuntimeKey() && current === identityGeneration.current) setError(platformAccountErrorKey(cause instanceof PlatformAccountError ? cause : null));
    } finally {
      if (key === getRuntimeKey() && current === identityGeneration.current) setBusy(false);
    }
  };
  return <SettingsPageLayout title={t('settings.page.platform-account.title')} description={t('settings.page.platform-account.description')} showSaveStatus headerEnd={signedInIdentity ? <SortableTabsStrip items={tabs} activeId={tab} onSelect={(id) => { if (id === 'profile' || id === 'billing' || id === 'usage') setTab(id); }} layoutMode="fit" variant="active-pill" pillSize="form" intrinsicWidth className="h-8 max-w-[32rem]" /> : null}>
    <SettingsSection title={t('platformAccount.identity')} divider={false} contentClassName="space-y-4">
      <SettingsFieldRow label={signedInIdentity ? signedInIdentity.user.name || signedInIdentity.user.email || t('platformAccount.signedIn') : statusText} settingsItem="platform-account.login">
        {!unsupported && state?.status !== 'unsupported' && state?.status !== 'unconfigured' && <div className="flex flex-wrap gap-2">
          {signedInIdentity && <Button variant="outline" disabled={busy} onClick={() => { setState(null); void signOut(); }}>{t('platformAccount.signOut')}</Button>}
          <Button variant="ghost" disabled={busy} onClick={() => { void refreshIdentity(); void perform(readPlatformAccount); }}>{t('platformAccount.refresh')}</Button>
        </div>}
      </SettingsFieldRow>
      {error && <p className="text-[var(--status-error-text)]" role="alert">{t(error)}</p>}
      {!signedInIdentity && !unsupported && identity && identity.status !== 'unconfigured' && identity.status !== 'unsupported' && <PlatformAccountAuth key={`${getRuntimeKey()}:${generation.current}`} onSignedIn={(next) => { setIdentity(next); void perform(readPlatformAccount); }} />}
      {signedInIdentity && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.session', { time: new Date(signedInIdentity.expiresAt).toLocaleString() })}</p>}
      {modelLockError && <p className={SETTINGS_HELPER_CLASS} role="alert">{t(modelLockError === 'platform_store_busy' ? 'platformAccount.modelLockBusy' : 'platformAccount.modelLockUnavailable')}</p>}
      {signedIn && <>
        <SettingsFieldRow label={t('platformAccount.account')} info={t('platformAccount.accountHint')} settingsItem="platform-account.account">
          <Select value={signedIn.accountId ?? ''} disabled={busy} onValueChange={(id) => { if (id) { setState(null); void perform(() => selectPlatformAccount(id)); } }}>
            <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={t('platformAccount.account')}><SelectValue>{selectedAccount ? t('platformAccount.accountName', { name: selectedAccount.name, kind: t(selectedAccount.kind === 'team' ? 'platformAccount.team' : 'platformAccount.personal') }) : t('platformAccount.chooseAccount')}</SelectValue></SelectTrigger>
            <SelectContent>{signedIn.accounts.map((account) => <SelectItem key={account.id} value={account.id}>{t('platformAccount.accountName', { name: account.name, kind: t(account.kind === 'team' ? 'platformAccount.team' : 'platformAccount.personal') })}</SelectItem>)}</SelectContent>
          </Select>
        </SettingsFieldRow>
      </>}
    </SettingsSection>
    {signedInIdentity && tab === 'profile' && <PlatformAccountProfile key={`${getRuntimeKey()}:${signedInIdentity.user.id}`} />}
    {signedIn && tab === 'billing' && <>
      <SettingsSection title={t('platformAccount.membership')} contentClassName="space-y-4">
        {signedIn.membership.length === 0 ? <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.noMembership')}</p> : signedIn.membership.map((membership) => <p className={SETTINGS_HELPER_CLASS} key={membership.id}>{t('platformAccount.membershipItem', { name: membership.offer.name, status: membership.status, date: new Date(membership.paid_through).toLocaleDateString() })}</p>)}
        {signedIn.consoleUrl && <Button variant="outline" onClick={() => { if (signedIn.consoleUrl) void openExternalUrl(signedIn.consoleUrl); }}>{t('platformAccount.console')}</Button>}
        <SettingsFieldRow label={t('platformAccount.available')}><span dir="auto">{formatPlatformCredits(signedIn.credits.available)}</span></SettingsFieldRow>
        <SettingsFieldRow label={t('platformAccount.reserved')}><span dir="auto">{formatPlatformCredits(signedIn.credits.reserved)}</span></SettingsFieldRow>
        {!modelLockError && <p className={SETTINGS_HELPER_CLASS}>{t(signedIn.modelService === 'available' ? 'platformAccount.modelAvailable' : 'platformAccount.modelUnavailable')}</p>}
      </SettingsSection>
      {!unsupported && signedIn.accountId && <PlatformAccountCommerce key={`${getRuntimeKey()}:${signedIn.user.id}:${signedIn.accountId}`} accountId={signedIn.accountId} hasActiveMembership={signedIn.membership.some((membership) => membership.product_id === 'superwagie' && membership.status === 'active' && Date.parse(membership.paid_through) > Date.now())} onAccountRefresh={() => void perform(readPlatformAccount)} />}
    </>}
    {signedInIdentity && tab === 'usage' && <>
      <SettingsSection title={t('platformAccount.usage')} divider={false} contentClassName="space-y-3">
        <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.usageUnavailable')}</p>
      </SettingsSection>
      {!unsupported && signedIn && (signedIn.modelService === 'available' || signedIn.modelRecoveryAvailable) && sessionID && <PlatformTaskStatus key={`${getRuntimeKey()}:${sessionID}:${signedIn.user.id}`} sessionID={sessionID} accounts={signedIn.accounts} />}
      {!unsupported && signedIn?.modelRecoveryAvailable && signedIn.accountId && <PlatformMediaHistory key={`${getRuntimeKey()}:${signedIn.user.id}:${signedIn.accountId}`} accounts={signedIn.accounts} />}
    </>}
  </SettingsPageLayout>;
};
