import type { DesktopSettings } from '@/lib/desktop';
import type { Locale } from '@/lib/i18n';
import type { ThemeMode } from '@/types/theme';
import { productHelpOperationSchema } from './client';

type OperationSettings = Pick<DesktopSettings, 'locale' | 'themeId' | 'themeVariant' | 'useSystemTheme' | 'lightThemeId' | 'darkThemeId'>;
export type ProductHelpOperationResult = 'completed' | 'failed' | 'unsupported';
export type ProductHelpOperationDependencies = {
  isCurrent: () => boolean;
  isSupported: () => boolean;
  theme: { lightThemeId: string; darkThemeId: string; systemVariant: 'light' | 'dark' };
  save: (patch: OperationSettings) => Promise<{ ok: boolean }>;
  read: () => Promise<OperationSettings | null>;
  applyLanguage: (locale: Locale) => void;
  applyTheme: (mode: ThemeMode) => void;
};

/** Only registered settings operations can reach persistence, even from an untyped caller. */
export async function runProductHelpOperation(operation: string, dependencies: ProductHelpOperationDependencies): Promise<ProductHelpOperationResult> {
  const parsed = productHelpOperationSchema.safeParse(operation);
  if (!parsed.success || !dependencies.isSupported()) return 'unsupported';
  if (!dependencies.isCurrent()) return 'failed';
  const language = parsed.data === 'language-en' ? 'en' : parsed.data === 'language-zh-CN' ? 'zh-CN' : null;
  const mode = parsed.data === 'theme-dark' ? 'dark' : parsed.data === 'theme-light' ? 'light' : 'system';
  const variant = mode === 'system' ? dependencies.theme.systemVariant : mode;
  const patch: OperationSettings = language ? { locale: language } : {
    themeId: variant === 'dark' ? dependencies.theme.darkThemeId : dependencies.theme.lightThemeId,
    themeVariant: variant,
    useSystemTheme: mode === 'system',
    lightThemeId: dependencies.theme.lightThemeId,
    darkThemeId: dependencies.theme.darkThemeId,
  };
  try {
    const result = await dependencies.save(patch);
    if (!result.ok || !dependencies.isCurrent()) return 'failed';
    const saved = await dependencies.read();
    if (!saved || !dependencies.isCurrent()) return 'failed';
    if (language) {
      if (saved.locale !== language) return 'failed';
      dependencies.applyLanguage(language);
    } else {
      if (saved.useSystemTheme !== patch.useSystemTheme || saved.themeVariant !== variant || saved.themeId !== patch.themeId) return 'failed';
      dependencies.applyTheme(mode);
    }
    return 'completed';
  } catch {
    return 'failed';
  }
}
