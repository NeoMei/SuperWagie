import { isShellTool } from '@/lib/opencode/tools';
import { readRunningShellID } from '@/lib/opencode/background-shell';
import type { TurnActivityRecord } from '../lib/turns/types';

type RunningShellPreview = {
    shellID: string;
};

export const shouldRenderLiveCommandPreview = (
    visible: boolean,
    shell: RunningShellPreview | undefined,
    output: string,
): boolean => visible && shell !== undefined && output.length > 0;

/** Find the latest shell call that OpenCode still reports as running. */
export const latestRunningShellPreview = (
    activities: readonly TurnActivityRecord[],
): RunningShellPreview | undefined => {
    for (let index = activities.length - 1; index >= 0; index -= 1) {
        const activity = activities[index];
        if (activity?.kind !== 'tool' || activity.part.type !== 'tool' || !isShellTool(activity.part.tool)) {
            continue;
        }
        if (activity.part.state.status !== 'running') {
            continue;
        }
        const shellID = readRunningShellID(activity.part);
        if (shellID) {
            return { shellID };
        }
    }
    return undefined;
};
