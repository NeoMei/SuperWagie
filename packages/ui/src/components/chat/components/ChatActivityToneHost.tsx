import React from 'react';

import { ChatActivityToneDot } from './ChatActivityTone';
import { registerFloatingPanelClearanceReader } from '@/components/chat/composer/state/composerInsetReaders';
import type { ActivityTone } from '../lib/turns/activityTone';

/**
 * A terminal tone needs a host after the working chip unmounts and the pill is
 * hidden. The layer has zero measured height and lives outside the status
 * overlay's ResizeObserver, so it cannot move the transcript's end inset.
 */
export const ChatActivityToneHost: React.FC<{ tone: ActivityTone }> = ({ tone }) => (
    <div
        data-chat-activity-tone="standalone"
        ref={registerFloatingPanelClearanceReader}
        className="pointer-events-none absolute bottom-full inset-x-0 mb-2 h-0"
        style={{ transform: 'translateY(calc(-1 * var(--chat-floating-panel-clearance, 0px)))' }}
    >
        <div className="chat-input-column">
            <span className="ms-3 inline-flex h-7 items-center">
                <ChatActivityToneDot tone={tone} />
            </span>
        </div>
    </div>
);
