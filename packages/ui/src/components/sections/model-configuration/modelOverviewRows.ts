import type { KnowledgeLibraryModelConfiguration } from '@/lib/knowledgeLibrary';
import type { ModelBinding, ModelConfiguration, ModelPurpose, ModelPurposeId } from '@/lib/modelConfiguration';
import type { RoutingState } from '@/lib/routing/routingApi';

import { isLocalModelEndpoint, MODEL_PURPOSE_LABELS } from './modelConfigurationView';

export type ModelOverviewRow = {
  purpose: ModelPurposeId;
  required: boolean;
  model: string | null;
  connectionName?: string;
  configuration: 'missing' | 'configured' | 'inherited' | 'local' | 'native' | 'planned' | 'unknown';
  test: 'untested' | 'verified' | 'failed' | 'component' | 'unsupported' | 'blocked' | 'unknown';
  testedAt?: string;
  errorCode?: string;
  reason?: 'credentials' | 'policy' | 'adapter' | 'runtime' | 'component' | 'managedUnavailable';
  canTest: boolean;
  canConfigure: boolean;
};

export type ModelOverviewInputs = {
  knowledge: { status: 'loading' | 'failed' } | { status: 'ready'; configuration: KnowledgeLibraryModelConfiguration };
  routing: { status: 'loading' | 'failed' } | { status: 'ready'; configuration: RoutingState };
  native: { status: 'loading' | 'failed' } | {
    status: 'ready';
    defaultModel?: string;
    smallModelUseDefault: boolean;
    smallModelOverride?: string;
  };
  voice: {
    tts: { provider: 'browser' | 'local' | 'openai' | 'openai-compatible' | 'say'; model?: string };
    stt: { provider: 'local' | 'openai-compatible'; model?: string };
  };
  runtime: 'available' | 'unsupported';
};

const knowledgePurposes = new Set<ModelPurposeId>(['ocr', 'vision', 'embedding', 'rerank']);
const presentModel = (value: string | undefined): string | null => value?.trim() || null;

function nativeRow(row: ModelOverviewRow, input: ModelOverviewInputs['native']): ModelOverviewRow {
  if (input.status !== 'ready') return row;
  const model = row.purpose === 'agent' ? presentModel(input.defaultModel)
    : input.smallModelUseDefault ? null : presentModel(input.smallModelOverride);
  return { ...row, model, configuration: model ? 'native' : 'inherited', test: 'component', reason: 'component' };
}

function inheritedRow(row: ModelOverviewRow, inputs: ModelOverviewInputs): ModelOverviewRow {
  if (knowledgePurposes.has(row.purpose)) {
    const input = inputs.knowledge;
    if (input.status !== 'ready' || input.configuration.status !== 'available') return row;
    const projection = input.configuration;
    if (projection.unavailablePurposes?.some((purpose) => purpose === row.purpose)) return row;
    const model = projection.models.find((entry) => entry.purpose === row.purpose);
    if (!model) return { ...row, configuration: 'missing', test: 'untested', reason: undefined };
    return { ...row, model: model.model, configuration: 'inherited', test: 'component', reason: 'component' };
  }
  if (row.purpose === 'tts' || row.purpose === 'stt-realtime') {
    const selection = row.purpose === 'tts' ? inputs.voice.tts : inputs.voice.stt;
    const local = selection.provider === 'local' || selection.provider === 'browser' || selection.provider === 'say';
    const model = presentModel(selection.model);
    if (local) return { ...row, model, configuration: 'local', test: 'component', reason: 'component' };
    return { ...row, model, configuration: model ? 'inherited' : 'missing', test: model ? 'component' : 'untested', reason: model ? 'component' : undefined };
  }
  return { ...row, configuration: 'missing', test: 'untested', reason: undefined };
}

function configuredRow(row: ModelOverviewRow, configuration: ModelConfiguration, purpose: ModelPurpose, binding: ModelBinding): ModelOverviewRow {
  const connection = configuration.connections.find((candidate) => candidate.id === binding.connectionId);
  const configured: ModelOverviewRow = { ...row, model: binding.model, configuration: 'configured', reason: undefined };
  if (!connection) return { ...configured, test: 'unknown', reason: 'runtime' };
  configured.connectionName = connection.name;
  if (connection.protocol === 'managed-media' && ['tts', 'stt-short', 'image-generation'].includes(row.purpose)) {
    return { ...configured, test: 'unsupported', reason: 'managedUnavailable' };
  }
  const local = isLocalModelEndpoint(connection.baseUrl);
  if (configuration.enterpriseMode && !local) return { ...configured, test: 'blocked', reason: 'policy' };
  if (!connection.hasApiKey && connection.credentialSource) {
    const unknown = configuration.credentialSources.status !== 'available';
    return { ...configured, configuration: unknown ? 'configured' : 'missing', test: unknown ? 'unknown' : 'untested', reason: 'credentials', errorCode: unknown ? 'model_configuration_credential_unavailable' : 'model_configuration_credential_missing' };
  }
  const preset = binding.presetId ? configuration.presets.find((candidate) => candidate.id === binding.presetId) : undefined;
  if (binding.presetId && (!preset || preset.status !== 'compatible')) {
    return { ...configured, test: 'unsupported', reason: 'adapter' };
  }
  const canTest = Boolean(purpose.probeProtocols?.includes(connection.protocol));
  if (!canTest) return { ...configured, test: 'component', reason: 'component' };
  return { ...configured, test: binding.verification.status, testedAt: binding.verification.testedAt, errorCode: binding.verification.errorCode, canTest };
}

function routingRow(row: ModelOverviewRow, configuration: ModelConfiguration, purpose: ModelPurpose, binding: ModelBinding | undefined, input: ModelOverviewInputs['routing']): ModelOverviewRow {
  if (input.status !== 'ready' || !input.configuration.available) return row;
  const state = input.configuration;
  const effective = state.classifier?.effective;
  if (state.enterpriseMode && !state.customEndpoint?.pinned) {
    return { ...row, configuration: binding ? 'configured' : 'missing', model: binding?.model ?? null, test: 'blocked', reason: 'policy' };
  }
  if (effective && effective !== 'off') {
    const inherited: ModelOverviewRow = {
      ...row, configuration: 'inherited', test: 'component', reason: 'component', connectionName: effective,
      model: effective === 'custom' ? state.customEndpoint?.model ?? null : null,
    };
    if (effective !== 'custom' || state.customEndpoint?.pinned || !binding) return inherited;
    const connection = configuration.connections.find((candidate) => candidate.id === binding.connectionId);
    if (state.customEndpoint?.model !== binding.model || state.customEndpoint.url !== connection?.baseUrl) return inherited;
    return configuredRow(row, configuration, purpose, binding);
  }
  if (!state.classifier && state.jevAvailable) {
    return { ...row, configuration: 'inherited', test: 'component', reason: 'component', connectionName: state.jevSource };
  }
  if (binding && !state.customEndpoint?.pinned) return { ...row, configuration: 'configured', model: binding.model };
  return { ...row, configuration: 'missing', test: 'untested', reason: undefined };
}

/** Projects current public snapshots without treating read failures or saves as health checks. */
export function buildModelOverviewRows(configuration: ModelConfiguration | null, inputs: ModelOverviewInputs): ModelOverviewRow[] {
  const purposeIds = Object.keys(MODEL_PURPOSE_LABELS).filter((id): id is ModelPurposeId => id in MODEL_PURPOSE_LABELS);
  return purposeIds.map((id) => {
    const purpose = configuration?.purposes.find((candidate) => candidate.id === id);
    const row: ModelOverviewRow = {
      purpose: id,
      required: purpose?.required ?? id === 'agent',
      model: null,
      configuration: 'unknown',
      test: 'unknown',
      reason: 'runtime',
      canTest: false,
      canConfigure: id === 'agent' || id === 'auxiliary' || Boolean(configuration && purpose && purpose.status !== 'planned' && inputs.runtime === 'available'),
    };
    if (id === 'agent' || id === 'auxiliary') return nativeRow(row, inputs.native);
    if (inputs.runtime === 'unsupported' || !configuration || !purpose) return row;
    const binding = configuration.bindings.find((candidate) => candidate.purpose === id);
    if (purpose.status === 'planned') return { ...row, model: binding?.model ?? null, configuration: 'planned', test: 'unsupported', reason: 'adapter' };
    if (id === 'routing') return routingRow(row, configuration, purpose, binding, inputs.routing);
    return binding ? configuredRow(row, configuration, purpose, binding) : inheritedRow(row, inputs);
  });
}
