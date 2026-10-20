import React from 'react';

import { APP_NAME } from '@/lib/branding';

interface OpenChamberLogoProps {
  className?: string;
  width?: number;
  height?: number;
  /** Kept for call sites that animated the old vector mark. */
  isAnimated?: boolean;
  variant?: 'default' | 'splash';
}

/**
 * The product mark. The artwork is the same raster asset the web shell serves,
 * so one file in `public/` updates every surface that shows it.
 */
export const OpenChamberLogo: React.FC<OpenChamberLogoProps> = ({
  className,
  width = 40,
  height = 40,
}) => (
  <img
    src="/logo.png"
    width={width}
    height={height}
    alt={APP_NAME}
    draggable={false}
    className={className}
  />
);
