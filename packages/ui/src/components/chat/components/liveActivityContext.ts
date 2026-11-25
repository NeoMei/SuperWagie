import { createContext } from 'react';

import type { StreamPhase } from '../message/types';
import type { ShownPart } from '../lib/turns/liveActivity';

/** Only the final message splits its non-text parts from its answer/footer. */
export const LiveFinalActivityContext = createContext<{
    messageId: string;
    expanded: boolean;
    contentId: string;
    /** Pages the turn's agent showed, drawn above the answer instead of inside the fold. */
    pages: readonly ShownPart[];
} | null>(null);

/** Parts drawn outside their own step to keep them visible while Activity is folded. */
export const LiveTurnHoistedPagesContext = createContext<ReadonlySet<string> | null>(null);

/** The phase of the message that wrote a hoisted note. */
export const ShownPartStreamPhaseContext = createContext<(messageId: string) => StreamPhase>(() => 'completed');
