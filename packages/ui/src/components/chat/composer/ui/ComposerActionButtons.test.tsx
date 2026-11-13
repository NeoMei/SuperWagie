import React, { act } from 'react';
import { Window } from 'happy-dom';
import { describe, expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';

import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { I18nProvider } from '@/lib/i18n';
import { useMessageQueueStore, type FollowUpBehavior } from '@/stores/messageQueueStore';

import { ComposerActionButtons } from './ComposerActionButtons';

// Renders the composer controls and returns what a user can see and do.
const renderComposerActions = async (options: {
    followUpBehavior: FollowUpBehavior;
    canAbort?: boolean;
    clickFollowUp?: boolean;
    clickStop?: boolean;
}) => {
    const { followUpBehavior, canAbort = true, clickFollowUp = true, clickStop = false } = options;
    const win = new Window({ url: 'http://localhost' });
    const values = { window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, IS_REACT_ACT_ENVIRONMENT: true };
    const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
    useMessageQueueStore.setState({ followUpBehavior });
    const container = document.createElement('div');
    const root = createRoot(container);
    let primaryActions = 0;
    let abortActions = 0;
    try {
        await act(async () => root.render(
            <ThemeSystemProvider>
            <I18nProvider>
                <ComposerActionButtons
                    isMobile={false}
                    footerIconButtonClass="icon-button"
                    sendIconSizeClass="send-icon-size"
                    stopIconSizeClass="stop-icon-size"
                    canSend
                    canAbort={canAbort}
                    hasContent
                    currentSessionId="session-1"
                    newSessionDraftOpen={false}
                    onPrimaryAction={() => { primaryActions += 1; }}
                    onAbort={() => { abortActions += 1; }}
                />
            </I18nProvider>
            </ThemeSystemProvider>));
        const action = container.querySelector<HTMLButtonElement>('button.bottom-full');
        const markup = action?.outerHTML ?? '';
        if (clickFollowUp) {
            await act(async () => { action?.click(); });
        }
        const stop = container.querySelector<HTMLButtonElement>('[aria-label="Stop generating"]');
        const stopLabel = stop?.getAttribute('aria-label') ?? null;
        const coinCount = container.querySelectorAll('[data-composer-stop-coin]').length;
        const coinInStop = Boolean(stop?.querySelector('[data-composer-stop-coin]'));
        if (clickStop) {
            await act(async () => { stop?.click(); });
        }
        return { markup, primaryActions, abortActions, stopLabel, coinCount, coinInStop };
    } finally {
        await act(async () => root.unmount());
        for (const [key, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
        await win.happyDOM.close();
    }
};

describe('ComposerActionButtons', () => {
    test('queues a follow-up through the send path when follow-ups queue', async () => {
        const { markup, primaryActions } = await renderComposerActions({ followUpBehavior: 'queue' });

        expect(markup).toContain('aria-label="Queue message"');
        expect(markup).toContain('-rotate-90');
        expect(primaryActions).toBe(1);
    });

    test('shows a plain send that steers when follow-ups steer', async () => {
        const { markup, primaryActions } = await renderComposerActions({ followUpBehavior: 'steer' });

        expect(markup).toContain('aria-label="Send message"');
        expect(markup).not.toContain('-rotate-90');
        expect(primaryActions).toBe(1);
    });

    test('keeps the running session stop control accessible and aborts once', async () => {
        const result = await renderComposerActions({ followUpBehavior: 'queue', clickFollowUp: false, clickStop: true });

        expect(result.stopLabel).toBe('Stop generating');
        expect(result.coinCount).toBe(1);
        expect(result.coinInStop).toBe(true);
        expect(result.abortActions).toBe(1);
        expect(result.primaryActions).toBe(0);
    });

    test('shows no stop coin while the session is idle', async () => {
        const result = await renderComposerActions({ followUpBehavior: 'queue', canAbort: false, clickFollowUp: false });

        expect(result.stopLabel).toBeNull();
        expect(result.coinCount).toBe(0);
        expect(result.coinInStop).toBe(false);
        expect(result.abortActions).toBe(0);
    });
});
