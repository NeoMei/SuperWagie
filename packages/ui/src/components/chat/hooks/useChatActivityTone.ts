import React from 'react';

import { ClockPausedContext } from '@/hooks/clockPausedContext';
import type { ActivityTone, ActivityToneState } from '../lib/turns/activityTone';

const DONE_TONE_MS = 3000;

type ToneState = { key: string; value: ActivityTone };

const toneFor = (current: ToneState, key: string, value: ActivityTone): ToneState => (
    current.key === key && current.value === value ? current : { key, value }
);

/**
 * The parent owns the terminal tone so it survives the working chip unmounting.
 * Cold history stays neutral; one live turn lights green for three seconds. A
 * live failure stays red until the next turn, and a user stop is neutral.
 * Resumed work cancels a pending green.
 */
export const useChatActivityTone = (key: string, state: ActivityToneState, messageId: string | null): ActivityTone => {
    const clockPaused = React.useContext(ClockPausedContext);
    const [tone, setTone] = React.useState<ToneState>({ key, value: 'neutral' });
    const liveTurnKey = React.useRef<string | null>(null);
    const pendingGreenKey = React.useRef<string | null>(null);
    const previous = React.useRef({ key, state, messageId });

    React.useEffect(() => {
        const changedTurn = previous.current.key !== key;
        const changedState = previous.current.state !== state || previous.current.messageId !== messageId;
        previous.current = { key, state, messageId };
        if (changedTurn) {
            liveTurnKey.current = null;
            pendingGreenKey.current = null;
        }
        if (state === 'working' || state === 'waiting') {
            liveTurnKey.current = key;
            pendingGreenKey.current = key;
            setTone(current => toneFor(current, key, state));
            return;
        }
        if (state === 'error') {
            pendingGreenKey.current = null;
            const liveError = liveTurnKey.current === key;
            setTone(current => toneFor(current, key, liveError ? 'error' : 'neutral'));
            return;
        }
        if (state === 'stopped') {
            liveTurnKey.current = null;
            pendingGreenKey.current = null;
            setTone(current => toneFor(current, key, 'neutral'));
            return;
        }
        if (state === 'done' && pendingGreenKey.current === key && changedState) {
            setTone(current => toneFor(current, key, 'done'));
            return;
        }
        if (changedTurn || changedState) {
            setTone(current => toneFor(current, key, 'neutral'));
        }
    }, [key, messageId, state]);

    React.useEffect(() => {
        if (clockPaused || state !== 'done' || pendingGreenKey.current !== key) return;
        const timer = window.setTimeout(() => {
            if (pendingGreenKey.current === key) pendingGreenKey.current = null;
            setTone(current => current.key === key && current.value === 'done'
                ? { key, value: 'neutral' } : current);
        }, DONE_TONE_MS);
        return () => window.clearTimeout(timer);
    }, [clockPaused, key, state]);

    return tone.key === key ? tone.value : 'neutral';
};
