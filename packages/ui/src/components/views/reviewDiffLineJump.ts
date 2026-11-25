import type { PierreDiffViewerHandle } from './PierreDiffViewer';

type Line = Parameters<PierreDiffViewerHandle['scrollToLine']>[0];

export function startReviewDiffLineJump({
  lineNumber, side, scroll, unavailable,
  requestFrame = requestAnimationFrame, cancelFrame = cancelAnimationFrame,
  now = () => performance.now(),
}: Pick<Line, 'lineNumber' | 'side'> & {
  scroll: PierreDiffViewerHandle['scrollToLine'];
  unavailable: () => void;
  requestFrame?: typeof requestAnimationFrame;
  cancelFrame?: typeof cancelAnimationFrame;
  now?: () => number;
}): () => void {
  const deadline = now() + 6_000;
  let frame: number | null = null;
  let cancelled = false;
  const attempt = () => {
    frame = null;
    if (cancelled || scroll({ lineNumber, side, align: 'center' })) return;
    if (now() >= deadline) unavailable();
    else frame = requestFrame(attempt);
  };
  frame = requestFrame(attempt);
  return () => {
    cancelled = true;
    if (frame !== null) cancelFrame(frame);
  };
}
