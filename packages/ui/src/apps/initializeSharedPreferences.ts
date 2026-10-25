import { startAppearanceAutoSave } from '@/lib/appearanceAutoSave';
import { initializeLocale } from '@/lib/i18n';
import { startModelPrefsAutoSave } from '@/lib/modelPrefsAutoSave';
import { initializeAppearancePreferences } from '@/lib/persistence';
import { startTypographyWatcher } from '@/lib/typographyWatcher';

type InitializeSharedPreferencesOptions = {
  /** Console prefix for init failures, for example `[vscode-main]`. */
  logLabel: string;
  /** Runs once appearance init settles, whether it succeeded or failed. */
  onAppearanceSettled?: () => void;
};

/** Boots local appearance and autosave; authenticated roots own workspace reads. */
export const initializeSharedPreferences = ({
  logLabel,
  onAppearanceSettled,
}: InitializeSharedPreferencesOptions): void => {
  initializeLocale();

  void initializeAppearancePreferences().then(() => {
    startAppearanceAutoSave();
    startModelPrefsAutoSave();
    startTypographyWatcher();
  }).catch((err) => {
    console.error(`${logLabel} appearance init failed:`, err);
  }).finally(() => {
    onAppearanceSettled?.();
  });
};
