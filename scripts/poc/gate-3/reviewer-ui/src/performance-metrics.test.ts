import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  markFirstPagePainted,
  markProgressVisible,
  markReviewStarted,
  percentile,
  resetMetrics,
  sampleInteraction,
  snapshotMetrics
} from './performance-metrics';
import { recordClosingMetrics, recordCompletedInteraction } from './main';

class DeterministicPerformance {
  nowMs = 0;
  readonly marks: string[] = [];

  now = (): number => this.nowMs;
  mark = (name: string): PerformanceMark => {
    this.marks.push(name);
    return { name, entryType: 'mark', startTime: this.nowMs, duration: 0, detail: null } as PerformanceMark;
  };
}

let clock: DeterministicPerformance;
let frameQueue: FrameRequestCallback[];

function flushFrame(at: number): void {
  clock.nowMs = at;
  const callbacks = frameQueue.splice(0);
  for (const callback of callbacks) callback(at);
}

beforeEach(() => {
  clock = new DeterministicPerformance();
  frameQueue = [];
  vi.stubGlobal('performance', clock);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frameQueue.push(callback);
    return frameQueue.length;
  });
  resetMetrics();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('performance metrics', () => {
  it('calculates deterministic nearest-rank P50 and P95 without mutating samples', () => {
    const samples = [100, 2, 3, 4, 1];

    expect(percentile(samples, 0.5)).toBe(3);
    expect(percentile(samples, 0.95)).toBe(100);
    expect(samples).toEqual([100, 2, 3, 4, 1]);
    expect(percentile([], 0.95)).toBe(0);
  });

  it('records first-only progress and first-page paint timing after two animation frames', async () => {
    markReviewStarted();
    const progress = markProgressVisible();
    expect(snapshotMetrics().progressVisibleMs).toBe(0);
    flushFrame(9);
    flushFrame(18);
    await progress;

    const repeatedProgress = markProgressVisible();
    flushFrame(24);
    flushFrame(30);
    await repeatedProgress;

    const firstPage = markFirstPagePainted();
    expect(snapshotMetrics().firstPageMs).toBe(0);
    flushFrame(36);
    flushFrame(45);
    await firstPage;

    expect(snapshotMetrics()).toEqual({
      progressVisibleMs: 18,
      firstPageMs: 45,
      interactions: []
    });
    expect(clock.marks).toEqual([
      'review:start',
      'review:progress-visible:start', 'review:progress-visible:paint',
      'review:first-page:start', 'review:first-page:paint'
    ]);
  });

  it('records click-to-paint only after two animation frames', async () => {
    clock.nowMs = 100;
    const completed = sampleInteraction('zoom');
    expect(snapshotMetrics().interactions).toEqual([]);

    flushFrame(116);
    expect(snapshotMetrics().interactions).toEqual([]);
    flushFrame(132);

    await expect(completed).resolves.toBe(32);
    expect(snapshotMetrics().interactions).toEqual([{ name: 'zoom', durationMs: 32 }]);
    expect(clock.marks).toEqual([
      'review:interaction:zoom:1:start', 'review:interaction:zoom:1:paint'
    ]);
  });

  it('emits a numeric-only privacy-safe snapshot for every interaction kind', async () => {
    for (const name of ['scroll', 'zoom', 'page', 'selection', 'annotation'] as const) {
      const completed = sampleInteraction(name);
      flushFrame(clock.nowMs + 8);
      flushFrame(clock.nowMs + 8);
      await completed;
    }

    const snapshot = snapshotMetrics();
    expect(snapshot.interactions.map(({ name }) => name)).toEqual([
      'scroll', 'zoom', 'page', 'selection', 'annotation'
    ]);
    expect(Object.values(snapshot).flat(2).every((value) =>
      typeof value === 'number' || typeof value === 'object' || typeof value === 'string'
    )).toBe(true);
    expect(JSON.stringify(snapshot)).not.toMatch(/\/Users\/|fixture text|annotation content|WPS|handle|revision/i);
    expect(snapshot.interactions.every(({ durationMs }) => Number.isFinite(durationMs))).toBe(true);
  });

  it('records a snapshot only after an interaction paint sample completes and again on close', async () => {
    const host = { recordMetrics: vi.fn(async () => {}) };
    const interaction = recordCompletedInteraction(host, 'page');
    expect(host.recordMetrics).not.toHaveBeenCalled();

    flushFrame(8);
    expect(host.recordMetrics).not.toHaveBeenCalled();
    flushFrame(16);
    await interaction;

    expect(host.recordMetrics).toHaveBeenCalledTimes(1);
    expect(host.recordMetrics).toHaveBeenLastCalledWith({
      progressVisibleMs: 0,
      firstPageMs: 0,
      interactions: [{ name: 'page', durationMs: 16 }]
    });

    await recordClosingMetrics(host);
    expect(host.recordMetrics).toHaveBeenCalledTimes(2);
  });

  it('includes synchronous user-action work performed after the interaction boundary', async () => {
    const host = { recordMetrics: vi.fn(async () => {}) };
    clock.nowMs = 100;

    const interaction = recordCompletedInteraction(host, 'zoom');
    clock.nowMs = 140;
    flushFrame(156);
    flushFrame(172);
    await interaction;

    expect(host.recordMetrics).toHaveBeenCalledWith({
      progressVisibleMs: 0,
      firstPageMs: 0,
      interactions: [{ name: 'zoom', durationMs: 72 }]
    });
    expect(clock.marks[0]).toBe('review:interaction:zoom:1:start');
  });

  it('discards pending interaction and milestone completions after a metrics reset', async () => {
    markReviewStarted();
    const oldInteraction = sampleInteraction('page');
    const oldFirstPage = markFirstPagePainted();
    flushFrame(8);

    resetMetrics();
    clock.nowMs = 10;
    markReviewStarted();
    flushFrame(16);

    await expect(oldInteraction).resolves.toBeNull();
    await expect(oldFirstPage).resolves.toBeNull();
    expect(snapshotMetrics()).toEqual({
      progressVisibleMs: 0,
      firstPageMs: 0,
      interactions: []
    });
  });

  it('does not persist a stale interaction when reset occurs between its frames', async () => {
    const host = { recordMetrics: vi.fn(async () => {}) };
    const staleInteraction = recordCompletedInteraction(host, 'annotation');
    flushFrame(8);
    resetMetrics();
    flushFrame(16);

    await staleInteraction;

    expect(host.recordMetrics).not.toHaveBeenCalled();
  });
});
