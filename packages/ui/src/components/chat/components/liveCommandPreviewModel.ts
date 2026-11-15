import type { ToolPart } from '@/lib/opencode/model';
import { readBackgroundShellID, readRunningShellID, readRunningShellOutput } from '@/lib/opencode/background-shell';
import { isShellTool, normalizeToolName, toolDescription, toolDescriptionText } from '@/lib/opencode/tools';
import { getToolMetadata } from '@/lib/toolHelpers';
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

const isShellLike = (tool: string): boolean => isShellTool(tool) || normalizeToolName(tool) === 'bash';

/** Selects the latest shell so its output can fold independently of Activity. */
export const latestShellPreview = (activities: readonly TurnActivityRecord[]): ShellPreview | undefined => {
    for (let index = activities.length - 1; index >= 0; index -= 1) {
        const activity = activities[index];
        if (activity?.kind !== 'tool' || activity.part.type !== 'tool' || !isShellLike(activity.part.tool)) continue;
        const state = activity.part.state;
        const metadata = 'metadata' in state ? state.metadata : undefined;
        const commandText = toolDescriptionText(toolDescription(activity.part.tool, state.input, metadata))
            || coerceToText(state.input.command)
            || coerceToText(state.input.cmd)
            || coerceToText(state.input.shell)
            || coerceToText(state.input.script)
            || coerceToText(state.input.code)
            || coerceToText(metadata?.command)
            || coerceToText(metadata?.cmd);
        const descriptionText = coerceToText(state.input.description)
            || coerceToText(metadata?.description)
            || coerceToText(metadata?.title);
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
                command: commandText || getToolMetadata(activity.part.tool).displayName,
                description: descriptionText || undefined,
                running,
            };
        }
    }
    return undefined;
};
