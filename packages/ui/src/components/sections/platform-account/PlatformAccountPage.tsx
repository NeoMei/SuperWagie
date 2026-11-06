import React from 'react';
import { Button } from '@/components/ui/button';
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
import { PlatformAccountUsage, PlatformAccountUsageSummary } from './PlatformAccountUsage';
import { PlatformAccountProfile } from './PlatformAccountProfile';
import { PlatformAccountApiKeys } from './PlatformAccountApiKeys';
import { useModelConfigurationTabStore } from '../model-configuration/modelConfigurationTabs';
import { usePlatformAccountTabStore } from './platformAccountTabs';
import { platformAccountErrorKey } from './platformAccountErrors';
import type { I18nKey } from '@/lib/i18n';
import { PlatformAccountError, readPlatformAccount, readPlatformIdentitySession, selectPlatformAccount, logoutPlatformAccount, readPlatformModelTask, readPlatformMediaHistory, reconcilePlatformModelTask, formatPlatformCredits, type PlatformModelTask, type PlatformMediaHistory, type PlatformAccountState, type PlatformIdentitySession } from '@/lib/platformAccount';

const recoverableSessionError = (error: PlatformAccountError | null): error is PlatformAccountError => error instanceof PlatformAccountError
  && ['platform_session_changed', 'platform_session_expired', 'unauthenticated'].includes(error.code);

const accountInitials = (name: string, email: string) => {
  const source = name.trim() || email.trim();
  const parts = source.split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts.at(-1)?.[0] ?? ''}` : source.slice(0, 2)).toUpperCase();
};

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
    void useConfigStore.getState().loadProviders({ directory: settingsDirectory, source: 'platform-account:key-setup', fresh: true });
  }, [settingsDirectory]);
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
  const membershipSummary = (actions: Parameters<React.ComponentProps<typeof PlatformAccountCommerce>['membershipSummary']>[0] | null) => signedIn ? <>
    <SettingsSection className="oc-tile space-y-2 rounded-lg p-4 @xl:col-span-2" divider={false} title={t('platformAccount.membership')} headerAction={actions && <Button size="sm" variant="outline" aria-pressed={actions.membershipOpen} onClick={actions.openMembership}>{t('platformAccount.membershipPlans')}</Button>} contentClassName="space-y-2">
    {signedIn.membership.length === 0 ? <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.noMembership')}</p> : signedIn.membership.map((membership) => <div key={membership.id} className="space-y-1">
      <p className="text-lg font-medium text-foreground">{membership.offer.name}</p>
      <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.paidThrough', { date: new Date(membership.paid_through).toLocaleDateString() })}{` · ${membership.status === 'active' ? t('platformAccount.membershipStatusActive') : membership.status === 'refunded' ? t('platformAccount.membershipStatusRefunded') : t('platformAccount.membershipStatusOther', { status: membership.status })}`}</p>
    </div>)}
    </SettingsSection>
    <SettingsSection className="oc-tile space-y-3 rounded-lg p-4" divider={false} title={t('platformAccount.available')} info={t('platformAccount.creditBenefitHint')} contentClassName="space-y-3">
      <p dir="auto" className="break-all text-2xl font-medium tabular-nums">{formatPlatformCredits(signedIn.credits.available)}</p>
      <SettingsFieldRow label={t('platformAccount.reserved')} className="py-0"><span dir="auto" className="break-all tabular-nums">{formatPlatformCredits(signedIn.credits.reserved)}</span></SettingsFieldRow>
      {actions && <Button size="sm" variant="ghost" aria-pressed={actions.addonOpen} onClick={actions.openAddon}>{t('platformAccount.addonPlans')}</Button>}
    </SettingsSection>
  </> : null;
  const tabs: Array<{ id: typeof tab; label: string }> = [
    { id: 'billing', label: t('platformAccount.billingTab') },
    { id: 'keys', label: t('platformAccount.apiKeysTab') },
    { id: 'usage', label: t('platformAccount.usageTab') },
    { id: 'orders', label: t('platformAccount.ordersTab') },
    { id: 'profile', label: t('platformAccount.profileTab') },
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
  const refreshAction = !unsupported && identity?.status !== 'unsupported' && identity?.status !== 'unconfigured' && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void refreshIdentity(); void perform(readPlatformAccount); }}>{t('platformAccount.refresh')}</Button>;
  return <div className="@container/account h-full min-h-0">
    <div className="flex h-full min-h-0 flex-col @3xl/account:flex-row">
      {signedInIdentity && <aside className="grid shrink-0 grid-cols-2 gap-4 bg-sidebar p-4 @3xl/account:flex @3xl/account:w-52 @3xl/account:flex-col @3xl/account:gap-6" aria-label={t('platformAccount.identity')}>
        <div className="flex min-w-0 items-center gap-3" data-settings-item="platform-account.login">
          <div aria-hidden className="oc-tile-inset flex size-9 shrink-0 items-center justify-center rounded-full typography-ui-label font-medium">{accountInitials(signedInIdentity.user.name, signedInIdentity.user.email)}</div>
          <div className="min-w-0">
            <p dir="auto" className="truncate font-medium">{signedInIdentity.user.name || signedInIdentity.user.email || t('platformAccount.signedIn')}</p>
            <p dir="auto" className={`truncate ${SETTINGS_HELPER_CLASS}`}>{signedInIdentity.user.email}</p>
          </div>
        </div>
        {signedIn && <SettingsStackedField label={t('platformAccount.account')} info={t('platformAccount.accountHint')} settingsItem="platform-account.account">
          <Select value={signedIn.accountId ?? ''} disabled={busy} onValueChange={(id) => { if (id) { setState(null); void perform(() => selectPlatformAccount(id)); } }}>
            <SelectTrigger className={`${SETTINGS_SELECT_ROW_TRIGGER_CLASS} max-w-full`} aria-label={t('platformAccount.account')}><SelectValue>{selectedAccount ? t('platformAccount.accountName', { name: selectedAccount.name, kind: t(selectedAccount.kind === 'team' ? 'platformAccount.team' : 'platformAccount.personal') }) : t('platformAccount.chooseAccount')}</SelectValue></SelectTrigger>
            <SelectContent>{signedIn.accounts.map((account) => <SelectItem key={account.id} value={account.id}>{t('platformAccount.accountName', { name: account.name, kind: t(account.kind === 'team' ? 'platformAccount.team' : 'platformAccount.personal') })}</SelectItem>)}</SelectContent>
          </Select>
        </SettingsStackedField>}
        <nav aria-label={t('settings.page.platform-account.title')} className="col-span-2 grid grid-cols-2 gap-1 @3xl/account:grid-cols-1">
          {tabs.map((item) => <Button key={item.id} variant="ghost" data-platform-account-tab={item.id} aria-current={tab === item.id ? 'page' : undefined} className={`justify-start text-start ${tab === item.id ? 'bg-interactive-selection text-interactive-selection-foreground' : ''}`} onClick={() => setTab(item.id)}>{item.label}</Button>)}
        </nav>
        <div className="col-span-2 flex flex-wrap gap-1 @3xl/account:mt-auto @3xl/account:flex-col @3xl/account:items-start">
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void signOut(); }}>{t('platformAccount.signOut')}</Button>
        </div>
      </aside>}
      <SettingsPageLayout outerClassName="min-h-0 min-w-0 flex-1" className="max-w-none px-5 py-5 @3xl:px-6 @3xl:py-5" title={signedInIdentity ? tabs.find((item) => item.id === tab)?.label : t('settings.page.platform-account.title')} showSaveStatus={tab === 'profile'} headerEnd={signedInIdentity && (tab !== 'keys' || !signedIn?.accountId || signedIn.user.id !== signedInIdentity.user.id) ? refreshAction : null}>
    {!signedInIdentity && <SettingsSection title={t('platformAccount.identity')} divider={false}><SettingsFieldRow label={statusText} settingsItem="platform-account.login">{refreshAction}</SettingsFieldRow></SettingsSection>}
    {error && <p className="pb-4 text-[var(--status-error-text)]" role="alert">{t(error)}</p>}
    {signedInIdentity && tab === 'profile' && <p className={`pb-4 ${SETTINGS_HELPER_CLASS}`}>{t('platformAccount.session', { time: new Date(signedInIdentity.expiresAt).toLocaleString() })}</p>}
    {modelLockError && <p className={`pb-4 ${SETTINGS_HELPER_CLASS}`} role="alert">{t(modelLockError === 'platform_store_busy' ? 'platformAccount.modelLockBusy' : 'platformAccount.modelLockUnavailable')}</p>}
    {!signedInIdentity && !unsupported && identity && identity.status !== 'unconfigured' && identity.status !== 'unsupported' && <SettingsSection title={t('platformAccount.authentication')} contentClassName="space-y-4">
      <PlatformAccountAuth key={`${getRuntimeKey()}:${generation.current}`} onSignedIn={(next) => { setIdentity(next); void perform(readPlatformAccount); }} />
    </SettingsSection>}
    {signedInIdentity && tab === 'profile' && <PlatformAccountProfile key={`${getRuntimeKey()}:${signedInIdentity.user.id}`} />}
    {signedIn && (tab === 'billing' || tab === 'orders') && <>
      {tab === 'billing' && (!signedIn.accountId || unsupported) && membershipSummary(null)}
      {!unsupported && signedIn.accountId && <PlatformAccountCommerce key={`${getRuntimeKey()}:${signedIn.user.id}:${signedIn.accountId}`} accountId={signedIn.accountId} view={tab === 'orders' ? 'orders' : 'overview'} payer={selectedAccount ? t('platformAccount.accountName', { name: selectedAccount.name, kind: t(selectedAccount.kind === 'team' ? 'platformAccount.team' : 'platformAccount.personal') }) : signedIn.accountId} membershipSummary={membershipSummary} hasActiveMembership={signedIn.membership.some((membership) => membership.product_id === 'superwagie' && membership.status === 'active' && Date.parse(membership.paid_through) > Date.now())} onAccountRefresh={() => void perform(readPlatformAccount)} />}
    </>}
    {signedInIdentity && tab === 'billing' && !unsupported && signedIn?.accountId && signedIn.user.id === signedInIdentity.user.id && <>
      <PlatformAccountUsageSummary key={JSON.stringify([getRuntimeKey(), signedIn.user.id, signedIn.accountId])} accountId={signedIn.accountId} />
      <Button size="sm" variant="ghost" onClick={() => setTab('usage')}>{t('platformAccount.viewUsage')}</Button>
    </>}
    {signedInIdentity && tab === 'keys' && !unsupported && signedIn?.accountId && signedIn.user.id === signedInIdentity.user.id && <PlatformAccountApiKeys key={JSON.stringify([getRuntimeKey(), signedIn.user.id, signedIn.accountId])} accountId={signedIn.accountId} onConfigured={refreshModelConfiguration} />}
    {signedInIdentity && tab === 'usage' && <>
      {!unsupported && signedIn?.accountId && signedIn.user.id === signedInIdentity.user.id && <PlatformAccountUsage
        key={JSON.stringify([getRuntimeKey(), signedIn.user.id, signedIn.accountId])} accountId={signedIn.accountId} />}
      {!unsupported && signedIn && (signedIn.modelService === 'available' || signedIn.modelRecoveryAvailable) && sessionID && <PlatformTaskStatus key={`${getRuntimeKey()}:${sessionID}:${signedIn.user.id}`} sessionID={sessionID} accounts={signedIn.accounts} />}
      {!unsupported && signedIn?.modelRecoveryAvailable && signedIn.accountId && <PlatformMediaHistory key={`${getRuntimeKey()}:${signedIn.user.id}:${signedIn.accountId}`} accounts={signedIn.accounts} />}
    </>}
      </SettingsPageLayout>
    </div>
  </div>;
};
