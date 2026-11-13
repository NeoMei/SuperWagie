import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { StatusRow } from '../StatusRow';
import ScrollToBottomButton from './ScrollToBottomButton';
import { ChatActivityToneDot } from './ChatActivityTone';
import { ChatActivityToneHost } from './ChatActivityToneHost';
import { ChatColumnSessionContext } from '../chatColumnSession';
import { I18nProvider } from '@/lib/i18n';
import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';

const css = readFileSync(new URL('../../../index.css', import.meta.url), 'utf8');
const theme = getDefaultTheme(false);
const themeContext: ThemeContextValue = {
    currentTheme: theme, availableThemes: [theme], customThemeIds: [], customThemesLoading: false,
    setTheme: () => undefined,
    reloadCustomThemes: async () => undefined,
    importTheme: async () => theme,
    deleteImportedTheme: async () => undefined,
    isSystemPreference: false, setSystemPreference: () => undefined,
    themeMode: 'light', setThemeMode: () => undefined,
    lightThemeId: theme.metadata.id, darkThemeId: theme.metadata.id,
    setLightThemePreference: () => undefined, setDarkThemePreference: () => undefined,
};
let host: HTMLElement;
let root: Root;
let dom: Window;

const dots = () => [...host.querySelectorAll<HTMLElement>('.oc-activity-tone')];
const render = (element: React.ReactElement) => act(async () => root.render(
    <I18nProvider><ThemeSystemContext.Provider value={themeContext}>
        <ChatColumnSessionContext.Provider value={{ sessionId: 'ses', directory: '/project' }}>
            {element}
        </ChatColumnSessionContext.Provider>
    </ThemeSystemContext.Provider></I18nProvider>,
));

beforeEach(() => {
    dom = new Window({ url: 'http://localhost' });
    for (const [name, value] of Object.entries({
        window: dom, document: dom.document, navigator: dom.navigator,
        localStorage: dom.localStorage, customElements: dom.customElements,
        Node: dom.Node, Text: dom.Text, HTMLElement: dom.HTMLElement,
        getComputedStyle: dom.getComputedStyle.bind(dom),
        ResizeObserver: dom.ResizeObserver, MutationObserver: dom.MutationObserver,
        requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
        cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
        IS_REACT_ACT_ENVIRONMENT: true,
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

describe('chat activity tone hosts', () => {
    test('one mark is decorative, uses theme tokens, and breathes only in active states', async () => {
        await render(<ChatActivityToneDot tone="working" />);
        expect(dots()).toHaveLength(1);
        expect(dots()[0].getAttribute('aria-hidden')).toBe('true');
        expect(dots()[0].getAttribute('data-activity-tone')).toBe('working');
        expect(dots()[0].className).not.toContain('waiting-dim');
        expect(dots()[0].className).toContain('oc-activity-mark--breathing');

        await render(<ChatActivityToneDot tone="done" />);
        expect(dots()[0].className).not.toContain('oc-activity-mark--breathing');
        await render(<ChatActivityToneDot tone="waiting" />);
        expect(dots()[0].className).toContain('oc-activity-mark--breathing');

        for (const [tone, token] of [
            ['working', 'var(--status-warning)'],
            ['waiting', 'color-mix(in srgb, var(--status-warning) 65%, var(--status-error))'],
            ['error', 'var(--status-error)'],
            ['done', 'var(--status-success)'],
        ] as const) {
            expect(css).toContain(".oc-activity-tone[data-activity-tone='" + tone + "'] {");
            expect(css).toContain('--oc-activity-color: ' + token + ';');
        }
        expect(css).toContain('.oc-activity-mark__dot,\n  .oc-activity-mark__logo {\n    background-color: CanvasText;');
        expect(css).not.toContain('.oc-activity-header[data-activity-tone=');
    });

    test('the working row shows its provider mark once and the text stays neutral', async () => {
        await render(<StatusRow
            isWorking
            tone="working"
            showTone
            providerId="superwagie-account-operation"
            status={{ key: 'chat.agentStatus.thinking', seed: 'reasoning-0' }}
        />);
        expect(dots()).toHaveLength(1);
        expect(dots()[0].querySelector('.oc-activity-mark__logo')).not.toBeNull();
        expect(host.querySelectorAll('img')).toHaveLength(1);
        expect(host.querySelector('[role="status"].text-muted-foreground')).not.toBeNull();
    });

    test('a provider without a logo keeps the fallback dot and never leaves an empty mark', async () => {
        await render(<ChatActivityToneDot tone="working" providerId="" />);
        expect(dots()[0].querySelector('.oc-activity-mark__dot')).not.toBeNull();
        expect(dots()[0].querySelector('.oc-activity-mark__logo')).toBeNull();
    });

    test('the working row owns the dot and leaves its long status phrase neutral', async () => {
        await render(<StatusRow
            isWorking
            tone="working"
            showTone
            status={{ key: 'chat.agentStatus.thinking', seed: 'reasoning-0' }}
        />);
        expect(dots()).toHaveLength(1);
        expect(host.querySelector('[role="status"].text-muted-foreground')).not.toBeNull();
        await render(<StatusRow isWorking={false} tone="done" showTone status={null} />);
        expect(dots()).toHaveLength(0);
    });

    test('the pill and terminal-only layer each mount one zero-measurement dot', async () => {
        await render(<ScrollToBottomButton visible tone="error" showTone onClick={() => undefined} />);
        expect(dots()).toHaveLength(1);
        expect(dots()[0].getAttribute('data-activity-tone')).toBe('error');
        await render(<ScrollToBottomButton visible={false} tone="done" showTone onClick={() => undefined} />);
        expect(dots()).toHaveLength(0);

        await render(<ChatActivityToneHost tone="done" />);
        expect(dots()).toHaveLength(1);
        expect(host.querySelector('[data-chat-activity-tone="standalone"]')?.className).toContain('h-0');
    });
});
