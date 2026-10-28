import type { KnowledgeLibraryPreview } from '@/lib/knowledgeLibrary';

export type KnowledgeLibraryEstimate = NonNullable<KnowledgeLibraryPreview['estimate']>;

export type EstimateDuration =
  | { unit: 'underMinute' }
  | { unit: 'minutes'; min: number; max: number }
  | { unit: 'hours'; min: number; max: number }
  | { unit: 'days'; min: number; max: number };

const COST_RANGE = {
  'zh-CN': { currency: 'CNY', lowPerMillion: 0.5, highPerMillion: 5 },
  en: { currency: 'USD', lowPerMillion: 0.07, highPerMillion: 0.7 },
} as const;

const durationRange = (secondsMin: number, secondsMax: number): EstimateDuration => {
  const max = Math.max(0, Math.ceil(secondsMax));
  if (max < 60) return { unit: 'underMinute' };
  if (max < 3_600) return {
    unit: 'minutes',
    min: Math.max(1, Math.round(secondsMin / 60)),
    max: Math.max(1, Math.round(max / 60)),
  };
  if (max < 86_400) return {
    unit: 'hours',
    min: Math.max(1, Math.round(secondsMin / 3_600)),
    max: Math.max(1, Math.round(max / 3_600)),
  };
  return {
    unit: 'days',
    min: Math.max(1, Math.round(secondsMin / 86_400)),
    max: Math.max(1, Math.round(max / 86_400)),
  };
};

const currency = (value: number, locale: 'zh-CN' | 'en', code: 'CNY' | 'USD'): string => {
  const fractionDigits = value < 0.01 ? 3 : value < 1 ? 2 : 2;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: code,
    minimumFractionDigits: 0,
    maximumFractionDigits: fractionDigits,
  }).format(value);
};

/** Display values only; the provider invoice remains the source of truth. */
export const estimateDisplay = (estimate: KnowledgeLibraryEstimate, locale: 'zh-CN' | 'en') => {
  const compact = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 });
  const price = COST_RANGE[locale];
  const costMin = estimate.tokensMin * price.lowPerMillion / 1_000_000;
  const costMax = estimate.tokensMax * price.highPerMillion / 1_000_000;
  return {
    tokensMin: compact.format(estimate.tokensMin),
    tokensMax: compact.format(estimate.tokensMax),
    costMin: currency(costMin, locale, price.currency),
    costMax: currency(Math.max(costMin, costMax), locale, price.currency),
    duration: durationRange(estimate.secondsMin, estimate.secondsMax),
  };
};
