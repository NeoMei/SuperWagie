import React from 'react';
import { applyModelPickToRetry } from '@/sync/session-actions';
import { useSelectionStore } from '@/sync/selection-store';
import { useSessionStatus } from '@/sync/sync-context';

/** A retry may adopt a pending BYOK pick without dispatching another prompt. */
export function useRetryModelPick(sessionId: string | null, directory: string | undefined): void {
    const status = useSessionStatus(sessionId ?? '', directory);
    const attempt = status?.type === 'retry' ? status.attempt : undefined;
    const pick = useSelectionStore((state) => sessionId ? state.getSessionModelPick(sessionId) : null);
    React.useEffect(() => {
        if (!sessionId || attempt === undefined || !pick) return;
        void applyModelPickToRetry(sessionId, directory).catch((error) => {
            console.warn('[useRetryModelPick] Model switch failed', error);
        });
    }, [attempt, directory, pick, sessionId]);
}
