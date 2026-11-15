import type { Part, ToolPart } from '@/lib/opencode/model';
import { isInvisibleText } from '@/lib/invisibleText';
import { isShellTool } from '@/lib/opencode/tools';
import type { ChatMessageEntry } from './types';
import { isToolRowShown } from './toolRowVisibility';

type CommandActivityGroupMember = { message: ChatMessageEntry; part: ToolPart };

type ActivityGroup = { kind: 'command'; id: string; members: readonly CommandActivityGroupMember[] };

/** Every member ID resolves to the same group, including the first member. */
export type ActivityGroups = ReadonlyMap<string, ActivityGroup>;

const plans = new WeakMap<readonly ChatMessageEntry[], ActivityGroups>();

// A completed empty text part draws no row; a live empty part can still become prose.
const isSealedInvisibleText = (part: Part, message: ChatMessageEntry): boolean => (
    part.type === 'text' && isInvisibleText(part.text)
    && (part.time?.end !== undefined || (message.info.role === 'assistant' && message.info.time.completed !== undefined))
);

/** Groups follow authoritative part order, before visibility, slicing or Activity trimming. */
export const getActivityGroups = (messages: readonly ChatMessageEntry[]): ActivityGroups => {
    const cached = plans.get(messages);
    if (cached) return cached;
    const groups = new Map<string, ActivityGroup>();
    let commands: CommandActivityGroupMember[] = [];
    const flush = () => {
        const firstCommand = commands[0];
        const group: ActivityGroup | undefined = commands.length > 1 && firstCommand
            ? { kind: 'command', id: firstCommand.part.id, members: commands }
            : undefined;
        if (group) for (const member of group.members) groups.set(member.part.id, group);
        commands = [];
    };
    for (const message of messages) {
        for (const part of message.parts) {
            if (isSealedInvisibleText(part, message)) continue;
            if (part.type === 'tool' && isShellTool(part.tool) && isToolRowShown(part)) {
                commands.push({ message, part });
            } else {
                // Even empty text can grow later, so it already ends a run.
                flush();
            }
        }
        if (message.info.role === 'assistant' && message.info.error) flush();
    }
    flush();
    plans.set(messages, groups);
    return groups;
};

/** Whether a part's details are drawn by an earlier member's disclosure. */
export const isActivityGroupContinuation = (part: Part, groups: ActivityGroups | null | undefined): boolean => {
    const group = groups?.get(part.id);
    return group !== undefined && group.id !== part.id;
};

/** The original message still owns its footer, errors and any ungrouped content. */
export const isActivityContinuationOnlyMessage = (message: ChatMessageEntry, groups: ActivityGroups): boolean => (
    message.parts.some((part) => isActivityGroupContinuation(part, groups))
    && message.parts.every((part) => isActivityGroupContinuation(part, groups) || isSealedInvisibleText(part, message))
    && !(message.info.role === 'assistant' && (message.info.error || message.info.finish === 'stop'))
);
