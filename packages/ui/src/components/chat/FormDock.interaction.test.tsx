import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from 'bun:test';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import type { FormRequest, Session } from '@/lib/opencode/model';
import { opencodeClient } from '@/lib/opencode/client';
import { I18nProvider, useI18nStore } from '@/lib/i18n';
import { SyncProvider, useChildStoreManager } from '@/sync/sync-context';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { ChatColumnSessionContext } from './chatColumnSession';

let FormDock: typeof import('./FormDock')['FormDock'];

plugin({
    name: 'form-dock-worker-url',
    setup(build) {
        build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, ({ path }) => ({
            contents: `export default ${JSON.stringify(pathToFileURL(path.split('?')[0]).href)};`, loader: 'js',
        }));
    },
});

const sdk = OpenCode.make({
    baseUrl: 'http://localhost',
    fetch: async (request) => {
        const path = new URL(request instanceof Request ? request.url : request.toString()).pathname;
        if (path.endsWith('/event')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
        return Response.json([]);
    },
});
const session: Session = {
    id: 'session', projectID: 'project', directory: '/project', title: 'Conversation',
    time: { created: 1, updated: 1 }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
};
const form = (id: string, title: string): FormRequest => ({
    id, sessionID: 'session', title,
    fields: [{
        key: 'choice', title: 'Choose a direction', type: 'string', required: true,
        options: [{ label: 'Continue', value: 'continue' }, { label: 'Revise', value: 'revise' }],
    }],
});

function SeedForms({ forms }: { forms: FormRequest[] }) {
    const manager = useChildStoreManager();
    React.useLayoutEffect(() => {
        manager.ensureChild('/project', { bootstrap: false }).setState({
            status: 'complete', session: [session], form: { session: forms }, permission: {},
        });
    }, [forms, manager]);
    return null;
}

function Harness({ forms }: { forms: FormRequest[] }) {
    return (
        <SyncProvider sdk={sdk} directory="">
            <I18nProvider>
                <ChatColumnSessionContext.Provider value={{ sessionId: 'session', directory: '/project' }}>
                    <main data-composer-bound="true">
                        <SeedForms forms={forms} />
                        <FormDock sessionId="session" directory="/project" hidden={false} />
                    </main>
                </ChatColumnSessionContext.Provider>
            </I18nProvider>
        </SyncProvider>
    );
}

setDefaultTimeout(30_000);

describe('the question dock interaction', () => {
    let root: Root;
    let container: HTMLDivElement;
    let restoreGlobals: () => void;
    let restoreFetch: () => void;
    let win: Window;
    let rejectReply = false;
    const requests: Array<{ method: string; path: string; directory: string | null; body: string }> = [];

    beforeEach(async () => {
        win = new Window({ url: 'http://localhost' });
        const globals = {
            window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage,
            customElements: win.customElements, Node: win.Node, NodeList: win.NodeList,
            Element: win.Element, HTMLElement: win.HTMLElement, SVGElement: win.SVGElement,
            MutationObserver: win.MutationObserver, ResizeObserver: win.ResizeObserver,
            requestAnimationFrame: win.requestAnimationFrame.bind(win),
            cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
            getComputedStyle: win.getComputedStyle.bind(win), IS_REACT_ACT_ENVIRONMENT: true,
        };
        const previous = Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
        for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
        restoreGlobals = () => {
            for (const [name, descriptor] of previous) {
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else Reflect.deleteProperty(globalThis, name);
            }
        };
        // Keep the generated SDK, actions and store cleanup real. Only the
        // network boundary is replaced; the SyncProvider's read SDK is separate.
        const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
            const resolved = input instanceof Request ? input : new URL(input, 'http://localhost');
            const request = new Request(resolved, init);
            const path = new URL(request.url).pathname;
            if (!path.includes('/form/')) {
                if (path === '/api/fs/home') return Response.json({ home: '/home' });
                if (path === '/api/location') return Response.json({ directory: '/project', project: { id: 'project', directory: '/project', canonical: '/project' } });
                if (path === '/api/config') return Response.json([]);
                if (path === '/api/project') return Response.json([]);
                if (path === '/api/session-warming') return Response.json({ revision: 0, enabled: false, minutes: 60, sessions: [] });
                throw new Error(`Unexpected request: ${request.method} ${path}`);
            }
            requests.push({ method: request.method, path, directory: request.headers.get('x-opencode-directory'), body: await request.text() });
            if (rejectReply && request.method === 'POST') return Response.json({ message: 'Temporarily unavailable' }, { status: 500 });
            return new Response(null, { status: 204 });
        });
        restoreFetch = () => fetch.mockRestore();
        requests.length = 0;
        rejectReply = false;
        useConfigStore.setState({ isConnected: true, hasEverConnected: true });
        useUIStore.setState({ isMobile: false });
        useI18nStore.getState().setLocale('en');
        opencodeClient.reconnectToRuntimeBaseUrl();
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
        ({ FormDock } = await import('./FormDock'));
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        await win.happyDOM.abort();
        restoreFetch();
        restoreGlobals();
    });

    const button = (label: string): HTMLButtonElement => {
        const found = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((entry) => entry.textContent?.trim() === label);
        if (!found) throw new Error(`Missing button: ${label}`);
        return found;
    };

    test('opens the question with answer controls and submits the chosen answer without waiting for an event', async () => {
        await act(async () => root.render(<Harness forms={[form('submit-question', 'Select an approach')]} />));

        expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Select an approach');
        expect(container.textContent).toContain('Choose a direction');
        expect(button('Submit').disabled).toBe(true);
        await act(async () => button('Continue').click());
        expect(container.querySelector('[role="radio"][aria-checked="true"]')).not.toBeNull();
        expect(button('Submit').disabled).toBe(false);
        await act(async () => button('Submit').click());

        expect(requests).toEqual([{
            method: 'POST', path: '/api/session/session/form/submit-question/reply',
            directory: '%2Fproject', body: '{"answer":{"choice":"continue"}}',
        }]);
        expect(container.querySelectorAll('[role="dialog"]').length).toBe(0);
    });

    test('dismisses the current question and opens the next request with fresh answer controls', async () => {
        await act(async () => root.render(<Harness forms={[
            form('dismiss-question', 'First question'), form('next-question', 'Second question'),
        ]} />));
        await act(async () => button('Continue').click());
        await act(async () => button('Dismiss').click());

        expect(requests).toEqual([{
            method: 'DELETE', path: '/api/session/session/form/dismiss-question', directory: '%2Fproject', body: '',
        }]);
        expect(container.querySelectorAll('[role="dialog"]').length).toBe(1);
        expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Second question');
        expect(button('Submit').disabled).toBe(true);
        expect(container.querySelector('[role="radio"][aria-checked="true"]')).toBeNull();
        await act(async () => button('Revise').click());
        await act(async () => button('Submit').click());
        expect(requests[1]).toEqual({
            method: 'POST', path: '/api/session/session/form/next-question/reply',
            directory: '%2Fproject', body: '{"answer":{"choice":"revise"}}',
        });
        expect(container.querySelectorAll('[role="dialog"]').length).toBe(0);
    });

    test('keeps the selected answer available after a failed submission so the user can retry', async () => {
        rejectReply = true;
        await act(async () => root.render(<Harness forms={[form('retry-question', 'Retry question')]} />));
        await act(async () => button('Revise').click());
        await act(async () => button('Submit').click());

        expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Retry question');
        expect(container.querySelector('[role="radio"][aria-checked="true"]')).not.toBeNull();
        expect(button('Submit').disabled).toBe(false);
        expect(requests).toHaveLength(1);
        rejectReply = false;
        await act(async () => button('Submit').click());

        expect(requests).toHaveLength(2);
        expect(requests.map((request) => request.body)).toEqual([
            '{"answer":{"choice":"revise"}}', '{"answer":{"choice":"revise"}}',
        ]);
        expect(container.querySelectorAll('[role="dialog"]').length).toBe(0);
    });
});
