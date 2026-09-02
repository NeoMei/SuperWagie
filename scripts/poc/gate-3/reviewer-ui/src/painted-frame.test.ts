import { describe, expect, it, vi } from 'vitest';
import {
  PAINTED_FRAME_DEADLINE_MS,
  measurePaintedAction,
  waitForPaintedFrames
} from './painted-frame';

describe('bounded painted-frame wait', () => {
  it('rejects at the fixed deadline when requestAnimationFrame never calls back', async () => {
    vi.useFakeTimers();
    const requestFrame = vi.fn(() => 1);
    const pending = waitForPaintedFrames({
      requestFrame,
      cancelFrame: vi.fn(),
      setDeadline: setTimeout,
      clearDeadline: clearTimeout
    });
    const rejected = expect(pending).rejects.toThrow('painted frame deadline exceeded');

    await vi.advanceTimersByTimeAsync(PAINTED_FRAME_DEADLINE_MS);

    await rejected;
    expect(requestFrame).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('resolves only after two real animation-frame callbacks and cancels the deadline', async () => {
    const frames: FrameRequestCallback[] = [];
    const clearDeadline = vi.fn();
    const pending = waitForPaintedFrames({
      requestFrame: (callback) => { frames.push(callback); return frames.length; },
      cancelFrame: vi.fn(),
      setDeadline: vi.fn(() => 99 as unknown as ReturnType<typeof setTimeout>),
      clearDeadline
    });

    expect(frames).toHaveLength(1);
    frames.shift()?.(10);
    expect(frames).toHaveLength(1);
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    frames.shift()?.(20);
    await pending;

    expect(clearDeadline).toHaveBeenCalledOnce();
  });

  it('measures an action only after the bounded double-frame wait succeeds', async () => {
    const action = vi.fn();
    const wait = vi.fn(async () => {});
    const now = vi.fn()
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(145);

    await expect(measurePaintedAction(action, wait, now)).resolves.toBe(45);
    expect(action).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledOnce();
  });

  it('does not publish a duration when the painted-frame wait rejects', async () => {
    const action = vi.fn();
    const wait = vi.fn(async () => { throw new Error('painted frame deadline exceeded'); });
    const now = vi.fn().mockReturnValue(100);

    await expect(measurePaintedAction(action, wait, now)).rejects.toThrow(
      'painted frame deadline exceeded'
    );
    expect(action).toHaveBeenCalledOnce();
    expect(now).toHaveBeenCalledOnce();
  });
});
