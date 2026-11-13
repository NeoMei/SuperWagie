import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { ClockPausedContext } from '@/hooks/clockPausedContext';
import type { ActivityToneState } from '../lib/turns/activityTone';
import { useChatActivityTone } from './useChatActivityTone';

type ProbeProps = { turnKey: string; state: ActivityToneState; messageId: string | null };

const Probe: React.FC<ProbeProps> = ({ turnKey, state, messageId }) => (
    <span data-tone={useChatActivityTone(turnKey, state, messageId)} />
);

let host: HTMLElement;
let root: Root;
let dom: Window;

const tone = () => host.querySelector('[data-tone]')?.getAttribute('data-tone');
const render = ({ paused = false, ...props }: ProbeProps & { paused?: boolean }) => act(async () => root.render(
    <ClockPausedContext.Provider value={paused}>
        <Probe {...props} />
    </ClockPausedContext.Provider>,
));
const advance = (ms: number) => act(async () => { jest.advanceTimersByTime(ms); });

beforeEach(() => {
    dom = new Window({ url: 'http://localhost' });
    for (const [name, value] of Object.entries({
        window: dom, document: dom.document, navigator: dom.navigator, IS_REACT_ACT_ENVIRONMENT: true,
    })) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    jest.useFakeTimers();
    host = document.createElement('div');
    root = createRoot(host);
});

afterEach(() => {
    act(() => root.unmount());
    jest.useRealTimers();
    dom.happyDOM.abort();
});

describe('useChatActivityTone', () => {
    test('lights a live completion for three seconds and keeps cold history neutral', async () => {
        await render({ turnKey: 'turn', state: 'working', messageId: 'step' });
        expect(tone()).toBe('working');
        await render({ turnKey: 'turn', state: 'done', messageId: 'final' });
        expect(tone()).toBe('done');
        await advance(2999);
        expect(tone()).toBe('done');
        await advance(2);
        expect(tone()).toBe('neutral');

        await render({ turnKey: 'cold', state: 'done', messageId: 'old-final' });
        expect(tone()).toBe('neutral');
    });

    test('keeps a live failure red until a new turn or session, and cold errors neutral', async () => {
        await render({ turnKey: 'turn', state: 'error', messageId: 'failed' });
        expect(tone()).toBe('neutral');
        await advance(5000);
        expect(tone()).toBe('neutral');

        await render({ turnKey: 'turn', state: 'working', messageId: 'step' });
        expect(tone()).toBe('working');
        await render({ turnKey: 'turn', state: 'error', messageId: 'failed' });
        expect(tone()).toBe('error');
        await advance(5000);
        expect(tone()).toBe('error');
        await render({ turnKey: 'turn', state: 'error', messageId: 'failed-detail' });
        expect(tone()).toBe('error');

        await render({ turnKey: 'next-turn', state: 'error', messageId: 'other-failed' });
        expect(tone()).toBe('neutral');
        await render({ turnKey: 'next-turn', state: 'waiting', messageId: 'permission' });
        await render({ turnKey: 'next-turn', state: 'error', messageId: 'denied' });
        expect(tone()).toBe('error');
        await render({ turnKey: 'next-session', state: 'error', messageId: 'session-failed' });
        expect(tone()).toBe('neutral');
    });

    test('pauses the completion clock and clears a pending green on resumed work', async () => {
        await render({ turnKey: 'turn', state: 'working', messageId: 'step' });
        await render({ turnKey: 'turn', state: 'done', messageId: 'final', paused: true });
        expect(tone()).toBe('done');
        await advance(5000);
        expect(tone()).toBe('done');
        await render({ turnKey: 'turn', state: 'done', messageId: 'final' });
        await advance(3001);
        expect(tone()).toBe('neutral');

        await render({ turnKey: 'turn', state: 'working', messageId: 'step-2' });
        await render({ turnKey: 'turn', state: 'done', messageId: 'final-2' });
        expect(tone()).toBe('done');
        await advance(1000);
        await render({ turnKey: 'turn', state: 'working', messageId: 'resumed' });
        expect(tone()).toBe('working');
        await advance(3000);
        expect(tone()).toBe('working');
        await render({ turnKey: 'turn', state: 'done', messageId: 'resumed-final' });
        expect(tone()).toBe('done');
        await advance(3001);
        expect(tone()).toBe('neutral');
    });

    test('a stopped turn and the next session key stay neutral', async () => {
        await render({ turnKey: 'turn', state: 'working', messageId: 'step' });
        await render({ turnKey: 'turn', state: 'stopped', messageId: 'stopped' });
        expect(tone()).toBe('neutral');
        await render({ turnKey: 'turn', state: 'error', messageId: 'stopped-detail' });
        expect(tone()).toBe('neutral');
        await render({ turnKey: 'turn', state: 'waiting', messageId: 'waiting' });
        expect(tone()).toBe('waiting');
        await render({ turnKey: 'next-session', state: 'done', messageId: 'other-final' });
        expect(tone()).toBe('neutral');
    });
});
