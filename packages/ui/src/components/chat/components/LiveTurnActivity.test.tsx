import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import type { Part, AssistantMessage, Session } from '@/lib/opencode/model';
import { I18nProvider, useI18nStore } from '@/lib/i18n';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';
import type { RuntimeAPIs } from '@/lib/api/types';
import { SyncProvider, useChildStoreManager } from '@/sync/sync-context';
import { useUIStore } from '@/stores/useUIStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { projectTurnRecords } from '../lib/turns/projectTurnRecords';
import type { ChatMessageEntry, TurnChangedFile, TurnRecord } from '../lib/turns/types';
import { LiveTurnActivity } from './LiveTurnActivity';
import { getLiveFinalMessage } from '../lib/turns/liveActivity';
import { replaceGlobalSessionStatusById } from '@/sync/global-session-status';
import type { MessageListHandle } from '../MessageList';
import { requestReasoningReveal } from '../search/reasoningReveal';
import { applyGlobalBlockingRequestEvents, resetGlobalBlockingRequests } from '@/sync/global-blocking-requests';

plugin({
    name: 'live-activity-worker-url',
    setup(build) {
        build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, ({ path }) => ({
            contents: `export default ${JSON.stringify(pathToFileURL(path.split('?')[0]).href)};`, loader: 'js',
        }));
        // Expand Vite's eager asset glob into the same real file URL map for
        // Bun. This is a loader transform, not a replacement of the logo hook.
        build.onLoad({ filter: /useProviderLogo\.ts$/ }, ({ path }) => {
            const folder = resolve(dirname(path), '../assets/provider-logos');
            const logos = Object.fromEntries(readdirSync(folder).filter((name) => name.endsWith('.svg'))
                .map((name) => [`../assets/provider-logos/${name}`, pathToFileURL(resolve(folder, name)).href]));
            const contents = readFileSync(path, 'utf8').replace(/import\.meta\.glob<string>\([\s\S]*?\);/, `${JSON.stringify(logos)};`);
            return { contents, loader: 'ts' };
        });
    },
});

const unavailable = (): never => { throw new Error('Activity rendering must not call runtime APIs'); };
const runtimeApis: RuntimeAPIs = {
    runtime: { platform: 'web', isDesktop: false, isVSCode: false },
    get terminal() { return unavailable(); },
    get git() { return unavailable(); },
    get sourceControl() { return unavailable(); },
    get files() { return unavailable(); },
    get settings() { return unavailable(); },
    get permissions() { return unavailable(); },
    get notifications() { return unavailable(); },
};
const unexpectedThemeChange = (): never => { throw new Error('Rendering must not change the theme'); };
const theme = getDefaultTheme(true);
const themeContext: ThemeContextValue = {
    currentTheme: theme, availableThemes: [theme], customThemeIds: [], customThemesLoading: false,
    setTheme: unexpectedThemeChange, reloadCustomThemes: unexpectedThemeChange, importTheme: unexpectedThemeChange,
    deleteImportedTheme: unexpectedThemeChange, isSystemPreference: false, setSystemPreference: unexpectedThemeChange,
    themeMode: 'dark', setThemeMode: unexpectedThemeChange, lightThemeId: getDefaultTheme(false).metadata.id,
    darkThemeId: theme.metadata.id, setLightThemePreference: unexpectedThemeChange, setDarkThemePreference: unexpectedThemeChange,
};
const sdk = OpenCode.make({ baseUrl: 'http://localhost', fetch: async () => new Response('[]', { headers: { 'Content-Type': 'application/json' } }) });
// The answer's action bar also has an aria-expanded button, the branch menu
// trigger, so the changed-file toggle is the one that opens no popup.
const changedFilesToggle = () => document.querySelector<HTMLButtonElement>('[data-fixture-message="final"] button[aria-expanded]:not([aria-haspopup])');
let MessageBody: typeof import('../message/MessageBody').default;
let MessageList: typeof import('../MessageList').default;

function assistant(id: string, parts: Part[], finish?: AssistantMessage['finish']): ChatMessageEntry {
    const info: AssistantMessage = {
        id, sessionID: 'session', role: 'assistant', time: { created: 2, completed: finish ? 3 : undefined },
        modelID: 'model', providerID: 'provider', agent: 'build',
        cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, finish,
    };
    return { info, parts };
}
function text(id: string, content: string): Part {
    return { type: 'text', id, text: content, sessionID: 'session', messageID: 'message' };
}
const readPart: Part = {
    type: 'tool', tool: 'read', id: 'read', callID: 'read', sessionID: 'session', messageID: 'progress',
    state: { status: 'completed', input: { filePath: '/project/source.ts' }, output: 'code', metadata: {}, time: { start: 1, end: 2 } },
};
function turn(messages: ChatMessageEntry[]): TurnRecord {
    return projectTurnRecords([{
        info: { id: 'user', sessionID: 'session', role: 'user', time: { created: 1 } },
        parts: [text('request', 'Request')],
    }, ...messages]).turns[0];
}

function Harness({ record, retired = false, changedFiles, isLatestTurn = true, onCopyMessage, onCopyTurn, initialExpanded, working, captureManager }: {
    record: TurnRecord;
    retired?: boolean;
    changedFiles?: TurnChangedFile[];
    isLatestTurn?: boolean;
    onCopyMessage?: (messageId: string) => boolean;
    onCopyTurn?: () => Promise<boolean>;
    initialExpanded?: boolean;
    working?: boolean;
    captureManager?: (manager: ReturnType<typeof useChildStoreManager>) => void;
}) {
    const [expanded, setExpanded] = React.useState<boolean | undefined>(initialExpanded);
    const isWorking = working ?? (!retired && !getLiveFinalMessage(record.assistantMessages));
    const renderMessage = (message: ChatMessageEntry) => (
        <div key={message.info.id} data-fixture-message={message.info.id}>
            <MessageBody
                messageId={message.info.id} parts={message.parts} isUser={false}
                isMessageCompleted={message.info.role === 'assistant' && Boolean(message.info.finish)}
                messageFinish={message.info.role === 'assistant' ? message.info.finish : undefined}
                isMobile={false} copiedCode={null} onCopyCode={() => undefined} expandedTools={new Set()}
                onToggleTool={() => undefined} onShowPopup={() => undefined}
                streamPhase={isWorking && message.info.role === 'assistant' && !message.info.time.completed ? 'streaming' : 'completed'} allowAnimation={false}
                hasTextContent={message.parts.some((part) => part.type === 'text')} showReasoningTraces
                onCopyMessage={onCopyMessage ? () => onCopyMessage(message.info.id) : undefined}
                onCopyTurn={message === record.assistantMessages.at(-1) ? onCopyTurn : undefined}
                turnGroupingContext={{
                    turnId: 'user', isFirstAssistantInTurn: message === record.assistantMessages[0],
                    isLastAssistantInTurn: message === record.assistantMessages.at(-1),
                    isLatestTurn, changedFiles, isWorking, hasTools: record.hasTools, hasReasoning: record.hasReasoning,
                }}
            />
        </div>
    );
    function CaptureManager() {
        const manager = useChildStoreManager();
        React.useLayoutEffect(() => captureManager?.(manager), [manager]);
        return null;
    }
    return <RuntimeAPIContext.Provider value={runtimeApis}>
        <ThemeSystemContext.Provider value={themeContext}>
            <SyncProvider sdk={sdk} directory="/project">
                {captureManager ? <CaptureManager /> : null}
                <I18nProvider>
                    <LiveTurnActivity turn={record} hasLaterAssistant={retired} expanded={expanded} isWorking={isWorking}
                        onToggle={setExpanded} renderMessage={renderMessage} />
                </I18nProvider>
            </SyncProvider>
        </ThemeSystemContext.Provider>
    </RuntimeAPIContext.Provider>;
}

function ListHarness({ record, working, listRef, listKey = 'list' }: {
    record: TurnRecord;
    working: boolean;
    listRef?: React.Ref<MessageListHandle>;
    listKey?: string;
}) {
    return <RuntimeAPIContext.Provider value={runtimeApis}>
        <ThemeSystemContext.Provider value={themeContext}>
            <SyncProvider sdk={sdk} directory="/project">
                <I18nProvider>
                    <MessageList key={listKey} ref={listRef} sessionKey={listKey} directory="/project"
                        messages={[record.userMessage, ...record.assistantMessages]} sessionIsWorking={working} isLoadingOlder={false}
                        activeStreamingMessageId={working ? record.assistantMessages.at(-1)?.info.id : null}
                        activeStreamingPhase={working ? 'streaming' : null}
                        scrollContainerProps={{ 'data-scrollbar': 'chat' }} />
                </I18nProvider>
            </SyncProvider>
        </ThemeSystemContext.Provider>
    </RuntimeAPIContext.Provider>;
}

// The first test pays for loading the real message body and for its first
// render. Under the full parallel suite that crossed the 5 second default on
// Windows; later tests take well under a second.
setDefaultTimeout(30_000);

describe('live Activity with the real message body', () => {
    let root: Root;
    let container: HTMLDivElement;
    let restore: () => void;
    beforeEach(async () => {
        const win = new Window({ url: 'http://localhost', settings: { device: { prefersReducedMotion: 'reduce' } } });
        const globals = {
            window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage,
            customElements: win.customElements,
            Node: win.Node, NodeList: win.NodeList, Element: win.Element, HTMLElement: win.HTMLElement, SVGElement: win.SVGElement,
            HTMLAnchorElement: win.HTMLAnchorElement,
            MutationObserver: win.MutationObserver, ResizeObserver: win.ResizeObserver,
            requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
            getComputedStyle: win.getComputedStyle.bind(win), IS_REACT_ACT_ENVIRONMENT: true,
        };
        const previous = Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
        for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
        // Reduced motion makes the disclosure lifecycle deterministic without
        // replacing the real component or animation module.
        restore = () => {
            for (const [name, descriptor] of previous) {
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else Reflect.deleteProperty(globalThis, name);
            }
        };
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
        useUIStore.setState({ collapsibleThinkingBlocks: true, expandReasoningWhileStreaming: true, showReasoningTraces: true, showSplitAssistantMessageActions: false });
        useDirectoryStore.setState({ currentDirectory: '/project' });
        useI18nStore.getState().setLocale('en');
        replaceGlobalSessionStatusById(new Map());
        resetGlobalBlockingRequests();
        MessageBody = (await import('../message/MessageBody')).default;
        MessageList = (await import('../MessageList')).default;
    });
    afterEach(async () => {
        await act(async () => root.unmount());
        replaceGlobalSessionStatusById(new Map());
        resetGlobalBlockingRequests();
        requestReasoningReveal(null);
        restore();
    });

    test('keeps execution details folded while the latest progress and final answer stay visible', async () => {
        const progress = assistant('progress', [text('progress-text', 'Checking the source'), readPart], 'tool-calls');
        await act(async () => root.render(<Harness record={turn([progress])} />));
        expect(container.textContent).toContain('Checking the source');
        expect(container.querySelector('button[aria-controls]')?.getAttribute('aria-expanded')).toBe('false');
        expect(container.textContent).not.toContain('source.ts');
        const final = assistant('final', [text('final-text', 'The final answer')], 'stop');
        await act(async () => root.render(<Harness record={turn([progress, final])} />));
        expect(container.textContent).toContain('The final answer');
        expect(container.textContent).not.toContain('Checking the source');
        // Nothing runs any more, so the mark is back to the stack glyph.
        expect(container.querySelector('[data-work-glyph]')).toBeNull();
        const header = container.querySelector<HTMLButtonElement>('button[aria-controls]');
        expect(header?.getAttribute('aria-expanded')).toBe('false');
        expect(header?.textContent).toContain('Explored codebase');
        await act(async () => header?.click());
        expect(header?.textContent).toContain('Explored codebase');
        expect(container.textContent).toContain('Checking the source');
        expect(container.textContent).toContain('source.ts');
        expect(container.textContent).toContain('The final answer');
        await act(async () => root.render(<Harness record={turn([progress, { ...final, parts: [...final.parts] }])} />));
        expect(header?.getAttribute('aria-expanded')).toBe('true');
    });

    test('many running steps remain one summary and only the latest progress is foregrounded', async () => {
        const steps = Array.from({ length: 12 }, (_, index) => assistant(`step-${index}`, [
            text(`progress-${index}`, `Progress update ${index}`),
            { ...readPart, id: `read-${index}`, callID: `read-${index}` },
            { type: 'reasoning', id: `thought-${index}`, sessionID: 'session', messageID: `step-${index}`, text: `Private thought ${index}`, time: { start: 1, end: 2 } },
        ], 'tool-calls'));
        await act(async () => root.render(<Harness record={turn(steps)} />));
        expect(container.querySelector('button[aria-controls]')?.getAttribute('aria-expanded')).toBe('false');
        expect(container.querySelectorAll('[data-message-text-export-source]').length).toBe(1);
        expect(container.textContent).toContain('Progress update 11');
        expect(container.textContent).not.toContain('Progress update 0');
        expect(container.textContent).not.toContain('Private thought');
        expect(container.querySelectorAll('[data-reasoning-block-id]').length).toBe(0);
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
        expect(container.textContent).toContain('Progress update 0');
        expect(container.textContent).toContain('Progress update 11');
        expect(container.querySelectorAll('[data-reasoning-block-id]').length).toBe(12);
        expect(container.querySelectorAll('[data-message-text-export-source]').length).toBe(12);
    });

    test('keeps reasoning compact between tools and opens its real text only on request', async () => {
        const thought: Part = { type: 'reasoning', id: 'thought', sessionID: 'session', messageID: 'step', text: 'A short thought', time: { start: 1 } };
        await act(async () => root.render(<Harness record={turn([assistant('step', [thought])])} />));
        expect(container.textContent).not.toContain('A short thought');
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
        expect(container.textContent).toContain('A short thought');
        expect(container.querySelector('[data-reasoning-message-id="step"]')).not.toBeNull();
        expect(container.querySelector('[data-reasoning-block-id] [role="button"]')?.getAttribute('aria-expanded')).toBe('false');
        expect(container.querySelector('[data-reasoning-block-id] [data-message-text-export-source]')).toBeNull();
        expect(container.querySelector('[data-reasoning-block-id] [data-scrollable]')).toBeNull();
        const ended: Part = { ...thought, text: 'A short thought, now complete', time: { start: 1, end: 2 } };
        const progress = assistant('step', [ended, text('progress', 'Now inspect the source'), readPart], 'tool-calls');
        await act(async () => root.render(<Harness record={turn([progress])} />));
        expect(container.textContent).toContain('A short thought, now complete');
        const content = container.textContent ?? '';
        expect(content.indexOf('A short thought')).toBeLessThan(content.indexOf('Now inspect the source'));
        expect(content.indexOf('Now inspect the source')).toBeLessThan(content.indexOf('source.ts'));
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
        const final = assistant('final', [text('answer', 'Final answer stays visible')], 'stop');
        await act(async () => root.render(<Harness record={turn([progress, final])} />));
        expect(container.textContent).not.toContain('A short thought');
        expect(container.textContent).toContain('Final answer stays visible');
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
        expect(container.textContent).toContain('A short thought, now complete');
        expect(container.textContent).toContain('Now inspect the source');
        expect(container.textContent).toContain('source.ts');
        const reasoningHeader = container.querySelector<HTMLElement>('[data-reasoning-block-id] [role="button"]');
        expect(reasoningHeader?.getAttribute('aria-expanded')).toBe('false');
        await act(async () => reasoningHeader?.click());
        expect(container.querySelector('[data-reasoning-block-id] [data-message-text-export-source]')?.textContent).toContain('A short thought, now complete');
    });

    test('long reasoning uses its latest real heading while raw text stays unmounted', async () => {
        const raw = '# Inspecting the configuration\n' + 'Details that belong behind a user request. '.repeat(100) + '\n## Comparing the two approaches\nThe latest thought continues here.';
        const thought: Part = { type: 'reasoning', id: 'long-thought', sessionID: 'session', messageID: 'step', text: raw, time: { start: 1 } };
        await act(async () => root.render(<Harness record={turn([assistant('step', [thought])])} />));
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
        const block = container.querySelector('[data-reasoning-block-id="long-thought"]');
        expect(block?.textContent).toContain('Comparing the two approaches');
        expect(block?.textContent).not.toContain('Details that belong behind a user request.');
        expect(block?.querySelector('[data-message-text-export-source]')).toBeNull();
        await act(async () => block?.querySelector<HTMLElement>('[role="button"]')?.click());
        expect(block?.querySelector('[data-message-text-export-source]')?.textContent).toContain('Details that belong behind a user request.');
    });

    test('the complete message list keeps a manual collapse across steps, completion, and remount', async () => {
        window.HTMLElement.prototype.getBoundingClientRect = () => new window.DOMRect(0, 0, 1000, 800);
        const thought: Part = { type: 'reasoning', id: 'list-thought', sessionID: 'session', messageID: 'list-step', text: 'List thought', time: { start: 1 } };
        const initial = turn([assistant('list-step', [thought])]);
        initial.turnId = 'list-user';
        initial.userMessage.info.id = 'list-user';
        await act(async () => root.render(<ListHarness record={initial} working listKey="manual-list" />));
        const header = () => container.querySelector<HTMLButtonElement>('[data-live-turn-activity] button[aria-controls]');
        expect(header()?.getAttribute('aria-expanded')).toBe('false');
        await act(async () => header()?.click());
        expect(header()?.getAttribute('aria-expanded')).toBe('true');
        await act(async () => header()?.click());
        expect(header()?.getAttribute('aria-expanded')).toBe('false');
        const final = turn([assistant('list-step', [{ ...thought, text: 'List thought grows', time: { start: 1, end: 2 } }], 'tool-calls'), assistant('list-final', [text('answer', 'List final answer')], 'stop')]);
        final.userMessage.info.id = 'list-user';
        await act(async () => root.render(<ListHarness record={final} working={false} listKey="manual-list" />));
        expect(header()?.getAttribute('aria-expanded')).toBe('false');
        expect(container.textContent).toContain('List final answer');
        await act(async () => root.render(<ListHarness record={final} working={false} listKey="manual-list-remount" />));
        expect(header()?.getAttribute('aria-expanded')).toBe('false');
        expect(container.textContent).not.toContain('List thought grows');
        const fresh = turn([assistant('fresh-step', [{ ...thought, messageID: 'fresh-step', text: 'Fresh turn thought' }])]);
        fresh.userMessage.info.id = 'fresh-user';
        await act(async () => root.render(<ListHarness record={fresh} working listKey="fresh-list" />));
        expect(header()?.getAttribute('aria-expanded')).toBe('false');
        expect(container.textContent).not.toContain('Fresh turn thought');
    });

    test('reasoning search opens the complete message list fold and reveals final-message reasoning directly', async () => {
        window.HTMLElement.prototype.getBoundingClientRect = () => new window.DOMRect(0, 0, 1000, 800);
        const thought: Part = { type: 'reasoning', id: 'search-thought', sessionID: 'session', messageID: 'search-final', text: 'Searchable reasoning detail', time: { start: 1, end: 2 } };
        const record = turn([assistant('search-final', [thought, text('answer', 'Search final answer')], 'stop')]);
        record.userMessage.info.id = 'search-user';
        const listRef = React.createRef<MessageListHandle>();
        await act(async () => root.render(<ListHarness record={record} working={false} listRef={listRef} listKey="search-list" />));
        const header = () => container.querySelector<HTMLButtonElement>('[data-live-turn-activity] button[aria-controls]');
        expect(header()?.getAttribute('aria-expanded')).toBe('false');
        expect(container.querySelector('[data-reasoning-message-id="search-final"]')).toBeNull();
        await act(async () => {
            requestReasoningReveal('search-final');
            listRef.current?.alignViewportAnchor({ messageId: 'search-final', offsetTop: 0 });
        });
        expect(header()?.getAttribute('aria-expanded')).toBe('true');
        expect(container.querySelector('[data-reasoning-message-id="search-final"]')?.textContent).toContain('Searchable reasoning detail');
        expect(container.textContent).toContain('Search final answer');
        expect(container.querySelector('[data-reasoning-message-id="search-final"] [role="button"]')?.getAttribute('aria-expanded')).toBe('true');
        expect(container.querySelector('[data-reasoning-message-id="search-final"] [data-message-text-export-source]')?.textContent).toContain('Searchable reasoning detail');
    });

    test('an explicit reasoning opt-out still hides thought content in the complete message list', async () => {
        window.HTMLElement.prototype.getBoundingClientRect = () => new window.DOMRect(0, 0, 1000, 800);
        useUIStore.setState({ showReasoningTraces: false });
        const thought: Part = { type: 'reasoning', id: 'hidden-thought', sessionID: 'session', messageID: 'hidden-step', text: 'Opted-out reasoning', time: { start: 1 } };
        const record = turn([assistant('hidden-step', [thought, readPart])]);
        record.userMessage.info.id = 'hidden-user';
        await act(async () => root.render(<ListHarness record={record} working listKey="hidden-list" />));
        await act(async () => container.querySelector<HTMLButtonElement>('[data-live-turn-activity] button[aria-controls]')?.click());
        expect(container.querySelector('[data-reasoning-block-id]')).toBeNull();
        expect(container.textContent).not.toContain('Opted-out reasoning');
        expect(container.textContent).toContain('source.ts');
    });

    test('keeps a manual collapse through increments, another step, and completion', async () => {
        const thought: Part = { type: 'reasoning', id: 'thought', sessionID: 'session', messageID: 'step', text: 'First thought', time: { start: 1 } };
        await act(async () => root.render(<Harness record={turn([assistant('step', [thought])])} />));
        const header = () => container.querySelector<HTMLButtonElement>('button[aria-controls]');
        await act(async () => header()?.click());
        expect(header()?.getAttribute('aria-expanded')).toBe('true');
        await act(async () => header()?.click());
        expect(header()?.getAttribute('aria-expanded')).toBe('false');
        const next = assistant('next', [text('progress', 'Another step'), readPart], 'tool-calls');
        await act(async () => root.render(<Harness record={turn([assistant('step', [{ ...thought, text: 'First thought with more text' }]), next])} />));
        expect(header()?.getAttribute('aria-expanded')).toBe('false');
        expect(container.textContent).not.toContain('First thought');
        expect(container.textContent).toContain('Another step');
        await act(async () => root.render(<Harness record={turn([next, assistant('final', [text('final', 'Done')], 'stop')])} />));
        expect(header()?.getAttribute('aria-expanded')).toBe('false');
        expect(container.textContent).toContain('Done');
    });

    test('updates an unfinished reasoning sentence before the turn ends', async () => {
        const thought: Part = { type: 'reasoning', id: 'thought', sessionID: 'session', messageID: 'step', text: 'Inspecting', time: { start: 1 } };
        await act(async () => root.render(<Harness record={turn([assistant('step', [thought])])} />));
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
        expect(container.textContent).toContain('Inspecting');
        await act(async () => {
            root.render(<Harness record={turn([assistant('step', [{ ...thought, text: 'Inspecting the current configuration' }])])} />);
            await new Promise((resolve) => setTimeout(resolve, 120));
        });
        expect(container.textContent).toContain('Inspecting the current configuration');
        expect(container.querySelector('button[aria-controls]')?.getAttribute('aria-expanded')).toBe('true');
    });

    test('an empty live thought shows a waiting label and an empty settled thought takes no row', async () => {
        const empty: Part = { type: 'reasoning', id: 'empty', sessionID: 'session', messageID: 'step', text: '', time: { start: 1 } };
        await act(async () => root.render(<Harness record={turn([assistant('step', [empty])])} />));
        expect(container.textContent).toContain('Thinking');
        expect(container.querySelector('[data-reasoning-block-id="empty"]')).toBeNull();
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
        expect(container.querySelector('[data-reasoning-block-id="empty"] [role="button"]')?.getAttribute('aria-expanded')).toBe('false');
        await act(async () => root.render(<Harness record={turn([assistant('step', [empty])])} working={false} initialExpanded />));
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
        expect(container.querySelector('[data-reasoning-block-id="empty"]')).toBeNull();
    });

    test('the final answer stays outside history and reasoning text remains an explicit detail', async () => {
        const thought: Part = { type: 'reasoning', id: 'final-thought', sessionID: 'session', messageID: 'final', text: 'Final step reasoning', time: { start: 1, end: 2 } };
        const final = assistant('final', [thought, text('answer', 'Independent final answer')], 'stop');
        await act(async () => root.render(<Harness record={turn([final])} />));
        expect(container.textContent).not.toContain('Final step reasoning');
        expect(container.textContent).toContain('Independent final answer');
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
        expect(container.textContent).toContain('Final step reasoning');
        expect(container.textContent).toContain('Independent final answer');
        expect(container.querySelector('[data-reasoning-message-id="final"] [data-message-text-export-source]')).toBeNull();
        await act(async () => container.querySelector<HTMLElement>('[data-reasoning-message-id="final"] [role="button"]')?.click());
        expect(container.querySelector('[data-reasoning-message-id="final"] [data-message-text-export-source]')?.textContent).toContain('Final step reasoning');
    });

    test('a running background child keeps the process visible after the parent answers', async () => {
        const child: Part = {
            type: 'tool', tool: 'subagent', id: 'child', callID: 'child', sessionID: 'session', messageID: 'progress',
            state: { status: 'completed', input: { description: 'Inspect source', prompt: 'Inspect source', subagent_type: 'explore', background: true },
                output: 'Started', metadata: { sessionID: 'child-session', status: 'running' }, time: { start: 1, end: 2 } },
        };
        replaceGlobalSessionStatusById(new Map([['child-session', { status: { type: 'busy' }, directory: '/project' }]]));
        const record = turn([assistant('progress', [child], 'tool-calls'), assistant('final', [text('answer', 'Parent answer')], 'stop')]);
        await act(async () => root.render(<Harness record={record} working={false} />));
        expect(container.querySelector('button[aria-controls]')?.getAttribute('aria-expanded')).toBe('false');
        expect(container.querySelector('button[aria-controls]')?.textContent).toContain('Execution details');
        expect(container.querySelector('button[aria-controls]')?.textContent).not.toContain('Working');
        expect(container.textContent).toContain('Parent answer');
        expect(container.textContent).not.toContain('Inspect source');
        await act(async () => replaceGlobalSessionStatusById(new Map()));
        expect(container.querySelector('button[aria-controls]')?.getAttribute('aria-expanded')).toBe('false');
        expect(container.textContent).toContain('Parent answer');
    });

    test('a cross-directory background child waiting for permission keeps its status visible', async () => {
        const child: Part = {
            type: 'tool', tool: 'subagent', id: 'child', callID: 'child', sessionID: 'session', messageID: 'progress',
            state: { status: 'completed', input: { description: 'Inspect source', prompt: 'Inspect source', agent: 'explore', background: true },
                output: 'Started', metadata: { sessionID: 'waiting-child', status: 'running' }, time: { start: 1, end: 2 } },
        };
        applyGlobalBlockingRequestEvents('/other-project', [{ type: 'permission.asked', properties: {
            id: 'approval', sessionID: 'waiting-child', action: 'edit', resources: [],
        } }]);
        const record = turn([assistant('progress', [child], 'tool-calls'), assistant('final', [text('answer', 'Parent answer')], 'stop')]);
        await act(async () => root.render(<Harness record={record} working={false} />));
        expect(container.querySelector('button[aria-controls]')?.getAttribute('aria-expanded')).toBe('false');
        expect(container.querySelector('button[aria-controls]')?.textContent).toContain('Waiting for approval');
        await act(async () => applyGlobalBlockingRequestEvents('/other-project', [{ type: 'permission.replied', properties: {
            sessionID: 'waiting-child', requestID: 'approval',
        } }]));
        expect(container.querySelector('button[aria-controls]')?.getAttribute('aria-expanded')).toBe('false');
    });

    test('a complete live child directory clears a stale permission index from its old directory', async () => {
        const child: Part = {
            type: 'tool', tool: 'subagent', id: 'child', callID: 'child', sessionID: 'session', messageID: 'progress',
            state: { status: 'completed', input: { description: 'Inspect source', prompt: 'Inspect source', agent: 'explore', background: true },
                output: 'Started', metadata: { sessionID: 'moved-child', status: 'running' }, time: { start: 1, end: 2 } },
        };
        applyGlobalBlockingRequestEvents('/old-project', [{ type: 'permission.asked', properties: {
            id: 'old-approval', sessionID: 'moved-child', action: 'edit', resources: [],
        } }]);
        let manager: ReturnType<typeof useChildStoreManager> | undefined;
        const captureManager = (value: ReturnType<typeof useChildStoreManager>) => { manager = value; };
        const record = turn([assistant('progress', [child], 'tool-calls'), assistant('final', [text('answer', 'Parent answer')], 'stop')]);
        await act(async () => root.render(<Harness record={record} working={false} captureManager={captureManager} />));
        expect(container.querySelector('button[aria-controls]')?.textContent).toContain('Waiting for approval');
        if (!manager) throw new Error('Expected sync manager');
        const live = manager.ensureChild('/new-project', { bootstrap: false });
        const session: Session = {
            id: 'moved-child', parentID: 'session', projectID: 'p', directory: '/new-project', title: 'Inspect source', agent: 'explore',
            cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 1, updated: 3 },
        };
        await act(async () => live.setState({ status: 'complete', session: [session], permission: {}, form: {} }));
        expect(container.querySelector('button[aria-controls]')?.getAttribute('aria-expanded')).toBe('false');
        expect(container.querySelector('button[aria-controls]')?.textContent).not.toContain('Waiting for approval');
    });

    test('folded work names an authoritative stopped or failed final step', async () => {
        const failed = assistant('step', [text('progress', 'Unfinished response'), readPart], 'error');
        if (failed.info.role !== 'assistant') throw new Error('Expected assistant fixture');
        failed.info.error = { type: 'ProviderError', message: 'Unavailable' };
        await act(async () => root.render(<Harness record={turn([failed])} working={false} />));
        expect(container.querySelector('button[aria-controls]')?.textContent).toContain('Failed');
        const stopped: ChatMessageEntry = { ...failed, info: { ...failed.info, error: { type: 'MessageAbortedError', message: 'Step interrupted' } } };
        await act(async () => root.render(<Harness record={turn([stopped])} working={false} />));
        expect(container.querySelector('button[aria-controls]')?.textContent).toContain('Stopped');
        const recovered = assistant('final', [text('answer', 'Recovered successfully')], 'stop');
        await act(async () => root.render(<Harness record={turn([failed, recovered])} working={false} />));
        expect(container.querySelector('button[aria-controls]')?.textContent).not.toContain('Failed');
        expect(container.textContent).toContain('Recovered successfully');
    });

    test('preserves a manual expansion when the turn completes', async () => {
        const progress = assistant('step', [text('progress', 'Working through details'), readPart], 'tool-calls');
        await act(async () => root.render(<Harness record={turn([progress])} />));
        const header = () => container.querySelector<HTMLButtonElement>('button[aria-controls]');
        await act(async () => header()?.click());
        await act(async () => root.render(<Harness record={turn([progress, assistant('final', [text('final', 'Done')], 'stop')])} />));
        expect(header()?.getAttribute('aria-expanded')).toBe('true');
        expect(container.textContent).toContain('Working through details');
        expect(container.textContent).toContain('Done');
    });

    test('folds stopped work without a final answer and opens the recorded reasoning in one click', async () => {
        const thought: Part = { type: 'reasoning', id: 'thought', sessionID: 'session', messageID: 'step', text: 'Recorded thought', time: { start: 1 } };
        const record = turn([assistant('step', [thought])]);
        await act(async () => root.render(<Harness record={record} working />));
        await act(async () => root.render(<Harness record={record} working={false} />));
        expect(container.querySelector('button[aria-controls]')?.getAttribute('aria-expanded')).toBe('false');
        expect(container.textContent).not.toContain('Recorded thought');
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
        expect(container.textContent).toContain('Recorded thought');
    });

    test('shows the running command in the folded Activity header', async () => {
        const shell: Part = {
            type: 'tool', tool: 'shell', id: 'shell', callID: 'shell', sessionID: 'session', messageID: 'progress',
            state: { status: 'running', input: { command: 'npm test' }, time: { start: 1 } },
        };
        const progress = assistant('progress', [text('progress-text', 'Checking'), shell], 'tool-calls');
        await act(async () => root.render(<Harness record={turn([progress])} initialExpanded={false} />));
        const header = container.querySelector<HTMLButtonElement>('button[aria-controls]');
        expect(header?.textContent).toContain('Shell Command');
        expect(header?.textContent).toContain('npm test');
        expect(header?.textContent).not.toContain('Working');
        expect(container.querySelector('.live-activity-icon[data-running="true"]')).not.toBeNull();
        expect(container.querySelector('[data-work-glyph]')).toBeNull();
        // The row itself waits behind the header; opening it moves the command
        // out of the preview and into the detailed list.
        await act(async () => header?.click());
        expect(header?.textContent).not.toContain('npm test');
        expect(container.textContent).toContain('npm test');
    });

    test('draws a page the agent showed above the answer, outside the folded Activity', async () => {
        const pagePart = (id: string, messageID: string, ok: boolean): Part => ({
            type: 'tool', tool: 'openchamber_render', id, callID: id, sessionID: 'session', messageID,
            state: {
                status: 'completed', input: { action: 'render.page', parameters: { html: '<p>chart</p>', title: `Page ${id}` } },
                output: '{}', metadata: { openchamber: { ok } }, time: { start: 1, end: 2 },
            },
        });
        const progress = assistant('progress', [text('progress-text', 'Drawing'), readPart, pagePart('early', 'progress', true), pagePart('refused', 'progress', false)], 'tool-calls');
        const final = assistant('final', [pagePart('late', 'final', true), text('final-text', 'Here it is')], 'stop');
        await act(async () => root.render(<Harness record={turn([progress, final])} />));
        const frames = () => [...container.querySelectorAll('iframe')].map((frame) => frame.getAttribute('title'));
        // Both accepted pages sit with the answer, in the order they ran; the refused one does not.
        expect(frames()).toEqual(['Page early', 'Page late']);
        const finalMessage = container.querySelector('[data-fixture-message="final"]');
        expect(finalMessage?.textContent?.indexOf('Here it is')).toBeGreaterThan(-1);
        expect(finalMessage?.querySelectorAll('iframe')).toHaveLength(2);
        expect(container.querySelector('iframe')?.getAttribute('sandbox')).toBe('allow-scripts allow-forms');
        // Opening Activity shows the steps without drawing the pages a second time.
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
        expect(container.textContent).toContain('Drawing');
        expect(frames()).toEqual(['Page early', 'Page late']);
    });

    test('keeps a page in view in a turn that ended without an answer', async () => {
        const page: Part = {
            type: 'tool', tool: 'openchamber_render', id: 'page', callID: 'page', sessionID: 'session', messageID: 'progress',
            state: {
                status: 'completed', input: { action: 'render.page', html: '<p>chart</p>', title: 'Drawn page' },
                output: '{}', metadata: { openchamber: { ok: true } }, time: { start: 1, end: 2 },
            },
        };
        const record = turn([assistant('progress', [text('progress-text', 'Still working'), readPart, page], 'tool-calls')]);
        await act(async () => root.render(<Harness record={record} retired />));
        // The steps fold away; the page stays below the fold, drawn once.
        expect(container.textContent).not.toContain('Still working');
        expect([...container.querySelectorAll('iframe')].map((frame) => frame.getAttribute('title'))).toEqual(['Drawn page']);
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
        expect(container.textContent).toContain('Still working');
        expect(container.querySelectorAll('iframe')).toHaveLength(1);
    });

    test('draws what the agent does after a page below it while the turn works', async () => {
        const page: Part = {
            type: 'tool', tool: 'openchamber_render', id: 'page', callID: 'page', sessionID: 'session', messageID: 'asked',
            state: {
                status: 'completed', input: { action: 'render.page', html: '<p>pick</p>', title: 'Pick a layout', awaitAnswer: true },
                output: '{}', metadata: { openchamber: { ok: true, answer: { answered: true, summary: 'B', data: null } } }, time: { start: 1, end: 2 },
            },
        };
        const before = assistant('before', [text('before-text', 'Looking around'), readPart], 'tool-calls');
        const asked = assistant('asked', [page], 'tool-calls');
        // The reply is still being written: not yet marked final.
        const writing = assistant('writing', [text('writing-text', 'Building layout B')], undefined);
        await act(async () => root.render(<Harness record={turn([before, asked, writing])} />));

        const html = container.innerHTML;
        expect(html.indexOf('title="Pick a layout"')).toBeGreaterThan(-1);
        expect(html.indexOf('Building layout B')).toBeGreaterThan(html.indexOf('title="Pick a layout"'));
        expect(container.textContent).not.toContain('Looking around');
        expect(container.querySelectorAll('iframe')).toHaveLength(1);
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
        expect(container.textContent).toContain('Building layout B');
        expect(container.textContent).toContain('Looking around');
        expect(container.querySelectorAll('iframe')).toHaveLength(1);
    });

    test('keeps a page that waits for the user\'s answer in view while its call runs', async () => {
        const page: Part = {
            type: 'tool', tool: 'openchamber_render', id: 'page', callID: 'page', sessionID: 'session', messageID: 'progress',
            state: {
                status: 'running', input: { action: 'render.page', html: '<p>pick</p>', title: 'Pick a layout', awaitAnswer: true },
                time: { start: 1 },
            },
        };
        const record = turn([assistant('progress', [text('progress-text', 'Asking'), readPart, page], 'tool-calls')]);
        await act(async () => root.render(<Harness record={record} retired />));
        expect(container.textContent).not.toContain('Asking');
        expect([...container.querySelectorAll('iframe')].map((frame) => frame.getAttribute('title'))).toEqual(['Pick a layout']);
        expect(container.querySelector('[data-html-render-status="waiting"]')).not.toBeNull();
    });

    test('keeps thinking in the final message inside Activity, not outside with the answer', async () => {
        const thinking: Part = { type: 'reasoning', id: 'thinking', messageID: 'final', sessionID: 'session', text: 'Private reasoning content', time: { start: 1, end: 2 } };
        const final = assistant('final', [thinking, text('final-text', 'Public answer')], 'stop');
        await act(async () => root.render(<Harness record={turn([final])} />));
        expect(container.textContent).toContain('Public answer');
        expect(container.textContent).not.toContain('Private reasoning content');
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
        expect(container.textContent).toContain('Private reasoning content');
        expect(container.textContent).toContain('Public answer');
    });

    test('an interrupted turn folds all prose without fabricating a final answer', async () => {
        const record = turn([assistant('progress', [text('progress-text', 'Still working'), readPart], 'tool-calls')]);
        await act(async () => root.render(<Harness record={record} />));
        expect(container.textContent).toContain('Still working');
        expect(container.querySelector('button[aria-controls]')?.textContent).toContain('Execution details');
        await act(async () => root.render(<Harness record={record} retired />));
        expect(container.textContent).not.toContain('Still working');
        expect(container.textContent).toContain('Execution details');
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
        expect(container.textContent).toContain('Still working');
    });

    test('the answer copies the whole turn while each earlier step copies only itself', async () => {
        useUIStore.setState({ showSplitAssistantMessageActions: true });
        const copiedMessages: string[] = [];
        let copiedTurns = 0;
        const progress = assistant('progress', [text('progress-text', 'Checking the source'), readPart], 'tool-calls');
        const final = assistant('final', [text('final-text', 'The final answer')], 'stop');
        await act(async () => root.render(<Harness record={turn([progress, final])}
            onCopyMessage={(messageId) => { copiedMessages.push(messageId); return true; }}
            onCopyTurn={async () => { copiedTurns += 1; return true; }} />));
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());

        const copyButton = (messageId: string) => container.querySelector<HTMLButtonElement>(
            `[data-fixture-message="${messageId}"] button[aria-label="Copy message text"]`,
        );
        await act(async () => copyButton('final')?.click());
        expect(copiedTurns).toBe(1);
        expect(copiedMessages).toEqual([]);

        await act(async () => copyButton('progress')?.click());
        expect(copiedTurns).toBe(1);
        expect(copiedMessages).toEqual(['progress']);
    });

    test('keeps file statistics visible when expanded and uses an ASCII minus', async () => {
        const edit: Part = {
            type: 'tool', tool: 'edit', id: 'edit', callID: 'edit', sessionID: 'session', messageID: 'progress',
            state: { status: 'completed', input: { filePath: '/project/source.ts' }, output: '',
                metadata: { diff: '@@ -1,1 +1,2 @@\n-old\n+new\n+added' }, time: { start: 1, end: 2 } },
        };
        await act(async () => root.render(<Harness record={turn([
            assistant('progress', [edit], 'tool-calls'),
            assistant('final', [text('answer', 'Done')], 'stop'),
        ])} />));
        const header = container.querySelector<HTMLButtonElement>('button[aria-controls]');
        expect(header?.textContent).toContain('Changed 1 file');
        expect(header?.textContent).toContain('+2/-1');
        await act(async () => header?.click());
        expect(header?.textContent).toContain('Changed 1 file');
        expect(header?.textContent).toContain('+2/-1');
    });

    test('shows at most four changed files and folds the rest into one chip, including at the threshold', async () => {
        const record = turn([assistant('final', [text('answer', 'Done')], 'stop')]);
        for (const count of [0, 1, 3, 4, 5, 100]) {
            const files = Array.from({ length: count }, (_, index) => ({ file: `src/file-${index}.ts`, additions: 1, deletions: 0 }));
            await act(async () => root.render(<Harness record={record} changedFiles={files} />));
            expect(container.querySelectorAll('button[aria-label^="Open src/file-"]')).toHaveLength(Math.min(count, 4));
            const toggle = changedFilesToggle();
            if (count <= 4) {
                expect(toggle).toBeNull();
            } else {
                expect(toggle?.textContent).toBe(`+${count - 4}`);
                expect(toggle?.getAttribute('aria-label')).toBe(`Other changed files (${count - 4})`);
                expect(toggle?.getAttribute('aria-expanded')).toBe('false');
                expect(container.textContent).not.toContain('file-4.ts');
            }
        }
    });

    test('reveals the rest in source order, keeps them through updates and locale changes, then hides them with focus intact', async () => {
        const record = turn([assistant('final', [text('answer', 'Done')], 'stop')]);
        const files = Array.from({ length: 100 }, (_, index) => ({ file: `src/file-${index}.ts`, additions: 1, deletions: 0 }));
        await act(async () => root.render(<Harness record={record} changedFiles={files} />));
        const toggle = changedFilesToggle();
        if (!toggle) throw new Error('Missing changed-file toggle');
        toggle.focus();
        await act(async () => toggle.click());
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        expect(toggle.getAttribute('aria-label')).toBe('Show fewer files');
        expect(Array.from(container.querySelectorAll('button[aria-label^="Open src/file-"]'), (button) => button.getAttribute('title')))
            .toEqual(files.map((file) => file.file));
        expect(toggle.previousElementSibling?.getAttribute('title')).toBe('src/file-99.ts');
        await act(async () => root.render(<Harness record={record} changedFiles={[...files]} />));
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        await act(async () => {
            useI18nStore.getState().setLocale('zh-CN');
            await import('@/lib/i18n/messages/zh-CN');
        });
        expect(toggle.getAttribute('aria-label')).toBe('显示较少文件');
        await act(async () => toggle.click());
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        expect(toggle.textContent).toBe('+96');
        expect(toggle.getAttribute('aria-label')).toBe('其他已更改的文件（96）');
        expect(document.activeElement).toBe(toggle);
        expect(container.textContent).not.toContain('file-4.ts');
        expect(container.querySelectorAll('button[aria-label^="打开 src/file-"]')).toHaveLength(4);
    });

    test('a file without line counts shows its name alone, and one outside the turn diff is not a button', async () => {
        const record = turn([assistant('final', [text('answer', 'Done')], 'stop')]);
        await act(async () => root.render(<Harness record={record} changedFiles={[
            { file: 'src/a.ts' },
            { file: 'src/b.ts', additions: 1, deletions: 2 },
            { file: 'src/c.ts', additions: 1, deletions: 0, inTurnDiff: false },
        ]} />));
        expect(container.querySelector('button[aria-label="Open src/a.ts"]')?.textContent).toBe('a.ts');
        expect(container.querySelector('button[aria-label="Open src/b.ts"]')?.textContent).toBe('b.ts+1/-2');
        expect(container.querySelector('button[aria-label="Open src/c.ts"]')).toBeNull();
        expect(container.querySelector('span[title="src/c.ts"]')?.textContent).toBe('c.ts+1/-0');
    });

    test('keeps historical files informational and withholds the list before stop', async () => {
        const files = Array.from({ length: 5 }, (_, index) => ({ file: `src/file-${index}.ts`, additions: 1, deletions: 0 }));
        const final = assistant('final', [text('answer', 'Done')], 'tool-calls');
        await act(async () => root.render(<Harness record={turn([final])} changedFiles={files} isLatestTurn={false} />));
        expect(container.textContent).not.toContain('file-0.ts');
        await act(async () => root.render(<Harness record={turn([assistant('final', final.parts, 'stop')])} changedFiles={files} isLatestTurn={false} />));
        expect(container.textContent).toContain('file-0.ts');
        await act(async () => changedFilesToggle()?.click());
        expect(container.textContent).toContain('file-4.ts');
        expect(container.querySelectorAll('button[aria-label^="Open src/file-"]')).toHaveLength(0);
    });
});
