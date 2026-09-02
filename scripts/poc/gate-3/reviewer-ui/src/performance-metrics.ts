import type { ReviewPerformanceSnapshot } from '../../review-contract';

export type ReviewInteractionName = ReviewPerformanceSnapshot['interactions'][number]['name'];

let reviewStartedAt: number | null = null;
let progressVisibleMs = 0;
let firstPageMs = 0;
let interactionSequence = 0;
let interactions: ReviewPerformanceSnapshot['interactions'] = [];
let progressMeasurement: Promise<number | null> | null = null;
let firstPageMeasurement: Promise<number | null> | null = null;
let metricsGeneration = 0;

export function percentile(values: number[], p: 0.5 | 0.95): number {
  const finiteValues = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (finiteValues.length === 0) return 0;
  const rank = Math.max(1, Math.ceil(p * finiteValues.length));
  return finiteValues[rank - 1] ?? 0;
}

export function resetMetrics(): void {
  metricsGeneration += 1;
  reviewStartedAt = null;
  progressVisibleMs = 0;
  firstPageMs = 0;
  interactionSequence = 0;
  interactions = [];
  progressMeasurement = null;
  firstPageMeasurement = null;
}

export function markReviewStarted(): void {
  reviewStartedAt = performance.now();
  performance.mark('review:start');
}

export function markProgressVisible(): Promise<number | null> {
  if (progressMeasurement) return progressMeasurement;
  progressMeasurement = measurePaintMilestone('progress-visible', (durationMs) => {
    progressVisibleMs = durationMs;
  });
  return progressMeasurement;
}

export function markFirstPagePainted(): Promise<number | null> {
  if (firstPageMeasurement) return firstPageMeasurement;
  firstPageMeasurement = measurePaintMilestone('first-page', (durationMs) => {
    firstPageMs = durationMs;
  });
  return firstPageMeasurement;
}

export function sampleInteraction(name: ReviewInteractionName): Promise<number | null> {
  const generation = metricsGeneration;
  const sequence = interactionSequence += 1;
  const startedAt = performance.now();
  performance.mark(`review:interaction:${name}:${sequence}:start`);

  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (generation !== metricsGeneration) {
          resolve(null);
          return;
        }
        performance.mark(`review:interaction:${name}:${sequence}:paint`);
        const durationMs = finiteDuration(performance.now() - startedAt);
        interactions.push({ name, durationMs });
        resolve(durationMs);
      });
    });
  });
}

export function snapshotMetrics(): ReviewPerformanceSnapshot {
  return {
    progressVisibleMs,
    firstPageMs,
    interactions: interactions.map(({ name, durationMs }) => ({ name, durationMs }))
  };
}

function finiteDuration(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function measurePaintMilestone(
  name: 'progress-visible' | 'first-page',
  record: (durationMs: number) => void
): Promise<number | null> {
  const generation = metricsGeneration;
  performance.mark(`review:${name}:start`);
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (generation !== metricsGeneration) {
          resolve(null);
          return;
        }
        performance.mark(`review:${name}:paint`);
        const durationMs = reviewStartedAt === null
          ? 0
          : finiteDuration(performance.now() - reviewStartedAt);
        record(durationMs);
        resolve(durationMs);
      });
    });
  });
}
