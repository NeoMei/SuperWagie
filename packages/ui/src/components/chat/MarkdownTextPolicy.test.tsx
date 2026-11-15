import React, { act } from 'react';
import { expect, spyOn, test } from 'bun:test';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import { useUIStore } from '@/stores/useUIStore';
import { I18nProvider } from '@/lib/i18n';
import { SyncProvider, useDirectoryStore } from '@/sync/sync-context';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { RuntimeAPIs } from '@/lib/api/types';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';

plugin({ name: 'markdown-text-policy-worker-url', setup(build) {
    build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, ({ path }) => ({
        contents: `export default ${JSON.stringify(pathToFileURL(path.split('?')[0]).href)};`, loader: 'js',
    }));
} });
const Renderer = await import('./MarkdownRendererImpl');
const respond = async (input: RequestInfo | URL) => {
    const path = new URL(input instanceof Request ? input.url : String(input), 'http://text-policy.test').pathname;
    if (path.endsWith('/event') || path.endsWith('/events')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    if (path === '/api/fs/home') return Response.json({ home: '/synthetic', chatsRoot: '/synthetic/chats' });
    if (path === '/api/location') return Response.json({ directory: '/synthetic', project: { id: 'synthetic', directory: '/synthetic', canonical: '/synthetic' } });
    if (path === '/api/project' || path === '/api/config' || path === '/api/config/themes') return Response.json([]);
    if (path === '/api/session/active') return Response.json({ data: {} });
    if (path === '/api/session-warming') return Response.json({ revision: 0, enabled: false, minutes: 60, sessions: [] });
    return Response.json({ data: [] });
};
const sdk = OpenCode.make({ baseUrl: 'http://text-policy.test', fetch: respond });
const unavailable = (): never => { throw new Error('Text policy must not invoke runtime capabilities'); };
const runtime: RuntimeAPIs = {
    runtime: { platform: 'web', isDesktop: false, isVSCode: false },
    get terminal() { return unavailable(); }, get git() { return unavailable(); }, get files() { return unavailable(); },
    get settings() { return unavailable(); }, get permissions() { return unavailable(); }, get notifications() { return unavailable(); },
    get sourceControl() { return unavailable(); },
};
function ReadyDirectory({ children }: { children: React.ReactNode }) {
    const store = useDirectoryStore('/synthetic', { bootstrap: false });
    const seeded = React.useRef(false);
    if (!seeded.current) {
        seeded.current = true;
        store.setState({ status: 'complete', sessionStatusReady: true });
    }
    return children;
}

async function withRenderer(check: (host: HTMLElement, draw: (child: React.ReactNode) => Promise<void>) => Promise<void>) {
    const dom = new Window({ url: 'http://text-policy.test' });
    dom.document.write('<!doctype html><html><head></head><body></body></html>');
    class EventSocket extends EventTarget {
        static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
        readyState = 0; send() {} close() { this.readyState = 3; }
    }
    const values = { WebSocket: EventSocket, window: dom, document: dom.document, navigator: dom.navigator,
        HTMLElement: dom.HTMLElement, HTMLAnchorElement: dom.HTMLAnchorElement, Element: dom.Element, Node: dom.Node, Text: dom.Text,
        Event: dom.Event, CustomEvent: dom.CustomEvent, MouseEvent: dom.MouseEvent, Range: dom.Range,
        SVGElement: dom.SVGElement, MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
        IntersectionObserver: dom.IntersectionObserver, DOMParser: dom.DOMParser, XMLSerializer: dom.XMLSerializer,
        localStorage: dom.localStorage, sessionStorage: dom.sessionStorage, customElements: dom.customElements,
        requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
        getComputedStyle: dom.getComputedStyle.bind(dom), IS_REACT_ACT_ENVIRONMENT: true };
    const originals = new Map<string, PropertyDescriptor | undefined>();
    for (const [key, value] of Object.entries(values)) {
        originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
        Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    }
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(respond);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const draw = async (child: React.ReactNode) => {
        await act(async () => root.render(<RuntimeAPIContext.Provider value={runtime}><I18nProvider><SyncProvider sdk={sdk} directory="/synthetic"><ReadyDirectory><ThemeSystemProvider>{child}</ThemeSystemProvider></ReadyDirectory></SyncProvider></I18nProvider></RuntimeAPIContext.Provider>));
    };
    try { await check(host, draw); }
    finally {
        await act(async () => root.unmount());
        fetch.mockRestore();
        await dom.happyDOM.close();
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
    }
}

test('typed HTML and entities stay literal without altering code characters', async () => {
    await withRenderer(async (host, draw) => {
        const content = '<b>typed</b> &amp; &#65;\n\n`a<b &amp;`';
        await draw(<Renderer.SimpleMarkdownRenderer content={content} literalText singleTilde={false} enableFileReferences={false} />);
        expect(host.textContent).toContain('<b>typed</b> &amp; &#65;');
        expect(host.querySelector('b')).toBeNull();
        expect(host.querySelector('code')?.textContent).toBe('a<b &amp;');
    });
});

test('chat and file parser policies remain independent across same-source updates', async () => {
    await withRenderer(async (host, draw) => {
        for (const singleTilde of [false, true, false]) {
            await draw(<Renderer.SimpleMarkdownRenderer content="a ~removed~ b and ~~deleted~~ c" singleTilde={singleTilde} enableFileReferences={false} />);
            expect([...host.querySelectorAll('del')].map((node) => node.textContent)).toEqual(singleTilde ? ['removed', 'deleted'] : ['deleted']);
        }
    });
});

test('assistant ranges keep literal tildes when streaming settles', async () => {
    await withRenderer(async (host, draw) => {
        for (const isStreaming of [true, false]) {
            await draw(<Renderer.MarkdownRenderer content="ETA 5~20s and 8~10 minutes. ~literal~ ~~Removed~~" isStreaming={isStreaming} messageId="tilde-stream" isAnimated={false} enableFileReferences={false} />);
            expect(host.textContent).toContain('5~20s and 8~10 minutes. ~literal~');
            expect([...host.querySelectorAll('del')].map((node) => node.textContent)).toEqual(['Removed']);
        }
    });
});

test('file preview retains single-tilde strikethrough by default', async () => {
    await withRenderer(async (host, draw) => {
        await draw(<Renderer.SimpleMarkdownRenderer content="---\ntitle: Preview\n---\n\n~removed~ and ~~deleted~~" frontmatter="properties" allowRawHtml enableFileReferences={false} />);
        expect([...host.querySelectorAll('del')].map((node) => node.textContent)).toEqual(['removed', 'deleted']);
    });
});

test('chat copy and image exports preserve the same literal single tildes', async () => {
    await withRenderer(async () => {
        const { renderMarkdownForExport } = await import('./markdown/renderMarkdownForExport');
        for (const purpose of ['copy', 'image'] as const) {
            let output: HTMLElement | undefined;
            await act(async () => { output = await renderMarkdownForExport('~literal~ and ~~deleted~~', { purpose }); });
            expect(output?.textContent).toContain('~literal~');
            expect(output?.querySelector('del')?.textContent).toBe('deleted');
        }
    });
});

const uiSource = 'root = Stack([state])\nstate = Badge("UI block ready")';
test('assistant reply fences and model-mislabelled tags draw as real UI blocks', async () => {
    await withRenderer(async (host, draw) => {
        for (const content of [`\`\`\`openui-lang\n${uiSource}\n\`\`\``, `<openui-lang>\n${uiSource}\n</openui-lang>`]) {
            await draw(<Renderer.MarkdownRenderer content={content} messageId="ui-reply" isAnimated={false} enableFileReferences={false} />);
            expect(host.querySelector('[data-oc-ui-block]')?.textContent).toContain('UI block ready');
            expect(host.querySelector('[data-oc-ui-block]')?.textContent).not.toContain('root = Stack');
        }
    });
});

test('reasoning, user/document content and chat exports retain UI source as code', async () => {
    await withRenderer(async (host, draw) => {
        const content = `\`\`\`openui-lang\n${uiSource}\n\`\`\``;
        for (const variant of ['reasoning', 'tool'] as const) {
            await draw(<Renderer.MarkdownRenderer content={content} variant={variant} messageId={`ui-${variant}`} isAnimated={false} enableFileReferences={false} />);
            expect(host.querySelector('[data-oc-ui-block]')).toBeNull();
            expect(host.querySelector('pre code')?.textContent).toContain('root = Stack');
        }
        await draw(<Renderer.SimpleMarkdownRenderer content={content} enableFileReferences={false} />);
        expect(host.querySelector('[data-oc-ui-block]')).toBeNull();
        expect(host.querySelector('pre code')?.textContent).toContain('root = Stack');
        for (const purpose of ['copy', 'image'] as const) {
            await draw(<Renderer.MarkdownContent content={content} uiBlocks purpose={purpose} enableFileReferences={false} />);
            expect(host.querySelector('[data-oc-ui-block]')).toBeNull();
            expect(host.querySelector('pre code')?.textContent).toContain('root = Stack');
        }
    });
});

test('an expanded subagent reply draws its fields without an answer destination', async () => {
    await withRenderer(async (host, draw) => {
        const content = '```openui-lang\nroot = Stack([scope])\nscope = Choice("scope", ["API", "Links"], "Scope")\n```';
        await draw(<Renderer.SimpleMarkdownRenderer content={content} uiBlocks enableFileReferences={false} />);
        expect(host.querySelector('[data-oc-ui-block]')).not.toBeNull();
        const controls = [...host.querySelectorAll<HTMLButtonElement>('[role="radio"], [role="checkbox"]')];
        expect(controls.length).toBeGreaterThan(0);
        expect(controls.every((input) => input.disabled)).toBe(true);
    });
});

test('alerts show their upstream title and status icon', async () => {
    await withRenderer(async (host, draw) => {
        await draw(<Renderer.MarkdownRenderer content={'> [!WARNING]\n> Keep this output.'} messageId="alert" isAnimated={false} enableFileReferences={false} />);
        expect(host.querySelector('[data-oc-alert-title="WARNING"]')?.textContent).toBe('Warning');
        expect(host.querySelector('[data-oc-alert-title] svg')).not.toBeNull();
        expect(host.textContent).toContain('Keep this output.');
    });
});

test('native copy across rows of the same answer keeps both rows as Markdown', async () => {
    await withRenderer(async (host, draw) => {
        await draw(<>
            <div data-answer-part="answer:part"><Renderer.MarkdownRenderer content="Before **alpha**" messageId="answer" isAnimated={false} enableFileReferences={false} /></div>
            <div data-answer-part="answer:part"><Renderer.MarkdownRenderer content="**beta** after" messageId="answer" isAnimated={false} enableFileReferences={false} /></div>
        </>);
        const bold = host.querySelectorAll('[data-streamdown="strong"], strong');
        const start = bold[0]?.firstChild;
        const end = bold[1]?.firstChild;
        if (!start || !end) throw new Error('Expected both answer rows to render');
        const range = document.createRange();
        range.setStart(start, 0); range.setEnd(end, 4);
        const selection = document.getSelection();
        selection?.removeAllRanges(); selection?.addRange(range);
        const previousCopyPreference = useUIStore.getState().copyMessagesAsPlainText;
        useUIStore.setState({ copyMessagesAsPlainText: false });
        const values = new Map<string, string>();
        const event = new Event('copy', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'clipboardData', { value: { setData: (kind: string, value: string) => values.set(kind, value) } });
        try { document.dispatchEvent(event); } finally { useUIStore.setState({ copyMessagesAsPlainText: previousCopyPreference }); }
        expect(event.defaultPrevented).toBe(true);
        expect(values.get('text/plain')).toBe('**alpha**\n\n**beta**');
        selection?.removeAllRanges();
    });
});
