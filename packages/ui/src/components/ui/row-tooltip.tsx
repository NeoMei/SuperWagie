import React from 'react';

import { Tooltip, TooltipContent } from '@/components/ui/tooltip';

/** What the app's `TooltipProvider` waits, so these open like every other tooltip. */
const OPEN_DELAY_MS = 300;

type HoverTargetProps = {
  onPointerEnter?: React.PointerEventHandler<HTMLElement>;
  onPointerLeave?: React.PointerEventHandler<HTMLElement>;
  onPointerDown?: React.PointerEventHandler<HTMLElement>;
  onFocus?: React.FocusEventHandler<HTMLElement>;
  onBlur?: React.FocusEventHandler<HTMLElement>;
};

/**
 * A tooltip for a button that repeats in a list that comes and goes: tool rows,
 * code block actions, message chips, comment actions. A `Tooltip` per button
 * keeps a root mounted for every one of them, and the transcript mounts and
 * unmounts these rows while scrolling, so this mounts the tooltip only while its
 * one button is hovered or focused. It adds no DOM around the button and needs
 * no provider, so a block rendered for export takes it as it is. The state lives
 * here, so opening re-renders this leaf and never the row. A button that can be
 * disabled comes inside a span, which takes the pointer it refuses. Outside a
 * repeating row, use `Tooltip`.
 */
export function HoverTooltip({ label, side = 'top', children }: {
  label: React.ReactNode;
  side?: 'top' | 'bottom';
  children: React.ReactElement<HoverTargetProps>;
}) {
  const [anchor, setAnchor] = React.useState<HTMLElement | null>(null);
  const timerRef = React.useRef<number | null>(null);

  const clearTimer = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  };
  const close = () => {
    clearTimer();
    setAnchor(null);
  };
  React.useEffect(() => clearTimer, []);

  const child = children.props;
  const trigger = React.cloneElement(children, {
    onPointerEnter: (event: React.PointerEvent<HTMLElement>) => {
      child.onPointerEnter?.(event);
      if (event.pointerType !== 'mouse') return;
      const target = event.currentTarget;
      clearTimer();
      timerRef.current = window.setTimeout(() => setAnchor(target), OPEN_DELAY_MS);
    },
    onPointerLeave: (event: React.PointerEvent<HTMLElement>) => {
      child.onPointerLeave?.(event);
      close();
    },
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      child.onPointerDown?.(event);
      close();
    },
    onFocus: (event: React.FocusEvent<HTMLElement>) => {
      child.onFocus?.(event);
      if (event.target.matches(':focus-visible')) setAnchor(event.currentTarget);
    },
    onBlur: (event: React.FocusEvent<HTMLElement>) => {
      child.onBlur?.(event);
      close();
    },
  });

  return (
    <>
      {trigger}
      {anchor?.isConnected ? (
        <Tooltip open onOpenChange={close}>
          <TooltipContent anchor={anchor} side={side} sideOffset={6}>{label}</TooltipContent>
        </Tooltip>
      ) : null}
    </>
  );
}
