import React from 'react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Radio } from '@/components/ui/radio';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { SettingsFieldRow, SettingsSection, SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { isVSCodeRuntime } from '@/lib/desktop';
import type { ModelConfiguration, ModelPurposeId } from '@/lib/modelConfiguration';
import { modelTestErrorKey, MODEL_PURPOSE_LABELS } from './modelConfigurationView';
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
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const unsupported = isVSCodeRuntime();

  React.useEffect(() => {
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
    if (!testRunId || step !== 'tests') return;
    let cancelled = false;
    const poll = async () => {
      try {
        const run = await client.readTestRun(testRunId);
        if (cancelled) return;
        setTestResults(run.results);
        const failed = run.results.filter((result) => result.status === 'failed').map((result) => toPurposeId(result.purpose)).filter((purpose): purpose is ModelPurposeId => purpose !== null);
        if (run.status === 'completed') setTestPurposes(failed);
        setTestStatus(run.status === 'completed' && failed.length ? 'failed' : run.status);
        if (run.status === 'queued' || run.status === 'running') window.setTimeout(poll, 700);
      } catch (reason) { if (!cancelled) setError(reason instanceof ModelConfigurationBootstrapError ? reason.code : 'request_failed'); }
    };
    void poll();
    return () => { cancelled = true; };
  }, [client, step, testRunId]);

  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await operation(); } catch (reason) { setError(reason instanceof ModelConfigurationBootstrapError ? reason.code : 'request_failed'); }
    finally { setBusy(false); }
  };
  const discover = () => run(async () => {
    const input = { source, key: source === 'imported-key' ? key : undefined };
    const result = await client.discover(input);
    setDiscovery(result); setStep('discover');
  });
  const issueKey = () => run(async () => {
    const result = await client.issueKey({});
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
    const test = await client.startTests({ revision: result.revision, purposes });
    setTestPurposes(purposes); setTestResults(test.results); setTestRunId(test.testRunId); setTestStatus(test.status);
  });
  const retryTests = () => run(async () => {
    const purposes = testPurposes.length ? testPurposes : testResults.filter((result) => result.status === 'failed').map((result) => toPurposeId(result.purpose)).filter((purpose): purpose is ModelPurposeId => purpose !== null);
    const test = await client.startTests({ revision: configuration.revision, purposes });
    setTestPurposes(purposes); setTestResults(test.results); setTestRunId(test.testRunId); setTestStatus(test.status);
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
      {step === 'source' ? <SettingsSection title={t('modelConfiguration.quickSetup.source.title')} divider={false} contentClassName="space-y-3">
        {sourceOptions.map((option) => <div key={option} role="radio" aria-checked={source === option} tabIndex={busy || unsupported ? -1 : 0} className="flex w-full items-start gap-3 rounded-md p-2 text-start hover:bg-interactive-hover" onClick={() => { if (!busy && !unsupported) setSource(option); }} onKeyDown={(event) => { if ((event.key === 'Enter' || event.key === ' ') && !busy && !unsupported) { event.preventDefault(); setSource(option); } }}>
          <Radio checked={source === option} onChange={() => setSource(option)} ariaLabel={t(sourceText[option])} />
          <span><span className="typography-ui-label text-foreground">{t(sourceText[option])}</span><span className={`block ${SETTINGS_HELPER_CLASS}`}>{t(sourceHintText[option])}</span></span>
        </div>)}
        {source === 'imported-key' ? <SettingsFieldRow label={t('modelConfiguration.quickSetup.key')}><Input type="password" value={key} onChange={(event) => setKey(event.target.value)} aria-label={t('modelConfiguration.quickSetup.key')} className="max-w-[24rem]" /></SettingsFieldRow> : null}
        <Button onClick={discover} disabled={busy || unsupported || (source === 'imported-key' && !key.trim())}>{t('modelConfiguration.quickSetup.discover')}</Button>
        {source === 'session' ? <Collapsible>
          <CollapsibleTrigger className="w-auto typography-meta">{t('modelConfiguration.quickSetup.issueOptions')}</CollapsibleTrigger>
          <CollapsibleContent className="space-y-2 py-2">
            <p className={SETTINGS_HELPER_CLASS}>{t('modelConfiguration.quickSetup.issueHint')}</p>
            <Button variant="outline" onClick={issueKey} disabled={busy || unsupported}>{t('modelConfiguration.quickSetup.issueKey')}</Button>
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
        <p role="status" className={SETTINGS_HELPER_CLASS}>{testStatus ? t(testText[testStatus]) : t('modelConfiguration.quickSetup.tests.waiting')}</p>
        {testResults.length ? <ul className="space-y-1 typography-meta" aria-label={t('modelConfiguration.quickSetup.tests.results')}>{testResults.map((result) => <li key={result.purpose}>{purposeLabel(result.purpose)}: {t(testResultText[result.status])}{result.errorCode ? <><p>{t(modelTestErrorKey(result.errorCode))}</p><Collapsible><CollapsibleTrigger className="w-auto typography-meta">{t('modelConfiguration.quickSetup.details')}</CollapsibleTrigger><CollapsibleContent><code className="break-all">{result.errorCode}</code></CollapsibleContent></Collapsible></> : null}</li>)}</ul> : null}
        {testStatus === 'failed' ? <Button variant="outline" onClick={retryTests} disabled={busy}>{t('modelConfiguration.quickSetup.retry')}</Button> : null}
        {operationId ? <Button variant="ghost" onClick={rollback} disabled={busy}>{t('modelConfiguration.quickSetup.rollback')}</Button> : null}
      </SettingsSection> : null}
      {error ? <div><p role="alert" className="typography-meta text-[var(--status-error-text)]">{t('modelConfiguration.quickSetup.error')}</p><Collapsible><CollapsibleTrigger className="w-auto typography-meta">{t('modelConfiguration.quickSetup.details')}</CollapsibleTrigger><CollapsibleContent><code className="break-all">{error}</code></CollapsibleContent></Collapsible></div> : null}
      <DialogFooter><Button variant="outline" onClick={onClose} disabled={busy}>{t('modelConfiguration.quickSetup.close')}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
};
