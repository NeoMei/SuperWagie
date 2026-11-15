import type { Part, ReasoningPart, ToolPart } from '@/lib/opencode/model';
import { isShellTool } from '@/lib/opencode/tools';
import type { ChatMessageEntry } from './types';
import { isToolRowShown } from './toolRowVisibility';

export type ReasoningActivityGroupMember = { message: ChatMessageEntry; part: ReasoningPart };
type CommandActivityGroupMember = { message: ChatMessageEntry; part: ToolPart };

type ActivityGroup =
    | { kind: 'reasoning'; id: string; members: readonly ReasoningActivityGroupMember[] }
    | { kind: 'command'; id: string; members: readonly CommandActivityGroupMember[] };

/** Every member ID resolves to the same group, including the first member. */
export type ActivityGroups = ReadonlyMap<string, ActivityGroup>;

const plans = new WeakMap<readonly ChatMessageEntry[], { reasoning?: ActivityGroups; commands?: ActivityGroups }>();

/** Groups follow authoritative part order, before visibility, slicing or Activity trimming. */
export const getActivityGroups = (messages: readonly ChatMessageEntry[], groupReasoning = true): ActivityGroups => {
    const cachedPlans = plans.get(messages);
    const key = groupReasoning ? 'reasoning' : 'commands';
    const cached = cachedPlans?.[key];
    if (cached) return cached;
    const groups = new Map<string, ActivityGroup>();
    let reasoning: ReasoningActivityGroupMember[] = [];
    let commands: CommandActivityGroupMember[] = [];
    const flush = () => {
        const firstReasoning = reasoning[0];
        const firstCommand = commands[0];
        const group: ActivityGroup | undefined = reasoning.length > 1 && firstReasoning
            ? { kind: 'reasoning', id: firstReasoning.part.id, members: reasoning }
            : commands.length > 1 && firstCommand
                ? { kind: 'command', id: firstCommand.part.id, members: commands }
                : undefined;
        if (group) for (const member of group.members) groups.set(member.part.id, group);
        reasoning = [];
        commands = [];
    };
    for (const message of messages) {
        for (const part of message.parts) {
            if (part.type === 'reasoning') {
                if (!groupReasoning) {
                    flush();
                    continue;
                }
                if (commands.length > 0) flush();
                reasoning.push({ message, part });
            } else if (part.type === 'tool' && isShellTool(part.tool) && isToolRowShown(part)) {
                if (reasoning.length > 0) flush();
                commands.push({ message, part });
            } else {
                // Even empty text can grow later, so it already ends a run.
                flush();
            }
        }
        if (message.info.role === 'assistant' && message.info.error) flush();
    }
    flush();
    const remembered = cachedPlans ?? {};
    remembered[key] = groups;
    plans.set(messages, remembered);
    return groups;
};

const isActivityGroupOwner = (group: ActivityGroup, partId: string): boolean => group.id === partId;

/** Whether a part's details are drawn by an earlier member's disclosure. */
export const isActivityGroupContinuation = (part: Part, groups: ActivityGroups | null | undefined): boolean => {
    const group = groups?.get(part.id);
    return group !== undefined && !isActivityGroupOwner(group, part.id);
};

/** The original message still owns its footer, errors and any ungrouped content. */
export const isActivityContinuationOnlyMessage = (message: ChatMessageEntry, groups: ActivityGroups): boolean => (
    message.parts.length > 0
    && message.parts.every((part) => isActivityGroupContinuation(part, groups))
    && !(message.info.role === 'assistant' && (message.info.error || message.info.finish === 'stop'))
);
