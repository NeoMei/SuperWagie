import { isShellTool } from '@/lib/opencode/tools';
import type { ToolPart } from '@/lib/opencode/model';
import { readBackgroundShellID, readRunningShellID, readRunningShellOutput } from '@/lib/opencode/background-shell';
import type { TurnActivityRecord } from '../lib/turns/types';
import { coerceToText } from '../message/toolRenderers';

type ShellPreview = {
    key: string;
    part: ToolPart;
    shellID?: string;
    output?: string;
    command?: string;
    description?: string;
    running: boolean;
};

export const shouldRenderLiveCommandPreview = (
    visible: boolean,
    shell: ShellPreview | undefined,
    output: string,
): boolean => visible && shell !== undefined && (shell.running || output.length > 0 || Boolean(shell.command));

const isRunningShellStatus = (status: string): boolean => (
    status === 'pending' || status === 'running' || status === 'started'
);

/** Find the latest shell call so its own disclosure can survive settlement. */
export const latestShellPreview = (
    activities: readonly TurnActivityRecord[],
): ShellPreview | undefined => {
    for (let index = activities.length - 1; index >= 0; index -= 1) {
        const activity = activities[index];
        if (activity?.kind !== 'tool' || activity.part.type !== 'tool' || !isShellTool(activity.part.tool)) {
            continue;
        }
        const state = activity.part.state;
        const commandText = coerceToText(state.input.command);
        const descriptionText = coerceToText(state.input.description);
        const inputCommand = commandText.length > 0 ? commandText : undefined;
        const description = descriptionText.length > 0 ? descriptionText : undefined;
        const running = isRunningShellStatus(state.status);
        const shellID = running ? readRunningShellID(activity.part) : readBackgroundShellID(activity.part);
        const output = running
            ? readRunningShellOutput(activity.part)
            : coerceToText('output' in state ? state.output : undefined) || undefined;
        if (running || shellID || output || inputCommand) {
            return { key: activity.id, part: activity.part, shellID, output, command: inputCommand, description, running };
        }
    }
    return undefined;
};

/** Compatibility helper for callers that only need a live shell. */
export const latestRunningShellPreview = (
    activities: readonly TurnActivityRecord[],
): ShellPreview | undefined => {
    const shell = latestShellPreview(activities);
    return shell?.running ? shell : undefined;
};
