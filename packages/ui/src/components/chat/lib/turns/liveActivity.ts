import { isInvisibleText } from '@/lib/invisibleText';
import { getLastConversationRecord, type ToolPart } from '@/lib/opencode/model';
import { renderedPage } from '@/lib/opencode/tools';
import { isSessionNoticePart } from '@/lib/opencode/session-notices';
import type { ChatMessageEntry, TurnRecord } from './types';

/** A queued user message alone does not retire the previous turn. */
export function getTurnsWithLaterAssistant(turns: readonly TurnRecord[]): Set<string> {
    const retired = new Set<string>();
    let hasLaterAssistant = false;
    for (let index = turns.length - 1; index >= 0; index--) {
        const turn = turns[index];
        if (hasLaterAssistant) retired.add(turn.turnId);
        hasLaterAssistant ||= turn.assistantMessages.length > 0;
    }
    return retired;
}

export function getLiveFinalMessage(messages: readonly ChatMessageEntry[]): ChatMessageEntry | undefined {
    // Do not use projectTurnSummary's intermediate-text fallback. Compaction,
    // synthetic prompts, skill and shell records are their own message roles
    // in v2 and can trail the final answer, so the lookup skips them instead
    // of reading the last record.
    const last = getLastConversationRecord(messages);
    return last?.info.role === 'assistant' && last.info.finish === 'stop'
        && last.parts.some((part) => part.type === 'text' && !isInvisibleText(part.text))
        ? last : undefined;
}

/**
 * Session notices stay above an answer without creating an execution fold.
 * Earlier assistant steps count as progress; a lone answer does not.
 */
export function hasLiveActivity(turn: TurnRecord, showReasoning: boolean, isWorking = false): boolean {
    return turn.activityParts.some((activity) => (
        (activity.part.type === 'tool' && !isSessionNoticePart(activity.part))
        || (showReasoning && activity.kind === 'reasoning')
    )) || turn.assistantMessages.some((message, index) => (
        (index < turn.assistantMessages.length - 1 || (message.info.role === 'assistant' && message.info.finish === 'tool-calls'))
        && message.parts.some((part) => part.type === 'text' && !isInvisibleText(part.text))
    )) || (isWorking && showReasoning && turn.assistantMessages.some((message) => message.parts.some((part) => part.type === 'reasoning')));
}

/** The pages a turn's `openchamber_render` calls showed, waiting ones included, in the order they ran. */
export function getShownPages(messages: readonly ChatMessageEntry[]): ToolPart[] {
    return messages.flatMap((message) => message.parts.filter((part): part is ToolPart => (
        part.type === 'tool' && renderedPage(part.tool, part.state) !== null
    )));
}
