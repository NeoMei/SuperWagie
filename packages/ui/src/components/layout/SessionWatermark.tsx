import React from 'react';

/**
 * The product mark behind every chat, in the same place and size as the
 * workbench's watermark (centre, 59% down, 520px, 3.5% grey).
 *
 * It sits above the chat's opaque background layers because those layers paint
 * their own `bg-background`; at this opacity the mark reads on empty space and
 * disappears under dense text. It never takes pointer events.
 */
export const SessionWatermark: React.FC = () => (
  <img
    src="/superwagie-logo.png"
    alt=""
    aria-hidden
    draggable={false}
    className="pointer-events-none absolute left-1/2 top-[59%] z-[5] w-[693px] max-w-[70vw] -translate-x-1/2 -translate-y-1/2 select-none opacity-[0.035] grayscale"
  />
);
