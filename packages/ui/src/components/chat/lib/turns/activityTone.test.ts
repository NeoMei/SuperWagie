import { describe, expect, test } from 'bun:test';

import type { Message, SessionStatus, StructuredError } from '@/lib/opencode/model';
import { deriveChatActivityTone, selectChatActivityToneHost, type ChatActivityToneResult } from './activityTone';

const user = (id: string): Message => ({
    id, sessionID: 'ses', role: 'user', time: { created: 1 },
});

const assistant = (id: string, options: {
    completed?: boolean;
    finish?: 'stop' | 'error';
    error?: StructuredError;
    retry?: boolean;
} = {}): Message => ({
    id, sessionID: 'ses', role: 'assistant', time: {
        created: 2, completed: options.completed === false ? undefined : 3,
    },
    agent: 'build', providerID: 'provider', modelID: 'model',
    finish: options.finish, error: options.error,
    retry: options.retry ? { attempt: 1, at: 3, error: { type: 'SessionRetry', message: 'Retrying' } } : undefined,
});

const idle = (outcome: 'succeeded' | 'failed' | 'interrupted', error?: StructuredError): Message => ({
    id: 'idle', sessionID: 'ses', role: 'idle', time: { created: 4 }, outcome, error,
});

const derive = (messages: Message[], options: {
    status?: SessionStatus;
    hasPermissions?: boolean;
    hasForms?: boolean;
} = {}): ChatActivityToneResult => deriveChatActivityTone({
    sessionId: 'ses',
    sessionKey: 'runtime\u0000directory\u0000ses',
    messages: messages.map((info) => ({ info, parts: [] })),
    status: options.status ?? { type: 'idle' },
    hasPermissions: options.hasPermissions ?? false,
    hasForms: options.hasForms ?? false,
});

describe('deriveChatActivityTone', () => {
    test('separates active work, a user wait, and a retry without a busy status', () => {
        const running = assistant('step', { completed: false });
        expect(derive([user('prompt'), running]).state).toBe('working');
        expect(derive([user('prompt'), running], { hasPermissions: true }).state).toBe('waiting');
        expect(derive([user('prompt'), running], { hasForms: true }).state).toBe('waiting');
        expect(derive([user('prompt'), running], {
            status: { type: 'retry', attempt: 1, message: 'rate limited', next: 10 },
        }).state).toBe('waiting');
        expect(derive([user('prompt'), assistant('step', { retry: true })]).state).toBe('waiting');
    });

    test('keeps real terminal failures red and user stops neutral', () => {
        expect(derive([user('prompt'), assistant('step', {
            finish: 'error', error: { type: 'ProviderError', message: 'Unavailable' },
        })]).state).toBe('error');
        expect(derive([user('prompt'), assistant('step', {
            finish: 'error', error: { type: 'MessageAbortedError', message: 'Step interrupted' },
        })]).state).toBe('stopped');
        expect(derive([user('prompt'), assistant('step'), idle('failed', {
            type: 'ProviderError', message: 'Unavailable',
        })]).state).toBe('error');
        expect(derive([user('prompt'), assistant('step'), idle('interrupted')]).state).toBe('done');
    });

    test('keys a finished turn by its prompt and ignores a missing session', () => {
        const first = derive([user('prompt-1'), assistant('reply-1')]);
        const next = derive([user('prompt-1'), assistant('reply-1'), user('prompt-2'), assistant('reply-2')]);
        expect(first.state).toBe('done');
        expect(next.key).not.toBe(first.key);
        expect(deriveChatActivityTone({
            sessionId: null, sessionKey: null, messages: [],
            status: { type: 'idle' }, hasPermissions: false, hasForms: false,
        }).state).toBe('neutral');
    });

    test('selects exactly one visible tone host across every scroll and terminal edge', () => {
        const select = (statusRowVisible: boolean, showScrollToBottom: boolean, userOwnsScroll: boolean) =>
            selectChatActivityToneHost({ statusRowVisible, showScrollToBottom, userOwnsScroll });
        expect(select(true, false, false)).toBe('row');
        expect(select(true, false, true)).toBe('standalone');
        expect(select(true, true, false)).toBe('pill');
        expect(select(true, true, true)).toBe('pill');
        expect(select(false, false, false)).toBe('standalone');
        expect(select(false, false, true)).toBe('standalone');
        expect(select(false, true, false)).toBe('pill');
        expect(select(false, true, true)).toBe('pill');
    });
});
