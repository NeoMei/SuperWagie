import { getToolMetadata } from '@/lib/toolHelpers';
import { toolDescription, type ToolDescription } from '@/lib/opencode/tools';
import type { Part } from '@/lib/opencode/model';

export type LiveToolStatus = {
    label: string;
    description: string;
};

const descriptionText = (description: ToolDescription | null): string => {
    if (!description) return '';
    switch (description.kind) {
        case 'path':
        case 'text':
            return description.value;
        case 'questions':
            return `${description.count} 个问题`;
        case 'files':
            return description.count === 1
                ? description.files[0] ?? ''
                : `${description.count} 个文件`;
        case 'tools':
            return description.calls
                .map((call) => (call.count > 1 ? `${call.name} ×${call.count}` : call.name))
                .join('、');
    }
};

/**
 * The newest call still running, for the folded Activity header. Completed
 * calls are not "正在执行", so the header goes back to plain Activity while
 * the model thinks between steps.
 */
export const latestRunningTool = (parts: readonly Part[]): LiveToolStatus | null => {
    for (let index = parts.length - 1; index >= 0; index -= 1) {
        const part = parts[index];
        if (part?.type !== 'tool') continue;
        const status = part.state.status;
        if (status !== 'running' && status !== 'pending') continue;
        return {
            label: getToolMetadata(part.tool).displayName,
            description: descriptionText(toolDescription(
                part.tool,
                part.state.input,
                status === 'running' ? part.state.metadata : undefined,
            )),
        };
    }
    return null;
};
