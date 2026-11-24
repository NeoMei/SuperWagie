import { describe, expect, test } from 'bun:test';

import type { AssistantMessage } from '@/lib/opencode/model';
import { assistantErrorNotice } from '@/lib/messages/assistantError';
import { areRenderRelevantMessagesEqual } from '../../message/renderCompare';
import { applyRetryOverlay } from './applyRetryOverlay';
import type { ChatMessageEntry } from './types';

const user: ChatMessageEntry = {
    info: { role: 'user', id: 'prompt', sessionID: 'session', time: { created: 10 } },
    parts: [],
};
const failure = { type: 'provider.unavailable', message: 'Provider disconnected' };
const assistant: AssistantMessage = {
    role: 'assistant', id: 'step', sessionID: 'session', agent: 'build', providerID: 'p', modelID: 'm',
    time: { created: 12, completed: 14 }, finish: 'error', error: failure,
};
const retry = { attempt: 2, at: 18, error: failure };
const notice = { message: 'Waiting to retry' };
const overlay = { sessionId: 'session', lastIdleAt: 9 };
const messagesWith = (info: AssistantMessage): ChatMessageEntry[] => [user, { info, parts: [] }];

describe('retry projection', () => {
    test('shows retry and suppresses the failed bubble when OpenCode scheduled it for the current step', () => {
        const messages = messagesWith({ ...assistant, retry });
        const waiting = applyRetryOverlay(messages, { ...overlay, notice });
        expect(assistantErrorNotice(waiting[1].info)?.key).toBe('chat.assistantError.retry');
        const resumed = applyRetryOverlay(messages, overlay);
        expect(assistantErrorNotice(resumed[1].info)).toBeNull();
        expect(assistantErrorNotice(messages[1].info)?.key).toBe('chat.assistantError.failed');
        expect(areRenderRelevantMessagesEqual(messages[1], waiting[1])).toBe(false);
        expect(areRenderRelevantMessagesEqual(waiting[1], resumed[1])).toBe(false);
        expect(resumed[0]).toBe(user);
    });

    test('keeps unrelated and settled failures visible', () => {
        const unverified = messagesWith(assistant);
        expect(applyRetryOverlay(unverified, { ...overlay, notice })).toBe(unverified);
        const verified = messagesWith({ ...assistant, retry });
        expect(applyRetryOverlay(verified, { ...overlay, lastIdleAt: 15 })).toBe(verified);
        expect(applyRetryOverlay(verified, { ...overlay, sessionId: 'other', notice })).toBe(verified);
        expect(applyRetryOverlay(verified, null)).toBe(verified);
    });

    test('shows a waiting notice when retry status arrives before the assistant record', () => {
        const waiting = applyRetryOverlay([user], { ...overlay, notice });
        expect(waiting).toHaveLength(2);
        expect(assistantErrorNotice(waiting[1].info)?.key).toBe('chat.assistantError.retry');
        expect(applyRetryOverlay([user], overlay)).toEqual([user]);
    });
});
