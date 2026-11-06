import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

let dom = new Window({ url: 'http://localhost/' });
const installDOM = () => Object.assign(globalThis, {
    window: dom,
    document: dom.document,
    localStorage: dom.localStorage,
    navigator: dom.navigator,
    Event: dom.Event,
    CustomEvent: dom.CustomEvent,
    PointerEvent: dom.PointerEvent,
    KeyboardEvent: dom.KeyboardEvent,
    PopStateEvent: dom.PopStateEvent,
    HTMLElement: dom.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
});
installDOM();

const { useUIStore } = await import('@/stores/useUIStore');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { useGlobalSessionsStore } = await import('@/stores/useGlobalSessionsStore');
const { persistLastActiveSession, clearLastActiveSession } = await import('@/sync/last-session-cache');
const { beginLastSessionRestore } = await import('@/sync/last-session-restore');
const { getRuntimeKey, getRuntimeApiBaseUrl, switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
const { openSessionLink } = await import('@/lib/router/openSessionFromRoute');
const { useWorkbenchLanding } = await import('./useWorkbenchLanding');
const { useRouter } = await import('@/hooks/useRouter');
const { useMenuActions } = await import('@/hooks/useMenuActions');
const { ThemeSystemContext } = await import('@/contexts/theme-system-context');
const { getDefaultTheme } = await import('@/lib/theme/themes');
const { I18nProvider } = await import('@/lib/i18n');

const WORKBENCH = [{ id: 'openchamber-builtin-workbench' }];
let root: Root;
let container: HTMLDivElement;
let selected = '';
const originalSelect = useSessionUIStore.getState().setCurrentSession;

// The real selection action also starts message/config I/O. Keep the selection
// publication at this boundary; this test exercises landing authority, not I/O.
const selectSession = (id: string | null) => {
    selected = id ?? '';
    useSessionUIStore.setState({ currentSessionId: id, currentSessionDirectory: '/repo' });
    useUIStore.getState().closeMainSurfaces();
};

function Probe({ available }: { available: boolean }) {
    useWorkbenchLanding(available ? WORKBENCH : []);
    return <>
        <button data-action="session" onClick={() => selectSession('existing')}>Open session</button>
        <button data-action="draft" onClick={() => selectSession(null)}>New draft</button>
        <button data-action="send" onClick={() => selectSession('sent')}>Send</button>
        <textarea />
    </>;
}

function Router() { useRouter(); return null; }
function MenuActions() { useMenuActions(); return null; }
const theme = getDefaultTheme(false);
const themeContext: React.ContextType<typeof ThemeSystemContext> = {
    currentTheme: theme, themeMode: 'light', availableThemes: [theme],
    lightThemeId: theme.metadata.id, darkThemeId: theme.metadata.id,
    setTheme: () => {}, setThemeMode: () => {}, setLightThemePreference: () => {}, setDarkThemePreference: () => {},
    customThemeIds: [], customThemesLoading: false, isSystemPreference: false,
    reloadCustomThemes: async () => {}, importTheme: async () => theme,
    deleteImportedTheme: async () => {}, setSystemPreference: () => {},
};

const render = (available = true) => act(async () => { root.render(<Probe available={available} />); });
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 1550)); });
const click = (action: string) => act(async () => {
    const control = container.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
    if (!control) throw new Error('Missing reachable control');
    control.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    control.click();
});

beforeEach(async () => {
    await dom.happyDOM.close();
    dom = new Window({ url: 'http://localhost/' });
    installDOM();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    selected = '';
    useUIStore.getState().closeMainSurfaces();
    useUIStore.getState().setSettingsDialogOpen(false);
    useSessionUIStore.setState({ currentSessionId: null, setCurrentSession: selectSession });
    useGlobalSessionsStore.setState({ hasLoaded: true, status: 'ready', activeSessions: [], archivedSessions: [] });
    clearLastActiveSession(getRuntimeKey());
});

afterEach(async () => {
    await act(async () => root.unmount());
    useSessionUIStore.setState({ setCurrentSession: originalSelect, currentSessionId: null });
    clearLastActiveSession(getRuntimeKey());
    await dom.happyDOM.close();
});

describe('startup workbench landing', () => {
    test('lands on the available workbench when startup is untouched', async () => {
        await render();
        expect(useUIStore.getState().openGuestPageId).toBeNull();
        await settle();
        expect(useUIStore.getState().openGuestPageId).toBe('openchamber-builtin-workbench');
    });

    test.each(['session', 'draft', 'send'])('keeps chat visible after an explicit %s control', async (action) => {
        await render();
        await click(action);
        await settle();
        expect(useUIStore.getState().openGuestPageId).toBeNull();
        expect(selected).toBe(action === 'session' ? 'existing' : action === 'send' ? 'sent' : '');
    });

    test.each(['before', 'after'])('keeps automatic last-session restoration %s mount eligible for the default landing', async (timing) => {
        persistLastActiveSession(getRuntimeKey(), { sessionId: 'restored', directory: '/repo' });
        if (timing === 'before') beginLastSessionRestore({ selectNow: true });
        await act(async () => { root.render(<><Router /><Probe available /></>); });
        if (timing === 'after') beginLastSessionRestore({ selectNow: true });
        expect(selected).toBe('restored');
        expect(window.location.search).toContain('session=restored');
        await settle();
        expect(useUIStore.getState().openGuestPageId).toBe('openchamber-builtin-workbench');
    });

    test('remembers typing before the guest catalog arrives', async () => {
        await render(false);
        const composer = container.querySelector('textarea');
        if (!composer) throw new Error('Missing composer');
        composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
        await render(true);
        await settle();
        expect(useUIStore.getState().openGuestPageId).toBeNull();
    });

    test('preserves a session link received before layout mount and catalog discovery', async () => {
        await openSessionLink('linked', null);
        await render(false);
        await render(true);
        await settle();
        expect(selected).toBe('linked');
        expect(useUIStore.getState().openGuestPageId).toBeNull();
    });

    test('does not replace another full page or rearm after it closes', async () => {
        await render();
        useUIStore.getState().setArchivePageOpen(true);
        await settle();
        expect(useUIStore.getState().isArchivePageOpen).toBe(true);
        expect(useUIStore.getState().openGuestPageId).toBeNull();
        useUIStore.getState().closeMainSurfaces();
        await render(false);
        await render(true);
        await settle();
        expect(useUIStore.getState().openGuestPageId).toBeNull();
    });

    test('leaves chat available when the workbench is disabled or unavailable', async () => {
        await render(false);
        await settle();
        expect(useUIStore.getState().openGuestPageId).toBeNull();
    });

    test('cancels landing when the catalog removes the workbench before the delay ends', async () => {
        await render();
        await render(false);
        await settle();
        expect(useUIStore.getState().openGuestPageId).toBeNull();
    });

    test.each(['?session=linked', '?settings=general', '?tab=git', '?file=src/main.ts'])('keeps the initial %s route before layout mounts', async (query) => {
        window.history.replaceState({}, '', query);
        await act(async () => { root.render(<Router />); });
        await render();
        await settle();
        expect(useUIStore.getState().openGuestPageId).toBeNull();
    });

    test('keeps a native menu choice before layout and catalog discovery', async () => {
        await act(async () => { root.render(
            <I18nProvider><ThemeSystemContext.Provider value={themeContext}><MenuActions /></ThemeSystemContext.Provider></I18nProvider>,
        ); });
        await act(async () => { window.dispatchEvent(new CustomEvent('openchamber:menu-action', { detail: 'settings' })); });
        expect(useUIStore.getState().isSettingsDialogOpen).toBe(true);
        // Closing before MainLayout exists distinguishes retained intent from
        // merely noticing an open overlay when the layout eventually mounts.
        useUIStore.getState().setSettingsDialogOpen(false);
        await render(false);
        await render();
        await settle();
        expect(useUIStore.getState().openGuestPageId).toBeNull();
    });

    test('keeps browser history navigation even when it selects the empty route', async () => {
        await render();
        window.dispatchEvent(new PopStateEvent('popstate'));
        await settle();
        expect(useUIStore.getState().openGuestPageId).toBeNull();
    });

    test('remembers browser history navigation to the empty route before layout mounts', async () => {
        await act(async () => { root.render(<Router />); });
        window.dispatchEvent(new PopStateEvent('popstate'));
        await render();
        await settle();
        expect(useUIStore.getState().openGuestPageId).toBeNull();
    });

    test('does not rearm after applied landing, catalog refresh or layout remount', async () => {
        await render();
        await settle();
        expect(useUIStore.getState().openGuestPageId).toBe('openchamber-builtin-workbench');
        useUIStore.getState().closeMainSurfaces();
        await act(async () => { root.render(null); });
        await render(false);
        await render();
        await settle();
        expect(useUIStore.getState().openGuestPageId).toBeNull();
    });

    test('removes pending timer and input listeners on unmount', async () => {
        await render();
        await act(async () => { root.render(null); });
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
        useUIStore.getState().setArchivePageOpen(true);
        useUIStore.getState().closeMainSurfaces();
        await settle();
        expect(useUIStore.getState().openGuestPageId).toBeNull();
        await render();
        await settle();
        expect(useUIStore.getState().openGuestPageId).toBe('openchamber-builtin-workbench');
    });

    test.each([
        { next: 'other', expected: null },
        { next: 'original', expected: 'openchamber-builtin-workbench' },
    ])('runtime $next change preserves the correct landing authority across remount', async ({ next, expected }) => {
        await render(false);
        window.dispatchEvent(new CustomEvent('openchamber:runtime-endpoint-changed', {
            detail: { previousRuntimeKey: 'original', runtimeKey: next, previousApiBaseUrl: '', apiBaseUrl: '' },
        }));
        await act(async () => { root.render(null); });
        await render();
        await settle();
        expect(useUIStore.getState().openGuestPageId).toBe(expected);
    });

    test.each([
        { name: 'other runtime', hops: ['other'], expected: null },
        { name: 'runtime round trip', hops: ['other', 'original'], expected: null },
        { name: 'same runtime refresh', hops: ['original'], expected: 'openchamber-builtin-workbench' },
    ])('retains authority across an unmounted $name', async ({ hops, expected }) => {
        const previous = { apiBaseUrl: getRuntimeApiBaseUrl(), runtimeKey: getRuntimeKey() };
        const mint = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
            const request = new Request(input, init);
            if (request.url !== 'http://localhost/auth/url-token' || request.method !== 'POST') {
                throw new Error(`Unexpected test request: ${request.method} ${request.url}`);
            }
            return Response.json({ token: 'test-url-token', expiresAt: Date.now() + 60_000, expiresIn: 60 });
        });
        try {
            switchRuntimeEndpoint({ apiBaseUrl: 'http://localhost', runtimeKey: 'original' });
            await render(false);
            await act(async () => { root.render(null); });
            for (const runtimeKey of hops) switchRuntimeEndpoint({ apiBaseUrl: 'http://localhost', runtimeKey });
            await render();
            await settle();
            expect(useUIStore.getState().openGuestPageId).toBe(expected);
        } finally {
            switchRuntimeEndpoint(previous);
            mint.mockRestore();
        }
    });

    test.each([
        { name: 'scheduled tasks', open: () => useUIStore.getState().setScheduledTasksDialogOpen(true) },
        { name: 'integrations', open: () => useUIStore.getState().setIntegrationsCatalogOpen(true) },
        { name: 'usage', open: () => useUIStore.getState().setUsageStatsPageOpen(true) },
        { name: 'source board', open: () => useUIStore.getState().setSourceBoardOpen(true) },
        { name: 'worktrees', open: () => useUIStore.getState().setWorktreesPageProjectId('project') },
        { name: 'spaces', open: () => useUIStore.getState().setSpacesPageProjectId('project') },
        { name: 'run overview', open: () => useUIStore.getState().setRunOverviewKey('run') },
        { name: 'guest page', open: () => useUIStore.getState().setOpenGuestPage('another-guest') },
    ])('remembers opening $name before catalog discovery even if it closes', async ({ open }) => {
        await render(false);
        open();
        useUIStore.getState().closeMainSurfaces();
        await render();
        await settle();
        expect(useUIStore.getState().openGuestPageId).toBeNull();
    });
});
