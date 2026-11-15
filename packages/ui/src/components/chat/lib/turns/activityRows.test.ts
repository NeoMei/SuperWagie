import { describe, expect, test } from 'bun:test';
import type { Part, ToolPart } from '@/lib/opencode/model';

import { activityRowParts, planActivityTrim } from './activityRows';
import { getActivityGroups } from './activityGroups';
import type { ChatMessageEntry } from './types';

const tool = (id: string, state: ToolPart['state']): ToolPart => ({
    id, callID: id, type: 'tool', tool: 'read', messageID: 'm', sessionID: 's', state,
});
const text = (id: string, value: string): Part => ({ id, type: 'text', text: value, messageID: 'm', sessionID: 's' });
const reasoning = (id: string): Part => ({ id, type: 'reasoning', text: 'thinking', messageID: 'm', sessionID: 's', time: { start: 1 } });

describe('activityRowParts', () => {
    test('counts an adjacent command group once before choosing the seven visible rows', () => {
        const shell = (id: string): ToolPart => ({ ...tool(id, { status: 'running', input: {}, time: { start: 1 } }), tool: 'shell' });
        const first: ChatMessageEntry = { info: { id: 'first', sessionID: 's', role: 'user', time: { created: 1 } }, parts: [shell('one'), shell('two')] };
        const next: ChatMessageEntry = { info: { id: 'next', sessionID: 's', role: 'user', time: { created: 2 } }, parts: [shell('three'), text('done', 'Done')] };
        const messages = [first, next];
        const groups = getActivityGroups(messages);
        expect(messages.map((message) => activityRowParts(message.parts, true, groups).map((part) => part.id))).toEqual([['one'], ['done']]);
        expect(planActivityTrim(messages.map((message) => activityRowParts(message.parts, true, groups).length), 7)).toEqual({ hiddenMessages: 0, skipRows: 0, hiddenRows: 0 });
    });

    test('counts drawn parts: text, reasoning when shown, tools running or ended', () => {
        const parts: Part[] = [
            reasoning('r'),
            text('empty', '  '),
            tool('running', { status: 'running', input: {}, time: { start: 1 } }),
            tool('done', { status: 'completed', input: {}, output: '', metadata: {}, time: { start: 1, end: 2 } }),
            tool('pending', { status: 'pending', input: {}, raw: '' }),
            text('t', 'Done.'),
        ];
        expect(activityRowParts(parts, true).map((part) => part.id)).toEqual(['r', 'running', 'done', 'pending', 't']);
        expect(activityRowParts(parts, false).map((part) => part.id)).toEqual(['running', 'done', 'pending', 't']);
    });

    test('skips text made only of zero-width characters and keeps text that uses them', () => {
        const parts: Part[] = [
            text('zwsp', '\u200B'),
            text('bom', '\uFEFF\n'),
            text('joiners', '\u200C\u200D'),
            text('emoji', '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'),
            text('persian', '\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645'),
        ];
        expect(activityRowParts(parts, true).map((part) => part.id)).toEqual(['emoji', 'persian']);
    });
});

describe('planActivityTrim', () => {
    test('hides nothing while the rows fit', () => {
        expect(planActivityTrim([2, 3, 2], 7)).toEqual({ hiddenMessages: 0, skipRows: 0, hiddenRows: 0 });
    });

    test('hides whole earlier messages and cuts into the one at the edge', () => {
        // Last 7 rows: 1 of the second message, then 4 and 2.
        expect(planActivityTrim([3, 3, 4, 2], 7)).toEqual({ hiddenMessages: 1, skipRows: 2, hiddenRows: 5 });
    });

    test('hides a message whole when the budget ends right at it', () => {
        expect(planActivityTrim([3, 4, 3], 7)).toEqual({ hiddenMessages: 1, skipRows: 0, hiddenRows: 3 });
    });

    test('keeps the latest rows of one long message', () => {
        expect(planActivityTrim([12], 7)).toEqual({ hiddenMessages: 0, skipRows: 5, hiddenRows: 5 });
    });
});
