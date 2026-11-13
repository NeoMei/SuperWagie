import React from 'react';

import type { ChatMessageEntry } from '../lib/turns/types';
import { LiveActivityInlineContentContext, LiveActivityToolsHiddenContext, LiveFinalActivityContext } from './liveActivityContext';
import { ActivityRowSkipContext } from '../lib/turns/activityRows';
import { LivePinnedMessageContext, RevealedTextTurnContext } from './revealedTextContext';
import type { LivePinnedMessagePresentation, RevealedTextTurnScope } from './revealedTextContext';

export interface PinnedMessageRenderProps {
    message: ChatMessageEntry;
    turnScope: RevealedTextTurnScope;
    presentation: LivePinnedMessagePresentation;
    renderMessage: (message: ChatMessageEntry) => React.ReactNode;
}

/** One original message root holds its revealed prose and its unrevealed work. */
export function PinnedMessage({
    message,
    turnScope,
    presentation,
    renderMessage,
}: PinnedMessageRenderProps) {
    return (
        <RevealedTextTurnContext.Provider value={presentation.revealTurnScope ?? turnScope}>
            <LiveActivityToolsHiddenContext.Provider value={false}>
                <LiveActivityInlineContentContext.Provider value={false}>
                    <LiveFinalActivityContext.Provider value={null}>
                        <ActivityRowSkipContext.Provider value={null}>
                            <LivePinnedMessageContext.Provider value={presentation}>
                                {renderMessage(message)}
                            </LivePinnedMessageContext.Provider>
                        </ActivityRowSkipContext.Provider>
                    </LiveFinalActivityContext.Provider>
                </LiveActivityInlineContentContext.Provider>
            </LiveActivityToolsHiddenContext.Provider>
        </RevealedTextTurnContext.Provider>
    );
}
