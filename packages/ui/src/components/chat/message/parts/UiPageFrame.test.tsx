import React, { act } from 'react';
import { expect, spyOn, test } from 'bun:test';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import { z } from 'zod';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { RuntimeAPIs } from '@/lib/api/types';
import { I18nProvider } from '@/lib/i18n';
import { SyncProvider } from '@/sync/sync-context';
import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';
import type { ToolPart } from '@/lib/opencode/model';

plugin({ name: 'ui-page-worker-url', setup(build) {
    build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, ({ path }) => ({
        contents: `export default ${JSON.stringify(pathToFileURL(path.split('?')[0]).href)};`, loader: 'js',
    }));
} });
const { ShownPage } = await import('./HtmlRenderFrame');
const answerPayload = z.object({ sessionId: z.string(), callId: z.string(), summary: z.string(), data: z.json() }).strict();
const theme = getDefaultTheme(false);
const themeContext: ThemeContextValue = {
    currentTheme: theme, availableThemes: [theme], customThemeIds: [], setTheme: () => {}, customThemesLoading: false,
    reloadCustomThemes: async () => {}, importTheme: async () => theme, deleteImportedTheme: async () => {},
    isSystemPreference: false, setSystemPreference: () => {}, themeMode: 'light', setThemeMode: () => {},
    lightThemeId: theme.metadata.id, darkThemeId: theme.metadata.id, setLightThemePreference: () => {}, setDarkThemePreference: () => {},
};
const unavailable = (): never => { throw new Error('Page rendering must not invoke privileged runtime capabilities'); };
const runtime: RuntimeAPIs = {
    runtime: { platform: 'web', isDesktop: false, isVSCode: false },
    get terminal() { return unavailable(); }, get git() { return unavailable(); }, get files() { return unavailable(); },
    get settings() { return unavailable(); }, get permissions() { return unavailable(); }, get notifications() { return unavailable(); },
    get sourceControl() { return unavailable(); },
};
const page = (source: string, waiting: boolean): ToolPart => ({
    id: 'ui-page', sessionID: 'ui-session', messageID: 'ui-message', callID: 'ui-call', tool: 'openchamber_render', type: 'tool',
    state: waiting
        ? { status: 'running', input: { action: 'render.page', parameters: { ui: source, awaitAnswer: true } }, metadata: {}, time: { start: 1 } }
        : { status: 'completed', input: { action: 'render.page', parameters: { ui: source } }, output: '', metadata: { openchamber: { ok: true } }, time: { start: 1, end: 2 } },
});

async function withPage(part: ToolPart, check: (container: HTMLElement, answers: z.infer<typeof answerPayload>[]) => Promise<void> | void) {
    const browser = new Window({ url: 'http://ui-page.test' });
    class EventSocket extends EventTarget {
        static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
        readyState = 0; send() {} close() { this.readyState = 3; }
    }
    const globals = { WebSocket: EventSocket, window: browser, document: browser.document, navigator: browser.navigator,
        localStorage: browser.localStorage, sessionStorage: browser.sessionStorage, HTMLElement: browser.HTMLElement,
        HTMLAnchorElement: browser.HTMLAnchorElement, Element: browser.Element, Node: browser.Node, Text: browser.Text,
        Event: browser.Event, MouseEvent: browser.MouseEvent, SVGElement: browser.SVGElement, Range: browser.Range,
        customElements: browser.customElements, MutationObserver: browser.MutationObserver, DOMParser: browser.DOMParser,
        XMLSerializer: browser.XMLSerializer, CustomEvent: browser.CustomEvent, getComputedStyle: browser.getComputedStyle.bind(browser),
        ResizeObserver: browser.ResizeObserver, IntersectionObserver: browser.IntersectionObserver,
        requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
        IS_REACT_ACT_ENVIRONMENT: true };
    const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    const answers: z.infer<typeof answerPayload>[] = [];
    const respond = async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(input instanceof Request ? input.url : String(input), 'http://ui-page.test').pathname;
        if (path === '/api/openchamber/render/answer') {
            answers.push(answerPayload.parse(JSON.parse(String(init?.body))));
            return Response.json({ ok: true });
        }
        if (path.endsWith('/event') || path.endsWith('/events')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
        if (path === '/api/fs/home') return Response.json({ home: '/synthetic', chatsRoot: '/synthetic/chats' });
        if (path === '/api/session-warming') return Response.json({ revision: 0, enabled: false, minutes: 60, sessions: [] });
        return Response.json({ data: [] });
    };
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(respond);
    const sdk = OpenCode.make({ baseUrl: 'http://ui-page.test', fetch: respond });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
        await act(async () => root.render(<RuntimeAPIContext.Provider value={runtime}><I18nProvider>
            <ThemeSystemContext.Provider value={themeContext}><SyncProvider sdk={sdk} directory="">
                <ShownPage part={part} />
            </SyncProvider></ThemeSystemContext.Provider>
        </I18nProvider></RuntimeAPIContext.Provider>));
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
        await check(container, answers);
    } finally {
        await act(async () => root.unmount());
        fetch.mockRestore();
        await browser.happyDOM.abort();
        for (const [key, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
    }
}

test('a finished UI page from history draws native content rather than an empty iframe', async () => {
    await withPage(page('root = Stack([Badge("Historical result", "success")])', false), (container, answers) => {
        expect(container.querySelector('iframe') === null).toBe(true);
        expect(container.textContent).toContain('Historical result');
        expect(answers).toHaveLength(0);
    });
});

test('a waiting native UI page submits through the existing summary and data answer route', async () => {
    await withPage(page('root = Stack([Button("Continue", "primary", "continue")])', true), async (container, answers) => {
        const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent === 'Continue');
        expect(button !== undefined).toBe(true);
        await act(async () => button?.click());
        expect(answers).toHaveLength(1);
        expect(answers[0]).toMatchObject({ sessionId: 'ui-session', callId: 'ui-call', data: { button: 'Continue', value: 'continue', values: {} } });
        expect(container.querySelector('[data-waiting-page]') === null).toBe(true);
    });
});

test('invalid UI programs retain visible errors and source without unsupported answer requests', async () => {
    const source = 'root = Stack([missing])';
    await withPage(page(source, true), async (container, answers) => {
        expect(container.textContent).toContain('Undefined names: missing');
        const toggle = Array.from(container.querySelectorAll('button')).find((item) => item.textContent === 'Source');
        await act(async () => toggle?.click());
        expect(container.querySelector('pre')?.hidden).toBe(false);
        expect(container.querySelector('pre')?.textContent).toContain(source);
        expect(answers).toHaveLength(0);
    });
});
