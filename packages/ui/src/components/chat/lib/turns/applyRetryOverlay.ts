import type { ChatMessageEntry } from './types';

export interface RetryOverlay {
    sessionId: string;
    lastIdleAt: number | null;
    notice?: { message: string };
}

export const applyRetryOverlay = (
    messages: ChatMessageEntry[],
    overlay: RetryOverlay | null,
): ChatMessageEntry[] => {
    if (!overlay) return messages;
    const { sessionId, lastIdleAt, notice } = overlay;
    let lastUserIndex = -1;
    let targetIndex = -1;
    for (let index = messages.length - 1; index >= 0; index--) {
        const { info } = messages[index];
        if (info.sessionID !== sessionId) continue;
        if (info.role === 'user') {
            lastUserIndex = index;
            break;
        }
        if (targetIndex < 0 && info.role === 'assistant') targetIndex = index;
    }
    if (lastUserIndex < 0) return messages;

    const target = messages[targetIndex];
    const info = target?.info;
    const retryError = notice ? { type: 'SessionRetry', message: notice.message.trim() } : undefined;

    if (info?.role === 'assistant') {
        const stepTime = info.time.completed ?? info.time.created;
        const afterLastIdle = lastIdleAt === null || stepTime > lastIdleAt;
        if (!afterLastIdle || (info.error ? !info.retry : !retryError)) return messages;

        // This is a display projection for the current execution. Keep the
        // recorded error so it can be shown again if OpenCode ends the turn.
        const nextInfo = { ...info };
        if (retryError) nextInfo.error = retryError;
        else delete nextInfo.error;
        const next = messages.slice();
        next[targetIndex] = { ...target, info: nextInfo };
        return next;
    }

    if (!retryError) return messages;
    const promptTime = messages[lastUserIndex].info.time.created;
    if (lastIdleAt !== null && promptTime <= lastIdleAt) return messages;
    const synthetic: ChatMessageEntry = {
        info: {
            id: 'synthetic_retry_notice_' + sessionId,
            sessionID: sessionId,
            role: 'assistant',
            agent: '',
            modelID: '',
            providerID: '',
            time: { created: promptTime, completed: promptTime },
            finish: 'stop',
            error: retryError,
        },
        parts: [],
    };
    const next = messages.slice();
    next.splice(lastUserIndex + 1, 0, synthetic);
    return next;
};
