import type { I18nKey, useI18n } from '@/lib/i18n';
import type { ModelConfiguration, ModelPreset } from '@/lib/modelConfiguration';

export type ModelPurposeId = ModelConfiguration['purposes'][number]['id'];
export type ModelOriginFilter = 'all' | 'china' | 'international' | 'local';

export const MODEL_PURPOSE_LABELS = {
  agent: 'modelConfiguration.purpose.agent',
  auxiliary: 'modelConfiguration.purpose.auxiliary',
  ocr: 'modelConfiguration.purpose.ocr',
  vision: 'modelConfiguration.purpose.vision',
  embedding: 'modelConfiguration.purpose.embedding',
  rerank: 'modelConfiguration.purpose.rerank',
  'stt-short': 'modelConfiguration.purpose.stt-short',
  'stt-realtime': 'modelConfiguration.purpose.stt-realtime',
  'stt-file': 'modelConfiguration.purpose.stt-file',
  tts: 'modelConfiguration.purpose.tts',
  'image-generation': 'modelConfiguration.purpose.image-generation',
  'image-editing': 'modelConfiguration.purpose.image-editing',
  routing: 'modelConfiguration.purpose.routing',
  'multimodal-embedding': 'modelConfiguration.purpose.multimodal-embedding',
  'video-generation': 'modelConfiguration.purpose.video-generation',
} as const satisfies Record<ModelPurposeId, I18nKey>;

export const BUNDLED_SKILL_IDS = [
  'superppt', 'ai-image-to-ppt', 'image-to-editable-pptx', 'managed-image-edit', 'supervideo',
  'superwriter', 'WPSComposer', 'superweb', 'obsidian-excalidraw',
  'grilling', 'grill-me', 'grill-with-docs', 'to-spec', 'domain-modeling',
] as const;

/** Changing the browse filter never replaces a purpose's chosen model. */
export function visibleModelPresets(
  presets: ModelPreset[],
  purpose: ModelPurposeId,
  origin: ModelOriginFilter,
  selectedId: string,
): ModelPreset[] {
  const candidates = presets.filter((preset) => preset.purposes.includes(purpose));
  const visible = candidates.filter((preset) => origin === 'all' || preset.origin === origin);
  const selected = candidates.find((preset) => preset.id === selectedId);
  if (selected && !visible.some((preset) => preset.id === selected.id)) return [selected, ...visible];
  return visible;
}

export function isLocalModelEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && (url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname));
  } catch { return false; }
}

export function configurationErrorMessage(code: string, t: ReturnType<typeof useI18n>['t']): string {
  if (code === 'model_configuration_replacement_key_required') return t('modelConfiguration.replacementKey');
  if (code === 'model_configuration_credential_changed') return t('modelConfiguration.revisionConflict');
  if (code === 'model_configuration_revision_conflict') return t('modelConfiguration.revisionConflict');
  if (code === 'model_configuration_credential_destination_denied') return t('modelConfiguration.sourceDestination');
  if (code === 'model_configuration_credential_missing' || code === 'model_configuration_credential_unavailable') return t('modelConfiguration.sourceUnavailable');
  return t('modelConfiguration.writeFailed', { code });
}
