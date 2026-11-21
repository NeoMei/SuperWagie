import { expect, test } from 'bun:test';
import type { ChatMessageEntry } from '../lib/turns/types';
import { messageSelectionSegments, readExportMessage, selectionMessageSource, toggleSelectedMessage } from './selectedMessageContent';

const sessionId = 'selection-session';
const entry = (id: string, text: string, role: 'user' | 'assistant' = 'user', owner = sessionId): ChatMessageEntry => ({
    info: role === 'assistant'
        ? { id, sessionID: owner, role, agent: 'build', providerID: 'mock', modelID: 'mock', time: { created: 1 } }
        : { id, sessionID: owner, role, time: { created: 1 } },
    parts: [{ id: `${id}-text`, sessionID: owner, messageID: id, type: 'text', text }],
});

test('shift range and export use loaded transcript order even when only endpoints have rendered rows', () => {
    const entries = [entry('a', '**Start**'), entry('b', 'Earlier reply', 'assistant'), entry('c', 'Finish')];
    const selection = toggleSelectedMessage({ ids: new Set(['c']), anchorId: 'c' }, ['a', 'b', 'c'], 'a', true);
    const labels = { user: 'User', assistant: 'Assistant' };
    expect([...selection.ids]).toEqual(['c', 'a', 'b']);
    expect(messageSelectionSegments(entries, sessionId, selection.ids, labels)).toEqual([
        '### User', '**Start**', '### Assistant', 'Earlier reply', '### User', 'Finish',
    ]);
    expect(messageSelectionSegments([entries[0], entry('b', 'Wrong scope', 'assistant', 'other'), entries[2]],
        sessionId, selection.ids, labels)).toBeNull();
    expect(messageSelectionSegments([entries[0], entries[2]], sessionId, selection.ids, labels)).toBeNull();
});

test('exports assistant text but skips reasoning and tool-only messages', () => {
    const message = entry('a', 'Visible answer', 'assistant');
    const reasoning = { id: 'r', sessionID: sessionId, messageID: 'a', type: 'reasoning' as const, text: 'Internal trace', time: { start: 1, end: 2 } };
    const tool = {
        id: 't', sessionID: sessionId, messageID: 'a', type: 'tool' as const, tool: 'shell', callID: 'call',
        state: { status: 'completed' as const, input: {}, output: 'Tool result', metadata: {}, time: { start: 1, end: 2 } },
    };
    expect(readExportMessage({ ...message, parts: [reasoning, tool, ...message.parts] }, sessionId)?.segments).toEqual(['Visible answer']);
    expect(readExportMessage({ ...message, parts: [reasoning, tool] }, sessionId)).toBeNull();
});

test('selected live replies use the latest parts without admitting records outside the loaded transcript', () => {
    const base = [entry('a', 'Prompt'), entry('b', 'Stale reply', 'assistant')];
    const live = [entry('a', 'Other session prompt', 'user', 'other'), entry('b', 'New reply', 'assistant'), entry('c', 'Not loaded', 'assistant')];
    expect(messageSelectionSegments(selectionMessageSource(base, live), sessionId, new Set(['a', 'b']), {
        user: 'User', assistant: 'Assistant',
    })).toEqual(['### User', 'Prompt', '### Assistant', 'New reply']);
    expect(selectionMessageSource(base, live).map((record) => record.info.id)).toEqual(['a', 'b']);
});
