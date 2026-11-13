import React, { act } from 'react';
import { Window } from 'happy-dom';
import { describe, expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';

import { OpenCode } from '@opencode/client';
import { SyncProvider } from '@/sync/sync-context';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { I18nProvider } from '@/lib/i18n';
import { useConfigStore } from '@/stores/useConfigStore';
import { useMessageQueueStore, type FollowUpBehavior } from '@/stores/messageQueueStore';

import { MobilePillComposer } from './MobilePillComposer';

const renderPill = async (options: { hasContent: boolean; newSessionDraftOpen: boolean; canAbort?: boolean; dictationEnabled?: boolean; followUpBehavior?: FollowUpBehavior; inspectStop?: boolean }) => {
    const win = new Window({ url: 'http://localhost' });
    Object.defineProperty(win.navigator, 'mediaDevices', {
        value: { getUserMedia: () => Promise.resolve() },
        configurable: true,
    });
    // @ts-expect-error test mock
    win.AudioContext = class {} as unknown as typeof AudioContext;
    useConfigStore.setState({ dictationEnabled: options.dictationEnabled ?? true });
    useMessageQueueStore.setState({ followUpBehavior: options.followUpBehavior ?? 'queue' });
    const values = { window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, IS_REACT_ACT_ENVIRONMENT: true };
    const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
    const outer = document.createElement('div');
    const container = document.createElement('div');
    outer.append(container);
    const root = createRoot(container);
    let primaryActions = 0;
    let abortActions = 0;
    let expandActions = 0;
    let outerClicks = 0;
    outer.addEventListener('click', () => { outerClicks += 1; });
    try {
        await act(async () => root.render(
        <SyncProvider directory="/fixture" sdk={OpenCode.make({ baseUrl: "http://opencode.test", fetch: async () => new Response("[]", { headers: { "content-type": "application/json" } }) })}>
        <ThemeSystemProvider>
        <I18nProvider>
            <MobilePillComposer
                message={options.hasContent ? 'Draft message' : ''}
                sessionId={options.newSessionDraftOpen ? null : 'session-1'}
                newSessionDraftOpen={options.newSessionDraftOpen}
                hasContent={options.hasContent}
                isVSCode={false}
                canAbort={options.canAbort ?? false}
                footerIconButtonClass="icon-button"
                iconSizeClass="icon-size"
                sendIconSizeClass="send-icon-size"
                stopIconSizeClass="stop-icon-size"
                onExpand={() => { expandActions += 1; }}
                onPrimaryAction={() => { primaryActions += 1; }}
                onPickLocalFiles={() => {}}
                onOpenGitHubPicker={() => {}}
                onOpenAttachSheet={() => {}}
                onStartDictation={() => {}}
                onAbort={() => { abortActions += 1; }}
            />
        </I18nProvider>
        </ThemeSystemProvider>
        </SyncProvider>));
        if (options.hasContent) {
            // While a turn runs the follow-up action takes the same path as an
            // idle send; the composer decides there whether to queue or steer.
            const label = options.canAbort && (options.followUpBehavior ?? 'queue') === 'queue' ? 'Queue message' : 'Send message';
            const action = container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
            expect(action).not.toBeNull();
            await act(async () => { action?.click(); });
            expect(primaryActions).toBe(1);
        }
        const stop = container.querySelector<HTMLButtonElement>('[aria-label="Stop generating"]');
        const stopLabel = stop?.getAttribute('aria-label') ?? null;
        const coinCount = container.querySelectorAll('[data-composer-stop-coin]').length;
        const coinInStop = Boolean(stop?.querySelector('[data-composer-stop-coin]'));
        if (options.inspectStop) {
            const primaryBeforeStop = primaryActions;
            await act(async () => { stop?.click(); });
            return {
                markup: container.innerHTML,
                primaryActions: primaryBeforeStop,
                extraPrimaryActions: primaryActions - primaryBeforeStop,
                abortActions, expandActions, outerClicks, stopLabel, coinCount, coinInStop,
            };
        }
        return {
            markup: container.innerHTML,
            primaryActions, abortActions, expandActions, outerClicks, stopLabel, coinCount, coinInStop,
        };
    } finally {
        await act(async () => root.unmount());
        for (const [key, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
        await win.happyDOM.close();
    }
};

describe('MobilePillComposer', () => {
    test('uses the inline action to send content while the session is idle', async () => {
        const { markup, coinCount } = await renderPill({ hasContent: true, newSessionDraftOpen: false });

        expect(markup).toContain('aria-label="Send message"');
        expect(markup).not.toContain('aria-label="Queue message"');
        expect(coinCount).toBe(0);
    });

    test('queues content from inside the pill, between mic and stop, while the session is running', async () => {
        // The expanded composer shows a rotated send icon labelled "Queue
        // message" in this state; the collapsed pill must read the same.
        const { markup, coinCount } = await renderPill({ hasContent: true, newSessionDraftOpen: false, canAbort: true });

        expect(markup).toContain('aria-label="Stop generating"');
        expect(markup).toContain('aria-label="Queue message"');
        expect(markup).toContain('-rotate-90');
        expect(markup).not.toContain('aria-label="Send message"');
        const mic = markup.indexOf('aria-label="Start dictation"');
        const queue = markup.indexOf('aria-label="Queue message"');
        const stop = markup.indexOf('aria-label="Stop generating"');
        expect(mic).toBeLessThan(queue);
        expect(queue).toBeLessThan(stop);
        expect(coinCount).toBe(1);
    });

    test('offers a plain send between mic and stop when follow-ups steer', async () => {
        const { markup } = await renderPill({ hasContent: true, newSessionDraftOpen: false, canAbort: true, followUpBehavior: 'steer' });

        expect(markup).not.toContain('aria-label="Queue message"');
        expect(markup).not.toContain('-rotate-90');
        const mic = markup.indexOf('aria-label="Start dictation"');
        const send = markup.indexOf('aria-label="Send message"');
        const stop = markup.indexOf('aria-label="Stop generating"');
        expect(mic).toBeLessThan(send);
        expect(send).toBeLessThan(stop);
    });

    test('uses the inline send action for content in a new-session draft', async () => {
        const { markup } = await renderPill({ hasContent: true, newSessionDraftOpen: true });

        expect(markup).toContain('aria-label="Send message"');
        expect(markup).not.toContain('aria-label="Queue message"');
    });

    test('shows neither send nor queue for an empty existing session', async () => {
        const { markup } = await renderPill({ hasContent: false, newSessionDraftOpen: false });

        expect(markup).not.toContain('aria-label="Queue message"');
        expect(markup).not.toContain('aria-label="Send message"');
    });

    test('shows neither send nor queue for an empty new-session draft', async () => {
        const { markup } = await renderPill({ hasContent: false, newSessionDraftOpen: true });

        expect(markup).not.toContain('aria-label="Queue message"');
        expect(markup).not.toContain('aria-label="Send message"');
    });

    test('keeps only abort while a session runs without content', async () => {
        const { markup, coinCount } = await renderPill({ hasContent: false, newSessionDraftOpen: false, canAbort: true });

        expect(markup).toContain('aria-label="Stop generating"');
        expect(markup).not.toContain('aria-label="Queue message"');
        expect(markup).not.toContain('aria-label="Send message"');
        expect(coinCount).toBe(1);
    });

    test('aborts in place once from the running pill without expanding or bubbling the tap', async () => {
        const result = await renderPill({ hasContent: false, newSessionDraftOpen: false, canAbort: true, inspectStop: true });

        expect(result.stopLabel).toBe('Stop generating');
        expect(result.coinCount).toBe(1);
        expect(result.coinInStop).toBe(true);
        expect(result.abortActions).toBe(1);
        expect(result.extraPrimaryActions).toBe(0);
        expect(result.expandActions).toBe(0);
        expect(result.outerClicks).toBe(0);
    });

    test('renders the mic button when dictation is enabled and supported', async () => {
        const { markup } = await renderPill({ hasContent: false, newSessionDraftOpen: false, dictationEnabled: true });

        expect(markup).toContain('aria-label="Start dictation"');
    });

    test('hides the mic button when dictation is disabled', async () => {
        const { markup } = await renderPill({ hasContent: false, newSessionDraftOpen: false, dictationEnabled: false });

        expect(markup).not.toContain('aria-label="Start dictation"');
    });
});
