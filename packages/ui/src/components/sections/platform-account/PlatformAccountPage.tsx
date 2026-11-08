import { captureRuntimeInstance } from '@/lib/runtime-switch';
import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection, SettingsFieldRow, SettingsStackedField, SETTINGS_HELPER_CLASS, SETTINGS_SELECT_ROW_TRIGGER_CLASS } from '@/components/sections/shared/SettingsSection';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useI18n } from '@/lib/i18n';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useSettingsDirectory } from '@/hooks/useSettingsDirectory';
import { useConfigStore } from '@/stores/useConfigStore';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { PlatformAccountAuth } from './PlatformAccountAuth';
import { PlatformAccountCommerce } from './PlatformAccountCommerce';
import { PlatformMembershipSummary } from './PlatformMembershipSummary';
import { PlatformAccountUsage, PlatformAccountUsageSummary } from './PlatformAccountUsage';
import { PlatformAccountProfile } from './PlatformAccountProfile';
import { PlatformAccountIdentity } from './PlatformAccountIdentity';
import { PlatformAccountUsageChart } from './PlatformAccountUsageChart';
import { PlatformAccountApiKeys } from './PlatformAccountApiKeys';
import { useModelConfigurationTabStore } from '../model-configuration/modelConfigurationTabs';
import { usePlatformAccountTabStore } from './platformAccountTabs';
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
  const settingsDirectory = useSettingsDirectory();
  const refreshModelConfiguration = React.useCallback(() => {
    useModelConfigurationTabStore.getState().requestRefresh();
    const runtimeCurrent = captureRuntimeInstance();
    void useConfigStore.getState().loadSessionDefaults({ fresh: true }).then(() => {
      if (runtimeCurrent()) return useConfigStore.getState().loadProviders({ directory: settingsDirectory, source: 'platform-account:key-setup', fresh: true });
    });
  }, [settingsDirectory]);
  const sessionID = useSessionUIStore((store) => store.currentSessionId);
  const unsupported = runtime.isVSCode || isMobileSurfaceRuntime();
  const [state, setState] = React.useState<PlatformAccountState | null>(null);
  const [identity, setIdentity] = React.useState<PlatformIdentitySession | null>(null);
  const [profileRevision, setProfileRevision] = React.useState(0);
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
  const currentMembership = signedIn?.membership.find((membership) => membership.product_id === 'superwagie' && membership.status === 'active' && Date.parse(membership.paid_through) > Date.now());
  const membershipSummary = (actions: Parameters<React.ComponentProps<typeof PlatformAccountCommerce>['membershipSummary']>[0] | null) => signedIn ? <PlatformMembershipSummary account={signedIn} actions={actions} /> : null;
  const tabs: Array<{ id: typeof tab; label: string; icon: IconName }> = [
    { id: 'billing', label: t('platformAccount.billingTab'), icon: 'bank-card' },
    { id: 'keys', label: t('platformAccount.apiKeysTab'), icon: 'key' },
    { id: 'usage', label: t('platformAccount.usageTab'), icon: 'bar-chart' },
    { id: 'orders', label: t('platformAccount.ordersTab'), icon: 'file-list-2' },
    { id: 'profile', label: t('platformAccount.profileTab'), icon: 'user' },
  ];
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
  const refreshAction = !unsupported && identity?.status !== 'unsupported' && identity?.status !== 'unconfigured' && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setProfileRevision((value) => value + 1); void refreshIdentity(); void perform(readPlatformAccount); }}>{t('platformAccount.refresh')}</Button>;
  return <div className="@container/account flex h-full min-h-0 flex-col">
    {signedInIdentity && <nav aria-label={t('settings.page.platform-account.title')} className="flex shrink-0 gap-1 overflow-x-auto border-b border-border/60 px-4 pe-10 @3xl/account:px-6">
      {tabs.map((item) => <Button key={item.id} variant="ghost" data-platform-account-tab={item.id} aria-current={tab === item.id ? 'page' : undefined} className={`h-12 shrink-0 gap-2 rounded-none border-b-2 px-3 ${tab === item.id ? 'border-interactive-selection-foreground text-foreground' : 'border-transparent text-muted-foreground'}`} onClick={() => setTab(item.id)}><Icon name={item.icon} className="size-4" />{item.label}</Button>)}
      <div className="ms-auto flex shrink-0 items-center">{tab !== 'keys' || !signedIn?.accountId || signedIn.user.id !== signedInIdentity.user.id ? refreshAction : null}</div>
    </nav>}
    <div className="flex min-h-0 flex-1 flex-col @3xl/account:flex-row">
      {signedInIdentity && <aside className="grid shrink-0 grid-cols-2 gap-x-4 gap-y-3 p-5 @3xl/account:flex @3xl/account:min-h-0 @3xl/account:w-64 @3xl/account:flex-col @3xl/account:gap-5 @3xl/account:overflow-y-auto @3xl/account:p-6" aria-label={t('platformAccount.identity')}>
        <div className="col-span-2">
          <PlatformAccountIdentity key={`${getRuntimeKey()}:${signedInIdentity.user.id}`} user={signedInIdentity.user} revision={profileRevision} />
        </div>
        <Button variant="outline" className="justify-center @3xl/account:w-full" onClick={() => setTab('profile')}><Icon name="edit" className="size-4" />{t('platformAccount.editProfile')}</Button>
        {signedIn && <SettingsStackedField label={t('platformAccount.account')} info={t('platformAccount.accountHint')} settingsItem="platform-account.account">
          <Select value={signedIn.accountId ?? ''} disabled={busy} onValueChange={(id) => { if (id) { setState(null); void perform(() => selectPlatformAccount(id)); } }}>
            <SelectTrigger className={`${SETTINGS_SELECT_ROW_TRIGGER_CLASS} max-w-full`} aria-label={t('platformAccount.account')}><SelectValue>{selectedAccount ? t('platformAccount.accountName', { name: selectedAccount.name, kind: t(selectedAccount.kind === 'team' ? 'platformAccount.team' : 'platformAccount.personal') }) : t('platformAccount.chooseAccount')}</SelectValue></SelectTrigger>
            <SelectContent>{signedIn.accounts.map((account) => <SelectItem key={account.id} value={account.id}>{t('platformAccount.accountName', { name: account.name, kind: t(account.kind === 'team' ? 'platformAccount.team' : 'platformAccount.personal') })}</SelectItem>)}</SelectContent>
          </Select>
        </SettingsStackedField>}
        <div className="col-span-2 @3xl/account:mt-auto">
          <Button size="sm" variant="ghost" className="text-muted-foreground" disabled={busy} onClick={() => { void signOut(); }}>{t('platformAccount.signOut')}</Button>
        </div>
      </aside>}
      <SettingsPageLayout outerClassName="min-h-0 min-w-0 flex-1" className="max-w-none px-5 py-5 @3xl:px-6 @3xl:py-5" title={signedInIdentity ? tab === 'profile' ? t('platformAccount.profile') : undefined : t('settings.page.platform-account.title')} showSaveStatus={tab === 'profile'}>
    {!signedInIdentity && <SettingsSection title={t('platformAccount.identity')} divider={false}><SettingsFieldRow label={statusText} settingsItem="platform-account.login">{refreshAction}</SettingsFieldRow></SettingsSection>}
    {error && <p className="pb-4 text-[var(--status-error-text)]" role="alert">{t(error)}</p>}
    {modelLockError && <p className={`pb-4 ${SETTINGS_HELPER_CLASS}`} role="alert">{t(modelLockError === 'platform_store_busy' ? 'platformAccount.modelLockBusy' : 'platformAccount.modelLockUnavailable')}</p>}
    {!signedInIdentity && !unsupported && identity && identity.status !== 'unconfigured' && identity.status !== 'unsupported' && <SettingsSection title={t('platformAccount.authentication')} contentClassName="space-y-4">
      <PlatformAccountAuth key={`${getRuntimeKey()}:${generation.current}`} onSignedIn={(next) => { setIdentity(next); void perform(readPlatformAccount); }} />
    </SettingsSection>}
    {signedInIdentity && tab === 'profile' && <PlatformAccountProfile key={`${getRuntimeKey()}:${signedInIdentity.user.id}`} onProfileUpdated={() => setProfileRevision((value) => value + 1)} />}
    {signedInIdentity && tab === 'profile' && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.session', { time: new Date(signedInIdentity.expiresAt).toLocaleString() })}</p>}
    {signedIn && (tab === 'billing' || tab === 'orders') && <>
      {tab === 'billing' && (!signedIn.accountId || unsupported) && membershipSummary(null)}
      {!unsupported && signedIn.accountId && <PlatformAccountCommerce key={`${getRuntimeKey()}:${signedIn.user.id}:${signedIn.accountId}`} accountId={signedIn.accountId} view={tab === 'orders' ? 'orders' : 'overview'} payer={selectedAccount ? t('platformAccount.accountName', { name: selectedAccount.name, kind: t(selectedAccount.kind === 'team' ? 'platformAccount.team' : 'platformAccount.personal') }) : signedIn.accountId} membershipSummary={membershipSummary} hasActiveMembership={Boolean(currentMembership)} currentMembership={currentMembership} onAccountRefresh={() => void perform(readPlatformAccount)} />}
    </>}
    {signedInIdentity && tab === 'billing' && !unsupported && signedIn?.accountId && signedIn.user.id === signedInIdentity.user.id && <>
      <PlatformAccountUsageChart key={`activity:${JSON.stringify([getRuntimeKey(), signedIn.user.id, signedIn.accountId])}`} accountId={signedIn.accountId} />
      <PlatformAccountUsageSummary key={JSON.stringify([getRuntimeKey(), signedIn.user.id, signedIn.accountId])} accountId={signedIn.accountId} />
      <Button size="sm" variant="ghost" onClick={() => setTab('usage')}>{t('platformAccount.viewUsage')}</Button>
    </>}
    {signedInIdentity && tab === 'keys' && !unsupported && signedIn?.accountId && signedIn.user.id === signedInIdentity.user.id && <PlatformAccountApiKeys key={JSON.stringify([getRuntimeKey(), signedIn.user.id, signedIn.accountId])} accountId={signedIn.accountId} onConfigured={refreshModelConfiguration} />}
    {signedInIdentity && tab === 'usage' && <>
      {!unsupported && signedIn?.accountId && signedIn.user.id === signedInIdentity.user.id && <PlatformAccountUsageChart key={`activity:${JSON.stringify([getRuntimeKey(), signedIn.user.id, signedIn.accountId])}`} accountId={signedIn.accountId} />}
      {!unsupported && signedIn?.accountId && signedIn.user.id === signedInIdentity.user.id && <PlatformAccountUsage
        key={JSON.stringify([getRuntimeKey(), signedIn.user.id, signedIn.accountId])} accountId={signedIn.accountId} />}
      {!unsupported && signedIn && (signedIn.modelService === 'available' || signedIn.modelRecoveryAvailable) && sessionID && <PlatformTaskStatus key={`${getRuntimeKey()}:${sessionID}:${signedIn.user.id}`} sessionID={sessionID} accounts={signedIn.accounts} />}
      {!unsupported && signedIn?.modelRecoveryAvailable && signedIn.accountId && <PlatformMediaHistory key={`${getRuntimeKey()}:${signedIn.user.id}:${signedIn.accountId}`} accounts={signedIn.accounts} />}
    </>}
      </SettingsPageLayout>
    </div>
  </div>;
};
