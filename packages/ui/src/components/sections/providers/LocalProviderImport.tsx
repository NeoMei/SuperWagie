import React from 'react';
import { SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useRuntimeInstance } from '@/hooks/useRuntimeInstance';
import { useI18n } from '@/lib/i18n';
import { CustomProviderModelDiscovery } from './CustomProviderModelDiscovery';
import type { CustomProviderFormState } from './custom-provider-form';
import { LOCAL_PROVIDER_IMPORT_MAX_BYTES, mergeImportedProviderModels, readLocalProviderConfig } from './local-provider-import';

type Props = {
  form: CustomProviderFormState;
  busy: boolean;
  onApply: (form: CustomProviderFormState) => void;
};

export const LocalProviderImport: React.FC<Props> = ({ form, busy, onApply }) => {
  const { t } = useI18n();
  const runtime = useRuntimeInstance();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const request = React.useRef(0);
  const [imported, setImported] = React.useState<{
    isCurrent: () => boolean;
    preview: ReturnType<typeof readLocalProviderConfig>;
  } | null>(null);
  const [providerIndex, setProviderIndex] = React.useState('0');
  const [fileError, setFileError] = React.useState(false);

  React.useEffect(() => {
    setImported(null);
    setFileError(false);
    return () => { request.current += 1; };
  }, [runtime]);

  async function readFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    const generation = ++request.current;
    setImported(null);
    setFileError(false);
    setProviderIndex('0');
    try {
      if (file.size > LOCAL_PROVIDER_IMPORT_MAX_BYTES) throw new Error('File exceeds import size limit');
      const parsed = readLocalProviderConfig(await file.text());
      if (request.current === generation && runtime()) setImported({ preview: parsed, isCurrent: runtime });
    } catch {
      if (request.current === generation && runtime()) setFileError(true);
    }
  }

  const preview = imported?.isCurrent() ? imported.preview : null;
  const source = preview?.providers[Number(providerIndex)];
  const compatible = source && mergeImportedProviderModels(form, source) !== null;
  const existingIds = new Set(form.models.map((item) => item.id.trim()).filter(Boolean));
  return (
    <>
      <input ref={inputRef} type="file" accept=".json,.jsonc,application/json" hidden onChange={(event) => void readFile(event)} />
      <Button type="button" variant="outline" size="xs" className="!font-normal" disabled={busy}
        onClick={() => inputRef.current?.click()}>
        {t('settings.providers.page.custom.localImport.open')}
      </Button>
      {fileError ? <p role="alert" className={SETTINGS_HELPER_CLASS}>{t('settings.providers.page.custom.localImport.fileError')}</p> : null}
      {preview && (
        <div className="basis-full min-w-0 space-y-2">
          <p className={SETTINGS_HELPER_CLASS}>{t('settings.providers.page.custom.localImport.info')}</p>
          {preview.skipped > 0 ? <p className={SETTINGS_HELPER_CLASS}>{t('settings.providers.page.custom.localImport.skipped', { count: preview.skipped })}</p> : null}
          {source ? (
            <>
              {preview.providers.length > 1 ? (
                <Select value={providerIndex} onValueChange={setProviderIndex}>
                  <SelectTrigger className="h-8" aria-label={t('settings.providers.page.custom.localImport.provider')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {preview.providers.map((item, index) => (
                      <SelectItem key={index} value={String(index)}>{item.name} · {item.providerID}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
              <p className={SETTINGS_HELPER_CLASS}>{source.name} · {source.baseURL}</p>
              {compatible ? (
                <CustomProviderModelDiscovery
                  key={providerIndex}
                  models={source.models.map((item) => ({
                    id: item.id, name: item.name,
                    limit: { context: Number(item.contextWindow) || undefined, output: Number(item.maxOutputTokens) || undefined },
                  }))}
                  existingIds={existingIds}
                  onAdd={(selected) => {
                    if (busy || !imported?.isCurrent()) return;
                    const ids = new Set(selected.map((item) => item.id));
                    const result = mergeImportedProviderModels(form, { ...source, models: source.models.filter((item) => ids.has(item.id)) });
                    if (!result) return;
                    onApply(result);
                    setImported(null);
                  }}
                  onCancel={() => setImported(null)}
                />
              ) : <p role="status" className={SETTINGS_HELPER_CLASS}>{t('settings.providers.page.custom.localImport.mismatch')}</p>}
            </>
          ) : <p role="status" className={SETTINGS_HELPER_CLASS}>{t('settings.providers.page.custom.localImport.empty')}</p>}
        </div>
      )}
    </>
  );
};
