import React from 'react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { PauseClock } from '@/components/ui/pause-clock';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Radio } from '@/components/ui/radio';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { SettingsFieldRow, SettingsSection, SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { isVSCodeRuntime } from '@/lib/desktop';
import type { ModelConfiguration, ModelPurposeId } from '@/lib/modelConfiguration';
import { modelTestErrorKey, MODEL_PURPOSE_LABELS } from './modelConfigurationView';
import { ModelTestFeedback, ModelTestMotion } from './ModelTestFeedback';
import {
  applyModelBootstrap, discoverModelBootstrap, issueModelBootstrapKey, previewModelBootstrap,
  readModelBootstrapTestRun, rollbackModelBootstrap, startModelBootstrapTests,
  type ModelBootstrapClient, type ModelBootstrapDiscovery, type ModelBootstrapMode, type ModelBootstrapPreview, type ModelBootstrapTestRun, ModelConfigurationBootstrapError,
} from '@/lib/modelConfigurationBootstrap';

type Step = 'source' | 'discover' | 'preview' | 'tests';
type Source = 'session' | 'imported-key';

interface ModelQuickSetupWizardProps {
  open: boolean;
  configuration: ModelConfiguration;
  onClose: () => void;
  onApplied: (configuration: ModelConfiguration) => void;
  onRolledBack?: () => void;
  client?: ModelBootstrapClient;
}

const defaultClient: ModelBootstrapClient = {
  discover: discoverModelBootstrap,
  issueKey: issueModelBootstrapKey,
  preview: previewModelBootstrap,
  apply: applyModelBootstrap,
  startTests: startModelBootstrapTests,
  readTestRun: readModelBootstrapTestRun,
  rollback: rollbackModelBootstrap,
};

const sourceOptions: readonly Source[] = ['session', 'imported-key'];
const stepKeys: readonly Step[] = ['source', 'discover', 'preview', 'tests'];
const stepText = { source: 'modelConfiguration.quickSetup.step.source', discover: 'modelConfiguration.quickSetup.step.discover', preview: 'modelConfiguration.quickSetup.step.preview', tests: 'modelConfiguration.quickSetup.step.tests' } satisfies Record<Step, I18nKey>;
const sourceText = { session: 'modelConfiguration.quickSetup.source.session', 'imported-key': 'modelConfiguration.quickSetup.source.imported-key' } satisfies Record<Source, I18nKey>;
const sourceHintText = { session: 'modelConfiguration.quickSetup.source.session.hint', 'imported-key': 'modelConfiguration.quickSetup.source.imported-key.hint' } satisfies Record<Source, I18nKey>;
const modeText = { 'fill-missing': 'modelConfiguration.quickSetup.mode.fill-missing', 'replace-managed': 'modelConfiguration.quickSetup.mode.replace-managed' } satisfies Record<ModelBootstrapMode, I18nKey>;
const testText = { queued: 'modelConfiguration.quickSetup.tests.queued', running: 'modelConfiguration.quickSetup.tests.running', completed: 'modelConfiguration.quickSetup.tests.completed', failed: 'modelConfiguration.quickSetup.tests.failed' } satisfies Record<'queued' | 'running' | 'completed' | 'failed', I18nKey>;
const testResultText = { pending: 'modelConfiguration.quickSetup.tests.result.pending', discovered: 'modelConfiguration.quickSetup.tests.result.discovered', configured: 'modelConfiguration.quickSetup.tests.result.configured', verified: 'modelConfiguration.quickSetup.tests.result.verified', failed: 'modelConfiguration.quickSetup.tests.result.failed', unavailable: 'modelConfiguration.quickSetup.tests.result.unavailable', skipped: 'modelConfiguration.quickSetup.tests.result.skipped', stale: 'modelConfiguration.quickSetup.tests.result.stale' } satisfies Record<'pending' | 'discovered' | 'configured' | 'verified' | 'failed' | 'unavailable' | 'skipped' | 'stale', I18nKey>;
const isPurposeId = (value: string): value is ModelPurposeId => Object.hasOwn(MODEL_PURPOSE_LABELS, value);
const toPurposeId = (value: string): ModelPurposeId | null => isPurposeId(value) ? value : null;

export const ModelQuickSetupWizard: React.FC<ModelQuickSetupWizardProps> = ({ open, configuration, onClose, onApplied, onRolledBack, client = defaultClient }) => {
  const { t } = useI18n();
  const [step, setStep] = React.useState<Step>('source');
  const fundingMode = 'credits' as const;
  const [source, setSource] = React.useState<Source>('session');
  const [key, setKey] = React.useState('');
  const [mode, setMode] = React.useState<ModelBootstrapMode>('fill-missing');
  const [discovery, setDiscovery] = React.useState<ModelBootstrapDiscovery | null>(null);
  const [preview, setPreview] = React.useState<ModelBootstrapPreview | null>(null);
  const [selections, setSelections] = React.useState<Record<string, string>>({});
  const [operationId, setOperationId] = React.useState<string | null>(null);
  const [testRunId, setTestRunId] = React.useState<string | null>(null);
  const [testStatus, setTestStatus] = React.useState<'queued' | 'running' | 'completed' | 'failed' | null>(null);
  const [testResults, setTestResults] = React.useState<ModelBootstrapTestRun['results']>([]);
  const [testPurposes, setTestPurposes] = React.useState<ModelPurposeId[]>([]);
  const [testModels, setTestModels] = React.useState<Partial<Record<ModelPurposeId, string>>>({});
  const [testStarting, setTestStarting] = React.useState(false);
  const [testError, setTestError] = React.useState<string | null>(null);
  const [testReadVersion, setTestReadVersion] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const runningAction = React.useRef(false);
  const [error, setError] = React.useState<string | null>(null);
  const unsupported = isVSCodeRuntime();
  const accountUnsupported = isMobileSurfaceRuntime() && source === 'session';
  const testsRunning = !testError && (testStarting || testStatus === 'queued' || testStatus === 'running');

  React.useEffect(() => {
    setTestStarting(false); setTestError(null); setTestModels({});
    if (!open) {
      setKey('');
      setDiscovery(null);
      setPreview(null);
      setSelections({});
      setOperationId(null);
      setTestRunId(null);
      setTestStatus(null);
      setTestResults([]);
      setTestPurposes([]);
      setError(null);
      return;
    }
    setStep('source'); setSource('session'); setKey(''); setMode('fill-missing'); setDiscovery(null); setPreview(null); setSelections({});
    setOperationId(null); setTestRunId(null); setTestStatus(null); setTestResults([]); setTestPurposes([]); setBusy(false); setError(null);
  }, [open]);

  React.useEffect(() => {
    if (!open || !testRunId || step !== 'tests') return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      if (cancelled) return;
      try {
        const run = await client.readTestRun(testRunId);
        if (cancelled) return;
        setTestResults(run.results);
        const failed = run.results.filter((result) => result.status === 'failed').map((result) => toPurposeId(result.purpose)).filter((purpose): purpose is ModelPurposeId => purpose !== null);
        if (run.status === 'completed') setTestPurposes(failed);
        setTestStatus(run.status === 'completed' && failed.length ? 'failed' : run.status);
        if (run.status === 'queued' || run.status === 'running') timer = window.setTimeout(poll, 700);
      } catch (reason) { if (!cancelled) setTestError(reason instanceof ModelConfigurationBootstrapError ? reason.code : 'request_failed'); }
    };
    void poll();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [client, open, step, testRunId, testReadVersion]);

  const run = async (operation: () => Promise<void>) => {
    if (runningAction.current) return;
    runningAction.current = true;
    setBusy(true); setError(null);
    try { await operation(); } catch (reason) { setError(reason instanceof ModelConfigurationBootstrapError ? reason.code : 'request_failed'); }
    finally { runningAction.current = false; setBusy(false); }
  };
  const beginTests = async (savedConfiguration: ModelConfiguration, purposes: ModelPurposeId[]) => {
    const models: Partial<Record<ModelPurposeId, string>> = {};
    for (const purpose of purposes) {
      const binding = savedConfiguration.bindings.find((candidate) => candidate.purpose === purpose);
      if (binding) models[purpose] = binding.model;
    }
    setTestModels(models); setTestPurposes(purposes);
    setTestRunId(null); setTestStatus(null); setTestError(null);
    setTestResults(purposes.map((purpose) => ({ purpose, status: 'pending' })));
    setTestStarting(true);
    try {
      const test = await client.startTests({ revision: savedConfiguration.revision, purposes });
      setTestResults(test.results); setTestRunId(test.testRunId); setTestStatus(test.status);
    } catch (reason) {
      setTestError(reason instanceof ModelConfigurationBootstrapError ? reason.code : 'request_failed');
    } finally { setTestStarting(false); }
  };
  const discover = () => run(async () => {
    const input: Parameters<ModelBootstrapClient['discover']>[0] = { source, key: source === 'imported-key' ? key : undefined };
    if (source === 'session') input.fundingMode = fundingMode;
    const result = await client.discover(input);
    setDiscovery(result); setStep('discover');
  });
  const issueKey = () => run(async () => {
    const result = await client.issueKey({ fundingMode });
    setDiscovery(result); setStep('discover');
  });
  const makePreview = () => run(async () => {
    if (!discovery) return;
    const result = await client.preview({ discoveryId: discovery.discoveryId, revision: configuration.revision, mode, selections });
    setPreview(result); setOperationId(result.operationId); setStep('preview');
  });
  const apply = () => run(async () => {
    if (!discovery || !preview) return;
    const result = await client.apply({ operationId: operationId ?? preview.operationId, discoveryId: discovery.discoveryId, revision: configuration.revision, mode }); onApplied(result); setStep('tests');
    const appliedPurposes = new Set(preview.items.filter((item) => item.action === 'add' || item.action === 'replace').map((item) => item.purpose));
    const purposes = result.purposes.filter((purpose) => purpose.status === 'available' && appliedPurposes.has(purpose.id)).map((purpose) => purpose.id);
    await beginTests(result, purposes);
  });
  const retryTests = () => run(async () => {
    const purposes = testPurposes.length ? testPurposes : testResults.filter((result) => result.status === 'failed').map((result) => toPurposeId(result.purpose)).filter((purpose): purpose is ModelPurposeId => purpose !== null);
    await beginTests(configuration, purposes);
  });
  const rollback = () => run(async () => {
    if (!operationId) return;
    await client.rollback({ operationId, revision: configuration.revision });
    setOperationId(null); setTestStatus(null); onRolledBack?.(); setStep('source');
  });

  const purposeLabel = (value: string) => isPurposeId(value) ? t(MODEL_PURPOSE_LABELS[value]) : t('modelConfiguration.quickSetup.otherPurpose');
  const stepLabel = (current: Step) => t(stepText[current]);
  return <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
    <DialogContent className="max-w-2xl" aria-describedby="model-quick-setup-description">
      <DialogHeader>
        <DialogTitle>{t('modelConfiguration.quickSetup.title')}</DialogTitle>
        <DialogDescription id="model-quick-setup-description">{t('modelConfiguration.quickSetup.description')}</DialogDescription>
      </DialogHeader>
      <nav aria-label={t('modelConfiguration.quickSetup.progress')} className="flex flex-wrap gap-2">
        {stepKeys.map((keyValue) => <span key={keyValue} className={`typography-meta rounded-md px-2 py-1 ${step === keyValue ? 'bg-interactive-selection text-interactive-selection-foreground' : 'text-muted-foreground'}`}>{stepLabel(keyValue)}</span>)}
      </nav>
      {unsupported ? <p role="alert" className="typography-meta text-[var(--status-warning-text)]">{t('modelConfiguration.quickSetup.unsupported')}</p> : null}
      {accountUnsupported && <p role="alert" className={SETTINGS_HELPER_CLASS}>{t('platformAccount.unsupported')}</p>}
      {step === 'source' ? <SettingsSection title={t('modelConfiguration.quickSetup.source.title')} divider={false} contentClassName="space-y-3">
        {sourceOptions.map((option) => <div key={option} role="radio" aria-checked={source === option} tabIndex={busy || unsupported ? -1 : 0} className="flex w-full items-start gap-3 rounded-md p-2 text-start hover:bg-interactive-hover" onClick={() => { if (!busy && !unsupported) setSource(option); }} onKeyDown={(event) => { if ((event.key === 'Enter' || event.key === ' ') && !busy && !unsupported) { event.preventDefault(); setSource(option); } }}>
          <Radio checked={source === option} onChange={() => setSource(option)} ariaLabel={t(sourceText[option])} />
          <span><span className="typography-ui-label text-foreground">{t(sourceText[option])}</span><span className={`block ${SETTINGS_HELPER_CLASS}`}>{t(sourceHintText[option])}</span></span>
        </div>)}
        {source === 'session' && <SettingsFieldRow label={t('platformAccount.keySetup.fundingMode')} info={t('platformAccount.keySetup.fundingSwitchHint')}>
          <span className="typography-ui-label text-foreground">{t('platformAccount.keySetup.credits')}</span>
        </SettingsFieldRow>}
        {source === 'imported-key' ? <SettingsFieldRow label={t('modelConfiguration.quickSetup.key')}><Input type="password" value={key} onChange={(event) => setKey(event.target.value)} aria-label={t('modelConfiguration.quickSetup.key')} className="max-w-[24rem]" /></SettingsFieldRow> : null}
        <Button onClick={discover} disabled={busy || unsupported || accountUnsupported || (source === 'imported-key' && !key.trim())}>{t('modelConfiguration.quickSetup.discover')}</Button>
        {source === 'session' ? <Collapsible>
          <CollapsibleTrigger className="w-auto typography-meta">{t('modelConfiguration.quickSetup.issueOptions')}</CollapsibleTrigger>
          <CollapsibleContent className="space-y-2 py-2">
            <p className={SETTINGS_HELPER_CLASS}>{t('modelConfiguration.quickSetup.issueHint')}</p>
            <Button variant="outline" onClick={issueKey} disabled={busy || unsupported || accountUnsupported}>{t('modelConfiguration.quickSetup.issueKey')}</Button>
          </CollapsibleContent>
        </Collapsible> : null}
      </SettingsSection> : null}
      {step === 'discover' && discovery ? <SettingsSection title={t('modelConfiguration.quickSetup.discover.title')} divider={false} contentClassName="space-y-3">
        <p className={SETTINGS_HELPER_CLASS}>{t('modelConfiguration.quickSetup.modelsFound', { count: discovery.models.length })}</p>
        <SettingsFieldRow label={t('modelConfiguration.quickSetup.account')}><span>{discovery.accountId ?? '—'}</span></SettingsFieldRow>
        <Collapsible>
          <CollapsibleTrigger className="w-auto typography-meta">{t('modelConfiguration.quickSetup.details')}</CollapsibleTrigger>
          <CollapsibleContent><dl className="grid gap-x-4 gap-y-1 @xl:grid-cols-2 typography-meta">
          <div><dt className="text-muted-foreground">{t('modelConfiguration.quickSetup.instance')}</dt><dd>{discovery.instanceId ?? '—'}</dd></div>
          {discovery.expiresAt ? <div><dt className="text-muted-foreground">{t('modelConfiguration.quickSetup.expiresAt')}</dt><dd>{discovery.expiresAt}</dd></div> : null}
          {discovery.keyFingerprint ? <div><dt className="text-muted-foreground">{t('modelConfiguration.quickSetup.fingerprint')}</dt><dd className="break-all">{discovery.keyFingerprint}</dd></div> : null}
        </dl></CollapsibleContent></Collapsible>
        <Button onClick={makePreview} disabled={busy}>{t('modelConfiguration.quickSetup.preview')}</Button>
      </SettingsSection> : null}
      {step === 'preview' && preview ? <SettingsSection title={t('modelConfiguration.quickSetup.preview.title')} divider={false} contentClassName="space-y-3">
        <div className="space-y-1.5" role="radiogroup" aria-label={t('modelConfiguration.quickSetup.mode')}>
          {(['fill-missing', 'replace-managed'] as const).map((option) => <div key={option} role="radio" aria-checked={mode === option} tabIndex={busy ? -1 : 0} className="flex items-center gap-2 text-start" onClick={() => { if (!busy && mode !== option) { setMode(option); setPreview(null); setStep('discover'); } }} onKeyDown={(event) => { if ((event.key === 'Enter' || event.key === ' ') && !busy && mode !== option) { event.preventDefault(); setMode(option); setPreview(null); setStep('discover'); } }}><Radio checked={mode === option} onChange={() => setMode(option)} ariaLabel={t(modeText[option])} /><span className="typography-meta">{t(modeText[option])}</span></div>)}
        </div>
        <ul className="space-y-2 typography-meta">{preview.items.map((item) => {
          const label = purposeLabel(item.purpose);
          const actionText = { add: 'modelConfiguration.quickSetup.action.add', replace: 'modelConfiguration.quickSetup.action.replace', preserve: 'modelConfiguration.quickSetup.action.preserve', unavailable: 'modelConfiguration.quickSetup.action.unavailable' } satisfies Record<typeof item.action, I18nKey>;
          return <li key={item.purpose} className="flex flex-wrap items-center gap-2">
            <span>{label}: {item.modelId ? `${item.modelId} · ` : ''}{t(actionText[item.action])}</span>
            {item.reason ? <Collapsible><CollapsibleTrigger className="w-auto typography-meta">{t('modelConfiguration.quickSetup.details')}</CollapsibleTrigger><CollapsibleContent><code className="break-all">{item.reason}</code></CollapsibleContent></Collapsible> : null}
            {'candidates' in item && item.candidates && item.candidates.length > 1 ? <Select value={selections[item.purpose] ?? item.modelId ?? ''} onValueChange={(value) => { setSelections((current) => ({ ...current, [item.purpose]: value })); setPreview(null); setStep('discover'); }}>
              <SelectTrigger className="h-8 max-w-[18rem]" aria-label={label}><SelectValue /></SelectTrigger>
              <SelectContent>{item.candidates.map((candidate) => <SelectItem key={candidate.id} value={candidate.id}>{candidate.name}</SelectItem>)}</SelectContent>
            </Select> : null}
          </li>;
        })}</ul>
        <div className="flex flex-wrap gap-2"><Button onClick={apply} disabled={busy || (mode === 'replace-managed' && !preview.items.some((item) => item.action === 'replace' && item.requiresConfirmation))}>{t('modelConfiguration.quickSetup.apply')}</Button><Button variant="outline" onClick={() => setStep('discover')} disabled={busy}>{t('modelConfiguration.quickSetup.back')}</Button></div>
      </SettingsSection> : null}
      {step === 'tests' ? <SettingsSection title={t('modelConfiguration.quickSetup.tests.title')} divider={false} contentClassName="space-y-3">
        <p role={testError ? 'alert' : 'status'} className={`flex items-start gap-2 ${SETTINGS_HELPER_CLASS}`}><PauseClock paused={!open}><ModelTestMotion>{testsRunning ? <Spinner aria-hidden="true" /> : null}</ModelTestMotion></PauseClock>{testError ? t('modelConfiguration.quickSetup.tests.unknown') : testStatus ? t(testText[testStatus]) : t('modelConfiguration.quickSetup.tests.waiting')}</p>
        {testResults.length ? <ul className="space-y-2 typography-meta" aria-label={t('modelConfiguration.quickSetup.tests.results')}>{testResults.map((result) => {
          const purpose = toPurposeId(result.purpose);
          const status = result.status === 'verified' || result.status === 'failed' ? result.status
            : result.status === 'stale' ? 'unknown' : result.status === 'pending' ? testsRunning ? 'queued' : 'unknown' : null;
          return <li key={result.purpose}>{purpose && status ? <ModelTestFeedback purpose={purpose} model={testModels[purpose]} status={status} errorCode={result.errorCode ?? (status === 'unknown' ? testError ?? undefined : undefined)} />
            : <>{purposeLabel(result.purpose)}: {t(testResultText[result.status])}{result.errorCode ? <p>{t(modelTestErrorKey(result.errorCode))}</p> : null}</>}</li>;
        })}</ul> : null}
        {testError && testRunId ? <Button variant="outline" onClick={() => { setTestError(null); setTestReadVersion((version) => version + 1); }} disabled={busy}>{t('modelConfiguration.quickSetup.tests.refresh')}</Button> : null}
        {!testError && testStatus === 'failed' ? <Button variant="outline" onClick={retryTests} disabled={busy}>{t('modelConfiguration.quickSetup.retry')}</Button> : null}
        {operationId ? <Button variant="ghost" onClick={rollback} disabled={busy}>{t('modelConfiguration.quickSetup.rollback')}</Button> : null}
      </SettingsSection> : null}
      {error ? <div><p role="alert" className="typography-meta text-[var(--status-error-text)]">{t(error === 'native_credits_unavailable' ? 'platformAccount.keySetup.creditsUnavailable' : 'modelConfiguration.quickSetup.error')}</p><Collapsible><CollapsibleTrigger className="w-auto typography-meta">{t('modelConfiguration.quickSetup.details')}</CollapsibleTrigger><CollapsibleContent><code className="break-all">{error}</code></CollapsibleContent></Collapsible></div> : null}
      <DialogFooter><Button variant="outline" onClick={onClose} disabled={busy}>{t('modelConfiguration.quickSetup.close')}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
};
