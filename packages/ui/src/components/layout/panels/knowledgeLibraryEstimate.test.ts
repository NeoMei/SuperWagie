import { describe, expect, test } from 'bun:test';

import { estimateDisplay, type KnowledgeLibraryEstimate } from './knowledgeLibraryEstimate';

const estimate = (overrides: Partial<KnowledgeLibraryEstimate> = {}): KnowledgeLibraryEstimate => ({
  tokensMin: 500_000,
  tokensMax: 2_000_000,
  secondsMin: 90,
  secondsMax: 3_600,
  imageHeavyFiles: 0,
  ...overrides,
});

describe('knowledge library estimate display', () => {
  test('formats token, price and duration ranges', () => {
    const zh = estimateDisplay(estimate(), 'zh-CN');
    expect(zh.tokensMin).toContain('50');
    expect(zh.tokensMax).toContain('200');
    expect(zh.costMin).toContain('0.25');
    expect(zh.costMax).toContain('10');
    expect(zh.duration).toEqual({ unit: 'hours', min: 1, max: 1 });
  });

  test('uses compact duration buckets at the boundaries', () => {
    expect(estimateDisplay(estimate({ secondsMin: 0, secondsMax: 59 }), 'en').duration).toEqual({ unit: 'underMinute' });
    expect(estimateDisplay(estimate({ secondsMin: 60, secondsMax: 600 }), 'en').duration).toEqual({ unit: 'minutes', min: 1, max: 10 });
    expect(estimateDisplay(estimate({ secondsMin: 7_200, secondsMax: 86_400 }), 'en').duration).toEqual({ unit: 'days', min: 1, max: 1 });
  });

  test('prints zero usage as zero cost', () => {
    const display = estimateDisplay(estimate({ tokensMin: 0, tokensMax: 0, secondsMin: 0, secondsMax: 0 }), 'en');
    expect(display.costMin).toContain('0');
    expect(display.costMax).toContain('0');
    expect(display.duration).toEqual({ unit: 'underMinute' });
  });
});
