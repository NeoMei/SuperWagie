export const PAINTED_FRAME_DEADLINE_MS = 5_000;

type DeadlineHandle = ReturnType<typeof setTimeout>;

interface PaintedFrameDependencies {
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
  setDeadline?: (callback: () => void, delayMs: number) => DeadlineHandle;
  clearDeadline?: (handle: DeadlineHandle) => void;
}

/**
 * Waits for two actual animation-frame callbacks. The deadline can only reject;
 * it can never stand in for a painted frame or produce a performance sample.
 */
export function waitForPaintedFrames(
  dependencies: PaintedFrameDependencies = {}
): Promise<void> {
  const requestFrame = dependencies.requestFrame ?? requestAnimationFrame;
  const cancelFrame = dependencies.cancelFrame ?? cancelAnimationFrame;
  const setDeadline: NonNullable<PaintedFrameDependencies['setDeadline']> =
    dependencies.setDeadline ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearDeadline: NonNullable<PaintedFrameDependencies['clearDeadline']> =
    dependencies.clearDeadline ?? ((handle) => clearTimeout(handle));

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let pendingFrame: number | null = null;
    const deadline = setDeadline(() => {
      if (settled) return;
      settled = true;
      if (pendingFrame !== null) cancelFrame(pendingFrame);
      reject(new Error('painted frame deadline exceeded'));
    }, PAINTED_FRAME_DEADLINE_MS);

    const complete = (): void => {
      if (settled) return;
      settled = true;
      pendingFrame = null;
      clearDeadline(deadline);
      resolve();
    };

    pendingFrame = requestFrame(() => {
      if (settled) return;
      pendingFrame = requestFrame(() => complete());
    });
  });
}

export async function measurePaintedAction(
  action: () => unknown,
  wait: () => Promise<void> = waitForPaintedFrames,
  now: () => number = () => performance.now()
): Promise<number> {
  const started = now();
  action();
  await wait();
  const durationMs = now() - started;
  return Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
}
