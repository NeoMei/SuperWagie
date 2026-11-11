import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { AssistantMessage, Message, Metadata, Part, StructuredError, SyntheticMessage, ToolInput, ToolState, UserMessage } from '@/lib/opencode/model';
import type { AssistantStatusSnapshot } from './useAssistantStatus';
import { createParsedStatus, getActiveAssistantContext, hasBackgroundableWork, limitResetsAt } from './useAssistantStatus';
import { agentStatusSignature, agentStatusVariants, formatAgentStatusPhrase, type AgentStatus } from '@/lib/agentStatus';
import { formatMessage, type I18nKey, type I18nParams } from '@/lib/i18n/store';
import { dict as enDict } from '@/lib/i18n/messages/en';

declare global {
    var __openchamber_sync_context__: React.Context<unknown> | undefined;
    var __openchamber_sync_runtime_context__: React.Context<unknown> | undefined;
}

// Statuses are keys; the tests read them through the English dictionary.
const english = (status: AgentStatus): string => formatAgentStatusPhrase((key, params) => formatMessage(enDict, key, params), 'en', status);
const dictionary = (key: I18nKey, params?: I18nParams): string => formatMessage(enDict, key, params);
const englishPhrases = (key: I18nKey, params?: I18nParams): readonly string[] =>
    agentStatusVariants(key).map((variant) => dictionary(variant, params));
const expectsDictionaryPhrase = (actual: string, key: I18nKey, params?: I18nParams): void => {
    expect(englishPhrases(key, params)).toContain(actual);
};
const REPLACEMENT_MARKER = String.fromCharCode(36) + '& lab';
interface StatusProbeState {
    current: AssistantStatusSnapshot | null;
}
const observedStatus: StatusProbeState = { current: null };

const userMessage = (id: string): UserMessage => ({
    id,
    role: 'user',
    sessionID: 'ses_1',
    time: { created: 1 },
});

const assistantMessage = (id: string, providerID: string, modelID: string): AssistantMessage => ({
    id,
    role: 'assistant',
    sessionID: 'ses_1',
    time: { created: 2 },
    agent: 'build',
    providerID,
    modelID,
});

const syntheticMessage = (id: string): SyntheticMessage => ({
    id,
    role: 'synthetic',
    sessionID: 'ses_1',
    time: { created: 3 },
    text: 'server plugin prompt',
});

describe('getActiveAssistantContext', () => {
    test('keeps the model when plumbing messages land after the assistant', () => {
        const assistant = assistantMessage('assistant_1', 'anthropic', 'claude-opus-4-1');

        expect(getActiveAssistantContext([userMessage('user_1'), assistant, syntheticMessage('synthetic_1')])).toEqual({
            assistantId: assistant.id,
            model: {
                providerId: 'anthropic',
                modelId: 'claude-opus-4-1',
            },
        });
    });

    test('reports the model recorded on the newest assistant message', () => {
        const prompt = userMessage('user_1');
        const assistant = assistantMessage('assistant_1', 'anthropic', 'claude-opus-4-1');
        const laterPrompt = userMessage('user_2');

        expect(getActiveAssistantContext([prompt, assistant, laterPrompt])).toEqual({
            assistantId: assistant.id,
            model: {
                providerId: 'anthropic',
                modelId: 'claude-opus-4-1',
            },
        });
    });

    test('follows the newer assistant message when the model changed mid-session', () => {
        const firstUser = userMessage('user_1');
        const firstAssistant = assistantMessage('assistant_1', 'anthropic', 'claude-opus-4-1');
        const secondUser = userMessage('user_2');
        const secondAssistant = assistantMessage('assistant_2', 'openai', 'gpt-5.6-sol');

        expect(getActiveAssistantContext([firstUser, firstAssistant, secondUser, secondAssistant])).toEqual({
            assistantId: secondAssistant.id,
            model: {
                providerId: 'openai',
                modelId: 'gpt-5.6-sol',
            },
        });
    });

    test('does not guess a model when the assistant message records none', () => {
        const assistant = assistantMessage('assistant_1', '', '');

        expect(getActiveAssistantContext([assistant])).toEqual({
            assistantId: assistant.id,
            model: null,
        });
    });

    test('reports no assistant when the session has only prompts', () => {
        expect(getActiveAssistantContext([userMessage('user_1')])).toEqual({
            assistantId: null,
            model: null,
        });
    });

    test('shows the session record model while a prompt sent after a finished turn waits for its answer', () => {
        // A v2 user message records no model; the send switched the session
        // first, so the session record names the model the new turn runs on.
        const previousAssistant = { ...assistantMessage('assistant_1', 'anthropic', 'claude-opus-4-1'), time: { created: 2, completed: 3 } };
        const messages = [userMessage('user_1'), previousAssistant, userMessage('user_2')];

        expect(getActiveAssistantContext(messages, { providerID: 'openai', id: 'gpt-5.6-sol' })).toEqual({
            assistantId: previousAssistant.id,
            model: { providerId: 'openai', modelId: 'gpt-5.6-sol' },
        });
        // Without a session record nothing is shown: naming the previous turn's
        // model would name the wrong one.
        expect(getActiveAssistantContext(messages)).toEqual({ assistantId: previousAssistant.id, model: null });
    });

    test('a turn still running keeps its model when a prompt is queued behind it', () => {
        const running = assistantMessage('assistant_1', 'anthropic', 'claude-opus-4-1');

        expect(getActiveAssistantContext([userMessage('user_1'), running, userMessage('user_2')])).toEqual({
            assistantId: running.id,
            model: { providerId: 'anthropic', modelId: 'claude-opus-4-1' },
        });
    });
});

describe('hasBackgroundableWork', () => {
    const tool = (name: string, state: Extract<Part, { type: 'tool' }>['state']): Part => ({
        id: `prt_${name}`,
        sessionID: 'ses_1',
        messageID: 'msg_1',
        type: 'tool',
        callID: `call_${name}`,
        tool: name,
        state,
    });

    test('a running command or subagent can go to the background', () => {
        expect(hasBackgroundableWork([tool('shell', { status: 'running', input: { command: 'bun test' }, time: { start: 1 } })])).toBe(true);
        expect(hasBackgroundableWork([tool('subagent', { status: 'running', input: { agent: 'explore' }, time: { start: 1 } })])).toBe(true);
    });

    test('other tools, pending calls and settled calls cannot', () => {
        expect(hasBackgroundableWork([tool('read', { status: 'running', input: {}, time: { start: 1 } })])).toBe(false);
        expect(hasBackgroundableWork([tool('shell', { status: 'pending', input: {}, raw: '' })])).toBe(false);
        expect(hasBackgroundableWork([tool('shell', {
            status: 'completed',
            input: { command: 'sleep 300', background: true },
            output: 'Command moved to the background',
            metadata: { status: 'running', shellID: 'sh_1' },
            time: { start: 1, end: 2 },
        })])).toBe(false);
    });

    test('a command or subagent inside Code Mode can go to the background', () => {
        for (const name of ['shell', 'subagent']) {
            expect(hasBackgroundableWork([tool('execute', {
                status: 'running', input: { code: 'await tools.shell(...)' }, time: { start: 1 },
                metadata: { toolCalls: [{ tool: name, status: 'running' }] },
            })])).toBe(true);
        }
    });

    test('Code Mode uses live nested calls, including parallel work', () => {
        const execute = (toolCalls: Array<{ tool: string; status: string }>) => tool('execute', {
            status: 'running', input: {}, time: { start: 1 }, metadata: { toolCalls },
        });
        expect(hasBackgroundableWork([execute([{ tool: 'shell', status: 'completed' }])])).toBe(false);
        expect(hasBackgroundableWork([execute([{ tool: 'shell', status: 'error' }])])).toBe(false);
        expect(hasBackgroundableWork([execute([{ tool: 'read', status: 'running' }])])).toBe(false);
        expect(hasBackgroundableWork([execute([])])).toBe(false);
        expect(hasBackgroundableWork([execute([
            { tool: 'shell', status: 'running' }, { tool: 'read', status: 'completed' },
        ])])).toBe(true);
    });

    test('Code Mode recognizes child progress that replaces the nested call list', () => {
        const progress: Metadata[] = [{ shellID: 'sh_1' }, { sessionID: 'ses_child', status: 'running' }];
        for (const metadata of progress) {
            expect(hasBackgroundableWork([tool('execute', {
                status: 'running', input: {}, time: { start: 1 }, metadata,
            })])).toBe(true);
            expect(hasBackgroundableWork([tool('execute', {
                status: 'completed', input: {}, output: 'done', time: { start: 1, end: 2 }, metadata,
            })])).toBe(false);
        }
    });
});

describe('createParsedStatus', () => {
    const toolState = (status: 'running' | 'pending' | 'completed'): ToolState => {
        if (status === 'completed') {
            return { status: 'completed', input: {}, output: '', time: { start: 1, end: 2 } };
        }
        if (status === 'pending') {
            return { status: 'pending', input: {}, raw: '' };
        }
        return { status: 'running', input: {}, time: { start: 1 } };
    };

    const tool = (id: string, name: string, status: 'running' | 'pending' | 'completed' = 'running'): Part => ({
        id,
        sessionID: 'ses_1',
        messageID: 'msg_1',
        type: 'tool',
        callID: `call_${id}`,
        tool: name,
        state: toolState(status),
    });

    const runningTool = (name: string, input: ToolInput): Part => {
        const part = tool('1', name);
        if (part.type !== 'tool') throw new Error('expected a tool');
        part.state = { status: 'running', input, time: { start: 1 } };
        return part;
    };

    const statusOf = (parts: Part[]) => createParsedStatus(parts, 'ses_1:msg_1');

    test('names a tool by the kind of work it does', () => {
        expect(englishPhrases('chat.agentStatus.read')).toContain(english(statusOf([tool('1', 'read')]).status));
        expect(englishPhrases('chat.agentStatus.edit')).toContain(english(statusOf([tool('1', 'patch')]).status));
        expect(englishPhrases('chat.agentStatus.command')).toContain(english(statusOf([tool('1', 'shell')]).status));
        expect(englishPhrases('chat.agentStatus.lookup')).toContain(english(statusOf([tool('1', 'webfetch')]).status));
        expect(englishPhrases('chat.agentStatus.delegate')).toContain(english(statusOf([tool('1', 'subagent')]).status));
        expect(englishPhrases('chat.agentStatus.skill')).toContain(english(statusOf([tool('1', 'skill')]).status));
    });

    test('counts parallel calls of the same kind', () => {
        expect(englishPhrases('chat.agentStatus.read.count', { count: 3 })).toContain(english(statusOf([tool('1', 'read'), tool('2', 'read'), tool('3', 'file-diff')]).status));
        expect(englishPhrases('chat.agentStatus.edit.count', { count: 2 })).toContain(english(statusOf([tool('1', 'write'), tool('2', 'patch')]).status));
        expect(englishPhrases('chat.agentStatus.command.count', { count: 2 })).toContain(english(statusOf([tool('1', 'shell'), tool('2', 'execute')]).status));
        expect(englishPhrases('chat.agentStatus.delegate.count', { count: 2 })).toContain(english(statusOf([tool('1', 'subagent'), tool('2', 'subagent')]).status));
    });

    test('does not count searches, since one call spans many files', () => {
        expect(englishPhrases('chat.agentStatus.search')).toContain(english(statusOf([tool('1', 'grep'), tool('2', 'glob')]).status));
    });

    test('counts only unfinished calls', () => {
        expect(englishPhrases('chat.agentStatus.read')).toContain(english(statusOf([tool('1', 'read'), tool('2', 'read', 'completed')]).status));
    });

    test('keeps command and file details in their tool rows while the status chip names the work', () => {
        const shell = tool('1', 'shell');
        if (shell.type !== 'tool') throw new Error('expected a tool');
        shell.state = { status: 'running', input: { command: 'npm test' }, time: { start: 1 } };
        expect(englishPhrases('chat.agentStatus.command.withTarget', { target: 'npm test' })).toContain(english(statusOf([shell]).status));

        const edit = tool('1', 'edit');
        if (edit.type !== 'tool') throw new Error('expected a tool');
        edit.state = { status: 'running', input: { path: 'src/a.ts' }, time: { start: 1 } };
        expect(englishPhrases('chat.agentStatus.edit.withTarget', { target: 'a.ts' })).toContain(english(statusOf([edit]).status));
    });

    test('shows the newest kind when different tools run together', () => {
        expect(englishPhrases('chat.agentStatus.command')).toContain(english(statusOf([tool('1', 'read'), tool('2', 'shell')]).status));
        expect(englishPhrases('chat.agentStatus.read')).toContain(english(statusOf([tool('1', 'shell'), tool('2', 'read')]).status));
    });

    test('extracts a short target from the current work', () => {
        const cases: ReadonlyArray<readonly [string, ToolInput, string]> = [
            ['read', { path: '/repo/src/a.ts' }, 'a.ts'],
            ['read', { filePath: 'C:\\repo\\a.ts' }, 'a.ts'],
            ['shell', { command: 'npm   test' }, 'npm test'],
            ['webfetch', { url: 'https://docs.example.com:8443/path?q=1' }, 'docs.example.com'],
            ['grep', { pattern: 'status label' }, 'status label'],
            ['grep', { query: 'status label' }, 'status label'],
            ['websearch', { query: 'status label' }, 'status label'],
            ['websearch', { search: 'status label' }, 'status label'],
            ['skill', { name: 'superwriter' }, 'superwriter'],
        ];
        for (const [name, input, target] of cases) {
            const status = statusOf([runningTool(name, input)]).status;
            expect(status.key.endsWith('.withTarget')).toBe(true);
            expect(status.target).toBe(target);
        }
    });

    test('flattens a command with extra lines into one readable target', () => {
        expect(statusOf([runningTool('shell', { command: 'npm test\n --watch --verbose' })]).status).toEqual({
            key: 'chat.agentStatus.command.withTarget',
            target: 'npm test --watch --verbose',
        });
    });

    test('keeps sensitive fields and secret-bearing targets out of status copy', () => {
        const sensitive: ReadonlyArray<readonly [string, ToolInput]> = [
            ['write', { content: 'SECRET DATA' }],
            ['read', { text: 'SECRET DATA' }],
            ['execute', { code: 'SECRET DATA' }],
            ['subagent', { token: 'SECRET DATA' }],
            ['question', { password: 'SECRET DATA' }],
            ['question', { question: 'ping user@example.com' }],
            ['grep', { query: 'https://example.com/?token=x' }],
        ];
        for (const [name, input] of sensitive) {
            const status = statusOf([runningTool(name, input)]).status;
            expect(status.target).toBeUndefined();
            expect(status.key.endsWith('.withTarget')).toBe(false);
        }
    });

    test('caps a target at 60 visible characters', () => {
        const longName = 'a'.repeat(100) + '.ts';
        const target = statusOf([runningTool('read', { path: `/repo/${longName}` })]).status.target;
        expect(target).toHaveLength(60);
        expect(target?.endsWith('…')).toBe(true);
        expect(target?.slice(0, 59)).toBe('a'.repeat(59));

        const emojiName = '🙂'.repeat(100) + '.ts';
        const emojiTarget = statusOf([runningTool('read', { path: '/repo/' + emojiName })]).status.target;
        expect(Array.from(emojiTarget ?? '')).toHaveLength(60);
        expect(emojiTarget?.endsWith('…')).toBe(true);
    });

    test('waits for running input and reads nested Code Mode targets', () => {
        expect(statusOf([{
            type: 'tool',
            tool: 'read',
            id: '1',
            sessionID: 'ses_1',
            messageID: 'msg_1',
            callID: 'call_1',
            state: { status: 'pending', input: { path: '/repo/src/a.ts' }, raw: '' },
        } satisfies Part]).status.target).toBeUndefined();

        const nested: Part = {
            id: '1',
            sessionID: 'ses_1',
            messageID: 'msg_1',
            type: 'tool',
            callID: 'call_1',
            tool: 'execute',
            state: {
                status: 'running',
                input: {},
                time: { start: 1 },
                metadata: {
                    toolCalls: [{ tool: 'read', status: 'running', input: { path: '/repo/src/a.ts' } }],
                },
            },
        };
        expect(statusOf([nested]).status).toEqual({ key: 'chat.agentStatus.read.withTarget', target: 'a.ts' });
    });

    test('a completed nested Code Mode call stays out of the running status', () => {
        const nested: Part = {
            id: '1',
            sessionID: 'ses_1',
            messageID: 'msg_1',
            type: 'tool',
            callID: 'call_1',
            tool: 'execute',
            state: {
                status: 'running',
                input: {},
                time: { start: 1 },
                metadata: {
                    toolCalls: [{ tool: 'read', status: 'completed', input: { path: '/repo/src/a.ts' } }],
                },
            },
        };
        expect(statusOf([nested]).status).toEqual({ key: 'chat.agentStatus.command' });
    });

    test('a nested Code Mode call without status keeps the existing running status', () => {
        const nested: Part = {
            id: '1',
            sessionID: 'ses_1',
            messageID: 'msg_1',
            type: 'tool',
            callID: 'call_1',
            tool: 'execute',
            state: {
                status: 'running',
                input: {},
                time: { start: 1 },
                metadata: {
                    toolCalls: [{ tool: 'read', input: { path: '/repo/src/a.ts' } }],
                },
            },
        };
        expect(statusOf([nested]).status).toEqual({ key: 'chat.agentStatus.read.withTarget', target: 'a.ts' });
    });

    describe('encoded status and signatures', () => {
        test('a changed target changes the status signature', () => {
            const first = statusOf([runningTool('shell', { command: 'npm test' })]).status;
            const second = statusOf([runningTool('shell', { command: 'bun test' })]).status;
            expect(agentStatusSignature(first)).toBe(agentStatusSignature({ ...first }));
            expect(agentStatusSignature(first)).not.toBe(agentStatusSignature(second));
            expect(first).not.toEqual(second);
        });

        test('a replacement marker reaches the translated phrase exactly once', () => {
            const status = statusOf([runningTool('shell', { command: REPLACEMENT_MARKER })]).status;
            expect(status).toEqual({ key: 'chat.agentStatus.command.withTarget', target: REPLACEMENT_MARKER });
            const phrase = english(status);
            expect(phrase).toContain(REPLACEMENT_MARKER);
            expect(phrase.split(REPLACEMENT_MARKER)).toHaveLength(2);
        });
    });

    describe('OpenChamber tools', () => {
        const call = (name: string, input: ToolInput, status: 'running' | 'pending' = 'running'): Part => ({
            id: '1',
            sessionID: 'ses_1',
            messageID: 'msg_1',
            type: 'tool',
            callID: 'call_1',
            tool: name,
            state: status === 'running'
                ? { status: 'running', input, time: { start: 1 } }
                : { status: 'pending', input, raw: '' },
        });
        const script = (toolCalls: Metadata[]): Part => ({
            id: '1',
            sessionID: 'ses_1',
            messageID: 'msg_1',
            type: 'tool',
            callID: 'call_1',
            tool: 'execute',
            state: { status: 'running', input: {}, time: { start: 1 }, metadata: { toolCalls } },
        });

        test('say what the action does instead of the tool name', () => {
            const cases: ReadonlyArray<readonly [string, ToolInput, I18nKey]> = [
                ['openchamber_web', { action: 'browser.snapshot', parameters: {} }, 'chat.agentStatus.browser.read'],
                ['openchamber_memory', { action: 'memory.save', parameters: { title: 'x' } }, 'chat.agentStatus.memory.save'],
                ['openchamber', { action: 'session.create' }, 'chat.agentStatus.sessions.create'],
                ['openchamber_notify', { title: 'Done' }, 'chat.agentStatus.notify'],
            ];
            for (const [name, input, key] of cases) {
                expectsDictionaryPhrase(english(statusOf([call(name, input)]).status), key);
            }
        });

        test('fall back to the tool phrase for an action without its own', () => {
            expectsDictionaryPhrase(english(statusOf([call('openchamber_web', { action: 'browser.click' })]).status), 'chat.agentStatus.browser.use');
            expectsDictionaryPhrase(english(statusOf([call('openchamber_knowledge', {})]).status), 'chat.agentStatus.knowledge.check');
        });

        test('a page that waits for the answer says so once it shows', () => {
            const input = { action: 'render.page', parameters: { html: '<p>a</p>', awaitAnswer: true } };
            expectsDictionaryPhrase(english(statusOf([call('openchamber_render', input, 'pending')]).status), 'chat.agentStatus.render');
            expectsDictionaryPhrase(english(statusOf([call('openchamber_render', input)]).status), 'chat.agentStatus.waitingAnswer');
        });

        test('read the same from inside a Code Mode script', () => {
            expectsDictionaryPhrase(english(statusOf([script([
                { tool: 'openchamber_web', status: 'completed', input: { action: 'browser.open' } },
                { tool: 'openchamber_memory', status: 'running', input: { action: 'memory.read' } },
            ])]).status), 'chat.agentStatus.memory.check');
        });
    });

    describe('tools outside the built-ins', () => {
        const script = (tool: string): Part => ({
            id: '1',
            sessionID: 'ses_1',
            messageID: 'msg_1',
            type: 'tool',
            callID: 'call_1',
            tool: 'execute',
            state: { status: 'running', input: {}, time: { start: 1 }, metadata: { toolCalls: [{ tool, status: 'running' }] } },
        });
        const servers = ['linear', 'claude_in_chrome', 'claude', 'my.server'];
        const statusWith = (parts: Part[]) => english(createParsedStatus(parts, 'ses_1:msg_1', servers).status);

        test('the opencode namespace says what OpenCode does to itself', () => {
            const cases: ReadonlyArray<readonly [Part[], I18nKey]> = [
                [[script('opencode_session_rename')], 'chat.agentStatus.sessions.rename'],
                [[script('opencode_worktree_list')], 'chat.agentStatus.worktree.list'],
                [[script('opencode_read_mcp_resource')], 'chat.agentStatus.mcp.readResource'],
                [[tool('1', 'opencode.models')], 'chat.agentStatus.sessions.models'],
            ];
            for (const [parts, key] of cases) expectsDictionaryPhrase(statusWith(parts), key);
        });

        test('an MCP tool names its integration, the longest server name first', () => {
            expect(englishPhrases('chat.agentStatus.usingTool', { name: 'linear' })).toContain(statusWith([script('linear_list_issues')]));
            expect(englishPhrases('chat.agentStatus.usingTool', { name: 'linear' })).toContain(statusWith([tool('1', 'linear_get_document')]));
            expect(englishPhrases('chat.agentStatus.usingTool', { name: 'claude in chrome' })).toContain(statusWith([script('claude_in_chrome_navigate')]));
            expect(englishPhrases('chat.agentStatus.usingTool', { name: 'my.server' })).toContain(statusWith([script('my_server_query')]));
        });

        test('a tool no server claims reads as words', () => {
            expect(englishPhrases('chat.agentStatus.usingTool', { name: 'linear list issues' })).toContain(english(statusOf([script('linear_list_issues')]).status));
            expect(englishPhrases('chat.agentStatus.usingTool', { name: 'jev route' })).toContain(english(statusOf([tool('1', 'jev-route')]).status));
        });
    });
});

describe('limitResetsAt', () => {
    const error = (body: string): StructuredError => ({ type: 'provider.rate-limit', message: 'limit', status: 429, response: { body } });
    const rateLimit = (body: unknown) => error(JSON.stringify(body));

    test('reads resets_at under error, as the Claude Code plugin sends it', () => {
        const claude = rateLimit({ error: { type: 'rate_limit_error', resets_at: '2026-10-19T12:20:00.000Z', retry_after: 16775 } });
        expect(limitResetsAt(claude)).toBe(Date.parse('2026-10-19T12:20:00.000Z'));
    });

    test('reads a top-level resets_at in epoch seconds or milliseconds', () => {
        expect(limitResetsAt(rateLimit({ resets_at: 1792412400 }))).toBe(1792412400000);
        expect(limitResetsAt(rateLimit({ resets_at: 1792412400000 }))).toBe(1792412400000);
    });

    test('ignores errors without a usable reset time', () => {
        expect(limitResetsAt(undefined)).toBeUndefined();
        expect(limitResetsAt({ type: 'provider.unknown', message: 'boom' })).toBeUndefined();
        expect(limitResetsAt(error('resets_at soon, not json'))).toBeUndefined();
        expect(limitResetsAt(rateLimit({ error: { resets_at: 'tomorrow' } }))).toBeUndefined();
    });
});

test('reasoning activity carries its identity through repeated status reads', () => {
    const part: Part = { type: 'reasoning', id: 'reasoning-3', messageID: 'msg', sessionID: 'ses', text: '', time: { start: 1 } };
    expect(createParsedStatus([part], 'turn').status).toEqual({ key: 'chat.agentStatus.thinking', seed: 'reasoning-3' });
    expect(createParsedStatus([part], 'turn').status).toEqual({ key: 'chat.agentStatus.thinking', seed: 'reasoning-3' });
});

describe('useAssistantStatus encoded state', () => {
    const DIRECTORY = '/repo';
    const SESSION_ID = 'ses_encoded';
    const ASSISTANT_ID = 'assistant_encoded';

    type Permission = {
        id: string;
        sessionID: string;
        action: string;
        resources: string[];
    };

    const toolPart = (command: string): Part => ({
        id: 'tool_encoded',
        sessionID: SESSION_ID,
        messageID: ASSISTANT_ID,
        type: 'tool',
        callID: 'call_encoded',
        tool: 'shell',
        state: { status: 'running', input: { command }, time: { start: 1 } },
    });

    test('a changed target survives the directory sync round trip and permission wins immediately', async () => {
        const [{ ChildStoreManager }, { INITIAL_STATE }] = await Promise.all([
            import('@/sync/child-store'),
            import('@/sync/types'),
        ]);
        type State = typeof INITIAL_STATE;
        const { ChatColumnSessionContext } = await import('@/components/chat/chatColumnSession');
        await import('@/sync/sync-context');
        const { useMcpConfigStore } = await import('@/stores/useMcpConfigStore');
        const { useSessionUIStore } = await import('@/sync/session-ui-store');

        const messages: Message[] = [{
            id: ASSISTANT_ID,
            role: 'assistant',
            sessionID: SESSION_ID,
            time: { created: 1 },
            agent: 'build',
            providerID: 'openai',
            modelID: 'gpt-5',
        }];
        const permissions: Permission[] = [];
        const childStores = new ChildStoreManager();
        const store = childStores.ensureChild(DIRECTORY, { bootstrap: false });
        const state = {
            ...INITIAL_STATE,
            status: 'complete',
            session_status: { [SESSION_ID]: { type: 'busy' } },
            message: { [SESSION_ID]: messages },
            part: { [ASSISTANT_ID]: [toolPart('npm test')] },
            permission: { [SESSION_ID]: permissions },
        } satisfies State;
        store.setState(state);

        const mcpOriginal = useMcpConfigStore.getState();
        const uiOriginal = useSessionUIStore.getState();
        useMcpConfigStore.setState({
            serversByDirectory: { [DIRECTORY]: [] },
            loadMcpConfigs: () => Promise.resolve(true),
        });
        useSessionUIStore.setState({ sessionAbortFlags: new Map() });

        const SyncContext = globalThis.__openchamber_sync_context__;
        const SyncRuntimeContext = globalThis.__openchamber_sync_runtime_context__;
        if (!SyncContext || !SyncRuntimeContext) throw new Error('sync contexts were not published');

        const runtime = {
            childStores,
            messageLoader: { subscribe: () => () => undefined, getSnapshot: () => ({}) },
            sdk: {},
            runtimeKey: 'test',
            currentDirectory: { get: () => DIRECTORY, subscribe: () => () => undefined },
        };
        const system = { ...runtime, directory: DIRECTORY };

        const happyWindow = new Window({ url: 'http://localhost' });
        const globals = {
            window: happyWindow,
            document: happyWindow.document,
            navigator: happyWindow.navigator,
            localStorage: happyWindow.localStorage,
            Node: happyWindow.Node,
            Text: happyWindow.Text,
            Element: happyWindow.Element,
            HTMLElement: happyWindow.HTMLElement,
            SVGElement: happyWindow.SVGElement,
            MutationObserver: happyWindow.MutationObserver,
            ResizeObserver: happyWindow.ResizeObserver,
            IS_REACT_ACT_ENVIRONMENT: true,
        };
        const previous = Object.keys(globals).map(
            (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
        );
        for (const [name, value] of Object.entries(globals)) {
            Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
        }
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);

        try {
            const { useAssistantStatus } = await import('./useAssistantStatus');
            const Probe = () => {
                observedStatus.current = useAssistantStatus();
                return null;
            };
            const render = () => React.createElement(
                SyncContext.Provider,
                { value: system },
                React.createElement(
                    SyncRuntimeContext.Provider,
                    { value: runtime },
                    React.createElement(
                        ChatColumnSessionContext.Provider,
                        { value: { sessionId: SESSION_ID, directory: DIRECTORY } },
                        React.createElement(Probe),
                    ),
                ),
            );
            await act(async () => root.render(render()));
            expect(observedStatus.current?.working.status).toEqual({ key: 'chat.agentStatus.command.withTarget', target: 'npm test' });

            await act(async () => {
                store.setState({ part: { [ASSISTANT_ID]: [toolPart('bun test')] } });
                root.render(render());
            });
            expect(observedStatus.current?.working.status).toEqual({ key: 'chat.agentStatus.command.withTarget', target: 'bun test' });
            expect(observedStatus.current?.working.canAbort).toBe(true);

            permissions.push({ id: 'permission_encoded', sessionID: SESSION_ID, action: 'run', resources: [] });
            await act(async () => {
                store.setState({ permission: { [SESSION_ID]: [...permissions] } });
                root.render(render());
            });
            expect(observedStatus.current?.working.status).toEqual({ key: 'chat.agentStatus.waitingPermission' });
            expect(observedStatus.current?.working.isWaitingForPermission).toBe(true);
            expect(observedStatus.current?.working.canAbort).toBe(false);
            expect(observedStatus.current?.working.retryInfo).toBeNull();

            permissions.length = 0;
            await act(async () => {
                store.setState({ permission: { [SESSION_ID]: [] } });
                root.render(render());
            });
            expect(observedStatus.current?.working.status).toEqual({ key: 'chat.agentStatus.command.withTarget', target: 'bun test' });
            expect(observedStatus.current?.working.isWaitingForPermission).toBe(false);
            expect(observedStatus.current?.working.canAbort).toBe(true);

            await act(async () => {
                store.setState({ part: { [ASSISTANT_ID]: [toolPart(REPLACEMENT_MARKER)] } });
                root.render(render());
            });
            expect(observedStatus.current?.working.status).toEqual({ key: 'chat.agentStatus.command.withTarget', target: REPLACEMENT_MARKER });
            const phrase = english(observedStatus.current?.working.status ?? { key: 'chat.agentStatus.working' });
            expect(phrase).toContain(REPLACEMENT_MARKER);
            expect(phrase.split(REPLACEMENT_MARKER)).toHaveLength(2);
        } finally {
            await act(async () => root.unmount());
            for (const [name, descriptor] of previous) {
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else Reflect.deleteProperty(globalThis, name);
            }
            happyWindow.happyDOM.abort();
            useMcpConfigStore.setState(mcpOriginal, true);
            useSessionUIStore.setState(uiOriginal, true);
        }
    });
});
