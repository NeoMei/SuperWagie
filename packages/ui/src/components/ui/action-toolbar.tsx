import React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

const REST_CLASS = 'text-muted-foreground hover:bg-transparent hover:text-foreground focus-visible:text-foreground active:bg-transparent';
/** The toggle-on fill, shared with the markdown wrap toggles that keep their own geometry. */
const PRESSED_CLASS = 'bg-interactive-selection text-interactive-selection-foreground hover:bg-interactive-selection hover:text-interactive-selection-foreground active:bg-interactive-selection';

/**
 * The 24px icon button every toolbar row shares. Three looks: an action rests
 * muted and brightens on hover, a toggle that is on carries the selection
 * fill, a disabled one fades. Hover changes colour only, so a row of them
 * never flickers fills under the pointer.
 */
function ToolbarButton({
  label,
  icon,
  pressed,
  done,
  iconClassName,
  className,
  ...props
}: Omit<React.ComponentProps<typeof Button>, 'children' | 'variant' | 'size'> & {
  label: string;
  icon: IconName;
  pressed?: boolean;
  done?: boolean;
  iconClassName?: string;
}) {
  return (
    <Button
      variant="ghost"
      size="xs"
      aria-label={label}
      aria-pressed={pressed}
      className={cn('w-6 px-0 has-[>svg]:px-0', pressed ? PRESSED_CLASS : REST_CLASS, className)}
      {...props}
    >
      <Icon
        name={done ? 'check' : icon}
        className={cn('size-3.5', done ? 'text-[color:var(--status-success)]' : iconClassName)}
      />
    </Button>
  );
}

/** A label with its keyboard shortcut after it, muted, for a tooltip. */
function TooltipLabelWithShortcut({ label, shortcut }: { label: React.ReactNode; shortcut?: string }) {
  if (!shortcut) return <>{label}</>;
  return <span className="inline-flex items-center gap-2">{label}<span className="text-muted-foreground">{shortcut}</span></span>;
}

/**
 * A tooltip over one button. The span takes the hover a disabled button refuses,
 * so it also fits a button that can be disabled, and a menu, popover or select
 * trigger goes inside it. `className` is what the span needs from its row, such
 * as `shrink-0`. A button repeated on every row of a list uses `row-tooltip.tsx`.
 */
function ButtonTooltip({ label, side, sideOffset = 6, className, children }: {
  label: React.ReactNode;
  side?: 'top' | 'bottom';
  sideOffset?: number;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn('inline-flex', className)}>{children}</span>
      </TooltipTrigger>
      <TooltipContent side={side} sideOffset={sideOffset}>{label}</TooltipContent>
    </Tooltip>
  );
}

/** A `ToolbarButton` with its tooltip, which opens below so it never covers the row. */
export function ToolbarTooltipButton({ label, shortcut, ...props }: React.ComponentProps<typeof ToolbarButton> & { shortcut?: string }) {
  return (
    <ButtonTooltip label={<TooltipLabelWithShortcut label={label} shortcut={shortcut} />} side="bottom">
      <ToolbarButton label={label} {...props} />
    </ButtonTooltip>
  );
}
