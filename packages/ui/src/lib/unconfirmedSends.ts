import { z } from 'zod';

import { createChatDraftIdentity, type ChatDraftIdentity } from '@/lib/chatDraftPersistence';
import { flushDeferredStorage, getSafeSessionStorage, getSafeStorage } from '@/stores/utils/safeStorage';

const PREFIX = 'openchamber.unconfirmedSend.v1.';
const RECOVERY_LOCK = 'openchamber.unconfirmedSend.recovery';
const address = { directory: z.string().min(1), sessionId: z.string().min(1) };
const progressSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('pending') }),
    z.object({ type: z.literal('session'), ...address }),
    z.object({ type: z.literal('dispatch'), ...address, messageId: z.string().min(1).nullable() }),
]);
const recordSchema = z.object({
    identity: z.object({ ...address, sessionId: address.sessionId.nullable(), runtimeKey: z.string().min(1) }),
    text: z.string(),
    attachmentNames: z.array(z.string()).default([]),
    confirmedMentions: z.array(z.string()),
    progress: progressSchema,
});

type UnconfirmedSend = z.infer<typeof recordSchema>;
export type ComposerSendProgress = Exclude<UnconfirmedSend['progress'], { type: 'pending' }>;

export interface UnconfirmedSendRecovery {
    isCurrent: () => boolean;
    restore: (target: ChatDraftIdentity, text: string, confirmedMentions: Set<string>, attachmentNames: readonly string[]) => void;
    sessionDirectory: (sessionId: string, directory: string) => Promise<string | null>;
    hasMessage: (sessionId: string, messageId: string, directory: string) => Promise<boolean>;
}

const readRecord = (storage: Storage, key: string): UnconfirmedSend | null => {
    const raw = storage.getItem(key);
    if (!raw) return null;
    try {
        const parsed = recordSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
};

type RecoveryDecision = ChatDraftIdentity | 'drop' | 'keep';

async function recoveryDecision(record: UnconfirmedSend, server: UnconfirmedSendRecovery): Promise<RecoveryDecision> {
    const { identity, progress } = record;
    if (progress.type === 'pending') return identity;
    const messageId = progress.type === 'dispatch' ? progress.messageId : null;
    if (progress.type === 'dispatch' && messageId === null) return 'drop';
    const directory = await server.sessionDirectory(progress.sessionId, progress.directory);
    if (!server.isCurrent()) return 'keep';
    if (!directory) return progress.type === 'session' ? identity : 'keep';
    if (messageId !== null) {
        if (await server.hasMessage(progress.sessionId, messageId, directory)) return 'drop';
        if (!server.isCurrent()) return 'keep';
        // A move between the owner read and the prompt reads can also return 404.
        if (await server.sessionDirectory(progress.sessionId, directory) !== directory) return 'keep';
    }
    return createChatDraftIdentity(identity.runtimeKey, directory, progress.sessionId) ?? 'keep';
}

export function createUnconfirmedSendJournal(storage: Storage, locks: LockManager | null = null) {
    const active = new Set<string>();
    let recovering: Promise<void> = Promise.resolve();

    const track = (input: { identity: ChatDraftIdentity; text: string; confirmedMentions: Iterable<string>; attachmentNames?: readonly string[] }) => {
        const key = `${PREFIX}${globalThis.crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;
        let record: UnconfirmedSend = {
            ...input,
            confirmedMentions: [...input.confirmedMentions],
            attachmentNames: [...new Set(input.attachmentNames)],
            progress: { type: 'pending' },
        };
        const write = () => storage.setItem(key, JSON.stringify(record));
        active.add(key);
        let release = () => {};
        if (locks) {
            const alive = new Promise<void>((resolve) => { release = resolve; });
            void locks.request(key, () => alive).catch(() => undefined);
        }
        write();
        return {
            progress: (event: ComposerSendProgress) => {
                if (!active.has(key)) return;
                record = { ...record, progress: event };
                write();
            },
            settle: () => {
                // A failure has just put text back through the deferred draft store.
                flushDeferredStorage();
                storage.removeItem(key);
                active.delete(key);
                release();
            },
        };
    };

    const recover = (runtimeKey: string, server: UnconfirmedSendRecovery): Promise<void> => {
        const apply = async () => {
            const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
            for (const key of keys) {
                if (!server.isCurrent()) return;
                if (!key?.startsWith(PREFIX) || active.has(key)) continue;
                const applyRecord = async () => {
                    const record = readRecord(storage, key);
                    if (!record || record.identity.runtimeKey !== runtimeKey || !server.isCurrent()) return;
                    let decision: RecoveryDecision;
                    try {
                        decision = await recoveryDecision(record, server);
                    } catch {
                        // An unsuccessful read cannot prove that the request was never admitted.
                        return;
                    }
                    if (!server.isCurrent() || decision === 'keep') return;
                    if (decision !== 'drop') {
                        server.restore(decision, record.text, new Set(record.confirmedMentions), record.attachmentNames);
                        flushDeferredStorage();
                    }
                    storage.removeItem(key);
                };
                if (locks) {
                    await locks.request(key, { ifAvailable: true }, async (lock) => {
                        if (lock) await applyRecord();
                    });
                } else {
                    await applyRecord();
                }
            }
        };
        recovering = recovering.catch(() => undefined).then(() => locks ? locks.request(RECOVERY_LOCK, apply) : apply());
        return recovering;
    };

    return { track, recover };
}

const locks = globalThis.navigator?.locks ?? null;
export const unconfirmedSends = createUnconfirmedSendJournal(locks ? getSafeStorage() : getSafeSessionStorage(), locks);
