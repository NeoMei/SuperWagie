import type { ToolPart } from '@/lib/opencode/model';

const isToolRunning = (status: string): boolean => status === 'pending' || status === 'running' || status === 'started';

/** A running call draws immediately; a settled call requires sane authoritative timing. */
export const isToolRowShown = (toolPart: ToolPart): boolean => {
    const { state } = toolPart;
    if (isToolRunning(state.status)) return true;
    if (state.status !== 'completed' && state.status !== 'error') return false;
    return state.time.end >= state.time.start;
};
