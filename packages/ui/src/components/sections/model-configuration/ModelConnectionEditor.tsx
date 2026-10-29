import React from 'react';
import { useI18n } from '@/lib/i18n';
import { beginGuidanceAction, reportGuidanceAction, useProductHelpGuidanceStore } from '@/lib/product-help/guidance-store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SettingsStackedField, SettingsTwoColumn, SETTINGS_SELECT_ROW_TRIGGER_CLASS } from '@/components/sections/shared/SettingsSection';
import { saveModelConnection, removeModelConnection, testModelConnection, ModelConfigurationError, type ModelConfiguration, type ModelPreset, type ModelConnection, type ModelConnectionInput, type ModelConnectionTestInput, type ModelConnectionTestResult, type ModelPurposeId } from '@/lib/modelConfiguration';
import { invalidateServerTTSStatus } from '@/hooks/useServerTTS';
import { configurationErrorMessage, isLocalModelEndpoint, MODEL_PURPOSE_LABELS } from './modelConfigurationView';
import { ModelPresetDetails as PresetDetails, ModelPresetPicker as PresetPicker } from './ModelConfigurationFields';

export type ModelConnectionProbeDraft = ModelConnectionTestInput;

export const ModelConnectionEditor: React.FC<{
  configuration: ModelConfiguration;
  selected: ModelConnection | null;
  initialPreset: ModelPreset | null;
  initialConnection?: ModelConnection | null;
  initialDraft?: ModelConnectionProbeDraft | null;
  pending: boolean;
  applyChange: (operation: () => Promise<ModelConfiguration>) => Promise<ModelConfiguration | null>;
  client: { saveConnection: typeof saveModelConnection; removeConnection: typeof removeModelConnection; testConnection: typeof testModelConnection };
  onSaved: (id: string, draft?: ModelConnectionProbeDraft) => void;
}> = ({ configuration, selected, initialPreset, initialConnection, initialDraft, pending, applyChange, client, onSaved }) => {
  const { t } = useI18n();
  const template = selected ?? initialConnection;
  const savedBinding = selected ? configuration.bindings.find((binding) => binding.connectionId === selected.id) : undefined;
  const firstPreset = initialDraft ? configuration.presets.find((candidate) => candidate.id === initialDraft.presetId)
    : initialPreset ?? configuration.presets.find((candidate) => candidate.id === savedBinding?.presetId);
  const [presetId, setPresetId] = React.useState(firstPreset?.id ?? '');
  const [name, setName] = React.useState(selected?.name ?? firstPreset?.name ?? '');
  const [baseUrl, setBaseUrl] = React.useState(template?.baseUrl ?? firstPreset?.baseUrl ?? '');
  const [workspaceId, setWorkspaceId] = React.useState(template?.workspaceId ?? firstPreset?.parameters.workspaceId ?? '');
  const [region, setRegion] = React.useState(template?.region ?? firstPreset?.parameters.region ?? '');
  const [apiKey, setApiKey] = React.useState('');
  const [credentialChoice, setCredentialChoice] = React.useState(selected?.credentialSource?.providerId ?? '__manual__');
  const [model, setModel] = React.useState(initialDraft?.model ?? savedBinding?.model ?? firstPreset?.model ?? '');
  const [parameters, setParameters] = React.useState(initialDraft?.parameters ?? savedBinding?.parameters ?? firstPreset?.parameters ?? {});
  const initialPurpose = initialDraft?.purpose ?? savedBinding?.purpose ?? firstPreset?.purposes.find((id) => configuration.purposes.some((purpose) => purpose.id === id && purpose.status === 'available')) ?? firstPreset?.purposes[0] ?? 'embedding';
  const [purposeId, setPurposeId] = React.useState<ModelPurposeId>(initialPurpose);
  const [error, setError] = React.useState<string | null>(null);
  const [testState, setTestState] = React.useState<ModelConnectionTestResult | 'testing' | null>(null);
  const preset = configuration.presets.find((candidate) => candidate.id === presetId);
  const guidanceRequestId = useProductHelpGuidanceStore((state) => state.session?.requestId);
  const hasSelection = Boolean(selected || preset);
  React.useEffect(() => {
    if (hasSelection) reportGuidanceAction(beginGuidanceAction('models.connection.selected'), 'complete');
  }, [guidanceRequestId, hasSelection]);
  const providerId = selected?.providerId ?? preset?.providerId ?? initialConnection?.providerId;
  const protocol = selected?.protocol ?? preset?.protocol ?? initialConnection?.protocol;
  const managedMedia = protocol === 'managed-media';
  const presets = selected ? configuration.presets.filter((candidate) => candidate.providerId === selected.providerId && candidate.protocol === selected.protocol) : configuration.presets;
  const resolvedBaseUrl = workspaceId.trim() ? baseUrl.replaceAll('{workspaceId}', workspaceId.trim()) : baseUrl;
  const incompleteBaseUrl = /[{}]/.test(resolvedBaseUrl);
  const availableSources = configuration.credentialSources.sources;
  const currentSource = selected?.credentialSource;
  const sourceOptions: ModelConfiguration['credentialSources']['sources'] = currentSource && !availableSources.some((source) => source.providerId === currentSource.providerId)
    ? [...availableSources, currentSource] : availableSources;
  const sourceAvailable = availableSources.some((source) => source.providerId === credentialChoice);
  const credentialReady = managedMedia || (credentialChoice === '__manual__'
    ? Boolean(apiKey.trim() || (selected?.hasApiKey && !selected.credentialSource) || isLocalModelEndpoint(resolvedBaseUrl)) : sourceAvailable);
  const connectionDirty = !selected || Boolean(apiKey.trim()) || name.trim() !== selected.name || resolvedBaseUrl.trim() !== selected.baseUrl
    || workspaceId.trim() !== (selected.workspaceId ?? '') || region.trim() !== (selected.region ?? '')
    || credentialChoice !== (selected.credentialSource?.providerId ?? '__manual__');
  const purposeOptions = configuration.purposes.filter((purpose) => preset ? preset.purposes.includes(purpose.id) : purpose.probeProtocols?.includes(protocol ?? 'openai-compatible'));
  const purpose = purposeOptions.find((candidate) => candidate.id === purposeId);
  const probeSupported = purpose?.status === 'available' && purpose.probeProtocols?.includes(protocol ?? 'openai-compatible')
    && (!preset || preset.status === 'compatible');
  const validDimensions = parameters.dimensions === undefined || Number.isInteger(parameters.dimensions) && parameters.dimensions > 0;
  const probeBlocked = configuration.enterpriseMode && !isLocalModelEndpoint(selected?.baseUrl ?? '');
  const canTest = Boolean(selected && !connectionDirty && probeSupported && model.trim() && validDimensions && !probeBlocked);
  React.useEffect(() => {
    if (configuration.enterpriseMode) reportGuidanceAction(beginGuidanceAction('models.connection.saved'), 'failed');
    if (!probeSupported || probeBlocked) reportGuidanceAction(beginGuidanceAction('models.connection.tested'), 'failed');
  }, [guidanceRequestId, configuration.enterpriseMode, probeSupported, probeBlocked]);
  const formIdentity = JSON.stringify({ revision: configuration.revision, selected, name, baseUrl, workspaceId, region, apiKey, credentialChoice, model, parameters, purposeId, presetId });
  const currentForm = React.useRef(formIdentity);
  const testGeneration = React.useRef(0);
  if (currentForm.current !== formIdentity) { currentForm.current = formIdentity; testGeneration.current += 1; }
  const mounted = React.useRef(true);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  React.useEffect(() => { setTestState(null); }, [formIdentity]);

  const choosePreset = (next: ModelPreset) => {
    setPresetId(next.id);
    if (!selected) setName(next.name);
    setBaseUrl(next.baseUrl); setModel(next.model); setParameters(next.parameters);
    setWorkspaceId(next.parameters.workspaceId ?? ''); setRegion(next.parameters.region ?? '');
    setPurposeId(next.purposes.find((id) => configuration.purposes.some((candidate) => candidate.id === id && candidate.status === 'available')) ?? next.purposes[0] ?? 'embedding');
  };
  const save = async () => {
    if (!providerId || !protocol) return;
    const guidanceAction = beginGuidanceAction('models.connection.saved');
    setError(null);
    const details = { name: name.trim(), baseUrl: resolvedBaseUrl.trim(), providerId, protocol };
    const connection: ModelConnectionInput = credentialChoice === '__manual__' ? details
      : { ...details, credentialSource: { type: 'opencode', providerId: credentialChoice } };
    if (selected) connection.id = selected.id;
    if (workspaceId.trim()) connection.workspaceId = workspaceId.trim();
    if (region.trim()) connection.region = region.trim();
    if (credentialChoice === '__manual__' && apiKey.trim()) connection.apiKey = apiKey.trim();
    try {
      const result = await applyChange(() => client.saveConnection(configuration.revision, connection));
      if (!result) return;
      setApiKey('');
      const saved = result.connections.find((candidate) => selected ? candidate.id === selected.id : !configuration.connections.some((previous) => previous.id === candidate.id));
      if (saved) {
        if (result.bindings.some((binding) => binding.purpose === 'tts' && binding.connectionId === saved.id)) invalidateServerTTSStatus();
        const draft: ModelConnectionProbeDraft = { purpose: purposeId, model, parameters };
        if (presetId) draft.presetId = presetId;
        onSaved(saved.id, draft);
        reportGuidanceAction(guidanceAction, 'complete');
      } else reportGuidanceAction(guidanceAction, 'failed');
    } catch (reason) {
      setError(reason instanceof ModelConfigurationError ? reason.code : 'request_failed');
      reportGuidanceAction(guidanceAction, 'failed');
    }
  };
  const testConnection = async () => {
    if (!selected || !canTest || testState === 'testing') return;
    const guidanceAction = beginGuidanceAction('models.connection.tested');
    const submitted = ++testGeneration.current;
    setTestState('testing'); setError(null);
    try {
      const input: ModelConnectionTestInput = { purpose: purposeId, model: model.trim(), parameters };
      if (preset?.model === model.trim()) input.presetId = preset.id;
      const result = await client.testConnection(selected.id, configuration.revision, input);
      if (mounted.current && testGeneration.current === submitted) {
        setTestState(result);
        reportGuidanceAction(guidanceAction, result.status === 'verified' ? 'complete' : 'failed');
      } else reportGuidanceAction(guidanceAction, 'failed');
    } catch (reason) {
      if (mounted.current && testGeneration.current === submitted) { setTestState(null); setError(reason instanceof ModelConfigurationError ? reason.code : 'request_failed'); }
      reportGuidanceAction(guidanceAction, 'failed');
    }
  };
  const testMessage = testState === 'testing' ? t('modelConfiguration.connectionTesting')
    : testState?.status === 'verified' ? t('modelConfiguration.connectionVerified')
      : testState?.status === 'failed' ? configurationErrorMessage(testState.errorCode ?? 'test_failed', t)
        : connectionDirty ? t('modelConfiguration.saveBeforeTest')
          : !probeSupported ? t('modelConfiguration.connectionTestUnavailable') : '';
  return <div className="space-y-3">
    <div data-settings-item="models.connection-preset">
    {presets.length ? <PresetPicker presets={presets} value={presetId} onChange={choosePreset} /> : null}
    {preset ? <PresetDetails preset={preset} /> : null}
    </div>
    <div data-settings-item="models.connection-details" className="space-y-3">
    <SettingsTwoColumn className="gap-y-3 @3xl:gap-x-8 @3xl:gap-y-3">
      <SettingsStackedField label={t('modelConfiguration.name')}><Input className="h-8" value={name} onChange={(event) => setName(event.target.value)} aria-label={t('modelConfiguration.name')} disabled={pending} /></SettingsStackedField>
      <SettingsStackedField label={t('modelConfiguration.protocol')}><p className="typography-ui-label" dir="ltr">{protocol ?? '—'}</p></SettingsStackedField>
      <SettingsStackedField label={t('modelConfiguration.baseUrl')}>
        <Input className="h-8" dir="ltr" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} aria-label={t('modelConfiguration.baseUrl')} disabled={pending} />
        {resolvedBaseUrl !== baseUrl ? <p className="mt-1 typography-meta break-all text-muted-foreground" dir="ltr">{resolvedBaseUrl}</p> : null}
      </SettingsStackedField>
      <SettingsStackedField label={t('modelConfiguration.model')} info={t('modelConfiguration.connectionModelHint')}><Input className="h-8" dir="ltr" value={model} onChange={(event) => setModel(event.target.value)} aria-label={t('modelConfiguration.model')} disabled={pending} /></SettingsStackedField>
      <SettingsStackedField label={t('modelConfiguration.credentialSource')} info={t('modelConfiguration.sourceHint')}>
        <Select value={credentialChoice} onValueChange={(value) => { setCredentialChoice(value); setApiKey(''); }} disabled={pending || managedMedia}>
          <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={t('modelConfiguration.credentialSource')}><SelectValue>{credentialChoice === '__manual__' ? t('modelConfiguration.enterKey') : t('modelConfiguration.reuseKey', { provider: sourceOptions.find((source) => source.providerId === credentialChoice)?.name ?? credentialChoice })}</SelectValue></SelectTrigger>
          <SelectContent><SelectItem value="__manual__">{t('modelConfiguration.enterKey')}</SelectItem>{sourceOptions.map((source) => <SelectItem key={source.providerId} value={source.providerId}>{t('modelConfiguration.reuseKey', { provider: source.name ?? source.providerId })}</SelectItem>)}</SelectContent>
        </Select>
      </SettingsStackedField>
      <SettingsStackedField label={t('modelConfiguration.apiKey')} info={t(isLocalModelEndpoint(resolvedBaseUrl) ? 'modelConfiguration.localKeyHint' : 'modelConfiguration.keyHint')}>
        {managedMedia ? <p className="typography-meta text-muted-foreground">{t('modelConfiguration.managedSessionCredential')}</p>
          : credentialChoice === '__manual__' ? <Input className="h-8" dir="ltr" type="password" autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} aria-label={t('modelConfiguration.apiKey')} disabled={pending} placeholder={t(selected?.hasApiKey ? 'modelConfiguration.keyStored' : 'modelConfiguration.keyMissing')} /> : <p className="typography-meta text-muted-foreground">{t('modelConfiguration.reuseKey', { provider: sourceOptions.find((source) => source.providerId === credentialChoice)?.name ?? credentialChoice })}</p>}
      </SettingsStackedField>
      {workspaceId || preset?.baseUrl.includes('{workspaceId}') ? <SettingsStackedField label={t('modelConfiguration.workspace')}><Input className="h-8" dir="ltr" value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)} aria-label={t('modelConfiguration.workspace')} disabled={pending} /></SettingsStackedField> : null}
      {region || preset?.parameters.region ? <SettingsStackedField label={t('modelConfiguration.region')}><Input className="h-8" dir="ltr" value={region} onChange={(event) => setRegion(event.target.value)} aria-label={t('modelConfiguration.region')} disabled={pending} /></SettingsStackedField> : null}
      <SettingsStackedField label={t('modelConfiguration.testPurpose')} info={t('modelConfiguration.testHint')}>
        <Select value={purposeId} onValueChange={(id) => { const next = purposeOptions.find((candidate) => candidate.id === id); if (next) setPurposeId(next.id); }} disabled={pending || !purposeOptions.length}>
          <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={t('modelConfiguration.testPurpose')}><SelectValue>{purpose ? t(MODEL_PURPOSE_LABELS[purpose.id]) : t('modelConfiguration.testPurpose')}</SelectValue></SelectTrigger>
          <SelectContent>{purposeOptions.map((candidate) => <SelectItem key={candidate.id} value={candidate.id}>{t(MODEL_PURPOSE_LABELS[candidate.id])}</SelectItem>)}</SelectContent>
        </Select>
      </SettingsStackedField>
      {purposeId === 'embedding' ? <SettingsStackedField label={t('modelConfiguration.dimensions')}><Input className="h-8" dir="ltr" type="number" min={1} value={parameters.dimensions ?? ''} onChange={(event) => setParameters((previous) => ({ ...previous, dimensions: event.target.value ? Number(event.target.value) : undefined }))} aria-label={t('modelConfiguration.dimensions')} disabled={pending} /></SettingsStackedField> : null}
      {purposeId === 'tts' ? <SettingsStackedField label={t('modelConfiguration.voice')}><Input className="h-8" dir="ltr" value={parameters.voice ?? ''} onChange={(event) => setParameters((previous) => ({ ...previous, voice: event.target.value }))} aria-label={t('modelConfiguration.voice')} disabled={pending} /></SettingsStackedField> : null}
    </SettingsTwoColumn>
    {configuration.credentialSources.status !== 'available' || (credentialChoice !== '__manual__' && !sourceAvailable) ? <p className="typography-meta text-[var(--status-warning-text)]">{t('modelConfiguration.sourceUnavailable')}</p> : null}
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" disabled={pending || configuration.enterpriseMode || !providerId || !protocol || !name.trim() || !baseUrl.trim() || incompleteBaseUrl || !credentialReady} onClick={() => void save()}>{t('settings.common.actions.saveChanges')}</Button>
      <Button data-settings-item="models.connection-test" variant="outline" size="sm" disabled={pending || !canTest || testState === 'testing'} onClick={() => void testConnection()}>{t('modelConfiguration.testConnection')}</Button>
      {preset ? <Button variant="ghost" size="sm" disabled={pending} onClick={() => choosePreset(preset)}>{t('modelConfiguration.restoreDefaults')}</Button> : null}
      {selected ? <Button variant="ghost" size="sm" disabled={pending} onClick={async () => {
        setError(null);
        try { const result = await applyChange(() => client.removeConnection(selected.id, configuration.revision)); if (result) { setApiKey(''); onSaved(''); } }
        catch (reason) { setError(reason instanceof ModelConfigurationError ? reason.code : 'request_failed'); }
      }}>{t('settings.common.actions.delete')}</Button> : null}
    </div>
    </div>
    <p role={error || testState && testState !== 'testing' && testState.status === 'failed' ? 'alert' : 'status'} className={`min-h-5 typography-meta ${error || testState && testState !== 'testing' && testState.status === 'failed' ? 'text-[var(--status-error-text)]' : testState && testState !== 'testing' && testState.status === 'verified' ? 'text-[var(--status-success-text)]' : 'text-muted-foreground'}`}>{error ? configurationErrorMessage(error, t) : testMessage}</p>
  </div>;
};
