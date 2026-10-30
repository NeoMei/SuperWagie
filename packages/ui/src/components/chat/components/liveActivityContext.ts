import { createContext } from 'react';

import type { ToolPart } from '@/lib/opencode/model';

/** Only the final message splits its non-text parts from its answer/footer. */
export const LiveFinalActivityContext = createContext<{
    messageId: string;
    expanded: boolean;
    contentId: string;
    animate: boolean;
    /** User interactions drawn above the answer instead of inside the fold. */
    interactions: readonly ToolPart[];
} | null>(null);

/** Calls drawn outside execution, so an opened fold does not repeat them. */
export const LiveTurnHoistedInteractionsContext = createContext<ReadonlySet<string> | null>(null);

/**
 * A folded execution keeps every process row behind the turn's header.
 * Final answer text, questions and interactive pages are presented separately.
 */
export const LiveActivityToolsHiddenContext = createContext(false);

/** Execution prose streams inline; reasoning defaults to compact status. */
export const LiveActivityInlineContentContext = createContext(false);
