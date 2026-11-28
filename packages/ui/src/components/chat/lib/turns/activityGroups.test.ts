import { describe, expect, test } from 'bun:test';
import type { Part, ReasoningPart, TextPart, ToolPart } from '@/lib/opencode/model';
import { getActivityGroups, isActivityContinuationOnlyMessage } from './activityGroups';
import type { ChatMessageEntry } from './types';

const reasoning = (id: string): ReasoningPart => ({ id, messageID: 'm', sessionID: 's', type: 'reasoning', text: id, time: { start: 1 } });
const text = (id: string, value = id): TextPart => ({ id, messageID: 'm', sessionID: 's', type: 'text', text: value });
const tool = (id: string, name = 'shell'): ToolPart => ({
    id, messageID: 'm', sessionID: 's', type: 'tool', tool: name, callID: id,
    state: { status: 'running', input: {}, time: { start: 1 } },
});
const message = (id: string, parts: Part[]): ChatMessageEntry => ({
    info: { id, sessionID: 's', role: 'assistant', agent: 'build', providerID: 'provider', modelID: 'model', time: { created: 1 } },
    parts,
});

describe('getActivityGroups', () => {
    test('attaches leading thoughts to the next phase and subsequent thoughts to the open phase, across source messages', () => {
        const first = message('first', [reasoning('r1'), tool('read', 'read')]);
        const next = message('next', [reasoning('r2'), tool('s1'), reasoning('r3'), tool('s2')]);
        const groups = getActivityGroups([first, next]);
        const exploration = groups.get('r1');
        expect(exploration?.members.map(({ part }) => part.id)).toEqual(['r1', 'read', 'r2']);
        expect(exploration?.members[0]?.message).toBe(first);
        expect(exploration?.members[2]?.message).toBe(next);
        expect(groups.get('s1')?.members.map(({ part }) => part.id)).toEqual(['s1', 'r3', 's2']);
    });

    test('absorbs five lookups before an edit, keeps six independent, and waits for a live trailing run to settle', () => {
        const lookups = Array.from({ length: 6 }, (_, i) => tool('read' + i, 'read'));
        const first = tool('first', 'edit');
        const last = tool('last', 'edit');
        const plan = (parts: Part[], live = false) => getActivityGroups([message('m', parts)], 'group', live);
        expect(plan([first, ...lookups.slice(0, 5), last]).get('first')?.members).toHaveLength(7);
        expect(plan([first, ...lookups, last]).get('read0')?.members).toHaveLength(6);
        expect(plan([first], true).get('first')?.phase).toBe('edit');
        expect(plan([first]).size).toBe(0);
        expect(plan([first, ...lookups.slice(0, 2)], true).get('read0')?.phase).toBe('explore');
        expect(plan([first, ...lookups.slice(0, 2)]).get('read0')?.phase).toBe('edit');
    });

    test('text, growing placeholders, interactive tools, failures and background commands end a phase', () => {
        const failed = tool('failed', 'websearch');
        failed.state = { status: 'error', input: {}, error: 'Request failed', time: { start: 1, end: 2 } };
        const background = tool('background');
        background.state = { status: 'completed', input: {}, metadata: { status: 'running', shellID: 'sh_1' }, output: '', time: { start: 1, end: 2 } };
        for (const separator of [text('answer'), text('empty', ''), tool('q', 'question'), tool('agent', 'subagent'), tool('request', 'openchamber_secret'), failed, background]) {
            expect(getActivityGroups([message('m', [tool('a'), separator, tool('b')])]).size).toBe(0);
        }
    });

    test('keeps plain reasoning in place and removes hidden reasoning before choosing an anchor', () => {
        const messages = [message('m', [tool('s1'), reasoning('r1'), reasoning('r2'), tool('s2'), tool('s3')])];
        const plain = getActivityGroups(messages, 'plain');
        expect([...plain.keys()]).toEqual(['s2', 's3']);
        expect(getActivityGroups(messages, 'plain')).toBe(plain);
        expect([...getActivityGroups(messages, 'hidden').keys()]).toEqual(['s1', 's2', 's3']);
        expect([...getActivityGroups(messages).keys()]).toEqual(['s1', 'r1', 'r2', 's2', 's3']);
    });

    test('adjacent reasoning keeps upstream part and message boundaries', () => {
        const messages = [message('first', [reasoning('r1')]), message('next', [reasoning('r2'), reasoning('r3')])];
        expect(getActivityGroups(messages).size).toBe(0);
    });

    test('an invalid settled shell row separates runs and cannot hide a later valid call', () => {
        const invalid = tool('invalid');
        invalid.state = { status: 'completed', input: {}, output: '', metadata: {}, time: { start: 2, end: 1 } };
        const groups = getActivityGroups([message('m', [tool('first'), invalid, tool('next'), tool('last')])]);
        expect(groups.has('first')).toBe(false);
        expect(groups.has('invalid')).toBe(false);
        expect(groups.get('next')?.members.map((member) => member.part.id)).toEqual(['next', 'last']);
    });

    test('caches an immutable turn array and rebuilds source members when the live record changes', () => {
        const first = message('first', [tool('s1')]);
        const last = message('last', [tool('s2')]);
        const messages = [first, last];
        const initial = getActivityGroups(messages);
        expect(getActivityGroups(messages)).toBe(initial);
        const updated = { ...last, parts: [tool('s2'), tool('s3')] };
        const next = getActivityGroups([first, updated]);
        expect(next.get('s1')?.id).toBe('s1');
        expect(next.get('s1')?.members.map((member) => member.part.id)).toEqual(['s1', 's2', 's3']);
        expect(next.get('s1')?.members[1]?.message).toBe(updated);
        expect(initial.get('s1')?.members).toHaveLength(2);
    });
});


test('sealed invisible text leaves visually consecutive commands in one disclosure', () => {
    const first = message('first', [tool('s1'), { ...text('blank', '\u200b'), time: { start: 1, end: 2 } }]);
    const second = message('second', [text('empty', ''), tool('s2')]);
    if (second.info.role !== 'assistant') throw new Error('Expected assistant fixture');
    second.info.time.completed = 3;
    const groups = getActivityGroups([first, second]);
    expect(groups.get('s1')?.members.map((member) => member.part.id)).toEqual(['s1', 's2']);
    expect(isActivityContinuationOnlyMessage(second, groups)).toBe(true);
});
