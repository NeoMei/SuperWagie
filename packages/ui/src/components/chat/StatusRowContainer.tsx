import React from 'react';

import { useAssistantStatus } from '@/hooks/useAssistantStatus';
import { useBackgroundSessionWork } from '@/hooks/useBackgroundSessionWork';
import { useKeybind } from '@/hooks/useKeybind';
import { useConfigStore } from '@/stores/useConfigStore';
import { getProviderModelDisplayName } from '@/lib/modelDisplay';
import { StatusRow } from './StatusRow';
import type { ActivityTone } from './lib/turns/activityTone';

/**
 * Status row wrapper.
 * Uses the dedicated assistant status hook so the row keeps accurate live activity
 * labels while still limiting subscriptions to the active assistant message.
 */
interface StatusRowContainerProps {
    tone?: ActivityTone;
    showTone?: boolean;
}

export const StatusRowContainer: React.FC<StatusRowContainerProps> = React.memo(({ tone, showTone }) => {
    const { activeModel, working } = useAssistantStatus();
    const currentAgentName = useConfigStore((state) => state.currentAgentName);
    const providers = useConfigStore((state) => state.providers);
    const backgroundWork = useBackgroundSessionWork();

    // The shortcut lives with the status that knows whether anything can go
    // to the background; otherwise it yields the key.
    useKeybind('background_session_work', () => {
        if (!working.canBackground) return false;
        backgroundWork();
    });

    const modelDisplayName = React.useMemo(() => {
        if (!activeModel) {
            return null;
        }
        const provider = providers.length > 0
            ? providers.find((candidate) => candidate.id === activeModel.providerId)
            : undefined;
        return getProviderModelDisplayName(provider, activeModel.modelId) || null;
    }, [activeModel, providers]);

    return (
        <StatusRow
            isWorking={working.isWorking}
            status={working.status}
            isGenericStatus={working.isGenericStatus}
            isWaitingForPermission={working.isWaitingForPermission}
            abortActive={working.abortActive}
            retryInfo={working.retryInfo}
            agentName={currentAgentName}
            modelName={modelDisplayName}
            providerId={activeModel?.providerId ?? null}
            onBackground={working.canBackground ? backgroundWork : undefined}
            tone={tone}
            showTone={showTone}
        />
    );
});

StatusRowContainer.displayName = 'StatusRowContainer';
