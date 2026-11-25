import { createContext } from 'react';

import type { Part } from '@/lib/opencode/model';
import { filterVisibleParts, isEmptyTextPart } from '../../message/partUtils';
import { isActivityGroupContinuation, type ActivityGroups } from './activityGroups';
import { isToolRowShown } from './toolRowVisibility';

export { isToolRowShown } from './toolRowVisibility';

// While a turn works with Activity collapsed, only its latest rows stay in
// view and the earlier ones fold into one "+N more" row. A row is what
// MessageBody draws for one part: a text, a reasoning block, a tool call.

export const LIVE_ACTIVITY_VISIBLE_ROWS = 7;

/** Whether a part MessageBody draws is a row (`parts` already filtered for reasoning). */
export const isActivityRowPart = (part: Part): boolean => {
    if (part.type === 'tool') return isToolRowShown(part);
    if (part.type === 'text') return !isEmptyTextPart(part);
    return part.type === 'reasoning';
};

/** The parts of a message that draw a row, in order. */
export const activityRowParts = (parts: Part[], showReasoning: boolean, groups?: ActivityGroups | null): Part[] => (
    filterVisibleParts(parts, { includeReasoning: showReasoning }).filter((part) => (
        isActivityRowPart(part) && !isActivityGroupContinuation(part, groups)
    ))
);

interface ActivityTrim {
    // Messages at the start of the turn that are hidden entirely.
    readonly hiddenMessages: number;
    // Rows hidden at the start of the first message still shown.
    readonly skipRows: number;
    readonly hiddenRows: number;
}

const NO_TRIM: ActivityTrim = { hiddenMessages: 0, skipRows: 0, hiddenRows: 0 };

/** Which rows to hide so that the last `visibleRows` of the turn stay. */
export const planActivityTrim = (rowsPerMessage: readonly number[], visibleRows: number): ActivityTrim => {
    let kept = 0;
    for (let index = rowsPerMessage.length - 1; index >= 0; index -= 1) {
        const rows = rowsPerMessage[index] ?? 0;
        if (kept + rows <= visibleRows) {
            kept += rows;
            continue;
        }
        let hiddenRows = 0;
        for (let earlier = 0; earlier <= index; earlier += 1) hiddenRows += rowsPerMessage[earlier] ?? 0;
        const skipRows = rows - (visibleRows - kept);
        // The budget ran out exactly at this message: it is hidden whole.
        if (skipRows >= rows) return { hiddenMessages: index + 1, skipRows: 0, hiddenRows };
        return { hiddenMessages: index, skipRows, hiddenRows: hiddenRows - (rows - skipRows) };
    }
    return NO_TRIM;
};

/** The message the trim cuts into, and how many of its first rows it hides. */
export const ActivityRowSkipContext = createContext<{ messageId: string; rows: number; excludeHoisted: boolean } | null>(null);
