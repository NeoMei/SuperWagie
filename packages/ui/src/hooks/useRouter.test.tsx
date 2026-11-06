import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionPage } from '@/lib/opencode/client';

let dom = new Window({ url: 'http://localhost/' });
const installDOM = () => Object.assign(globalThis, {
    window: dom, document: dom.document, localStorage: dom.localStorage,
    navigator: dom.navigator, Event: dom.Event, CustomEvent: dom.CustomEvent,
    PopStateEvent: dom.PopStateEvent, HTMLElement: dom.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
});
installDOM();
const { useRouter } = await import('@/hooks/useRouter');
const { useUIStore } = await import('@/stores/useUIStore');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { useGlobalSessionsStore } = await import('@/stores/useGlobalSessionsStore');
const { useDirectoryStore } = await import('@/stores/useDirectoryStore');
const { navigateFromNotification } = await import('@/lib/router/notificationNavigation');
const { opencodeClient } = await import('@/lib/opencode/client');
const originalSelect = useSessionUIStore.getState().setCurrentSession;
let root: Root;
const deferredPage = () => {
    let resolve!: (value: SessionPage) => void;
    const promise = new Promise<SessionPage>((fulfill) => { resolve = fulfill; });
    return { promise, resolve };
};
let page = deferredPage();
const homeSpy = spyOn(opencodeClient, 'getFilesystemHomeInfo').mockResolvedValue({ home: '/audit', chatsRoot: '/audit/chats' });
const listSpy = spyOn(opencodeClient, 'listSessionsPage').mockImplementation(() => page.promise);
// Keep synchronous selection/directory publication; message/config I/O is outside this hook test.
const selectSession = (id: string | null, directory?: string | null) => {
    const resolvedDirectory = directory ?? useDirectoryStore.getState().currentDirectory;
    useSessionUIStore.setState({ currentSessionId: id, currentSessionDirectory: resolvedDirectory });
    useDirectoryStore.setState({ currentDirectory: resolvedDirectory });
};

function Probe() {
    useRouter();
    return <>
        <button onClick={() => { useUIStore.getState().setSettingsPage('appearance'); useUIStore.getState().setSettingsDialogOpen(true); }}>Open appearance</button>
        <button onClick={() => selectSession('newer')}>Select newer session</button>
    </>;
}
const mount = (query: string) => act(async () => {
    window.history.replaceState({}, '', query);
    root.render(<Probe />);
});
const click = (label: string) => act(async () => {
    const control = [...document.querySelectorAll('button')].find(button => button.textContent === label);
    if (!control) throw new Error('Missing control: ' + label);
    control.click();
});
const release = (result: SessionPage = { sessions: [], cursor: {} }) => act(async () => {
    page.resolve(result);
    await page.promise;
});
const snapshot = () => ({
    settingsOpen: useUIStore.getState().isSettingsDialogOpen,
    settingsPage: useUIStore.getState().settingsPage,
    session: useSessionUIStore.getState().currentSessionId,
    search: window.location.search,
});

beforeEach(async () => {
    await dom.happyDOM.close();
    dom = new Window({ url: 'http://localhost/' });
    installDOM();
    root = createRoot(document.body.appendChild(document.createElement('div')));
    page = deferredPage();
    listSpy.mockClear();
    useGlobalSessionsStore.getState().resetForRuntimeSwitch();
    useUIStore.getState().setSettingsDialogOpen(false);
    useUIStore.getState().setSettingsPage('home');
    useUIStore.setState({ contextPanelByDirectory: {}, pendingDiffFile: null });
    useDirectoryStore.setState({ currentDirectory: '/repo' });
    useSessionUIStore.setState({ currentSessionId: 'linked', currentSessionDirectory: '/repo', setCurrentSession: selectSession });
});
afterEach(async () => {
    await release();
    await act(async () => root.unmount());
    useSessionUIStore.setState({ setCurrentSession: originalSelect, currentSessionId: null });
    await dom.happyDOM.close();
});

test('untouched startup still applies its explicit Settings route', async () => {
    await mount('?session=linked&settings=appearance');
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(useGlobalSessionsStore.getState().hasLoaded).toBe(false);
    await release();
    expect(snapshot()).toEqual({ settingsOpen: true, settingsPage: 'appearance', session: 'linked', search: '?session=linked&settings=appearance' });
});

test('opening Settings during the actual session-list read survives completion', async () => {
    await mount('?session=linked');
    expect(listSpy).toHaveBeenCalledTimes(1);
    await click('Open appearance');
    expect(useUIStore.getState().isSettingsDialogOpen).toBe(true);
    await release();
    expect(snapshot()).toEqual({ settingsOpen: true, settingsPage: 'appearance', session: 'linked', search: '?session=linked&settings=appearance' });
});

test('selecting another session during the actual session-list read keeps its URL', async () => {
    await mount('?session=linked');
    expect(listSpy).toHaveBeenCalledTimes(1);
    await click('Select newer session');
    await release();
    expect(snapshot()).toEqual({ settingsOpen: false, settingsPage: 'home', session: 'newer', search: '?session=newer' });
});

test('a newer Settings page survives completion of an explicit initial Settings route', async () => {
    await mount('?session=linked&settings=home');
    expect(listSpy).toHaveBeenCalledTimes(1);
    await click('Open appearance');
    await release();
    expect(snapshot()).toEqual({ settingsOpen: true, settingsPage: 'appearance', session: 'linked', search: '?session=linked&settings=appearance' });
});

// These transport spies are process-local. No module implementation is mocked.
afterAll(() => { homeSpy.mockRestore(); listSpy.mockRestore(); });

const worktreePage: SessionPage = {
    sessions: [{
        id: 'unknown', projectID: 'project', directory: '/worktree', title: 'Linked session',
        cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 1 },
    }],
    cursor: {},
};

test('a legacy Files link waits for the unknown session worktree', async () => {
    await mount('?session=unknown&tab=files');
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe('/repo');
    expect(useUIStore.getState().contextPanelByDirectory).toEqual({});
    await release(worktreePage);
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe('/worktree');
    expect(useUIStore.getState().contextPanelByDirectory['/repo']).toBeUndefined();
    expect(useUIStore.getState().contextPanelByDirectory['/worktree']?.tabs.map(tab => tab.mode)).toEqual(['file']);
});

test.each(['settings', 'context', 'history', 'notification', 'unmount'])('a newer %s choice retires a pending workspace link', async (intent) => {
    await mount('?session=unknown&tab=files');
    await act(async () => {
        if (intent === 'settings') {
            useUIStore.getState().setSettingsDialogOpen(true);
            useUIStore.getState().setSettingsDialogOpen(false);
        } else if (intent === 'context') {
            useUIStore.getState().openContextSurface('/repo', 'git');
        } else if (intent === 'history') {
            window.history.pushState({}, '', '/');
            window.dispatchEvent(new PopStateEvent('popstate'));
        } else if (intent === 'notification') {
            expect(navigateFromNotification('http://localhost/?session=newer&settings=appearance')).toBe(true);
        } else {
            root.render(null);
        }
    });
    await release(worktreePage);
    expect(useUIStore.getState().contextPanelByDirectory['/worktree']).toBeUndefined();
    if (intent === 'context') expect(useUIStore.getState().contextPanelByDirectory['/repo']?.tabs.map(tab => tab.mode)).toEqual(['git']);
    if (intent === 'notification') {
        expect(useSessionUIStore.getState().currentSessionId).toBe('newer');
        expect(useUIStore.getState().isSettingsDialogOpen).toBe(true);
        expect(useUIStore.getState().settingsPage).toBe('appearance');
        expect(window.location.search).toBe('?session=newer&settings=appearance');
    }
});
