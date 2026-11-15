import React, { act } from 'react';
import { expect, spyOn, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import type { FormRequest, Message, Part, ToolPart } from '@/lib/opencode/model';
import { SyncProvider, useDirectoryStore } from '@/sync/sync-context';
import type { State } from '@/sync/types';
import { resetRecoverableQuestions } from '@/sync/recoverable-questions';
import { useSessionActivity } from './useSessionActivity';

const directory = '/activity-authority/project';
const respond = async (input: RequestInfo | URL) => {
    const path = new URL(input instanceof Request ? input.url : String(input), 'http://activity.test').pathname;
    if (path.endsWith('/event') || path.endsWith('/events')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    if (path === '/api/fs/home') return Response.json({ home: '/synthetic', chatsRoot: '/synthetic/chats' });
    if (path === '/api/location') return Response.json({ directory: '/synthetic', project: { id: 'synthetic', directory: '/synthetic', canonical: '/synthetic' } });
    if (path === '/api/project' || path === '/api/config') return Response.json([]);
    if (path === '/api/session/active') return Response.json({ data: {} });
    if (path === '/api/session-warming') return Response.json({ revision: 0, enabled: false, minutes: 60, sessions: [] });
    return Response.json({ data: [] });
};
const sdk = OpenCode.make({ baseUrl: 'http://activity.test', fetch: respond });
const assistant: Message = { id: 'assistant', sessionID: 'root', role: 'assistant', time: { created: 1 }, agent: 'build', modelID: 'model', providerID: 'provider' };
const form: FormRequest = { id: 'form', sessionID: 'root', title: 'Deferred question', fields: [{ key: 'answer', type: 'string' }], metadata: { kind: 'plugin', tool: { messageID: 'assistant', id: 'tool' } } };
const tool = (status: 'running' | 'completed'): ToolPart => ({
    id: 'tool', messageID: 'assistant', sessionID: 'root', callID: 'call', type: 'tool', tool: 'question',
    state: status === 'running' ? { status, input: {}, time: { start: 1 } } : { status, input: {}, output: '', time: { start: 1, end: 2 } },
});
async function activity(patch: Partial<State>) {
    resetRecoverableQuestions();
    const dom = new Window({ url: 'http://activity.test' });
    class EventSocket extends EventTarget {
        static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
        readyState = 0;
        send() {}
        close() { this.readyState = 3; }
    }
    const values = { WebSocket: EventSocket, window: dom, document: dom.document, navigator: dom.navigator,
        HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, Event: dom.Event, CustomEvent: dom.CustomEvent,
        MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver, localStorage: dom.localStorage,
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
    function Probe() {
        const store = useDirectoryStore(directory, { bootstrap: false });
        const seeded = React.useRef(false);
        if (!seeded.current) {
            seeded.current = true;
            store.setState({ ...patch, status: 'complete' });
        }
        const result = useSessionActivity('root', directory);
        return <span>{JSON.stringify(result)}</span>;
    }
    try {
        await act(async () => root.render(<SyncProvider sdk={sdk} directory=""><Probe /></SyncProvider>));
        return host.textContent;
    } finally {
        await act(async () => root.unmount());
        fetch.mockRestore();
        await dom.happyDOM.close();
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
    }
}
const snapshot = (parts: Part[] = []): Partial<State> => ({ message: { root: [assistant] }, part: { assistant: parts }, form: {}, session_status: {} });

test('authoritative idle wins over historical unfinished messages and running tools', async () => {
    const rendered = await activity({ ...snapshot([tool('running')]), session_status: { root: { type: 'idle' } } });
    expect(rendered).toContain('"phase":"idle"');
    expect(rendered).toContain('"isWorking":false');
});

test('an omitted session becomes idle once the authoritative snapshot arrives', async () => {
    expect(await activity({ ...snapshot(), sessionStatusReady: true })).toContain('"isWorking":false');
    expect(await activity({ ...snapshot(), sessionStatusReady: false })).toContain('"isWorking":true');
});

test('ended deferred forms keep Stop and retry status, while running linked forms pause the turn', async () => {
    const ended = await activity({ ...snapshot([tool('completed')]), form: { root: [form] }, session_status: { root: { type: 'retry', attempt: 1, next: 10, message: 'retry' } } });
    expect(ended).toContain('"phase":"retry"');
    expect(ended).toContain('"isWorking":true');
    const waiting = await activity({ ...snapshot([tool('running')]), form: { root: [form] }, session_status: { root: { type: 'busy' } } });
    expect(waiting).toContain('"isWorking":false');
});
