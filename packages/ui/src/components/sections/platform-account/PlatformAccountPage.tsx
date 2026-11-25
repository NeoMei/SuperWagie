import { captureRuntimeInstance } from '@/lib/runtime-switch';
import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection, SettingsFieldRow, SETTINGS_HELPER_CLASS, SETTINGS_SELECT_TRIGGER_CLASS } from '@/components/sections/shared/SettingsSection';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useI18n } from '@/lib/i18n';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useSettingsDirectory } from '@/hooks/useSettingsDirectory';
import { useConfigStore } from '@/stores/useConfigStore';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { PlatformAccountAuth } from './PlatformAccountAuth';
import { PlatformAccountCommerce } from './PlatformAccountCommerce';
import { PlatformAccountBenefits, PlatformMembershipSummary } from './PlatformMembershipSummary';
import { PlatformAccountUsage, PlatformAccountUsageSummary } from './PlatformAccountUsage';
import { PlatformAccountProfile } from './PlatformAccountProfile';
import { PlatformAccountIdentity } from './PlatformAccountIdentity';
import { PlatformAccountUsageChart } from './PlatformAccountUsageChart';
import { PlatformAccountApiKeys } from './PlatformAccountApiKeys';
import { useModelConfigurationTabStore } from '../model-configuration/modelConfigurationTabs';
import { usePlatformAccountTabStore } from './platformAccountTabs';
import { platformAccountErrorKey } from './platformAccountErrors';
import { formatPlatformMoney, formatPlatformPoints } from '@/lib/platformCommerce';
import type { I18nKey } from '@/lib/i18n';
import { PlatformAccountError, readPlatformAccount, readPlatformIdentitySession, selectPlatformAccount, logoutPlatformAccount, subscribePlatformAccountState, readPlatformModelTask, readPlatformMediaHistory, reconcilePlatformModelTask, type PlatformModelTask, type PlatformMediaHistory, type PlatformAccountState, type PlatformIdentitySession } from '@/lib/platformAccount';

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
      {task.calls.map((call) => {
        const amount = call.charged;
        const charge = amount === undefined ? null
          : call.asset === 'CREDIT/6' ? t('platformAccount.usageCreditAmount', { amount: formatPlatformPoints(amount) })
            : call.asset === 'CNY/6' ? t('platformAccount.cny', { amount: formatPlatformMoney(amount) })
              : call.asset === 'LR_QUOTA/0' ? t('platformAccount.usageQuotaAmount', { amount })
                : t('platformAccount.taskChargeUnitUnavailable');
        return <SettingsFieldRow key={call.callID} label={t(`platformAccount.call.${call.status}`)}>{charge && <span>{charge}</span>}</SettingsFieldRow>;
      })}
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
  const { t, locale } = useI18n();
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
  const contentId = React.useId();
  const scrollRegion = React.useRef<HTMLElement>(null);
  const [state, setState] = React.useState<PlatformAccountState | null>(null);
  const [identity, setIdentity] = React.useState<PlatformIdentitySession | null>(null);
  const [profileRevision, setProfileRevision] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const [switchingAccount, setSwitchingAccount] = React.useState(false);
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
  const perform = React.useCallback(async (operation: () => Promise<PlatformAccountState>, switching = false) => {
    const key = getRuntimeKey(); const current = ++generation.current;
    setBusy(true); setError(null); setSwitchingAccount(switching);
    try {
      const next = await operation();
      if (key === getRuntimeKey() && current === generation.current) setState(next);
    } catch (cause) {
      if (key === getRuntimeKey() && current === generation.current) {
        setError(platformAccountErrorKey(cause instanceof PlatformAccountError ? cause : null));
        setState(cause instanceof PlatformAccountError && recoverableSessionError(cause) ? { status: 'signed-out' } : null);
      }
    }
    finally {
      if (key === getRuntimeKey() && current === generation.current) {
        setBusy(false);
        setSwitchingAccount(false);
      }
    }
  }, []);
  React.useEffect(() => {
    if (!unsupported) { void refreshIdentity(); void perform(readPlatformAccount); }
    return subscribeRuntimeEndpointChanged(() => {
      ++generation.current; ++identityGeneration.current; setState(null); setIdentity(null); setError(null); setBusy(false); setSwitchingAccount(false);
      if (!unsupported) { void refreshIdentity(); void perform(readPlatformAccount); }
    });
  }, [unsupported, perform, refreshIdentity]);
  React.useEffect(() => subscribePlatformAccountState((next, key) => {
    if (key !== getRuntimeKey() || (next.status !== 'signed-out' && next.status !== 'expired')) return;
    ++generation.current;
    ++identityGeneration.current;
    setIdentity(next);
    setState(next);
    setError(null);
    setBusy(false);
    setSwitchingAccount(false);
  }), []);
  React.useEffect(() => () => { ++generation.current; ++identityGeneration.current; }, []);
  const signedInIdentity = identity?.status === 'signed-in' ? identity : null;
  const accountState = state?.status === 'signed-in' && state.user.id === signedInIdentity?.user.id ? state : null;
  const signedIn = switchingAccount ? null : accountState;
  const modelLockError = signedIn?.modelService === 'unavailable' && (signedIn.modelUnavailableReason === 'platform_store_busy' || signedIn.modelUnavailableReason === 'platform_store_lock_unavailable') ? signedIn.modelUnavailableReason : null;
  const selectedAccount = accountState?.accounts.find((account) => account.id === accountState.accountId);
  const accountKind = (account: NonNullable<typeof selectedAccount>) => t(account.kind === 'team' ? 'platformAccount.team' : 'platformAccount.personal');
  const accountName = (account: NonNullable<typeof selectedAccount>) => t('platformAccount.accountName', { name: account.name, kind: accountKind(account) });
  const selectedAccountName = selectedAccount ? accountName(selectedAccount) : undefined;
  const confirmedPayer = signedIn?.accountId ? signedIn : null;
  const currentMembership = confirmedPayer?.credits.activeMembership === false ? undefined : confirmedPayer?.membership.find((membership) => membership.product_id === 'superwagie' && membership.status === 'active' && Date.parse(membership.paid_through) > Date.now());
  const membershipSummary = (actions: Parameters<React.ComponentProps<typeof PlatformAccountCommerce>['membershipSummary']>[0] | null) => signedIn ? <PlatformMembershipSummary account={signedIn} actions={actions} /> : null;
  const hasWallet = accountState?.productCreditWallet === true || Boolean(signedInIdentity && tab === 'wallet' && state === null);
  const visibleTab = tab === 'wallet' && !hasWallet ? 'billing' : tab;
  React.useLayoutEffect(() => { scrollRegion.current?.scrollTo?.({ top: 0 }); }, [visibleTab]);
  const tabs: Array<{ id: typeof tab; label: string; icon: IconName }> = [
    { id: 'billing', label: t('platformAccount.billingTab'), icon: 'bank-card' },
    ...(hasWallet ? [{ id: 'wallet' as const, label: t('platformAccount.productWallet.tab'), icon: 'bank-card' as const }] : []),
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
    setIdentity(null); setState(null); setBusy(true); setError(null); setSwitchingAccount(false);
    try {
      const next = await logoutPlatformAccount();
      if (key === getRuntimeKey() && current === identityGeneration.current) setIdentity(next);
    } catch (cause) {
      if (key === getRuntimeKey() && current === identityGeneration.current) setError(platformAccountErrorKey(cause instanceof PlatformAccountError ? cause : null));
    } finally {
      if (key === getRuntimeKey() && current === identityGeneration.current) setBusy(false);
    }
  };
  const refreshAccount = () => { setProfileRevision((value) => value + 1); void refreshIdentity(); void perform(readPlatformAccount); };
  const refreshAction = !unsupported && identity?.status !== 'unsupported' && identity?.status !== 'unconfigured'
    && <Button size="sm" variant="ghost" disabled={busy} onClick={refreshAccount}>{t('platformAccount.refresh')}</Button>;
  const accountPicker = accountState && (
    <Select value={accountState.accountId ?? ''} disabled={busy} onValueChange={(id) => {
      if (id && id !== accountState.accountId && !busy) void perform(() => selectPlatformAccount(id), true);
    }}>
      <SelectTrigger className={`${SETTINGS_SELECT_TRIGGER_CLASS} min-w-0 max-w-full`} aria-label={t('platformAccount.account')} title={selectedAccountName}>
        <SelectValue className="flex items-center gap-1.5">
          {selectedAccount ? <>
            <bdi className="min-w-0 truncate">{selectedAccount.name}</bdi>
            <span className="shrink-0 text-muted-foreground">{accountKind(selectedAccount)}</span>
          </> : t('platformAccount.chooseAccount')}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>{accountState.accounts.map((account) => <SelectItem key={account.id} value={account.id}>{accountName(account)}</SelectItem>)}</SelectContent>
    </Select>
  );
  const activeTab = tabs.find((item) => item.id === visibleTab);
  const accountTitle = t('sessions.sidebar.footer.accountMenu.userCenter');
  return <div className="@container/account flex h-full min-h-0 flex-col">
    <div className={`flex min-h-0 min-w-0 flex-1 flex-col ${signedInIdentity ? '@xl/account:flex-row' : ''}`}>
      {signedInIdentity ? <aside aria-label={t('platformAccount.identity')} data-platform-account-sidebar className="max-h-[min(48dvh,15rem)] min-w-0 shrink-0 overflow-y-auto border-b border-border/60 bg-muted/35 @xl/account:max-h-none @xl/account:w-46 @xl/account:border-e @xl/account:border-b-0 @4xl/account:w-56">
        <div className="flex min-h-9 items-center justify-between gap-2 ps-4 pe-12 @xl/account:min-h-14 @xl/account:px-5">
          <span className="min-w-0 truncate typography-ui-label font-semibold" title={accountTitle}>{accountTitle}</span>
          {accountPicker
            ? <Button size="icon" variant="ghost" className="size-8 shrink-0" disabled={busy} title={t('platformAccount.refreshAccount')} aria-label={t('platformAccount.refreshAccount')} onClick={refreshAccount}>
              <Icon name="refresh" className="size-4" />
            </Button>
            : refreshAction}
        </div>
        <div className="grid grid-cols-2 gap-3 px-4 pb-2.5 @xl/account:grid-cols-1 @xl/account:gap-5 @xl/account:px-5 @xl/account:pb-6 @xl/account:pt-4">
          <div className="min-w-0 space-y-1.5 @xl/account:space-y-5">
            <PlatformAccountIdentity key={JSON.stringify([getRuntimeKey(), signedInIdentity.user.id])} user={signedInIdentity.user} revision={profileRevision} />
            {accountPicker && <div className="min-w-0 space-y-0.5 @xl/account:space-y-1.5" data-settings-item="platform-account.account">
              <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.account')}</p>
              {accountPicker}
            </div>}
          </div>
          <PlatformAccountBenefits account={confirmedPayer} currentMembership={currentMembership} loading={busy && !signedIn} />
        </div>
      </aside> : <div className="flex min-h-12 shrink-0 items-center border-b border-border/60 ps-4 pe-12 @2xl/account:ps-6">
        <span className="min-w-0 truncate typography-ui-label font-semibold">{accountTitle}</span>
      </div>}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {signedInIdentity && <nav aria-label={t('settings.page.platform-account.title')} className="grid shrink-0 grid-cols-3 gap-1 border-b border-border/60 px-3 py-1 @xl/account:py-1.5 @xl/account:ps-5 @xl/account:pe-12 @4xl/account:grid-flow-col @4xl/account:auto-cols-fr @4xl/account:grid-cols-none">
          {tabs.map((item) => <Button key={item.id} type="button" variant="ghost" data-platform-account-tab={item.id} aria-controls={contentId} aria-current={visibleTab === item.id ? 'page' : undefined}
            className={`h-auto min-h-9 min-w-0 gap-1.5 whitespace-normal px-1.5 text-center leading-tight @xl/account:min-h-10 @4xl/account:min-h-11 @4xl/account:px-2 ${visibleTab === item.id ? 'bg-interactive-selection text-interactive-selection-foreground hover:bg-interactive-selection' : 'text-muted-foreground'}`}
            onClick={() => setTab(item.id)}>
            <Icon name={item.icon} className="hidden size-4 shrink-0 @4xl/account:block" />
            <span className="min-w-0 break-words">{item.label}</span>
          </Button>)}
        </nav>}
        <SettingsPageLayout scrollRef={scrollRegion} outerClassName="min-h-0 min-w-0 flex-1" className="max-w-4xl px-4 py-4 @xl:px-6 @3xl:px-6 @3xl:py-5" title={signedInIdentity ? activeTab?.label : undefined}
          showSaveStatus={!!signedInIdentity && visibleTab === 'profile'}>
          <div id={contentId} className="min-w-0 space-y-5">
            {!signedInIdentity && <SettingsSection title={t('platformAccount.identity')} divider={false}><SettingsFieldRow label={statusText} settingsItem="platform-account.login">{refreshAction}</SettingsFieldRow></SettingsSection>}
            {signedInIdentity && !signedIn && visibleTab !== 'profile' && !error && <p role="status" className={SETTINGS_HELPER_CLASS}>{t(busy || state === null ? 'platformAccount.loading' : 'platformAccount.failed')}</p>}
            {signedIn && !signedIn.accountId && visibleTab !== 'profile' && visibleTab !== 'billing' && <p role="status" className={SETTINGS_HELPER_CLASS}>{t('platformAccount.chooseAccount')}</p>}
            {error && <p className="pb-4 text-[var(--status-error-text)]" role="alert">{t(error)}</p>}
            {modelLockError && <p className={`pb-4 ${SETTINGS_HELPER_CLASS}`} role="alert">{t(modelLockError === 'platform_store_busy' ? 'platformAccount.modelLockBusy' : 'platformAccount.modelLockUnavailable')}</p>}
            {!signedInIdentity && !unsupported && identity && identity.status !== 'unconfigured' && identity.status !== 'unsupported' && <SettingsSection title={t('platformAccount.authentication')} contentClassName="space-y-4">
              <PlatformAccountAuth key={`${getRuntimeKey()}:${generation.current}`} onSignedIn={(next) => { setIdentity(next); void perform(readPlatformAccount); }} />
            </SettingsSection>}
            {signedInIdentity && visibleTab === 'profile' && <PlatformAccountProfile key={`${getRuntimeKey()}:${signedInIdentity.user.id}`} userId={signedInIdentity.user.id} onProfileUpdated={() => setProfileRevision((value) => value + 1)} />}
            {signedInIdentity && visibleTab === 'profile' && <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-4">
              <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.session', { time: new Date(signedInIdentity.expiresAt).toLocaleString(locale) })}</p>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void signOut()}>{t('platformAccount.signOut')}</Button>
            </div>}
            {signedIn && (visibleTab === 'billing' || tab === 'orders' || visibleTab === 'wallet') && <>
              {visibleTab === 'billing' && (!signedIn.accountId || unsupported) && membershipSummary(null)}
              {!unsupported && signedIn.accountId && <PlatformAccountCommerce
                key={`${getRuntimeKey()}:${signedIn.user.id}:${signedIn.accountId}`}
                accountId={signedIn.accountId}
                view={tab === 'orders' ? 'orders' : visibleTab === 'wallet' ? 'wallet' : 'overview'}
                payer={selectedAccountName ?? signedIn.accountId}
                membershipSummary={membershipSummary}
                hasActiveMembership={signedIn.credits.activeMembership ?? Boolean(currentMembership)}
                currentMembership={currentMembership}
                onAccountRefresh={() => void perform(readPlatformAccount)}
                overviewFooter={<>
                  <PlatformAccountUsageSummary accountId={signedIn.accountId} />
                  <Button size="sm" variant="ghost" onClick={() => setTab('usage')}>{t('platformAccount.viewUsage')}</Button>
                </>}
              />}
            </>}
            {visibleTab === 'keys' && !unsupported && signedIn?.accountId && (
              <PlatformAccountApiKeys key={JSON.stringify([getRuntimeKey(), signedIn.user.id, signedIn.accountId])} accountId={signedIn.accountId} onConfigured={refreshModelConfiguration} />
            )}
            {signedIn && visibleTab === 'usage' && <>
              {!unsupported && signedIn.accountId && <PlatformAccountUsage
                key={JSON.stringify([getRuntimeKey(), signedIn.user.id, signedIn.accountId])} accountId={signedIn.accountId} />}
              {!unsupported && signedIn.accountId && <PlatformAccountUsageChart key={`activity:${JSON.stringify([getRuntimeKey(), signedIn.user.id, signedIn.accountId])}`} accountId={signedIn.accountId} />}
              {!unsupported && (signedIn.modelService === 'available' || signedIn.modelRecoveryAvailable) && sessionID && <PlatformTaskStatus key={`${getRuntimeKey()}:${sessionID}:${signedIn.user.id}`} sessionID={sessionID} accounts={signedIn.accounts} />}
              {!unsupported && signedIn.modelRecoveryAvailable && signedIn.accountId && <PlatformMediaHistory key={`${getRuntimeKey()}:${signedIn.user.id}:${signedIn.accountId}`} accounts={signedIn.accounts} />}
            </>}
          </div>
        </SettingsPageLayout>
      </div>
    </div>
  </div>;
};
