import React from 'react';

import { useWaitingBlink } from '@/hooks/useDurationTicker';
import type { ActivityTone } from '../lib/turns/activityTone';

/** One decorative status dot shared by the three composer-rider hosts. */
export const ChatActivityToneDot: React.FC<{ tone: ActivityTone; waiting: boolean }> = ({ tone, waiting }) => {
    const blink = useWaitingBlink(waiting);
    return <span
        aria-hidden="true"
        data-activity-tone={tone}
        className={'oc-activity-tone size-1.5 shrink-0 rounded-full ' + (blink ?? '')}
    />;
};
