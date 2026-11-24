import { expect, test } from 'bun:test';
import { startReviewDiffLineJump } from './reviewDiffLineJump';

test('waits for a virtual row and lands on the original side exactly once', () => {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const calls: Array<{ lineNumber: number; side: string }> = [];
  startReviewDiffLineJump({
    lineNumber: 18,
    side: 'deletions',
    scroll: (target) => {
      calls.push(target);
      return calls.length === 2;
    },
    unavailable: () => { throw new Error('The line should be available'); },
    requestFrame: (callback) => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelFrame: (id) => { frames.delete(id); },
    now: () => 0,
  });
  for (const timestamp of [0, 16]) {
    const next = frames.entries().next().value;
    if (!next) throw new Error('Expected a pending frame');
    frames.delete(next[0]);
    next[1](timestamp);
  }
  expect(calls).toEqual([
    { lineNumber: 18, side: 'deletions', align: 'center' },
    { lineNumber: 18, side: 'deletions', align: 'center' },
  ]);
  expect(frames.size).toBe(0);
});

test('a discarded comparison cancels its pending jump before the next snapshot renders', () => {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  let scrolled = false;
  const cancel = startReviewDiffLineJump({
    lineNumber: 4,
    side: 'additions',
    scroll: () => { scrolled = true; return true; },
    unavailable: () => { throw new Error('Cancelled jumps should stay silent'); },
    requestFrame: (callback) => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelFrame: (id) => { frames.delete(id); },
    now: () => 0,
  });
  cancel();
  for (const callback of frames.values()) callback(16);
  expect(scrolled).toBe(false);
  expect(frames.size).toBe(0);
});
