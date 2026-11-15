import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import type { ToolPart as ToolPartData } from '@/lib/opencode/model';
import { SyncProvider } from '@/sync/sync-context';
import { I18nProvider } from '@/lib/i18n';
import { getChatQuoteSourceMessageId } from '@/lib/chatQuoteAnchor';

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
    render: (parts: ToolPartData[], externalExpanded?: boolean) => Promise<void>;
    click: (id: string) => Promise<void>;
    header: (id: string) => HTMLElement;
}) => Promise<void>) => {
    const happyWindow = new Window({ url: 'http://localhost' });
    const globals = {
        window: happyWindow, document: happyWindow.document, navigator: happyWindow.navigator,
        localStorage: happyWindow.localStorage, customElements: happyWindow.customElements,
        Node: happyWindow.Node, Text: happyWindow.Text, NodeList: happyWindow.NodeList,
        Element: happyWindow.Element, HTMLElement: happyWindow.HTMLElement, SVGElement: happyWindow.SVGElement,
        CustomEvent: happyWindow.CustomEvent,
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
    const sdk = OpenCode.make({ baseUrl: 'http://localhost', fetch: async () => new Response('[]', { headers: { 'Content-Type': 'application/json' } }) });
    const Rows = ({ parts, externalExpanded }: { parts: ToolPartData[]; externalExpanded: boolean }) => {
        const [expanded, setExpanded] = React.useState(new Set<string>());
        return <CommandActivityGroup id={parts[0]?.id ?? 'empty'} parts={parts}
            isExpanded={externalExpanded || expanded.has(parts[0]?.id ?? '')} isMobile={false}
            onToggle={(id) => setExpanded((previous) => {
                const next = new Set(previous);
                if (next.has(id)) next.delete(id); else next.add(id);
                return next;
            })} />;
    };
    const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 130)); });
    const header = (id: string) => {
        const result = container.querySelector<HTMLElement>(`[data-command-fold="${id}"] [data-command-header]`);
        if (!result) throw new Error(`Missing command header ${id}`);
        return result;
    };
    try {
        await run({
            container, header,
            render: async (parts, externalExpanded = false) => {
                await act(async () => root.render(<SyncProvider sdk={sdk} directory=""><I18nProvider>
                    <Rows parts={parts} externalExpanded={externalExpanded} />
                </I18nProvider></SyncProvider>));
                await flush();
            },
            click: async (id) => { await act(async () => header(id).click()); await flush(); },
        });
    } finally {
        await act(async () => root.unmount());
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
        expect(header('one').textContent).not.toContain('echo');
        expect(header('one').textContent).not.toContain('result');
        const output = container.querySelector('[data-command-group-output]');
        expect(output?.textContent).toContain('echo one');
        expect(output?.textContent).toContain('first result');
        expect(output?.textContent).toContain('echo two');
        expect(output?.textContent).toContain('second result');
        const secondCommand = container.querySelector('[data-command-member="two"] pre');
        expect(secondCommand && getChatQuoteSourceMessageId(secondCommand)).toBe('msg_second');
        expect(output?.parentElement?.classList.contains('max-h-80')).toBe(true);
        expect(output?.querySelector('[data-scrollable]')).toBeNull();

        await render([command('one', 'completed', 'first result'), command('two', 'completed', 'second result')]);
        expect(header('one').getAttribute('aria-expanded')).toBe('false');
        expect(container.querySelector('[data-command-group-output]')).toBeNull();
        await click('one');
        expect(container.querySelector('[data-command-group-output]')?.textContent).toContain('first result');
        expect(container.querySelector('[data-command-group-output]')?.textContent).toContain('second result');
    });
});

test('reader choices and the header survive a singleton growing into a group', async () => {
    await withCommands(async ({ container, render, click, header }) => {
        await render([command('one', 'running', 'first')]);
        const firstHeader = header('one');
        await click('one');
        await render([command('one', 'completed', 'first'), command('two', 'running', 'second')]);
        expect(header('one')).toBe(firstHeader);
        expect(header('one').getAttribute('aria-expanded')).toBe('false');
        expect(container.querySelector('[data-command-group-output]')).toBeNull();
        await click('one');
        await render([command('one', 'completed', 'first'), command('two', 'error', 'before failure')]);
        expect(header('one').getAttribute('aria-expanded')).toBe('true');
        expect(header('one').textContent).toContain('Failed');
        expect(header('one').textContent).not.toContain('permission denied');
        expect(container.querySelector('[data-command-group-output]')?.textContent).toContain('before failure');
        expect(container.querySelector('[data-command-group-output]')?.textContent).toContain('permission denied');
    });
});

test('completed groups can be externally expanded for search and retain same-id replacement content', async () => {
    await withCommands(async ({ container, render, header }) => {
        await render([command('one', 'completed', 'old')]);
        expect(header('one').getAttribute('aria-expanded')).toBe('false');
        await render([command('one', 'completed', 'replacement'), command('two', 'completed', 'second')], true);
        expect(header('one').getAttribute('aria-expanded')).toBe('true');
        expect(container.querySelector('[data-command-group-output]')?.textContent).toContain('replacement');
        expect(container.querySelector('[data-command-group-output]')?.textContent).not.toContain('old');
    });
});
