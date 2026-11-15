import { create } from 'zustand';
import { useI18n, useI18nStore, type Locale } from '@/lib/i18n';
import { copy as enCopy } from './copy/en';
import type { EasterEggCopy } from './copy/types';

const LOADERS = {
  'zh-CN': () => import('./copy/zh-CN'),
} satisfies Record<Exclude<Locale, 'en'>, () => Promise<{ copy: EasterEggCopy }>>;

const useCopyStore = create<{ byLocale: Partial<Record<Locale, EasterEggCopy>> }>(() => ({ byLocale: { en: enCopy } }));
const requested = new Set<Locale>(['en']);
const request = (locale: Locale) => {
  if (locale === 'en' || requested.has(locale)) return;
  requested.add(locale);
  LOADERS[locale]()
    .then(({ copy }) => useCopyStore.setState((state) => ({ byLocale: { ...state.byLocale, [locale]: copy } })))
    .catch(() => requested.delete(locale));
};
request(useI18nStore.getState().locale);
useI18nStore.subscribe((state) => request(state.locale));

/** No cross-language fallback while the current locale's lines load. */
export function useEasterEggCopy(): EasterEggCopy | null {
  const { locale } = useI18n();
  return useCopyStore((state) => state.byLocale[locale] ?? null);
}
