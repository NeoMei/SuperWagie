import React, { act } from 'react';
import { expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { TrackerItemResult } from '@/lib/api/types';

test('a draft, account or matcher change retires the hook owner before a pending read can attach or send', async () => {
    const browser = new Window({ url: 'http://localhost/' });
    const globals = { window: browser, document: browser.document, navigator: browser.navigator,
        localStorage: browser.localStorage, Element: browser.Element, HTMLElement: browser.HTMLElement,
        Node: browser.Node, MutationObserver: browser.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true };
    const previous = Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
    for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    const { createRoot } = await import('react-dom/client');
    const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
    const { createWebAPIs } = await import('../../../../../web/src/api/index');
    const { I18nProvider } = await import('@/lib/i18n');
    const { useTrackerRegistry } = await import('@/lib/trackers/registry');
    const { unknownTrackerDescriptor } = await import('@/lib/trackers/descriptor');
    const { useTrackerAuthStore } = await import('@/stores/useTrackerAuthStore');
    const { usePastedReferences } = await import('./usePastedReferences');
    const apis = createWebAPIs();
    if (!apis.trackers) throw new Error('Web tracker adapter is required');
    const registryBefore = useTrackerRegistry.getState();
    const authBefore = useTrackerAuthStore.getState();
    const descriptor = { ...unknownTrackerDescriptor('linear'), urlPatterns: [{ host: 'linear.app', path: '^/team/issue/([A-Z]+-[0-9]+)' }] };
    useTrackerRegistry.setState({ ordered: [descriptor], byId: new Map([[descriptor.id, descriptor]]), status: 'ready', holdsList: true });
    useTrackerAuthStore.getState().setStatus('linear', { connected: true, account: { id: 'account-a', name: 'A', current: true } });
    const container = document.createElement('div');
    const root = createRoot(container);
    let latest: ReturnType<typeof usePastedReferences> | undefined;
    let draft = 'draft-a';
    let text = '';
    const Probe = () => {
        latest = usePastedReferences({ directory: null, scopeKey: draft, enabled: true, text: () => text, remove: () => {} });
        return null;
    };
    const render = async () => act(async () => root.render(
        <RuntimeAPIContext.Provider value={apis}><I18nProvider><Probe /></I18nProvider></RuntimeAPIContext.Provider>,
    ));
    let answer: (result: TrackerItemResult) => void = () => {};
    const get = spyOn(apis.trackers, 'get').mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    try {
        await render();
        const changes = [
            () => { draft = 'draft-b'; },
            () => useTrackerAuthStore.getState().setStatus('linear', { connected: true, account: { id: 'account-b', name: 'B', current: true } }),
            () => useTrackerRegistry.setState({ ordered: [{ ...descriptor, name: 'Renamed tracker' }] }),
        ];
        for (const [index, change] of changes.entries()) {
            text = `https://linear.app/team/issue/ENG-${index + 1}`;
            if (!latest) throw new Error('Paste hook did not mount');
            const captured = latest.manager;
            let send = Promise.resolve(false);
            await act(async () => { captured.readPaste(text); send = captured.beforeSend(text); });
            await act(async () => { change(); });
            await render();
            await act(async () => {
                answer({ connected: true, item: { provider: 'linear', id: `item-${index}`, identifier: `ENG-${index + 1}`,
                    title: 'Resolved item', url: text, state: null, description: 'Captured context', comments: [] } });
                expect(await send).toBe(false);
            });
            expect(captured.inText(text)).toEqual([]);
            expect(latest.chips.size).toBe(0);
        }
        expect(get).toHaveBeenCalledTimes(3);
    } finally {
        get.mockRestore();
        await act(async () => root.unmount());
        useTrackerRegistry.setState(registryBefore);
        useTrackerAuthStore.setState(authBefore);
        await browser.happyDOM.abort();
        for (const [name, value] of previous) {
            if (value) Object.defineProperty(globalThis, name, value);
            else Reflect.deleteProperty(globalThis, name);
        }
    }
});
