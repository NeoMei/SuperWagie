import React, { act } from 'react';
import { expect, spyOn, test } from 'bun:test';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import { requestReasoningReveal } from '../../search/reasoningReveal';
import type { ReasoningPart, ToolPart as ToolPartData } from '@/lib/opencode/model';
import { SyncProvider } from '@/sync/sync-context';
import { I18nProvider, useI18nStore } from '@/lib/i18n';
import { getChatQuoteSourceMessageId } from '@/lib/chatQuoteAnchor';
import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';
import { useUIStore } from '@/stores/useUIStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useGuestsStore } from '@/lib/guests/store';

plugin({
    name: 'command-execution-worker-url',
    setup(build) {
        build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, ({ path }) => ({
            contents: `export default ${JSON.stringify(pathToFileURL(path.split('?')[0]).href)};`,
            loader: 'js',
        }));
    },
});

const { CommandActivityGroup } = await import('./CommandActivityGroup');

const theme = getDefaultTheme(false);
const themeContext: ThemeContextValue = {
  currentTheme: theme, availableThemes: [theme], customThemeIds: [], setTheme: () => {}, customThemesLoading: false,
  reloadCustomThemes: async () => {}, importTheme: async () => theme, deleteImportedTheme: async () => {},
  isSystemPreference: false, setSystemPreference: () => {}, themeMode: 'light', setThemeMode: () => {},
  lightThemeId: theme.metadata.id, darkThemeId: theme.metadata.id, setLightThemePreference: () => {}, setDarkThemePreference: () => {},
};


const command = (id: string, status: 'running' | 'completed' | 'error', output = 'first line\nlast line'): ToolPartData => ({
    id, sessionID: 'ses_command', messageID: 'msg_command', callID: id, type: 'tool', tool: 'shell',
    state: status === 'running'
        ? { status, input: { command: `echo ${id}`, description: 'secret description' }, metadata: { output }, time: { start: 1 } }
        : status === 'completed'
            ? { status, input: { command: `echo ${id}` }, output, metadata: {}, time: { start: 1, end: 2 } }
            : { status, input: { command: `echo ${id}` }, error: 'permission denied', metadata: { output }, time: { start: 1, end: 2 } },
});

const withCommands = async (run: (harness: {
    container: HTMLElement;
    render: (parts: (ToolPartData | ReasoningPart)[], externalExpanded?: boolean) => Promise<void>;
    click: (id: string) => Promise<void>;
    header: (id: string) => HTMLElement;
}) => Promise<void>, autoExpand = true) => {
    const happyWindow = new Window({ url: 'http://localhost' });
    class EventSocket extends EventTarget {
        static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
        readyState = 0; send() {} close() { this.readyState = 3; }
    }
    const globals = {
        WebSocket: EventSocket,
        window: happyWindow, document: happyWindow.document, navigator: happyWindow.navigator,
        localStorage: happyWindow.localStorage, customElements: happyWindow.customElements,
        Node: happyWindow.Node, Text: happyWindow.Text, NodeList: happyWindow.NodeList,
        Element: happyWindow.Element, HTMLElement: happyWindow.HTMLElement, SVGElement: happyWindow.SVGElement,
        CustomEvent: happyWindow.CustomEvent, CSS: happyWindow.CSS,
        requestAnimationFrame: happyWindow.requestAnimationFrame.bind(happyWindow),
        cancelAnimationFrame: happyWindow.cancelAnimationFrame.bind(happyWindow),
        getComputedStyle: happyWindow.getComputedStyle.bind(happyWindow),
        ResizeObserver: happyWindow.ResizeObserver, MutationObserver: happyWindow.MutationObserver,
        IS_REACT_ACT_ENVIRONMENT: true,
    };
    const previous = Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
    for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const responseFor = (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes('/api/session-warming')) return Response.json({ revision: 0, enabled: false, minutes: 60, sessions: [] });
        if (url.includes('/event')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
        return Response.json(url.endsWith('/session/active') ? {} : { data: [] });
    };
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input) => responseFor(input));
    const sdk = OpenCode.make({ baseUrl: 'http://sync.test', fetch: async (input) => responseFor(input) });
    const previousPreference = useUIStore.getState().expandReasoningWhileStreaming;
    const previousDirectory = useDirectoryStore.getState().currentDirectory;
    const previousGuests = useGuestsStore.getState();
    const previousI18n = useI18nStore.getState();
    useI18nStore.getState().setLocale('en');
    useUIStore.setState({ expandReasoningWhileStreaming: autoExpand });
    useDirectoryStore.setState({ currentDirectory: '/synthetic/command-group' });
    useGuestsStore.setState({ status: 'ready', guests: [], runtimeKey: 'test' });
    const Rows = ({ parts, externalExpanded }: { parts: (ToolPartData | ReasoningPart)[]; externalExpanded: boolean }) => {
        const [expanded, setExpanded] = React.useState(externalExpanded);
        const [handledExternal, setHandledExternal] = React.useState(externalExpanded);
        if (externalExpanded !== handledExternal) {
            setHandledExternal(externalExpanded);
            setExpanded(externalExpanded);
        }
        return <CommandActivityGroup id={parts[0]?.id ?? 'empty'} parts={parts}
            isExpanded={expanded} isMobile={false}
            onToggle={() => setExpanded((previous) => !previous)} />;
    };
    const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 240)); });
    const header = (id: string) => {
        const result = container.querySelector<HTMLElement>(`[data-command-fold="${id}"] [data-command-header]`);
        if (!result) throw new Error(`Missing command header ${id}`);
        return result;
    };
    try {
        await run({
            container, header,
            render: async (parts, externalExpanded = false) => {
                await act(async () => root.render(<SyncProvider sdk={sdk} directory="/synthetic/command-group"><I18nProvider><ThemeSystemContext.Provider value={themeContext}>
                    <Rows parts={parts} externalExpanded={externalExpanded} />
                </ThemeSystemContext.Provider></I18nProvider></SyncProvider>));
                await flush();
            },
            click: async (id) => { await act(async () => header(id).click()); await flush(); },
        });
    } finally {
        await act(async () => root.unmount());
        fetch.mockRestore();
        useUIStore.setState({ expandReasoningWhileStreaming: previousPreference });
        useDirectoryStore.setState({ currentDirectory: previousDirectory });
        useGuestsStore.setState(previousGuests);
        useI18nStore.setState(previousI18n);
        await happyWindow.happyDOM.abort();
        for (const [name, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
        }
    }
};

test('consecutive commands share one header and capped scroller while retaining every command and result', async () => {
    await withCommands(async ({ container, render, click, header }) => {
        await render([command('one', 'completed', 'first result'), { ...command('two', 'running', 'second result'), messageID: 'msg_second' }]);
        expect(container.querySelectorAll('[data-command-header]').length).toBe(1);
        expect(header('one').getAttribute('aria-expanded')).toBe('true');
        expect(header('one').textContent).not.toContain('echo two');
        expect(header('one').textContent).not.toContain('result');
        const output = container.querySelector('[data-command-scroll]');
        expect(output?.textContent).toContain('echo one');
        expect(output?.textContent).toContain('first result');
        expect(output?.textContent).toContain('echo two');
        expect(output?.textContent).toContain('second result');
        const secondCommand = container.querySelector('[data-command-member="two"] pre');
        expect(secondCommand && getChatQuoteSourceMessageId(secondCommand)).toBe('msg_second');
        expect(output?.parentElement?.classList.contains('max-h-80')).toBe(true);
        expect(output?.querySelector('[data-scrollable]') === null).toBe(true);

        await render([command('one', 'completed', 'first result'), command('two', 'completed', 'second result')]);
        expect(header('one').getAttribute('aria-expanded')).toBe('false');
        expect(container.querySelector('[data-command-output]') === null).toBe(true);
        await click('one');
        expect(container.querySelector('[data-command-scroll]')?.textContent).toContain('first result');
        expect(container.querySelector('[data-command-scroll]')?.textContent).toContain('second result');
    });
});

test('mixed activity uses one header and reveals file links and lookup rows in their source order', async () => {
    await withCommands(async ({ render, click, header, container }) => {
        const lookup = (id: string, tool: string, input: ToolPartData['state']['input']): ToolPartData => ({
            ...command(id, 'completed'), messageID: 'source-' + id, tool,
            state: { status: 'completed', input, output: 'lookup result', metadata: {}, time: { start: 1, end: 2 } },
        });
        await render([lookup('a', 'read', { filePath: '/synthetic/command-group/example.ts' }),
            lookup('b', 'websearch', { query: 'documentation' }), command('c', 'completed')]);
        expect(header('a').textContent).toBe('Ran 1 command · 1 read · 1 web lookup');
        expect(header('a').title).toBe(header('a').textContent ?? '');
        expect(header('a').getAttribute('aria-expanded')).toBe('false');
        await click('a');
        const details = container.querySelector('[data-command-scroll]');
        expect(details?.textContent).toContain('example.ts');
        expect(details?.textContent).toContain('echo c');
        expect(Array.from(details?.querySelectorAll('[data-chat-source-message-id]') ?? [],
            (row) => row.getAttribute('data-chat-source-message-id'))).toEqual(['source-a', 'source-b', 'msg_command']);
    });
});

const commandWithInput = (id: string, status: 'running' | 'completed' | 'error', input: ToolPartData['state']['input']): ToolPartData => {
    const part = command(id, status, 'private command output');
    return { ...part, state: { ...part.state, input } };
};

test('the folded command header retains completed progress while subsequent calls run', async () => {
    await withCommands(async ({ container, render, click, header }) => {
        const status = (state: 'running' | 'completed') => commandWithInput('status', state, { command: 'git status --short' });
        const tests = (state: 'running' | 'completed') => commandWithInput('tests', state, { command: 'bun test' });
        await render([status('running')]);
        expect(header('status').textContent).not.toContain('Completed');
        await render([status('completed')]);
        const stableHeader = header('status');
        expect(stableHeader.getAttribute('aria-expanded')).toBe('false');
        expect(stableHeader.textContent).toContain('Completed 1 command · Check Git status');

        await render([status('completed'), tests('running')]);
        await click('status');
        expect(header('status')).toBe(stableHeader);
        expect(stableHeader.getAttribute('aria-expanded')).toBe('false');
        expect(stableHeader.textContent).toContain('Completed 1 command · Check Git status');
        expect(stableHeader.textContent).not.toContain('Run tests');
        await render([status('completed'), tests('completed')]);
        expect(stableHeader.textContent).toContain('Completed 2 commands · Run tests');
        expect(stableHeader.textContent).not.toContain('private command output');
        expect(stableHeader.textContent).not.toContain('bun test');
        await click('status');
        expect(container.querySelector('[data-command-scroll]')?.textContent).toContain('private command output');
    });
});

test('failed calls do not replace the most recent successful completion summary', async () => {
    await withCommands(async ({ render, header }) => {
        const success = commandWithInput('status', 'completed', { command: 'git status' });
        await render([success, commandWithInput('build', 'error', { command: 'bun run build' })]);
        expect(header('status').textContent).toContain('Completed 1 command · Check Git status');
        expect(header('status').textContent).not.toContain('Build project');
        await render([commandWithInput('only-failure', 'error', { command: 'bun run build' })]);
        expect(header('only-failure').textContent).not.toContain('Completed');
    });
});

test('completion summaries follow replacement input and locale without resetting disclosure', async () => {
    await withCommands(async ({ render, header }) => {
        await render([commandWithInput('same', 'completed', { command: 'git status' })]);
        const stableHeader = header('same');
        expect(stableHeader.textContent).toContain('Check Git status');
        await render([commandWithInput('same', 'completed', { command: 'git diff' })]);
        expect(stableHeader.textContent).toContain('View Git changes');
        expect(stableHeader.textContent).not.toContain('Check Git status');
        await act(async () => { useI18nStore.getState().setLocale('zh-CN'); });
        expect(header('same')).toBe(stableHeader);
        expect(stableHeader.getAttribute('aria-expanded')).toBe('false');
        expect(stableHeader.textContent).toContain('已完成 1 条 · 查看 Git 差异');
    });
});

test('reader choices and the header survive a singleton growing into a group', async () => {
    await withCommands(async ({ container, render, click, header }) => {
        await render([command('one', 'running', 'first')]);
        const firstHeader = header('one');
        await click('one');
        await render([command('one', 'completed', 'first'), command('two', 'running', 'second')]);
        expect(header('one') === firstHeader).toBe(true);
        expect(header('one').getAttribute('aria-expanded')).toBe('false');
        expect(container.querySelector('[data-command-scroll]')?.closest('[aria-hidden]')?.getAttribute('aria-hidden')).toBe('true');
        await click('one');
        await render([command('one', 'completed', 'first'), command('two', 'error', 'before failure')]);
        expect(header('one').getAttribute('aria-expanded')).toBe('true');
        expect(header('one').textContent).toContain('Failed');
        expect(header('one').textContent).not.toContain('permission denied');
        expect(container.querySelector('[data-command-scroll]')?.textContent).toContain('before failure');
        expect(container.querySelector('[data-command-scroll]')?.textContent).toContain('permission denied');
    });
});

test('completed groups can be externally expanded for search and retain same-id replacement content', async () => {
    await withCommands(async ({ container, render, header }) => {
        await render([command('one', 'completed', 'old')]);
        expect(header('one').getAttribute('aria-expanded')).toBe('false');
        await render([command('one', 'completed', 'replacement'), command('two', 'completed', 'second')], true);
        expect(header('one').getAttribute('aria-expanded')).toBe('true');
        expect(container.querySelector('[data-command-scroll]')?.textContent).toContain('replacement');
        expect(container.querySelector('[data-command-scroll]')?.textContent).not.toContain('old');
    });
});


test('commands respect the same default collapsed-stream preference as thinking', async () => {
    await withCommands(async ({ container, render, click, header }) => {
        await render([command('default-closed', 'running', 'working')]);
        expect(header('default-closed').getAttribute('aria-expanded')).toBe('false');
        expect(container.querySelector('[data-command-scroll]')?.closest('[aria-hidden]')?.getAttribute('aria-hidden')).toBe('true');
        expect(container.querySelector('[data-command-output]')).toBeNull();
        await click('default-closed');
        expect(header('default-closed').getAttribute('aria-expanded')).toBe('true');
        expect(container.querySelector('[data-command-output]')?.textContent).toContain('working');
        await render([command('default-closed', 'completed', 'done')]);
        expect(header('default-closed').getAttribute('aria-expanded')).toBe('true');
        expect(container.querySelector('[data-command-output]')?.textContent).toContain('done');
    }, false);
});


test('failed singleton output stays behind the fold and external reopen can be repeated', async () => {
    await withCommands(async ({ container, render, click, header }) => {
        await render([command('failure', 'error', 'partial stdout')]);
        expect(header('failure').getAttribute('aria-expanded')).toBe('false');
        expect(header('failure').textContent).toContain('Failed');
        expect(header('failure').textContent).not.toContain('permission denied');
        expect(header('failure').textContent).not.toContain('partial stdout');
        await render([command('failure', 'error', 'partial stdout')], true);
        expect(header('failure').getAttribute('aria-expanded')).toBe('true');
        expect(container.querySelector('[data-command-output]')?.textContent).toContain('partial stdout');
        expect(container.querySelector('[data-command-output]')?.textContent).toContain('permission denied');
        await click('failure');
        expect(header('failure').getAttribute('aria-expanded')).toBe('false');
        await render([command('failure', 'error', 'partial stdout')], false);
        await render([command('failure', 'error', 'partial stdout')], true);
        expect(header('failure').getAttribute('aria-expanded')).toBe('true');
    });
});

test('a search for a continuation thought opens its group and source block on each visit', async () => {
    const thought: ReasoningPart = {
        type: 'reasoning', id: 'thought', messageID: 'later', sessionID: 'ses_command',
        time: { start: 1, end: 2 }, text: 'Checked the references.',
    };
    try {
        await withCommands(async ({ render, container, click, header }) => {
            await render([command('first', 'completed'), thought]);
            for (let visit = 0; visit < 2; visit++) {
                expect(header('first').getAttribute('aria-expanded')).toBe('false');
                await act(async () => requestReasoningReveal('later'));
                expect(header('first').getAttribute('aria-expanded')).toBe('true');
                const source = container.querySelector<HTMLElement>('[data-reasoning-message-id="later"]');
                expect(source?.querySelector('[aria-expanded]')?.getAttribute('aria-expanded')).toBe('true');
                expect(source && getChatQuoteSourceMessageId(source)).toBe('later');
                await click('first');
            }
        });
    } finally {
        requestReasoningReveal(null);
    }
});
