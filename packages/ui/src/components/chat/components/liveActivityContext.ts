import { createContext } from 'react';

import type { ToolPart } from '@/lib/opencode/model';

/** Only a rendered final message outside a pinned inner fold splits its non-text parts from its answer/footer. */
type LiveFinalActivityContextValue = {
    messageId: string;
    expanded: boolean;
    contentId: string;
    animate: boolean;
    /** Interaction cards owned by this final message, drawn above its answer and outside execution. */
    interactions: readonly ToolPart[];
} | null;
export const LiveFinalActivityContext = createContext<LiveFinalActivityContextValue>(null);

/** All interaction call IDs, so every disclosure suppresses duplicate cards. */
export const LiveTurnHoistedInteractionsContext = createContext<ReadonlySet<string> | null>(null);

/** Shell calls rendered by the sibling command disclosure, never inside Activity. */
export const LiveActivityHoistedShellsContext = createContext<ReadonlySet<string> | null>(null);

/**
 * A folded execution keeps unrevealed tails, tool rows and reasoning behind
 * the outer Activity header and each pinned message's inner fold. Retired
 * prose, the current authoritative answer, questions and interactive pages
 * stay outside those folds.
 */
export const LiveActivityToolsHiddenContext = createContext(false);

/** Execution prose streams inline; reasoning defaults to compact status. */
export const LiveActivityInlineContentContext = createContext(false);
