import { describe, expect, test } from 'bun:test';

import type { ChatDraftIdentity } from './chatDraftPersistence';
import { createUnconfirmedSendJournal, type UnconfirmedSendRecovery } from './unconfirmedSends';

const identity = { runtimeKey: 'host-a', directory: '/repo', sessionId: 'session-1' };
const input = { identity, text: 'Keep @file.ts', confirmedMentions: ['file.ts'] };

const storageForReload = (): Storage => {
    const values = new Map<string, string>();
    return {
        get length() { return values.size; },
        key: (index) => [...values.keys()][index] ?? null,
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => { values.set(key, value); },
        removeItem: (key) => { values.delete(key); },
        clear: () => values.clear(),
    };
};

const recovery = (overrides: Partial<UnconfirmedSendRecovery> = {}) => {
    const restored: Array<{ target: ChatDraftIdentity; text: string; mentions: Set<string> }> = [];
    const options: UnconfirmedSendRecovery = {
        isCurrent: () => true,
        restore: (target, text, mentions) => { restored.push({ target, text, mentions }); },
        sessionDirectory: async (_id, directory) => directory,
        hasMessage: async () => false,
        ...overrides,
    };
    return { options, restored };
};

describe('recovering unconfirmed composer sends', () => {
    test('restores a prompt that never left without reading from the server', async () => {
        const storage = storageForReload();
        createUnconfirmedSendJournal(storage).track(input);
        const page = createUnconfirmedSendJournal(storage);
        const { options, restored } = recovery({ hasMessage: async () => { throw new Error('unavailable'); } });

        await page.recover('host-a', options);
        await page.recover('host-a', options);

        expect(restored).toEqual([{ target: identity, text: 'Keep @file.ts', mentions: new Set(['file.ts']) }]);
    });

    test('skips sends still active in the same page and removes a settled receipt', async () => {
        const storage = storageForReload();
        const page = createUnconfirmedSendJournal(storage);
        const send = page.track(input);
        const { options, restored } = recovery();
        await page.recover('host-a', options);
        send.settle();
        await createUnconfirmedSendJournal(storage).recover('host-a', options);
        expect(restored).toEqual([]);
    });

    test('recovers attachment names with the original text and a file-only draft', async () => {
        const storage = storageForReload();
        const sender = createUnconfirmedSendJournal(storage);
        sender.track({ ...input, attachmentNames: ['report.pdf', 'chart.png'] });
        sender.track({ ...input, text: '', attachmentNames: ['only.png'] });
        const notifications: Array<{ text: string; names: readonly string[] }> = [];
        const { options } = recovery({
            restore: (_target, text, _mentions, names) => { notifications.push({ text, names }); },
        });
        await createUnconfirmedSendJournal(storage).recover('host-a', options);
        expect(notifications).toEqual([
            { text: 'Keep @file.ts', names: ['report.pdf', 'chart.png'] },
            { text: '', names: ['only.png'] },
        ]);
    });

    test('looks up the exact issued prompt and does not restore it if admitted', async () => {
        const storage = storageForReload();
        const send = createUnconfirmedSendJournal(storage).track(input);
        send.progress({ type: 'dispatch', directory: '/repo/canonical', sessionId: 'session-1', messageId: 'msg-a' });
        const examined: string[][] = [];
        const { options, restored } = recovery({ hasMessage: async (...address) => { examined.push(address); return true; } });
        await createUnconfirmedSendJournal(storage).recover('host-a', options);
        expect(examined).toEqual([['session-1', 'msg-a', '/repo/canonical']]);
        expect(restored).toEqual([]);
        expect(storage.length).toBe(0);
    });

    test('keeps uncertain delivery across offline starts and restores after authoritative absence', async () => {
        const storage = storageForReload();
        const send = createUnconfirmedSendJournal(storage).track(input);
        send.progress({ type: 'dispatch', directory: '/repo', sessionId: 'session-1', messageId: 'msg-a' });
        const page = createUnconfirmedSendJournal(storage);
        const { options, restored } = recovery();
        await page.recover('host-a', { ...options, hasMessage: async () => { throw new Error('offline'); } });
        expect(restored).toEqual([]);
        expect(storage.length).toBe(1);
        await page.recover('host-a', options);
        expect(restored.map(({ text }) => text)).toEqual(['Keep @file.ts']);
        expect(storage.length).toBe(0);
    });

    test('checks the moved session and keeps a receipt when its owner cannot be confirmed', async () => {
        const storage = storageForReload();
        const send = createUnconfirmedSendJournal(storage).track(input);
        send.progress({ type: 'dispatch', directory: '/deleted-worktree', sessionId: 'session-1', messageId: 'msg-a' });
        const page = createUnconfirmedSendJournal(storage);
        const checked: string[] = [];
        const { options, restored } = recovery({
            sessionDirectory: async () => null,
            hasMessage: async (_id, _messageId, directory) => { checked.push(directory); return false; },
        });
        await page.recover('host-a', options);
        expect(checked).toEqual([]);
        expect(restored).toEqual([]);
        expect(storage.length).toBe(1);

        await page.recover('host-a', { ...options, sessionDirectory: async () => '/repo/current' });
        expect(checked).toEqual(['/repo/current']);
        expect(restored.map(({ target }) => target.directory)).toEqual(['/repo/current']);
    });

    test('retains a receipt when the session moves again during an absence check', async () => {
        const storage = storageForReload();
        const send = createUnconfirmedSendJournal(storage).track(input);
        send.progress({ type: 'dispatch', directory: '/old', sessionId: 'session-1', messageId: 'msg-a' });
        const { options, restored } = recovery({
            sessionDirectory: async (_id, directory) => directory === '/old' ? '/owning' : '/moved-again',
        });
        await createUnconfirmedSendJournal(storage).recover('host-a', options);
        expect(restored).toEqual([]);
        expect(storage.length).toBe(1);
    });

    test('routes interrupted first sends into the created session or the original draft', async () => {
        const storage = storageForReload();
        const owner = createUnconfirmedSendJournal(storage);
        const originalDraft = { ...identity, sessionId: null };
        owner.track({ ...input, identity: originalDraft, text: 'Created session' })
            .progress({ type: 'session', directory: '/draft', sessionId: 'session-created' });
        owner.track({ ...input, identity: originalDraft, text: 'Missing session' })
            .progress({ type: 'session', directory: '/draft', sessionId: 'session-missing' });
        const { options, restored } = recovery({ sessionDirectory: async (id) => id === 'session-created' ? '/actual' : null });
        await createUnconfirmedSendJournal(storage).recover('host-a', options);
        expect(restored.map(({ text, target }) => [text, target])).toEqual([
            ['Created session', { runtimeKey: 'host-a', directory: '/actual', sessionId: 'session-created' }],
            ['Missing session', originalDraft],
        ]);
    });

    test('does not consume another runtime or reconcile after the runtime changes', async () => {
        const storage = storageForReload();
        const send = createUnconfirmedSendJournal(storage).track(input);
        send.progress({ type: 'dispatch', directory: '/repo', sessionId: 'session-1', messageId: 'msg-a' });
        let current = true;
        const { options, restored } = recovery({
            isCurrent: () => current,
            hasMessage: async () => { current = false; return false; },
        });
        const page = createUnconfirmedSendJournal(storage);
        await page.recover('host-b', options);
        expect(current).toBe(true);
        await page.recover('host-a', options);
        expect(restored).toEqual([]);
        expect(storage.length).toBe(1);
    });

    test('does not recover an issued command whose server assigns the ID', async () => {
        const storage = storageForReload();
        const send = createUnconfirmedSendJournal(storage).track(input);
        send.progress({ type: 'dispatch', directory: '/repo', sessionId: 'session-1', messageId: null });
        const { options, restored } = recovery();
        await createUnconfirmedSendJournal(storage).recover('host-a', options);
        expect(restored).toEqual([]);
        expect(storage.length).toBe(0);
    });
});
