import React from 'react';
import { RiCheckLine, RiCloseLine, RiQuestionLine } from '@remixicon/react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { SettingsSection, SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import { ModelTestMotion } from '@/components/sections/model-configuration/ModelTestFeedback';
import { MODEL_PURPOSE_LABELS, modelTestErrorKey } from '@/components/sections/model-configuration/modelConfigurationView';
import { useI18n } from '@/lib/i18n';
import { PlatformAccountError } from '@/lib/platformAccount';
import { readPlatformAccountKeySetup, runPlatformAccountKeySetup, type PlatformAccountKeySetupAction, type PlatformAccountKeySetupState } from '@/lib/platformApiKeys';
import { captureRuntimeInstance } from '@/lib/runtime-switch';

type SetupStage = NonNullable<PlatformAccountKeySetupState['activation']>['stage'];
type StepStatus = 'pending' | 'running' | 'completed' | 'partial' | 'failed' | 'unconfirmed';
const stages: SetupStage[] = ['issue', 'configure', 'test'];
const runtimeGuidanceKey = (code: string | null | undefined) => code === 'model_configuration_account_runtime_required' || code === 'platform_runtime_unsupported'
  ? 'platformAccount.keySetup.runtimeRequired'
  : code === 'model_configuration_account_runtime_unavailable' ? 'platformAccount.keySetup.runtimeUnavailable' : null;
type SetupErrorKey = 'platformAccount.apiKeysDenied' | 'platformAccount.keySetup.readFailed'
  | 'platformAccount.keySetup.runtimeRequired' | 'platformAccount.keySetup.runtimeUnavailable';

export const PlatformAccountApiKeys: React.FC<{ accountId: string; onConfigured?: () => void }> = ({ accountId, onConfigured }) => {
  const { t, locale } = useI18n();
  const [state, setState] = React.useState<PlatformAccountKeySetupState | null>(null);
  const [error, setError] = React.useState<SetupErrorKey | null>(null);
  const [reading, setReading] = React.useState(true);
  const [pendingAction, setPendingAction] = React.useState<PlatformAccountKeySetupAction | null>(null);
  const acting = pendingAction !== null;
  const generation = React.useRef(0);
  const readSequence = React.useRef(0);
  const mutationActive = React.useRef(false);
  const notifiedConnection = React.useRef<string | null>(null);
  const previousRun = React.useRef<{ operationId: string | null; testRunId: string | null } | null>(null);
  const [awaitingRun, setAwaitingRun] = React.useState(false);
  const publish = React.useCallback((next: PlatformAccountKeySetupState, commandResponse = false) => {
    const activation = next.activation;
    const prior = previousRun.current;
    if (prior && activation && (
      activation.operationId !== prior.operationId || activation.testRunId && activation.testRunId !== prior.testRunId
      || commandResponse && (!activation.testRunId || activation.stage !== 'test')
    )) { previousRun.current = null; setAwaitingRun(false); }
    setState(next);
    if (!previousRun.current) setError(null);
    if (!previousRun.current && activation?.connectionId && activation.providerId && activation.stage === 'test'
      && !['issuing', 'configuring', 'testing'].includes(activation.status)) {
      const binding = JSON.stringify([activation.operationId, activation.testRunId, activation.connectionId, activation.providerId]);
      if (notifiedConnection.current !== binding) { notifiedConnection.current = binding; onConfigured?.(); }
    }
  }, [onConfigured]);
  const read = React.useCallback(async () => {
    const owner = generation.current;
    const sequence = ++readSequence.current;
    const runtimeCurrent = captureRuntimeInstance();
    const current = () => owner === generation.current && sequence === readSequence.current && runtimeCurrent();
    setReading(true);
    try {
      const next = await readPlatformAccountKeySetup(accountId);
      if (current()) publish(next);
    } catch (cause) {
      if (current()) {
        const denied = cause instanceof PlatformAccountError && cause.status === 403;
        if (denied) setState(null);
        setError((cause instanceof PlatformAccountError ? runtimeGuidanceKey(cause.code) : null)
          ?? (denied ? 'platformAccount.apiKeysDenied' : 'platformAccount.keySetup.readFailed'));
      }
    } finally { if (current()) setReading(false); }
  }, [accountId, publish]);
  React.useEffect(() => {
    const owner = generation;
    mutationActive.current = false;
    notifiedConnection.current = null;
    previousRun.current = null; setAwaitingRun(false);
    setPendingAction(null);
    setState(null);
    setError(null);
    void read();
    return () => { ++owner.current; };
  }, [read]);
  const activation = state?.activation;
  const working = !error && activation && (['issuing', 'configuring'].includes(activation.status) || !awaitingRun && activation.status === 'testing');
  React.useEffect(() => {
    if (!working && !acting) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!active) return;
      await read();
      if (active) timer = setTimeout(poll, 800);
    };
    timer = setTimeout(poll, 800);
    return () => { active = false; clearTimeout(timer); };
  }, [working, acting, read]);
  const run = async (action: PlatformAccountKeySetupAction) => {
    if (mutationActive.current || error || awaitingRun) return;
    mutationActive.current = true;
    const owner = generation.current;
    const runtimeCurrent = captureRuntimeInstance();
    const current = () => owner === generation.current && runtimeCurrent();
    previousRun.current = { operationId: state?.activation?.operationId ?? null, testRunId: state?.activation?.testRunId ?? null };
    notifiedConnection.current = null;
    setAwaitingRun(true);
    ++readSequence.current;
    setReading(false); setPendingAction(action); setError(null);
    try {
      const next = await runPlatformAccountKeySetup(accountId, action);
      if (current()) { ++readSequence.current; setReading(false); publish(next, true); }
    } catch (cause) {
      if (current()) {
        ++readSequence.current; setReading(false);
        const denied = cause instanceof PlatformAccountError && cause.status === 403;
        const runtimeRefusal = cause instanceof PlatformAccountError ? runtimeGuidanceKey(cause.code) : null;
        if (denied) { setState(null); previousRun.current = null; setAwaitingRun(false); }
        else if (runtimeRefusal) { previousRun.current = null; setAwaitingRun(false); }
        setError(runtimeRefusal ?? (denied ? 'platformAccount.apiKeysDenied' : 'platformAccount.keySetup.readFailed'));
      }
    } finally {
      if (current()) { mutationActive.current = false; setPendingAction(null); }
    }
  };
  const busy = acting || Boolean(working);
  const tests = activation?.stage === 'test' && !awaitingRun ? activation.tests : [];
  const ready = !busy && !error && !awaitingRun && activation?.status === 'ready' && activation.test?.status === 'verified';
  const verified = ready && tests.length > 0 && tests.every((test) => test.status === 'verified' && test.applied);
  const partial = ready && !verified;
  const visibleTests = tests.filter((test) => test.status !== 'queued' && (test.status !== 'skipped' || !busy && activation?.status !== 'testing'));
  const testCount = tests.length;
  const passedCount = tests.filter((test) => test.status === 'verified').length;
  const applicationIncomplete = !busy && !error && !awaitingRun && activation?.status === 'failed'
    && activation.errorCode === 'account_key_test_failed' && testCount > 0 && passedCount === testCount
    && tests.some((test) => test.applicationError !== undefined);
  const requestedStage = pendingAction === 'activate' ? 'issue' : pendingAction === 'resume' ? 'configure' : 'test';
  const observedStage = activation ? stages.indexOf(activation.stage) : -1;
  const currentStage = pendingAction ? Math.max(observedStage, stages.indexOf(requestedStage)) : observedStage;
  const stepStatus = (index: number): StepStatus => {
    if ((error || awaitingRun) && !acting) return 'unconfirmed';
    if (verified) return 'completed';
    if (index < currentStage) return activation?.key ? 'completed' : 'unconfirmed';
    if (index > currentStage || currentStage < 0) return 'pending';
    if (busy) return 'running';
    if (applicationIncomplete) return 'partial';
    if (activation?.status === 'failed') return 'failed';
    return 'unconfirmed';
  };
  const stageLabel = (stage: SetupStage) => t(stage === 'issue' ? 'platformAccount.keySetup.issue' : stage === 'configure' ? 'platformAccount.keySetup.configure' : 'platformAccount.keySetup.test');
  return <SettingsSection description={t('platformAccount.keySetup.description')} divider={false} contentClassName="space-y-4" headerAction={<Button size="sm" variant="outline" disabled={reading || acting} onClick={() => void read()}>{t('platformAccount.refresh')}</Button>}>
    <ModelTestMotion><section role="region" aria-label={t('platformAccount.keySetup.panelTitle')} className="oc-tile min-w-0 space-y-4 rounded-lg p-4">
      <h3 className="typography-ui-label text-foreground">{t('platformAccount.keySetup.panelTitle')}</h3>
      <div className="space-y-2" aria-live="polite">
        {error && <p className="text-[var(--status-error)]" role="alert">{t(error)}</p>}
        {reading && !state && !error && !acting && <p className={SETTINGS_HELPER_CLASS} role="status">{t('platformAccount.loading')}</p>}
        {busy && <p role="status" className="flex items-start gap-2 text-foreground"><Spinner aria-hidden="true" className="mt-0.5" /><span>{working && activation ? t('platformAccount.keySetup.working', { stage: stageLabel(activation.stage) }) : t(pendingAction === 'retest' ? 'platformAccount.keySetup.testPending' : 'platformAccount.keySetup.requestPending')}</span></p>}
        {verified && <p role="status" className="flex items-start gap-2 font-medium text-[var(--status-success)]"><RiCheckLine aria-hidden="true" className="mt-0.5 size-4 shrink-0" />{t('platformAccount.keySetup.verified')}</p>}
        {partial && <p role="alert" className="text-[var(--status-warning)]">{t('platformAccount.keySetup.partial')}</p>}
        {applicationIncomplete && <p role="alert" className="text-[var(--status-warning)]">{t('platformAccount.keySetup.applicationIncomplete')}</p>}
        {!busy && !error && !awaitingRun && !applicationIncomplete && activation?.status === 'failed' && <p role="alert" className="text-[var(--status-error)]">{t(runtimeGuidanceKey(activation.errorCode) ?? (activation.errorCode === 'account_key_scope_limit' ? 'platformAccount.keySetup.scopeLimit' : activation.errorCode === 'account_key_scope_unavailable' ? 'platformAccount.keySetup.scopeUnavailable' : activation.stage === 'issue' ? 'platformAccount.keySetup.issueFailed' : activation.stage === 'configure' ? 'platformAccount.keySetup.configureFailed' : 'platformAccount.keySetup.testFailed'))}</p>}
        {!busy && !error && !awaitingRun && (activation?.status === 'unknown' || activation?.status === 'interrupted') && <p role="alert" className="text-[var(--status-warning)]">{t(runtimeGuidanceKey(activation.errorCode) ?? (activation.errorCode === 'account_key_apply_required' ? 'platformAccount.keySetup.applyRequired' : activation.stage === 'issue' ? 'platformAccount.keySetup.issueUnknown' : activation.stage === 'test' ? 'platformAccount.keySetup.testUnknown' : 'platformAccount.keySetup.configureInterrupted'))}</p>}
        {state?.enterpriseMode && <p className={SETTINGS_HELPER_CLASS} role="status">{t('platformAccount.keySetup.enterprise')}</p>}
      </div>
      <ol className="grid grid-cols-3 gap-3" aria-label={t('platformAccount.keySetup.progress')} aria-busy={busy}>
        {stages.map((stage, index) => {
          const status = stepStatus(index);
          const statusColor = status === 'completed' ? 'text-[var(--status-success)]' : status === 'failed' ? 'text-[var(--status-error)]' : status === 'unconfirmed' || status === 'partial' ? 'text-[var(--status-warning)]' : status === 'running' ? 'text-foreground' : 'text-muted-foreground';
          return <li key={stage} aria-current={status === 'running' ? 'step' : undefined} className={`min-w-0 space-y-2 ${statusColor}`}>
            <span aria-hidden="true" className="inline-flex size-7 items-center justify-center rounded-full bg-background typography-meta">
              {status === 'completed' ? <RiCheckLine className="size-4" /> : status === 'running' ? <Spinner /> : status === 'failed' ? <RiCloseLine className="size-4" /> : status === 'unconfirmed' || status === 'partial' ? <RiQuestionLine className="size-4" /> : index + 1}
            </span>
            <p className="break-words typography-ui-label">{stageLabel(stage)}</p>
            <p className="break-words typography-meta">{t(`platformAccount.keySetup.step.${status}`)}</p>
          </li>;
        })}
      </ol>
      {state && !activation && !error && (!awaitingRun || acting) && <>
        <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.keySetup.offer')}</p>
        <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.keySetup.cost')}</p>
        <Button disabled={busy || reading || state.enterpriseMode} onClick={() => void run('activate')}>{t('platformAccount.keySetup.activate')}</Button>
      </>}
      {activation && <>
        {activation.key && <div className="space-y-1">
          <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.apiKeysTab')}</p>
          <p dir="ltr" className="break-all font-mono text-xl">•••• {activation.key.last4}</p>
          <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.keySetup.secretHint')}</p>
        </div>}
        <div className="space-y-2">
          {testCount > 0 && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.keySetup.testSummary', { passed: passedCount, total: testCount })}</p>}
          {visibleTests.length > 0 && <ul aria-label={t('platformAccount.keySetup.modelTests')}>
            {visibleTests.map((test) => {
              const status = error && test.status === 'testing' ? 'unknown' : test.status;
              const color = test.applicationError ? 'text-[var(--status-warning)]' : status === 'verified' ? 'text-[var(--status-success)]' : status === 'failed' ? 'text-[var(--status-error)]' : status === 'unknown' ? 'text-[var(--status-warning)]' : 'text-muted-foreground';
              const feedbackStatus = test.applicationError?.status ?? status;
              const feedbackCode = test.applicationError?.errorCode ?? test.errorCode;
              const runtimeGuidance = runtimeGuidanceKey(feedbackCode);
              const guidance = runtimeGuidance ? t(runtimeGuidance) : feedbackStatus === 'skipped' ? t(feedbackCode === 'account_key_existing_configuration_unknown' || feedbackCode === 'model_configuration_account_provider_unavailable' ? 'platformAccount.keySetup.existingConfigurationUnknown'
                : feedbackCode === 'account_key_existing_configuration' ? 'platformAccount.keySetup.existingConfiguration'
                  : feedbackCode === 'account_key_model_unavailable' || feedbackCode === 'account_key_model_unconfigured' ? 'platformAccount.keySetup.modelUnavailable'
                    : feedbackCode === 'account_key_model_not_authorized' ? 'platformAccount.keySetup.modelNotAuthorized'
                      : feedbackCode === 'account_key_other_connection' ? 'platformAccount.keySetup.otherConnection'
                        : feedbackCode === 'account_key_configuration_conflict' ? 'modelConfiguration.revisionConflict' : 'platformAccount.keySetup.probeUnavailable')
                  : feedbackStatus === 'unknown' ? t(feedbackCode === 'account_key_configuration_conflict' || feedbackCode === 'account_key_configuration_changed' ? 'modelConfiguration.revisionConflict' : test.applicationError ? 'platformAccount.keySetup.applyUnknown' : 'modelConfiguration.testFeedback.unknownHint')
                  : feedbackStatus === 'failed' ? t(feedbackCode === 'model_configuration_embedding_rebuild_required' || feedbackCode === 'embedding_rebuild_required' ? 'platformAccount.keySetup.rebuildRequired'
                    : ['model_configuration_unsupported_protocol', 'model_configuration_knowledge_not_ready', 'model_configuration_ocr_unavailable', 'embedding_model_change_unsupported'].includes(feedbackCode ?? '') ? 'platformAccount.keySetup.consumerUnavailable'
                      : feedbackCode === 'model_configuration_embedding_dimensions_mismatch' ? 'modelConfiguration.overview.error.dimensions'
                      : feedbackCode === 'account_key_scope_unavailable' ? 'platformAccount.keySetup.scopeUnavailable'
                        : feedbackCode === 'account_key_configuration_conflict' || feedbackCode === 'account_key_configuration_changed' ? 'modelConfiguration.revisionConflict'
                          : test.applicationError ? 'platformAccount.keySetup.applyFailed' : modelTestErrorKey(feedbackCode ?? 'test_failed')) : null;
              const statusLabel = t(test.applicationError ? 'platformAccount.keySetup.modelUnapplied' : status === 'verified' && test.applied ? 'platformAccount.keySetup.modelApplied' : `platformAccount.keySetup.modelStatus.${status}`);
              const testedAt = test.testedAt && status !== 'testing' && status !== 'queued' ? t('platformAccount.keySetup.testedAt', { time: new Date(test.testedAt).toLocaleString(locale) }) : undefined;
              return <li key={`${activation.testRunId}:${test.id}`} data-account-model-test={test.purpose} data-test-status={status} aria-label={t('modelConfiguration.testFeedback.region', { purpose: t(MODEL_PURPOSE_LABELS[test.purpose]) })} className="min-w-0 space-y-1 border-b border-border/40 py-2 last:border-b-0 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-200">
                <div className="flex min-w-0 items-start gap-3">
                  <div className="flex min-w-0 flex-1 flex-col gap-x-2 @sm:flex-row @sm:flex-wrap @sm:items-baseline">
                    <p className="break-words typography-ui-label">{t(MODEL_PURPOSE_LABELS[test.purpose])}</p>
                    {test.modelId && <p className={`${SETTINGS_HELPER_CLASS} min-w-0 break-all`}><bdi dir="auto">{test.modelId}</bdi></p>}
                  </div>
                  <span title={testedAt} aria-label={testedAt ? `${statusLabel}, ${testedAt}` : undefined} className={`inline-flex shrink-0 items-center gap-1.5 typography-meta ${color}`}>
                    {status === 'testing' ? <Spinner aria-hidden="true" /> : status === 'verified' ? <RiCheckLine aria-hidden="true" className="size-4" /> : status === 'failed' ? <RiCloseLine aria-hidden="true" className="size-4" /> : status === 'unknown' ? <RiQuestionLine aria-hidden="true" className="size-4" /> : null}
                    {statusLabel}
                  </span>
                </div>
                {guidance && <p className={`${SETTINGS_HELPER_CLASS} ${color}`}>{guidance}</p>}
              </li>;
            })}
          </ul>}
          {!tests.length && !awaitingRun && !busy && !error && activation.test?.testedAt && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.keySetup.testedAt', { time: new Date(activation.test.testedAt).toLocaleString(locale) })}</p>}
          {activation.connectionId && activation.stage === 'test' && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.keySetup.configured')}</p>}
        </div>
        {activation.actions.length > 0 && <div className="space-y-2">
          {activation.actions.includes('retest') && <p className={SETTINGS_HELPER_CLASS}>{t('platformAccount.keySetup.cost')}</p>}
          <div className="flex flex-wrap gap-2">
            {activation.actions.includes('resume') && <Button disabled={busy || reading || Boolean(error) || awaitingRun || state?.enterpriseMode} onClick={() => void run('resume')}>{t('platformAccount.keySetup.resume')}</Button>}
            {activation.actions.includes('retest') && <Button variant="outline" disabled={busy || reading || Boolean(error) || awaitingRun || state?.enterpriseMode} onClick={() => void run('retest')}>{t('platformAccount.keySetup.retest')}</Button>}
          </div>
        </div>}
      </>}
    </section></ModelTestMotion>
  </SettingsSection>;
};
