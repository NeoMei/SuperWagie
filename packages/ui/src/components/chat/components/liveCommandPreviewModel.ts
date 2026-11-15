import type { ToolPart } from '@/lib/opencode/model';
import { readBackgroundShellID, readRunningShellID, readRunningShellOutput } from '@/lib/opencode/background-shell';
import { isShellTool, toolDescription, toolDescriptionText } from '@/lib/opencode/tools';
import { coerceToText } from '../message/toolRenderers';
import type { TurnActivityRecord } from '../lib/turns/types';

type ShellPreview = {
    key: string;
    part: ToolPart;
    shellID?: string;
    output?: string;
    command?: string;
    description?: string;
    running: boolean;
};

const isRunningStatus = (status: string): boolean => (
    status === 'pending' || status === 'running' || status === 'started'
);

/** Selects the latest shell so its output can fold independently of Activity. */
export const latestShellPreview = (activities: readonly TurnActivityRecord[]): ShellPreview | undefined => {
    for (let index = activities.length - 1; index >= 0; index -= 1) {
        const activity = activities[index];
        if (activity?.kind !== 'tool' || activity.part.type !== 'tool' || !isShellTool(activity.part.tool)) continue;
        const state = activity.part.state;
        const metadata = 'metadata' in state ? state.metadata : undefined;
        const describedText = toolDescriptionText(toolDescription(activity.part.tool, state.input, metadata));
        const commandText = describedText || coerceToText(state.input.command) || coerceToText(metadata?.command);
        const descriptionText = coerceToText(state.input.description) || coerceToText(metadata?.description);
        const running = isRunningStatus(state.status);
        const shellID = running ? readRunningShellID(activity.part) : readBackgroundShellID(activity.part);
        const output = running
            ? readRunningShellOutput(activity.part)
            : coerceToText('output' in state ? state.output : undefined) || undefined;
        if (running || shellID || output || commandText) {
            return {
                key: activity.id,
                part: activity.part,
                shellID,
                output,
                command: commandText || undefined,
                description: descriptionText || undefined,
                running,
            };
        }
    }
    return undefined;
};
