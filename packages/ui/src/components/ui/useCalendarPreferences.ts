import * as React from 'react';
import { z } from 'zod';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';

const WEEKDAY_INDEXES = [0, 1, 2, 3, 4, 5, 6] as const;

const getWeekStartsOn = (locale: string): number => {
  try {
    const info = z.object({ weekInfo: z.object({ firstDay: z.number() }).optional() }).safeParse(new Intl.Locale(locale));
    const firstDayRaw = info.success ? info.data.weekInfo?.firstDay : undefined;
    if (firstDayRaw === undefined) return 1;
    return firstDayRaw % 7;
  } catch {
    return 1;
  }
};

const getUses24Hour = (locale: string): boolean => {
  try {
    const options = new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions();
    if (options.hour12 !== undefined) {
      return !options.hour12;
    }
    return options.hourCycle === 'h23' || options.hourCycle === 'h24';
  } catch {
    return true;
  }
};

const getLocalizedWeekdayLabels = (locale: string): string[] => {
  const formatter = new Intl.DateTimeFormat(locale, { weekday: 'short' });
  const sundayBase = new Date(2023, 0, 1);
  return WEEKDAY_INDEXES.map((offset) => formatter.format(new Date(sundayBase.getFullYear(), sundayBase.getMonth(), sundayBase.getDate() + offset)));
};

const rotateWeekdays = <T,>(items: T[], weekStartsOn: number): T[] => {
  return [...items.slice(weekStartsOn), ...items.slice(0, weekStartsOn)];
};

/**
 * The user's calendar: 12 or 24 hours and the first day of the week, from
 * Settings or else the locale, with the weekday names in that order.
 */
export function useCalendarPreferences() {
  const { locale } = useI18n();
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const weekStartPreference = useUIStore((state) => state.weekStartPreference);
  return React.useMemo(() => {
    const use24Hour = timeFormatPreference === '24h' ? true : timeFormatPreference === '12h' ? false : getUses24Hour(locale);
    const weekStartsOn = weekStartPreference === 'sunday' ? 0 : weekStartPreference === 'monday' ? 1 : getWeekStartsOn(locale);
    const labels = getLocalizedWeekdayLabels(locale);
    const weekdays = rotateWeekdays(WEEKDAY_INDEXES.map((value) => ({ value, label: labels[value] || '' })), weekStartsOn);
    return { locale, use24Hour, weekStartsOn, weekdays };
  }, [locale, timeFormatPreference, weekStartPreference]);
}
