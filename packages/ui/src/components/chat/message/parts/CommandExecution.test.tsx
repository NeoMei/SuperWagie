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

plugin({
    name: 'command-execution-worker-url',
    setup(build) {
        build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, ({ path }) => ({
            contents: `export default ${JSON.stringify(pathToFileURL(path.split('?')[0]).href)};`,
            loader: 'js',
        }));
    },
});

const { default: ToolPart } = await import('./ToolPart');

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
        return parts.map((part) => <ToolPart key={part.id} part={part}
            isExpanded={externalExpanded || expanded.has(part.id)} isMobile={false}
            onToggle={(id) => setExpanded((previous) => {
                const next = new Set(previous);
                if (next.has(id)) next.delete(id); else next.add(id);
                return next;
            })} />);
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

test('command streams in a bounded body, folds after completion and retains its complete contents', async () => {
    await withCommands(async ({ container, render, click, header }) => {
        await render([command('one', 'running')]);
        expect(header('one').getAttribute('aria-expanded')).toBe('true');
        expect(header('one').textContent).toContain('Shell command');
        expect(header('one').textContent).not.toContain('echo one');
        expect(header('one').textContent).not.toContain('first line');
        expect(header('one').textContent).not.toContain('secret description');
        const output = container.querySelector('[data-command-output]');
        expect(output?.textContent).toContain('echo one');
        expect(output?.textContent).toContain('first line\nlast line');
        expect(output?.parentElement?.classList.contains('max-h-80')).toBe(true);

        await render([command('one', 'completed', 'first line\nlast line\nfinished')]);
        expect(header('one').getAttribute('aria-expanded')).toBe('false');
        expect(container.querySelector('[data-command-output]')).toBeNull();
        expect(header('one').textContent).not.toContain('finished');
        await click('one');
        expect(header('one').getAttribute('aria-expanded')).toBe('true');
        expect(container.querySelector('[data-command-output]')?.textContent).toContain('echo one');
        expect(container.querySelector('[data-command-output]')?.textContent).toContain('first line\nlast line\nfinished');
    });
});

test('each command stays in its original position with a separate expandable history', async () => {
    await withCommands(async ({ container, render, click }) => {
        await render([command('one', 'completed', 'first result'), command('two', 'running', 'second result')]);
        expect(Array.from(container.querySelectorAll('[data-command-fold]'), (node) => node.getAttribute('data-command-fold'))).toEqual(['one', 'two']);
        await render([command('one', 'completed', 'first result'), command('two', 'completed', 'second result')]);
        await click('one');
        await click('two');
        expect(Array.from(container.querySelectorAll('[data-command-output]'), (node) => node.textContent)).toEqual([
            'echo onefirst result', 'echo twosecond result',
        ]);
    });
});

test('reader disclosure choices survive new output and completion', async () => {
    await withCommands(async ({ render, click, header }) => {
        await render([command('one', 'running')]);
        await click('one');
        expect(header('one').getAttribute('aria-expanded')).toBe('false');
        await render([command('one', 'running', 'updated output')]);
        expect(header('one').getAttribute('aria-expanded')).toBe('false');
        await click('one');
        await render([command('one', 'completed', 'final output')]);
        expect(header('one').getAttribute('aria-expanded')).toBe('true');
        await click('one');
        expect(header('one').getAttribute('aria-expanded')).toBe('false');
    });
});

test('failed commands retain stdout and error inside the body, and external search expansion remains possible', async () => {
    await withCommands(async ({ container, render, header }) => {
        await render([command('one', 'error', 'before failure')]);
        expect(header('one').getAttribute('aria-expanded')).toBe('false');
        expect(header('one').textContent).toContain('Failed');
        expect(container.textContent).not.toContain('permission denied');
        expect(container.textContent).not.toContain('echo one');
        await render([command('one', 'error', 'before failure')], true);
        expect(header('one').getAttribute('aria-expanded')).toBe('true');
        expect(container.querySelector('[data-command-output]')?.textContent).toContain('before failure');
        expect(container.querySelector('[data-command-output]')?.textContent).toContain('permission denied');
    });
});
