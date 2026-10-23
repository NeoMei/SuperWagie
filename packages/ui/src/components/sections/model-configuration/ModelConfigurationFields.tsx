import React from 'react';
import { useI18n, type I18nKey } from '@/lib/i18n';
import type { ModelPreset } from '@/lib/modelConfiguration';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SettingsFieldRow, SETTINGS_HELPER_CLASS, SETTINGS_SELECT_ROW_TRIGGER_CLASS } from '@/components/sections/shared/SettingsSection';

const PRESET_NOTE_LABELS = {
  'preserve-existing-index': 'modelConfiguration.note.preserve-existing-index',
  'openai-tts-retirement': 'modelConfiguration.note.openai-tts-retirement',
  'reference-edit-not-mask': 'modelConfiguration.note.reference-edit-not-mask',
  'buffered-dictation': 'modelConfiguration.note.buffered-dictation',
  'editable-ppt-excluded': 'modelConfiguration.note.editable-ppt-excluded',
} as const satisfies Record<ModelPreset['noteCodes'][number], I18nKey>;

export const ModelPresetDetails: React.FC<{ preset: ModelPreset }> = ({ preset }) => {
  const { t } = useI18n();
  const state = preset.status === 'compatible' ? 'modelConfiguration.compatible'
    : preset.status === 'planned' ? 'modelConfiguration.planned' : 'modelConfiguration.adapter';
  return <div className="space-y-1.5">
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 typography-meta text-muted-foreground">
      <span>{t(state)}</span>
      <span className="break-all" dir="ltr">{preset.model}</span>
      <a className="text-primary underline-offset-4 hover:underline" href={preset.docsUrl} target="_blank" rel="noreferrer">{t('modelConfiguration.docs')}</a>
      <a className="text-primary underline-offset-4 hover:underline" href={preset.keyUrl} target="_blank" rel="noreferrer">{t('modelConfiguration.getKey')}</a>
    </div>
    {(preset.noteCodes ?? []).map((code) => <p key={code} className="typography-meta text-[var(--status-warning-text)]">{t(PRESET_NOTE_LABELS[code])}</p>)}
    <p className={SETTINGS_HELPER_CLASS}>{t('modelConfiguration.reviewedAt', { date: preset.reviewedAt })}</p>
  </div>;
};

export const ModelPresetPicker: React.FC<{
  presets: ModelPreset[]; value: string; onChange: (preset: ModelPreset) => void;
}> = ({ presets, value, onChange }) => {
  const { t } = useI18n();
  return <SettingsFieldRow label={t('modelConfiguration.recommendation')}>
    <Select value={value} onValueChange={(id) => {
      const preset = presets.find((candidate) => candidate.id === id);
      if (preset) onChange(preset);
    }}>
      <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={t('modelConfiguration.recommendation')}>
        <SelectValue placeholder={t('modelConfiguration.recommendation')}>{presets.find((preset) => preset.id === value)?.name ?? t('modelConfiguration.recommendation')}</SelectValue>
      </SelectTrigger>
      <SelectContent>{presets.map((preset) => <SelectItem key={preset.id} value={preset.id}>{preset.name}</SelectItem>)}</SelectContent>
    </Select>
  </SettingsFieldRow>;
};
