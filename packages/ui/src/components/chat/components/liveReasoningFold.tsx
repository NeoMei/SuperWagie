import React from 'react';
import ReasoningPart from '../message/parts/ReasoningPart';
import { useUIStore } from '@/stores/useUIStore';
import { LiveActivityInlineContentContext } from './liveActivityContext';
import type { ReasoningPreview } from './liveReasoningFoldModel';

type Props = {
    previews: readonly ReasoningPreview[];
    settled: boolean;
    isWorking: boolean;
};

/** Renders thinking at the same level as command execution, outside Activity. */
export const LiveReasoningFold: React.FC<Props> = ({ previews, settled, isWorking }) => {
    const showReasoningTraces = useUIStore((state) => state.showReasoningTraces);
    if (!showReasoningTraces) return null;

    return <>
        {previews.map((preview, index) => {
            const isStreaming = !settled && isWorking && index === previews.length - 1 && preview.part.time?.end === undefined;
            return (
                <LiveActivityInlineContentContext.Provider key={preview.key} value={false}>
                    <ReasoningPart
                        part={preview.part}
                        messageId={preview.messageId}
                        streamPhase={isStreaming ? 'streaming' : 'completed'}
                    />
                </LiveActivityInlineContentContext.Provider>
            );
        })}
    </>;
};
