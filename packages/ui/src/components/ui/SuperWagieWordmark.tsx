import React from 'react';

import { cn } from '@/lib/utils';
import { APP_NAME_EN } from '@/lib/branding';

const THEME_CSS = `
.sw-wordmark-dark{display:none}
[data-theme='dark'] .sw-wordmark-light{display:none}
[data-theme='dark'] .sw-wordmark-dark{display:block}
`;

/** The bull and the SuperWagie name, on the theme's background. */
export const SuperWagieWordmark: React.FC<{ width?: number; className?: string }> = ({
  width = 190,
  className,
}) => (
  <>
    <style>{THEME_CSS}</style>
    <img
      src="/superwagie-logo.png"
      width={width}
      height={width}
      alt={APP_NAME_EN}
      draggable={false}
      className={cn('sw-wordmark-light', className)}
    />
    <img
      src="/superwagie-logo-dark.png"
      width={width}
      height={width}
      alt={APP_NAME_EN}
      draggable={false}
      aria-hidden
      className={cn('sw-wordmark-dark', className)}
    />
  </>
);
