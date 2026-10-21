import { createContext } from 'react';

import type { Part, ToolPart } from '@/lib/opencode/model';
import { filterVisibleParts, isEmptyTextPart } from '../../message/partUtils';

// While a turn works with Activity collapsed, only its latest rows stay in
// view and the earlier ones fold into one "+N more" row. A row is what
// MessageBody draws for one part: a text, a reasoning block, a tool call.

const isToolRunning = (status: string | undefined): boolean => (
    status === 'pending' || status === 'running' || status === 'started'
);

/** Whether a tool call gets a row: while it runs, and once it ended with sane timing. */
export const isToolRowShown = (toolPart: ToolPart): boolean => {
    const { state } = toolPart;
    if (isToolRunning(state.status)) return true;
    if (state.status !== 'completed' && state.status !== 'error') return false;
    return state.time.end >= state.time.start;
};

/** Whether a part MessageBody draws is a row (`parts` already filtered for reasoning). */
export const isActivityRowPart = (part: Part): boolean => {
    if (part.type === 'tool') return isToolRowShown(part);
    if (part.type === 'text') return !isEmptyTextPart(part);
    return part.type === 'reasoning';
};

/** The parts of a message that draw a row, in order. */
export const activityRowParts = (parts: Part[], showReasoning: boolean): Part[] => (
    filterVisibleParts(parts, { includeReasoning: showReasoning }).filter(isActivityRowPart)
);

/** The message the trim cuts into, and how many of its first rows it hides. */
export const ActivityRowSkipContext = createContext<{ messageId: string; rows: number } | null>(null);
