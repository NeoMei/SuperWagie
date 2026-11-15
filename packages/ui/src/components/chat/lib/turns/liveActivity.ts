import { isInvisibleText } from '@/lib/invisibleText';
import { getLastConversationRecord, type ToolPart } from '@/lib/opencode/model';
import { isShownInPlace } from '@/lib/opencode/tools';
import { isStandaloneTool } from '../../message/parts/toolRenderUtils';
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

/** Subagent-only turns and notices keep their own rows without an Activity fold. */
export function hasLiveActivity(turn: TurnRecord, showReasoning: boolean): boolean {
    return turn.activityParts.some((activity) => (
        (activity.part.type === 'tool' && !isStandaloneTool(activity.part.tool) && !isSessionNoticePart(activity.part))
        || (showReasoning && activity.kind === 'reasoning')
    ));
}

/**
 * What a turn's calls showed the user, in order: questions, the pages of
 * `openchamber_render` calls, waiting ones included, and the workflow runs
 * `workflow.run` calls proposed.
 */
function getShownInteractions(messages: readonly ChatMessageEntry[]): ToolPart[] {
    return messages.flatMap((message) => message.parts.filter((part): part is ToolPart => (
        part.type === 'tool' && isShownInPlace(part.tool, part.state)
    )));
}

/** Pages and blocking interaction cards retain their natural place outside a turn fold. */
export type ShownPart = ToolPart;

export function getShownPages(messages: readonly ChatMessageEntry[], _finalMessage?: ChatMessageEntry): ShownPart[] {
    return getShownInteractions(messages);
}

/** The message row that draws an interaction hoisted above the final answer. */
export function uiPageMessageId(turn: TurnRecord | undefined, expanded: boolean, messageId: string, partId: string): string {
    const final = turn ? getLiveFinalMessage(turn.assistantMessages) : undefined;
    return !expanded && turn && final && getShownPages(turn.assistantMessages, final).some((part) => part.id === partId && part.messageID === messageId)
        ? final.info.id
        : messageId;
}
