import type { Message, Part, SessionStatus } from '@/lib/opencode/model';
import { getLastConversationRecord } from '@/lib/opencode/model';
import { assistantErrorNotice, isStoppedTurnError } from '@/lib/messages/assistantError';
import { findRecordedTurnError } from '../../sessionErrorNoticeState';

export type ActivityTone = 'neutral' | 'working' | 'waiting' | 'error' | 'done';
export type ActivityToneState = ActivityTone | 'stopped';
type MessageRecord = { readonly info: Message; readonly parts: readonly Part[] };

type ChatActivityToneInput = {
    readonly sessionId: string | null;
    readonly sessionKey: string | null;
    readonly messages: readonly MessageRecord[];
    readonly status: SessionStatus;
    readonly hasPermissions: boolean;
    readonly hasForms: boolean;
};

export type ChatActivityToneResult = {
    readonly key: string;
    readonly state: ActivityToneState;
    readonly lastMessageId: string | null;
};

/**
 * Pick the one mounted dot. The working chip is invisible while the reader
 * owns the scroll, and the pill is invisible at the live edge; terminal tones
 * need a standalone layer when neither chip is on screen.
 */
export const selectChatActivityToneHost = ({
    statusRowVisible, showScrollToBottom, userOwnsScroll,
}: {
    readonly statusRowVisible: boolean;
    readonly showScrollToBottom: boolean;
    readonly userOwnsScroll: boolean;
}): 'row' | 'pill' | 'standalone' => (
    showScrollToBottom ? 'pill' : statusRowVisible && !userOwnsScroll ? 'row' : 'standalone'
);

const STOPPED_NOTICE = 'chat.assistantError.stopped';
const RETRY_NOTICE = 'chat.assistantError.retry';

const isStoppedError = (info: Message): boolean => (
    assistantErrorNotice(info)?.key === STOPPED_NOTICE
);

const isRetryNoticed = (info: Message): boolean => (
    assistantErrorNotice(info)?.key === RETRY_NOTICE
    || info.role === 'assistant' && info.retry?.error.type === 'SessionRetry'
);

/**
 * One turn's state from live channels and the trailing conversation record.
 * A retry or a blocking request is a wait even while the session status is
 * idle. A user stop is neutral; a real terminal failure keeps its error color.
 */
export const deriveChatActivityTone = ({
    sessionId, sessionKey, messages, status, hasPermissions, hasForms,
}: ChatActivityToneInput): ChatActivityToneResult => {
    const lastMessage = getLastConversationRecord(messages)?.info;
    const completedAssistant = lastMessage?.role === 'assistant'
        && lastMessage.time.completed !== undefined ? lastMessage : undefined;
    const recordedTurnError = findRecordedTurnError(messages.map((record) => record.info));
    const isWorking = Boolean(sessionId) && (
        status.type === 'busy' || status.type === 'retry'
        || lastMessage?.role === 'assistant' && lastMessage.time.completed === undefined
    ) && !hasPermissions && !hasForms;
    const waiting = Boolean(sessionId) && (
        hasPermissions || hasForms || status.type === 'retry'
        || (lastMessage ? isRetryNoticed(lastMessage) : false)
    );
    const terminalFailed = Boolean(
        (completedAssistant && (completedAssistant.finish === 'error' || completedAssistant.error))
        || recordedTurnError,
    );
    const stopped = Boolean(
        (completedAssistant && isStoppedError(completedAssistant))
        || (recordedTurnError && isStoppedTurnError(recordedTurnError.type, recordedTurnError.message)),
    );
    const lastUser = [...messages].reverse().find((record) => record.info.role === 'user');
    const turnId = lastUser?.info.id ?? lastMessage?.id ?? '';
    const state: ActivityToneState = !sessionId || !lastMessage ? 'neutral'
        : waiting ? 'waiting'
            : isWorking ? 'working'
                : terminalFailed && status.type !== 'retry' ? stopped ? 'stopped' : 'error'
                    : completedAssistant ? 'done'
                        : 'neutral';
    return {
        key: [sessionKey ?? '', turnId].join('\u0000'),
        state,
        lastMessageId: lastMessage?.id ?? null,
    };
};
