export type Locale = 'en' | 'zh-CN';

export const LOCALES = ['en', 'zh-CN'] as const satisfies readonly Locale[];

export const DEFAULT_LOCALE: Locale = 'zh-CN';

export type LayoutDirection = 'ltr' | 'rtl';

/** Both supported interface languages use left-to-right layout. */
export function getLocaleDirection(_locale: Locale): LayoutDirection {
  return 'ltr';
}

/**
 * The window edge where a line of the layout starts. OS window controls stay on
 * their physical edge in every language, so window chrome maps them through this.
 */
export function getInlineStartSide(direction: LayoutDirection): 'left' | 'right' {
  return direction === 'rtl' ? 'right' : 'left';
}

/**
 * Whether an element lays out right to left: the nearest explicit `dir`
 * decides (the document root carries the UI direction). Read from the
 * attribute because `matches(':dir(rtl)')` throws on WebKit before 16.4.
 */
export function isRightToLeft(element: Element): boolean {
  return element.closest('[dir="rtl"], [dir="ltr"]')?.getAttribute('dir') === 'rtl';
}

export const LOCALE_LABEL_KEYS: Record<Locale, 'common.language.english' | 'common.language.simplifiedChinese'> = {
  en: 'common.language.english',
  'zh-CN': 'common.language.simplifiedChinese',
};

export const LOCALE_STORAGE_KEY = 'openchamber.i18n.v1';

type StoredLocale = {
  locale?: unknown;
};

export function normalizeLocale(value: string | undefined | null): Locale {
  if (!value) {
    return DEFAULT_LOCALE;
  }

  const normalized = value.toLowerCase().replace(/_/g, '-');
  if (normalized.startsWith('zh')) {
    return 'zh-CN';
  }
  if (normalized.startsWith('en')) {
    return 'en';
  }
  return DEFAULT_LOCALE;
}

function readStoredLocale(): Locale | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }

  try {
    const raw = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (!raw) {
      return undefined;
    }
    const parsed = JSON.parse(raw) as StoredLocale;
    return typeof parsed.locale === 'string' ? normalizeLocale(parsed.locale) : undefined;
  } catch {
    return undefined;
  }
}

export function writeStoredLocale(locale: Locale): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, JSON.stringify({ locale: normalizeLocale(locale) }));
  } catch {
    return;
  }
}

declare global {
  interface Window {
    /** The host application's display language (VS Code sets it), used before the user picks a locale. */
    __OPENCHAMBER_HOST_LANGUAGE__?: string;
  }
}

export function detectInitialLocale(): Locale {
  const stored = readStoredLocale();
  if (stored) {
    return stored;
  }

  const hostLanguage = globalThis.window?.__OPENCHAMBER_HOST_LANGUAGE__;
  if (hostLanguage) {
    return normalizeLocale(hostLanguage);
  }

  return DEFAULT_LOCALE;
}
