import * as React from 'react';

import { isOpencodeNotFound, opencodeClient } from '@/lib/opencode/client';
import { captureRuntimeInstance } from '@/lib/runtime-switch';
import { normalizePath } from '@/lib/pathNormalization';
import { spaceIdOfDirectory } from '@/lib/spaces/space-route';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { unconfirmedSends, type UnconfirmedSendRecovery } from '@/lib/unconfirmedSends';

async function absentOnNotFound<T>(read: () => Promise<T>, absent: T): Promise<T> {
    try {
        return await read();
    } catch (error) {
        if (isOpencodeNotFound(error)) return absent;
        throw error;
    }
}

export function useUnconfirmedSendRecovery(
    runtimeKey: string | null,
    isConnected: boolean,
    restore: UnconfirmedSendRecovery['restore'],
): void {
    React.useEffect(() => {
        if (!runtimeKey) return;
        const isCurrentRuntime = captureRuntimeInstance();
        let mounted = true;
        const isCurrent = () => mounted && isCurrentRuntime();
        const requireConnection = () => {
            if (!isCurrent() || !isConnected) throw new Error('Send confirmation requires the original runtime');
        };
        const recover = () => {
            void unconfirmedSends.recover(runtimeKey, {
                isCurrent,
                restore,
                sessionDirectory: async (sessionId, directory) => {
                    requireConnection();
                    const scope = spaceIdOfDirectory(directory);
                    const hint = normalizePath(useGlobalSessionsStore.getState().entityById.get(sessionId)?.directory);
                    const candidate = hint && scope === spaceIdOfDirectory(hint) ? hint : directory;
                    return absentOnNotFound(async () => {
                        const session = await opencodeClient.getSession(sessionId, candidate);
                        const actual = normalizePath(session.directory);
                        if (session.id !== sessionId || !actual || spaceIdOfDirectory(actual) !== scope) {
                            throw new Error('Send confirmation could not verify session ownership');
                        }
                        return actual;
                    }, null);
                },
                hasMessage: async (sessionId, messageId, directory) => {
                    requireConnection();
                    // A steered prompt can still be in the inbox. Check it first because
                    // admission can move that prompt from the inbox into the transcript.
                    const pending = await absentOnNotFound(() => opencodeClient.getSessionInbox(sessionId, directory), []);
                    if (pending.some(({ info }) => info.id === messageId)) return true;
                    requireConnection();
                    return absentOnNotFound(async () => {
                        const { info } = await opencodeClient.getSessionMessage(sessionId, messageId, directory);
                        if (info.id !== messageId) throw new Error('Send confirmation returned a different message');
                        return true;
                    }, false);
                },
            }).catch(() => undefined);
        };
        recover();
        window.addEventListener('focus', recover);
        return () => {
            mounted = false;
            window.removeEventListener('focus', recover);
        };
    }, [runtimeKey, isConnected, restore]);
}
