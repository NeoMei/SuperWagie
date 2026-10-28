import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import {
  SettingsSection, SettingsFieldRow, SettingsChipGroup,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS, SETTINGS_HELPER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { DefaultsSettings } from '@/components/sections/openchamber/DefaultsSettings';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { useProductHelpGuidanceStore } from '@/lib/product-help/guidance-store';
import {
  readModelConfiguration, saveModelConnection, removeModelConnection, saveModelBinding, testModelBinding, testModelConnection,
  ModelConfigurationError, type ModelConfiguration, type ModelPreset, type ModelBindingInput, type ModelConnection,
} from '@/lib/modelConfiguration';
import { readKnowledgeLibraryModelConfiguration, type KnowledgeLibraryModelConfiguration } from '@/lib/knowledgeLibrary';
import { loadDesktopSettings, reportSettingsSaveState } from '@/lib/persistence';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useUIStore } from '@/stores/useUIStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { fetchRoutingState } from '@/lib/routing/routingApi';
import { useRoutingStore } from '@/stores/useRoutingStore';
import { invalidateServerTTSStatus } from '@/hooks/useServerTTS';
import { isDesktopShell, isVSCodeRuntime } from '@/lib/desktop';
import { ModelConfigurationOverview } from './ModelConfigurationOverview';
import { buildModelOverviewRows, type ModelOverviewInputs, type ModelOverviewRow } from './modelOverviewRows';
import { ModelConnectionEditor, type ModelConnectionProbeDraft } from './ModelConnectionEditor';
import { ModelPresetDetails as PresetDetails, ModelPresetPicker as PresetPicker } from './ModelConfigurationFields';
import { configurationErrorMessage, isLocalModelEndpoint, BUNDLED_SKILL_IDS, MODEL_PURPOSE_LABELS, visibleModelPresets, type ModelOriginFilter, type ModelPurposeId } from './modelConfigurationView';
import { useModelConfigurationTabStore } from './modelConfigurationTabs';

type ModelBindingDraft = ModelBindingInput;
type ModelPurpose = ModelConfiguration['purposes'][number];

const modelConfigurationClient = {
  read: readModelConfiguration,
  readKnowledgeModels: readKnowledgeLibraryModelConfiguration,
  saveConnection: saveModelConnection,
  removeConnection: removeModelConnection,
  saveBinding: saveModelBinding,
  testBinding: testModelBinding,
  testConnection: testModelConnection,
};

type ModelConfigurationClient = typeof modelConfigurationClient;
type ApplyChange = (operation: () => Promise<ModelConfiguration>) => Promise<ModelConfiguration | null>;
type PurposeConnectionSelection = { purpose: ModelPurposeId; connectionId: string };

function publicModelEndpoint(value: string): string {
  try {
    const url = new URL(value);
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return url.toString();
  } catch { return ''; }
}


function bindingFingerprint(binding: ModelBindingDraft | null): string {
  return JSON.stringify([binding?.connectionId ?? '', binding?.presetId ?? '', binding?.model.trim() ?? '',
    binding?.parameters.dimensions ?? null, binding?.parameters.voice ?? '', binding?.parameters.language ?? '',
    binding?.parameters.workspaceId ?? '', binding?.parameters.region ?? '']);
}


const ModelOriginPicker: React.FC<{ value: ModelOriginFilter; onChange: (value: ModelOriginFilter) => void }> = ({ value, onChange }) => {
  const { t } = useI18n();
  return <SettingsFieldRow label={t('modelConfiguration.origin')}>
    <SettingsChipGroup value={value} onChange={onChange} aria-label={t('modelConfiguration.origin')} options={[
      { value: 'all', label: t('modelConfiguration.origin.all') },
      { value: 'china', label: t('modelConfiguration.origin.china') },
      { value: 'international', label: t('modelConfiguration.origin.international') },
    ]} />
  </SettingsFieldRow>;
};


function consumerName(id: string, t: ReturnType<typeof useI18n>['t']): string {
  if (id.startsWith('superwagie-')) return 'SuperWagie';
  if (id === 'knowledge-library') return t('knowledgeLibrary.page.title');
  if (id === 'voice-input') return t('modelConfiguration.purpose.stt-short');
  if (id === 'voice-transcription') return t('modelConfiguration.purpose.stt-file');
  if (id === 'read-aloud') return t('modelConfiguration.purpose.tts');
  if (id === 'auto-routing') return t('modelConfiguration.purpose.routing');
  return id;
}

const PurposeEditor: React.FC<{
  configuration: ModelConfiguration;
  purpose: ModelPurpose;
  pending: boolean;
  applyChange: ApplyChange;
  client: ModelConfigurationClient;
  addConnection: (preset?: ModelPreset, connection?: ModelConnection, probeDraft?: ModelConnectionProbeDraft) => void;
  connectionSelection: PurposeConnectionSelection | null;
  onConnectionSelected: () => void;
}> = ({ configuration, purpose, pending, applyChange, client, addConnection, connectionSelection, onConnectionSelected }) => {
  const { t } = useI18n();
  const openSettings = useUIStore((state) => state.setSettingsPage);
  const currentVoice = useConfigStore(useShallow((state) => ({
    provider: state.voiceProvider,
    model: state.voiceProvider === 'local' ? state.localTtsModelId : state.voiceProvider === 'openai-compatible' ? state.openaiCompatibleTtsModel : '',
    url: state.voiceProvider === 'openai-compatible' ? state.openaiCompatibleUrl : '',
    voice: state.voiceProvider === 'browser' ? state.browserVoice : state.voiceProvider === 'say' ? state.sayVoice : state.voiceProvider === 'openai' ? state.openaiVoice : state.voiceProvider === 'openai-compatible' ? state.openaiCompatibleVoice : '',
    sttProvider: state.sttProvider,
    sttModel: state.sttProvider === 'local' ? state.sttLocalModel : state.sttModel,
    sttUrl: state.sttProvider === 'openai-compatible' ? state.sttServerUrl : '',
  })));
  const binding = configuration.bindings.find((candidate) => candidate.purpose === purpose.id);
  const [origin, setOrigin] = React.useState<ModelOriginFilter>('all');
  const [presetId, setPresetId] = React.useState(binding?.presetId ?? '');
  const [connectionId, setConnectionId] = React.useState(binding?.connectionId ?? '');
  const [model, setModel] = React.useState(binding?.model ?? '');
  const [dimensions, setDimensions] = React.useState(binding?.parameters.dimensions?.toString() ?? '');
  const [voice, setVoice] = React.useState(binding?.parameters.voice ?? '');
  const [language, setLanguage] = React.useState(binding?.parameters.language ?? '');
  const [error, setError] = React.useState<string | null>(null);
  const [knowledgeModels, setKnowledgeModels] = React.useState<KnowledgeLibraryModelConfiguration | 'failed' | null>(null);
  const readsKnowledgeModels = ['ocr', 'vision', 'embedding', 'rerank'].includes(purpose.id) && !binding;
  React.useEffect(() => {
    if (!readsKnowledgeModels) return;
    const controller = new AbortController();
    setKnowledgeModels(null);
    void client.readKnowledgeModels(controller.signal).then((models) => {
      if (!controller.signal.aborted) setKnowledgeModels(models);
    }).catch(() => {
      if (!controller.signal.aborted) setKnowledgeModels('failed');
    });
    return () => controller.abort();
  }, [client, configuration.revision, readsKnowledgeModels, purpose.id]);
  const currentKnowledgeModels = knowledgeModels && knowledgeModels !== 'failed' && knowledgeModels.status === 'available'
    ? knowledgeModels.models.filter((model) => model.purpose === purpose.id) : [];
  const knowledgeModelsUnavailable = knowledgeModels === 'failed' ? true : knowledgeModels?.status === 'unavailable'
    || (knowledgeModels?.status === 'available' && knowledgeModels.unavailablePurposes?.some((id) => id === purpose.id));
  const legacyTts = purpose.id === 'tts' && !binding;
  const legacyStt = (purpose.id === 'stt-short' || purpose.id === 'stt-realtime') && !binding;
  const ttsProviderLabels = { browser: 'settings.voice.page.provider.browser', local: 'settings.voice.page.provider.local', openai: 'settings.voice.page.provider.openai', 'openai-compatible': 'settings.voice.page.provider.custom', say: 'settings.voice.page.provider.say' } as const satisfies Record<typeof currentVoice.provider, I18nKey>;
  const legacyVoiceModel = legacyTts ? currentVoice.model : legacyStt ? currentVoice.sttModel : '';
  const legacyVoiceUrl = publicModelEndpoint(legacyTts ? currentVoice.url : legacyStt ? currentVoice.sttUrl : '');
  const preset = configuration.presets.find((candidate) => candidate.id === presetId);
  const visiblePresets = visibleModelPresets(configuration.presets, purpose.id, origin, presetId);
  const eligibleConnections = configuration.connections.filter((connection) => !preset || (
    connection.providerId === preset.providerId && connection.protocol === preset.protocol
  ));
  const chosenConnection = configuration.connections.find((connection) => connection.id === connectionId);
  const canTest = Boolean(chosenConnection && purpose.probeProtocols?.includes(chosenConnection.protocol));
  const selectedConnections = chosenConnection && !eligibleConnections.some((connection) => connection.id === chosenConnection.id)
    ? [chosenConnection, ...eligibleConnections] : eligibleConnections;
  const parsedDimensions = dimensions === '' ? undefined : Number(dimensions);
  const dimensionsValid = parsedDimensions === undefined || (Number.isInteger(parsedDimensions) && parsedDimensions > 0);
  const parameters: ModelBindingDraft['parameters'] = {};
  if (parsedDimensions !== undefined) parameters.dimensions = parsedDimensions;
  if (voice.trim()) parameters.voice = voice.trim();
  if (language.trim()) parameters.language = language.trim();
  if (chosenConnection?.workspaceId) parameters.workspaceId = chosenConnection.workspaceId;
  if (chosenConnection?.region) parameters.region = chosenConnection.region;
  const draft: ModelBindingDraft = { connectionId, model: model.trim(), parameters };
  if (presetId) draft.presetId = presetId;
  const savedFingerprint = bindingFingerprint(binding ?? null);
  const draftFingerprint = bindingFingerprint(draft);
  const dirty = draftFingerprint !== savedFingerprint;
  const previousBindingFingerprint = React.useRef(savedFingerprint);
  const previousDirty = React.useRef(false);
  const [bindingConflict, setBindingConflict] = React.useState(false);
  const native = purpose.status === 'native';
  const planned = purpose.status === 'planned';
  const blocked = pending || planned || bindingConflict || preset?.status === 'requires-adapter' || preset?.status === 'planned';
  const probeBlocked = blocked || (configuration.enterpriseMode && !isLocalModelEndpoint(chosenConnection?.baseUrl ?? ''));

  const reloadSavedBinding = React.useCallback(() => {
    setConnectionId(binding?.connectionId ?? '');
    setPresetId(binding?.presetId ?? '');
    setModel(binding?.model ?? '');
    setDimensions(binding?.parameters.dimensions?.toString() ?? '');
    setVoice(binding?.parameters.voice ?? '');
    setLanguage(binding?.parameters.language ?? '');
    setBindingConflict(false);
    setError(null);
  }, [binding]);

  React.useEffect(() => {
    if (previousBindingFingerprint.current !== savedFingerprint) {
      previousBindingFingerprint.current = savedFingerprint;
      if (!previousDirty.current || draftFingerprint === savedFingerprint) {
        reloadSavedBinding();
        previousDirty.current = false;
        return;
      }
      setBindingConflict(true);
    } else if (draftFingerprint === savedFingerprint) {
      setBindingConflict(false);
    }
    previousDirty.current = dirty;
  }, [dirty, draftFingerprint, reloadSavedBinding, savedFingerprint]);

  React.useEffect(() => {
    if (connectionId || !preset) return;
    const matching = configuration.connections.find((connection) => connection.providerId === preset.providerId && connection.protocol === preset.protocol);
    if (matching) setConnectionId(matching.id);
  }, [configuration.connections, connectionId, preset]);

  React.useEffect(() => {
    if (connectionSelection?.purpose !== purpose.id) return;
    const selected = configuration.connections.find((connection) => connection.id === connectionSelection.connectionId);
    if (!selected) return;
    if (!preset || (selected.providerId === preset.providerId && selected.protocol === preset.protocol)) {
      setConnectionId(selected.id);
    }
    onConnectionSelected();
  }, [configuration.connections, connectionSelection, onConnectionSelected, preset, purpose.id]);

  const choosePreset = (next: ModelPreset) => {
    setPresetId(next.id);
    setModel(next.model);
    setDimensions(next.parameters.dimensions?.toString() ?? '');
    setVoice(next.parameters.voice ?? '');
    setLanguage(next.parameters.language ?? '');
    const compatible = configuration.connections.find((connection) => connection.providerId === next.providerId && connection.protocol === next.protocol);
    setConnectionId(compatible?.id ?? '');
    setError(null);
  };

  const persist = async (next: ModelBindingDraft | null) => {
    setError(null);
    try {
      const result = await applyChange(() => client.saveBinding(purpose.id, configuration.revision, next));
      if (!result) return;
      if (purpose.id === 'routing') await useRoutingStore.getState().load();
      if (purpose.id === 'tts') {
        invalidateServerTTSStatus();
      }
      if (!next) {
        setConnectionId(''); setModel(''); setPresetId(''); setDimensions(''); setVoice(''); setLanguage('');
      }
    } catch (reason) { setError(reason instanceof ModelConfigurationError ? reason.code : 'request_failed'); }
  };

  return <>
    <SettingsSection
      title={t(MODEL_PURPOSE_LABELS[purpose.id])}
      settingsItem={native ? undefined : `models.${purpose.id}`}
      divider={false}
      info={t(purpose.required ? 'modelConfiguration.required' : 'modelConfiguration.optional')}
      description={t(native ? 'modelConfiguration.native' : planned ? 'modelConfiguration.planned' : binding?.verification.status === 'verified' ? 'modelConfiguration.verified' : binding ? 'modelConfiguration.untested' : 'modelConfiguration.inherited')}
      className="space-y-3 pb-4"
      contentClassName="space-y-2"
    >
      <div>
        <ModelOriginPicker value={origin} onChange={setOrigin} />
        <PresetPicker presets={visiblePresets} value={presetId} onChange={choosePreset} />
      </div>
      {preset ? <PresetDetails preset={preset} /> : null}
      <p className={SETTINGS_HELPER_CLASS}>{t('modelConfiguration.consumers')}: {[...new Set(purpose.consumerIds.map((id) => consumerName(id, t)))].join(', ')}</p>
      {legacyTts || legacyStt ? <SettingsFieldRow label={t('settings.voice.page.field.provider')}>
        <span className="typography-meta text-muted-foreground">{legacyTts ? t(ttsProviderLabels[currentVoice.provider]) : t(currentVoice.sttProvider === 'local' ? 'settings.voice.page.provider.local' : 'settings.voice.page.provider.server')}</span>
      </SettingsFieldRow> : null}
      {legacyVoiceModel ? <SettingsFieldRow label={t('modelConfiguration.model')}><span dir="ltr" className="typography-meta break-all text-muted-foreground">{legacyVoiceModel}</span></SettingsFieldRow> : null}
      {legacyVoiceUrl ? <SettingsFieldRow label={t('modelConfiguration.baseUrl')}><span dir="ltr" className="typography-meta break-all text-muted-foreground">{legacyVoiceUrl}</span></SettingsFieldRow> : null}
      {legacyTts && currentVoice.voice ? <SettingsFieldRow label={t('modelConfiguration.voice')}><span dir="auto" className="typography-meta text-muted-foreground">{currentVoice.voice}</span></SettingsFieldRow> : null}
      {readsKnowledgeModels && knowledgeModelsUnavailable ? <p className={SETTINGS_HELPER_CLASS}>{t('modelConfiguration.currentUnavailable')}</p> : null}
      {currentKnowledgeModels.map((current) => <SettingsFieldRow key={current.modelId} label={t('modelConfiguration.model')}>
        <div className="space-y-1 typography-meta text-muted-foreground">
          <p dir="ltr" className="break-all">{current.model}</p>
          {current.baseUrl ? <p dir="ltr" className="break-all">{current.baseUrl}</p> : null}
          {current.dimensions ? <p>{t('modelConfiguration.dimensions')}: {current.dimensions}</p> : null}
          <p>{t(current.hasKey ? 'modelConfiguration.keyStored' : 'modelConfiguration.keyMissing')}</p>
        </div>
      </SettingsFieldRow>)}
      {purpose.id === 'embedding' && !preset?.noteCodes?.includes('preserve-existing-index') ? <p className="typography-meta text-[var(--status-warning-text)]">{t('modelConfiguration.indexHint')}</p> : null}
      {native ? <Button variant="outline" size="sm" onClick={() => openSettings('providers')}>{t('modelConfiguration.providers')}</Button> : null}
      {!native && !planned ? <>
        <div>
          <SettingsFieldRow label={t('modelConfiguration.connection')}>
            <div className="flex max-w-[24rem] flex-wrap items-center gap-2">
              <Select value={connectionId} onValueChange={setConnectionId} disabled={pending}>
                <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={t('modelConfiguration.connection')}>
                  <SelectValue placeholder={t('modelConfiguration.notConfigured')}>{selectedConnections.find((connection) => connection.id === connectionId)?.name ?? t('modelConfiguration.connection')}</SelectValue>
                </SelectTrigger>
                <SelectContent>{selectedConnections.map((connection) => <SelectItem key={connection.id} value={connection.id}>{connection.name}</SelectItem>)}</SelectContent>
              </Select>
              <Button variant="outline" size="sm" disabled={pending || configuration.enterpriseMode} onClick={() => addConnection(preset, chosenConnection, { presetId, model, purpose: purpose.id, parameters })}>{t('modelConfiguration.addConnection')}</Button>
            </div>
          </SettingsFieldRow>
          <SettingsFieldRow label={t('modelConfiguration.model')}>
            <Input className="h-8 max-w-[24rem]" dir="ltr" value={model} onChange={(event) => {
              const value = event.target.value;
              setModel(value);
              if (preset && value.trim() !== preset.model) setPresetId('');
            }} aria-label={t('modelConfiguration.model')} disabled={pending} />
          </SettingsFieldRow>
          {purpose.id === 'embedding' || purpose.id === 'multimodal-embedding' ? <SettingsFieldRow label={t('modelConfiguration.dimensions')}>
            <Input className="h-8 max-w-[12rem]" type="number" min={1} step={1} value={dimensions} aria-invalid={!dimensionsValid} onChange={(event) => setDimensions(event.target.value)} aria-label={t('modelConfiguration.dimensions')} disabled={pending} />
          </SettingsFieldRow> : null}
          {purpose.id === 'tts' ? <SettingsFieldRow label={t('modelConfiguration.voice')}><Input className="h-8 max-w-[24rem]" dir="auto" value={voice} onChange={(event) => setVoice(event.target.value)} aria-label={t('modelConfiguration.voice')} disabled={pending} /></SettingsFieldRow> : null}
          {purpose.id.startsWith('stt-') || purpose.id === 'tts' ? <SettingsFieldRow label={t('modelConfiguration.language')}><Input className="h-8 max-w-[12rem]" dir="ltr" value={language} onChange={(event) => setLanguage(event.target.value)} aria-label={t('modelConfiguration.language')} disabled={pending} /></SettingsFieldRow> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={blocked || !connectionId || !model.trim() || !dimensionsValid || !dirty} onClick={() => void persist(draft)}>{t('settings.common.actions.saveChanges')}</Button>
          <Button variant="outline" size="sm" disabled={probeBlocked || !binding || dirty || !canTest} onClick={async () => {
            setError(null);
            try { await applyChange(() => client.testBinding(purpose.id, configuration.revision)); }
            catch (reason) { setError(reason instanceof ModelConfigurationError ? reason.code : 'request_failed'); }
          }}>{t('modelConfiguration.test')}</Button>
          {binding ? <Button variant="ghost" size="sm" disabled={pending} onClick={() => void persist(null)}>{t('settings.common.actions.clear')}</Button> : null}
        </div>
        <p className={SETTINGS_HELPER_CLASS}>{t(!dirty && binding && canTest ? 'modelConfiguration.noUnsavedChanges' : canTest ? 'modelConfiguration.testHint' : 'modelConfiguration.verifyInComponent')}</p>
        {purpose.id === 'tts' || purpose.id === 'stt-short' || purpose.id === 'stt-realtime' ? <p className={SETTINGS_HELPER_CLASS}>{t('modelConfiguration.activationHint')}</p> : null}
      </> : null}
      {purpose.id.startsWith('stt-') || purpose.id === 'tts' ? <Button variant="link" size="sm" onClick={() => openSettings('voice')}>{t('modelConfiguration.voiceSettings')}</Button> : null}
      {['ocr', 'vision', 'embedding', 'rerank'].includes(purpose.id) && isDesktopShell() ? <Button variant="link" size="sm" onClick={() => openSettings('knowledge-library')}>{t('modelConfiguration.knowledgeSettings')}</Button> : null}
      {purpose.id === 'routing' ? <Button variant="link" size="sm" onClick={() => openSettings('routing')}>{t('modelConfiguration.routingSettings')}</Button> : null}
      {bindingConflict ? <div className="space-y-2">
        <p role="alert" className="typography-meta text-[var(--status-warning-text)]">{t('modelConfiguration.bindingConflict')}</p>
        <Button variant="outline" size="sm" onClick={reloadSavedBinding}>{t('modelConfiguration.reloadSaved')}</Button>
      </div> : null}
      {error || binding?.verification.status === 'failed' ? <p role="alert" className="typography-meta text-[var(--status-error-text)]">{configurationErrorMessage(error ?? binding?.verification.errorCode ?? 'request_failed', t)}</p> : null}
    </SettingsSection>
    {purpose.id === 'agent' || purpose.id === 'auxiliary' ? <DefaultsSettings modelPurpose={purpose.id} /> : null}
  </>;
};


export const ModelConfigurationPage: React.FC<{ client?: ModelConfigurationClient }> = ({ client = modelConfigurationClient }) => {
  const { t } = useI18n();
  const tab = useModelConfigurationTabStore((state) => state.tab);
  const purposeId = useModelConfigurationTabStore((state) => state.purpose);
  const setTab = useModelConfigurationTabStore((state) => state.setTab);
  const setPurpose = useModelConfigurationTabStore((state) => state.setPurpose);
  const [configuration, setConfiguration] = React.useState<ModelConfiguration | null>(null);
  const [loadState, setLoadState] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const [pending, setPending] = React.useState(false);
  const [connectionId, setConnectionId] = React.useState('');
  const [connectionPreset, setConnectionPreset] = React.useState<ModelPreset | null>(null);
  const [connectionTemplate, setConnectionTemplate] = React.useState<ModelConnection | null>(null);
  const [connectionProbeDraft, setConnectionProbeDraft] = React.useState<ModelConnectionProbeDraft | null>(null);
  const [connectionForPurpose, setConnectionForPurpose] = React.useState<ModelPurposeId | null>(null);
  const [connectionSelection, setConnectionSelection] = React.useState<PurposeConnectionSelection | null>(null);
  const active = React.useRef(true);
  const requestSequence = React.useRef(0);
  const isVSCode = isVSCodeRuntime();
  const [hasOpenedPurpose, setHasOpenedPurpose] = React.useState(tab === 'purposes');
  const [overviewNative, setOverviewNative] = React.useState<ModelOverviewInputs['native']>({ status: 'loading' });
  const [overviewRouting, setOverviewRouting] = React.useState<ModelOverviewInputs['routing']>({ status: 'loading' });
  const [overviewKnowledge, setOverviewKnowledge] = React.useState<ModelOverviewInputs['knowledge']>({ status: 'loading' });
  const [testingPurpose, setTestingPurpose] = React.useState<ModelPurposeId | null>(null);
  const [overviewError, setOverviewError] = React.useState<{ purpose: ModelPurposeId; code: string } | null>(null);
  const overviewPreferences = useConfigStore(useShallow((state) => ({
    defaultModel: state.opencodeDefaultModel,
    voiceProvider: state.voiceProvider,
    ttsModel: state.voiceProvider === 'local' ? state.localTtsModelId : state.voiceProvider === 'openai-compatible' ? state.openaiCompatibleTtsModel : undefined,
    sttProvider: state.sttProvider,
    sttModel: state.sttProvider === 'local' ? state.sttLocalModel : state.sttModel,
  })));

  React.useEffect(() => { if (tab === 'purposes') setHasOpenedPurpose(true); }, [tab]);
  React.useEffect(() => {
    if (tab !== 'overview' || loadState === 'loading') return;
    const controller = new AbortController();
    const runtimeKey = getRuntimeKey();
    const current = () => !controller.signal.aborted && runtimeKey === getRuntimeKey();
    setOverviewNative({ status: 'loading' });
    setOverviewKnowledge({ status: 'loading' });
    setOverviewRouting({ status: 'loading' });
    void loadDesktopSettings().then((settings) => {
      if (!current()) return;
      setOverviewNative(settings ? {
        status: 'ready', defaultModel: settings.defaultModel?.trim() || undefined,
        smallModelUseDefault: settings.smallModelUseDefault !== false,
        smallModelOverride: settings.smallModelOverride?.trim() || undefined,
      } : { status: 'failed' });
    }).catch(() => { if (current()) setOverviewNative({ status: 'failed' }); });
    if (isVSCode) setOverviewRouting({ status: 'failed' });
    else void fetchRoutingState().then((routing) => {
      if (current()) setOverviewRouting({ status: 'ready', configuration: routing });
    }).catch(() => { if (current()) setOverviewRouting({ status: 'failed' }); });
    if (isVSCode) setOverviewKnowledge({ status: 'failed' });
    else void client.readKnowledgeModels(controller.signal).then((models) => {
      if (current()) setOverviewKnowledge({ status: 'ready', configuration: models });
    }).catch(() => { if (current()) setOverviewKnowledge({ status: 'failed' }); });
    return () => controller.abort();
  }, [client, configuration, isVSCode, loadState, tab]);

  const load = React.useCallback(async () => {
    const sequence = ++requestSequence.current;
    const runtimeKey = getRuntimeKey();
    setOverviewError(null);
    setLoadState('loading');
    try {
      const result = await client.read();
      if (active.current && sequence === requestSequence.current && runtimeKey === getRuntimeKey()) {
        setConfiguration(result); setLoadState('ready');
      }
    } catch {
      if (active.current && sequence === requestSequence.current && runtimeKey === getRuntimeKey()) setLoadState('error');
    }
  }, [client]);

  React.useEffect(() => {
    active.current = true;
    if (isVSCode) setLoadState('error');
    else void load();
    return () => { active.current = false; requestSequence.current += 1; };
  }, [isVSCode, load]);

  const applyChange: ApplyChange = async (operation) => {
    const sequence = requestSequence.current;
    const runtimeKey = getRuntimeKey();
    setPending(true);
    reportSettingsSaveState('saving');
    try {
      const result = await operation();
      if (!active.current || sequence !== requestSequence.current || runtimeKey !== getRuntimeKey()) return null;
      setOverviewError(null);
      setConfiguration((current) => !current || result.revision >= current.revision ? result : current);
      reportSettingsSaveState('saved');
      return result;
    } catch (error) {
      if (active.current && sequence === requestSequence.current && runtimeKey === getRuntimeKey()) reportSettingsSaveState('error');
      throw error;
    } finally { if (active.current && sequence === requestSequence.current && runtimeKey === getRuntimeKey()) setPending(false); }
  };
  const overviewInputs: ModelOverviewInputs = {
    native: overviewNative.status === 'ready' ? { ...overviewNative, defaultModel: overviewNative.defaultModel || overviewPreferences.defaultModel } : overviewNative,
    knowledge: overviewKnowledge,
    routing: overviewRouting,
    voice: { tts: { provider: overviewPreferences.voiceProvider, model: overviewPreferences.ttsModel }, stt: { provider: overviewPreferences.sttProvider, model: overviewPreferences.sttModel } },
    runtime: isVSCode ? 'unsupported' : 'available',
  };
  const overviewRows = buildModelOverviewRows(loadState === 'ready' ? configuration : null, overviewInputs).map<ModelOverviewRow>((row) =>
    overviewError?.purpose === row.purpose ? { ...row, test: 'unknown', reason: 'runtime' } : row);
  const testFromOverview = async (id: ModelPurposeId) => {
    if (pending || testingPurpose || loadState !== 'ready' || !configuration || !overviewRows.some((row) => row.purpose === id && row.canTest)) return;
    const sequence = requestSequence.current;
    const runtimeKey = getRuntimeKey();
    setTestingPurpose(id); setOverviewError(null);
    try { await applyChange(() => client.testBinding(id, configuration.revision)); }
    catch (error) {
      if (active.current && sequence === requestSequence.current && runtimeKey === getRuntimeKey()) setOverviewError({ purpose: id, code: error instanceof ModelConfigurationError ? error.code : 'request_failed' });
    } finally {
      if (active.current && sequence === requestSequence.current && runtimeKey === getRuntimeKey()) setTestingPurpose(null);
    }
  };
  const purpose = configuration?.purposes.find((candidate) => candidate.id === purposeId);
  const selectedConnection = configuration?.connections.find((connection) => connection.id === connectionId) ?? null;
  const tabs = [
    { id: 'overview', label: t('modelConfiguration.tab.overview') },
    { id: 'purposes', label: t('modelConfiguration.tab.purposes') },
    { id: 'connections', label: t('modelConfiguration.tab.connections') },
    { id: 'coverage', label: t('modelConfiguration.tab.coverage') },
  ];

  return <SettingsPageLayout title={t('modelConfiguration.title')} titleAccessory={<SettingsInfoHint>{t('modelConfiguration.description')}</SettingsInfoHint>} showSaveStatus headerEnd={configuration ? <Button variant="ghost" size="sm" disabled={pending} onClick={() => void load()}>{t('modelConfiguration.refresh')}</Button> : null}>
    <div className="mb-3">
      <SortableTabsStrip items={tabs} activeId={tab} onSelect={(id) => {
        if (id === 'overview' || id === 'purposes' || id === 'connections' || id === 'coverage') setTab(id);
      }} layoutMode="fit" variant="active-pill" pillSize="form" className="h-8 max-w-[36rem]" />
    </div>
    {loadState === 'loading' ? <p role="status" className={SETTINGS_HELPER_CLASS}>{t('common.loading')}</p> : null}
    {loadState === 'error' ? <div className="mb-3 space-y-3">
      <p role="alert" className="typography-meta text-[var(--status-error-text)]">{t(isVSCode ? 'modelConfiguration.unsupported' : 'modelConfiguration.readFailed')}</p>
      {!isVSCode ? <Button variant="outline" size="sm" onClick={() => void load()}>{t('modelConfiguration.retry')}</Button> : null}
    </div> : null}
    {configuration?.enterpriseMode ? <p className="mb-3 typography-meta text-[var(--status-warning-text)]">{t('modelConfiguration.enterprise')}</p> : null}
    {tab === 'overview' ? <ModelConfigurationOverview rows={overviewRows} pending={pending || loadState === 'loading'} testingPurpose={testingPurpose} onConfigure={(id) => { setPurpose(id); setTab('purposes'); }} onTest={(id) => void testFromOverview(id)} error={overviewError} /> : null}
    <div hidden={tab !== 'purposes'}>
      <div className="mb-3">
        <SettingsFieldRow label={t('modelConfiguration.purpose')}>
          <Select value={purposeId} onValueChange={(id) => {
            const match = Object.keys(MODEL_PURPOSE_LABELS).find((candidate) => candidate === id);
            if (match) {
              const target = configuration?.purposes.find((candidate) => candidate.id === match);
              if (target) setPurpose(target.id);
              else if (match === 'agent' || match === 'auxiliary') setPurpose(match);
            }
          }}>
            <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={t('modelConfiguration.purpose')}><SelectValue>{t(MODEL_PURPOSE_LABELS[purposeId])}</SelectValue></SelectTrigger>
            <SelectContent>{Object.entries(MODEL_PURPOSE_LABELS).map(([id, label]) => <SelectItem key={id} value={id} disabled={!configuration && id !== 'agent' && id !== 'auxiliary'}>{t(label)}</SelectItem>)}</SelectContent>
          </Select>
        </SettingsFieldRow>
      </div>
      {hasOpenedPurpose && (configuration && purpose ? <PurposeEditor key={purpose.id} configuration={configuration} purpose={purpose} pending={pending || loadState !== 'ready'} applyChange={applyChange} client={client} connectionSelection={connectionSelection} onConnectionSelected={() => setConnectionSelection(null)} addConnection={(preset, connection, probeDraft) => { setConnectionId(''); setConnectionPreset(preset ?? null); setConnectionTemplate(connection ?? null); setConnectionProbeDraft(probeDraft ?? null); setConnectionForPurpose(purpose.id); setTab('connections'); }} />
        : purposeId === 'agent' || purposeId === 'auxiliary' ? <DefaultsSettings modelPurpose={purposeId} /> : null)}
    </div>
    {tab === 'connections' && configuration ? <SettingsSection title={t('modelConfiguration.tab.connections')} settingsItem="models.connections" divider={false} className="space-y-3 pb-4" contentClassName="space-y-3">
      <SettingsFieldRow label={t('modelConfiguration.connection')}>
        <div className="flex flex-wrap gap-2">
          <Select value={connectionId} onValueChange={(id) => { setConnectionId(id); setConnectionPreset(null); setConnectionTemplate(null); setConnectionProbeDraft(null); }} disabled={pending}>
            <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={t('modelConfiguration.connection')}><SelectValue placeholder={t('modelConfiguration.addConnection')}>{selectedConnection?.name ?? t('modelConfiguration.addConnection')}</SelectValue></SelectTrigger>
            <SelectContent>{configuration.connections.map((connection) => <SelectItem key={connection.id} value={connection.id}>{connection.name}</SelectItem>)}</SelectContent>
          </Select>
          <Button variant="outline" size="sm" disabled={pending || configuration.enterpriseMode} onClick={() => { setConnectionId(''); setConnectionPreset(null); setConnectionTemplate(null); setConnectionProbeDraft(null); setConnectionForPurpose(null); }}>{t('modelConfiguration.addConnection')}</Button>
        </div>
      </SettingsFieldRow>
      <ModelConnectionEditor key={selectedConnection?.id ?? connectionPreset?.id ?? connectionTemplate?.id ?? 'new'} configuration={configuration} selected={selectedConnection} initialPreset={connectionPreset} initialConnection={connectionTemplate} initialDraft={connectionProbeDraft} pending={pending || loadState !== 'ready'} applyChange={applyChange} client={client} onSaved={(id, probeDraft) => {
        setConnectionProbeDraft(probeDraft ?? null);
        setConnectionId(id);
        const guide = useProductHelpGuidanceStore.getState().session;
        if (guide?.target === 'models' && guide.mode === 'guide') setConnectionForPurpose(null);
        else if (id && connectionForPurpose) {
          setPurpose(connectionForPurpose); setConnectionSelection({ purpose: connectionForPurpose, connectionId: id });
          setConnectionForPurpose(null); setTab('purposes');
        }
      }} />
    </SettingsSection> : null}
    {tab === 'coverage' ? <SettingsSection title={t('modelConfiguration.tab.coverage')} info={t('modelConfiguration.coverageHint')} settingsItem="models.coverage" divider={false} contentClassName="space-y-3">
      {BUNDLED_SKILL_IDS.map((skill) => <SettingsFieldRow key={skill} label={skill}>
        <div className="space-y-1 typography-meta text-muted-foreground">
          <p>{configuration ? configuration.purposes.filter((candidate) => candidate.consumerIds.includes(skill)).map((candidate) => t(MODEL_PURPOSE_LABELS[candidate.id])).join(', ') : t('modelConfiguration.unsupported')}</p>
          {skill === 'image-to-editable-pptx' ? <p>{t('modelConfiguration.coverageEditableMissing')}</p>
            : !['superppt', 'ai-image-to-ppt', 'supervideo', 'superwriter'].includes(skill) ? <p>{t('modelConfiguration.coverageInherited')}</p> : null}
        </div>
      </SettingsFieldRow>)}
    </SettingsSection> : null}
  </SettingsPageLayout>;
};
