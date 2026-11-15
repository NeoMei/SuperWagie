import React, { act } from 'react';
import { expect, spyOn, test } from 'bun:test';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import { I18nProvider } from '@/lib/i18n';
import { SyncProvider } from '@/sync/sync-context';
import { useUIStore } from '@/stores/useUIStore';
import type { Part } from '@/lib/opencode/model';
import { normalizeUserDisplayParts } from './normalizeUserDisplayParts';
import { githubLikeDescriptor } from '@/lib/source-control/providers/descriptor.fixture';
import { useSourceControlProviderRegistry } from '@/lib/source-control/providers/registry';
import { CONTEXT_METADATA_KEY } from '@/lib/messages/contextParts';
import { onRowExpand } from '../lib/scroll/timelineScrollIntent';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { RuntimeAPIs } from '@/lib/api/types';

plugin({
    name: 'message-presentation-worker-url',
    setup(build) {
        build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, ({ path }) => ({
            contents: `export default ${JSON.stringify(pathToFileURL(path.split('?')[0]).href)};`, loader: 'js',
        }));
    },
});
const { default: MessageBody } = await import('./MessageBody');

const respond = async (input: RequestInfo | URL) => {
    const path = new URL(input instanceof Request ? input.url : String(input), 'http://presentation.test').pathname;
    if (path.endsWith('/event') || path.endsWith('/events')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    if (path === '/api/fs/home') return Response.json({ home: '/synthetic', chatsRoot: '/synthetic/chats' });
    if (path === '/api/location') return Response.json({ directory: '/synthetic', project: { id: 'synthetic', directory: '/synthetic', canonical: '/synthetic' } });
    if (path === '/api/project' || path === '/api/config') return Response.json([]);
    if (path === '/api/session/active') return Response.json({ data: {} });
    if (path === '/api/session-warming') return Response.json({ revision: 0, enabled: false, minutes: 60, sessions: [] });
    return Response.json({ data: [] });
};
const sdk = OpenCode.make({ baseUrl: 'http://presentation.test', fetch: respond });
const unavailable = (): never => { throw new Error('Presentation must not invoke native runtime capabilities'); };
const runtime: RuntimeAPIs = {
    runtime: { platform: 'web', isDesktop: false, isVSCode: false },
    get terminal() { return unavailable(); }, get git() { return unavailable(); }, get files() { return unavailable(); },
    get settings() { return unavailable(); }, get permissions() { return unavailable(); }, get notifications() { return unavailable(); },
    get sourceControl() { return unavailable(); },
};
const quote = (index: number): Part => ({
    type: 'text', id: `quote-${index}`, sessionID: 'session', messageID: 'prompt', text: `Quoted passage ${index}`,
    metadata: { [CONTEXT_METADATA_KEY]: { kind: 'chat-quote', quote: `Passage ${index}`, text: `Comment ${index}` } },
});
const parts = [quote(1), quote(2), quote(3), quote(4)];
const body = (options: { isUser?: boolean; onFork?: () => void; parts?: Part[] } = {}) => <RuntimeAPIContext.Provider value={runtime}><I18nProvider><SyncProvider sdk={sdk} directory="">
    <MessageBody messageId="prompt" parts={options.parts ?? parts} isUser={options.isUser ?? true} isMessageCompleted
        messageFinish="stop" isMobile={false} copiedCode={null} onCopyCode={() => {}} expandedTools={new Set()}
        onToggleTool={() => {}} onShowPopup={() => {}} streamPhase="completed" allowAnimation={false}
        hasTextContent={options.isUser === false} onFork={options.onFork} userMessagePart={options.onFork ? 'actions' : 'bubble'}
        footerModelName="Model" footerProviderID="superwagie" footerAgentName="build" footerVariant="high"
        messageCreatedAt={1000} messageCompletedAt={5000}
        turnGroupingContext={{ turnId: 'turn', isFirstAssistantInTurn: true, isLastAssistantInTurn: true,
            isLatestTurn: true, isWorking: false, hasTools: false, hasReasoning: false }} />
</SyncProvider></I18nProvider></RuntimeAPIContext.Provider>;

async function withDom(check: (host: HTMLElement) => Promise<void>) {
    const dom = new Window({ url: 'http://presentation.test' });
    dom.document.write('<!doctype html><html><head></head><body></body></html>');
    class EventSocket extends EventTarget {
        static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
        readyState = 0;
        send() {}
        close() { this.readyState = 3; }
    }
    const values = { WebSocket: EventSocket, window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, Element: dom.Element,
        HTMLElement: dom.HTMLElement, Event: dom.Event, CustomEvent: dom.CustomEvent, MouseEvent: dom.MouseEvent,
        MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver, localStorage: dom.localStorage,
        requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
        getComputedStyle: dom.getComputedStyle.bind(dom), IS_REACT_ACT_ENVIRONMENT: true };
    const originals = new Map<string, PropertyDescriptor | undefined>();
    for (const [key, value] of Object.entries(values)) {
        originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
        Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    }
    const previous = useUIStore.getState();
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(respond);
    useUIStore.setState({ userMessageRenderingMode: 'plain', collapsibleUserMessages: true });
    const host = document.createElement('div');
    document.body.append(host);
    try { await check(host); }
    finally {
        useUIStore.setState(previous);
        fetch.mockRestore();
        await dom.happyDOM.close();
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
    }
}

test('a collapsed prompt gives context rows the same two-line budget as upstream', async () => {
    await withDom(async (host) => {
        host.innerHTML = renderToStaticMarkup(body());
        expect(host.textContent).toContain('Comment 1');
        expect(host.textContent).toContain('Comment 2');
        expect(host.textContent).not.toContain('Comment 3');
        expect(host.textContent).not.toContain('Comment 4');
        expect(host.querySelector('[aria-expanded="false"]')).not.toBeNull();
    });
});

for (const stuck of [false, true]) {
    test(`expanding a ${stuck ? 'stuck' : 'normal'} prompt preserves upstream follow intent`, async () => {
        await withDom(async (host) => {
            host.dataset.scrollbar = 'chat';
            const header = document.createElement('div');
            if (stuck) header.dataset.turnStickyHeader = '';
            host.append(header);
            const root = createRoot(header);
            let releases = 0;
            const release = onRowExpand(host, () => { releases += 1; });
            try {
                await act(async () => root.render(body()));
                const card = header.querySelector('[role="button"]');
                if (!(card instanceof HTMLElement)) throw new Error('Expected a collapsed context row');
                await act(async () => card.click());
                expect(header.textContent).toContain('Comment 4');
                expect(releases).toBe(stuck ? 0 : 1);
            } finally {
                release();
                await act(async () => root.unmount());
            }
        });
    });
}

test('secondary prompt actions stay in More instead of separate inline buttons', async () => {
    await withDom(async (host) => {
        host.innerHTML = renderToStaticMarkup(body({ onFork: () => {} }));
        const actions = host.querySelectorAll('button[aria-label]');
        expect([...actions].some((button) => button.getAttribute('aria-label') === 'More actions')).toBe(true);
        expect([...actions].some((button) => button.getAttribute('aria-label')?.includes('Fork'))).toBe(false);
    });
});

test('assistant footer keeps effort and timestamp out of its inline facts', async () => {
    await withDom(async (host) => {
        const text: Part = { type: 'text', id: 'answer', sessionID: 'session', messageID: 'prompt', text: 'Answer', time: { start: 1, end: 2 } };
        host.innerHTML = renderToStaticMarkup(body({ isUser: false, parts: [text] }));
        const facts = host.querySelector('.message-footer__facts');
        expect(facts).not.toBeNull();
        expect(facts?.textContent).toContain('Model');
        expect(facts?.textContent).toContain('build');
        expect(facts?.textContent).not.toContain('high');
        expect(facts?.querySelector('[aria-label^="Message time:"]')).toBeNull();
    });
});


for (const mode of ['plain', 'markdown'] as const) test(`a sent ${mode} prompt draws linked URLs inline and keeps unrelated attachments`, async () => {
    await withDom(async (host) => {
        const provider = githubLikeDescriptor();
        const previousProviders = useSourceControlProviderRegistry.getState();
        useSourceControlProviderRegistry.setState({ ordered: [provider], byId: new Map([[provider.id, provider]]), status: 'ready', holdsList: true });
        useUIStore.setState({ userMessageRenderingMode: mode });
        const url = 'https://github.com/openchamber/openchamber/issues/12';
        const linked: Part = { type: 'text', id: 'linked', sessionID: 'session', messageID: 'prompt', text: 'Linked context', metadata: {
            [CONTEXT_METADATA_KEY]: { kind: 'repository-issue', provider: 'github', number: 12, title: 'Linked issue', url },
        } };
        const attachment: Part = { type: 'text', id: 'attachment', sessionID: 'session', messageID: 'prompt', text: 'Unmentioned context', metadata: {
            [CONTEXT_METADATA_KEY]: { kind: 'repository-issue', provider: 'github', number: 13, title: 'Keep attachment', url: 'https://github.com/openchamber/openchamber/issues/13' },
        } };
        const text: Part = { type: 'text', id: 'text', sessionID: 'session', messageID: 'prompt', text: `Please inspect ${url}.` };
        const display = normalizeUserDisplayParts([text, linked, attachment], () => provider);
        const root = createRoot(host);
        try {
            if (mode === 'markdown') {
                const { loadMarkdownRendererModule } = await import('../markdownRendererLoader');
                await loadMarkdownRendererModule();
            }
            await act(async () => root.render(body({ parts: display })));
            const inline = host.querySelectorAll('button[title="#12 Linked issue"]');
            expect(inline.length).toBe(1);
            expect(host.textContent).not.toContain('Issue #12: Linked issue');
            expect(host.textContent).toContain('Keep attachment');
            expect(host.textContent).not.toContain(url);
        } finally {
            await act(async () => root.unmount());
            useSourceControlProviderRegistry.setState(previousProviders);
        }
    });
});
