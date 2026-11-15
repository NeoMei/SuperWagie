import { describe, expect, test } from 'bun:test';
import type { Part, ReasoningPart, TextPart, ToolPart } from '@/lib/opencode/model';
import { getActivityGroups } from './activityGroups';
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
    test('retains original source messages and parts while grouping across message boundaries', () => {
        const first = message('first', [reasoning('r1')]);
        const next = message('next', [reasoning('r2'), tool('s1'), tool('s2')]);
        const groups = getActivityGroups([first, next]);
        expect([...groups.keys()]).toEqual(['r1', 'r2', 's1', 's2']);
        expect(groups.get('r1')).toBe(groups.get('r2'));
        const group = groups.get('r1');
        expect(group?.kind).toBe('reasoning');
        expect(group?.members.map((member) => member.message.info.id)).toEqual(['first', 'next']);
        expect(group?.members[0]?.message).toBe(first);
        expect(group?.members[0]?.part).toBe(first.parts[0]);
        expect(groups.get('s1')?.id).toBe('s1');
    });

    test('interleaved thinking and shell calls remain separate singletons', () => {
        const groups = getActivityGroups([message('m', [reasoning('r1'), tool('s1'), reasoning('r2'), tool('s2')])]);
        expect(groups.size).toBe(0);
    });

    test('text including a growing empty placeholder, other tools and questions end a run', () => {
        for (const separator of [text('text'), text('empty', ''), tool('read', 'read'), tool('question', 'question')]) {
            expect(getActivityGroups([message('m', [reasoning('r1'), separator, reasoning('r2')])]).size).toBe(0);
            expect(getActivityGroups([message('m', [tool('s1'), separator, tool('s2')])]).size).toBe(0);
        }
    });

    test('reasoning remains a command separator even when a caller hides traces', () => {
        const groups = getActivityGroups([message('m', [tool('s1'), reasoning('hidden'), tool('s2'), tool('s3')])]);
        expect(groups.has('s1')).toBe(false);
        expect(groups.get('s2')?.members.map((member) => member.part.id)).toEqual(['s2', 's3']);
    });

    test('plain reasoning keeps individual parts while still separating command groups', () => {
        const messages = [message('m', [tool('s1'), reasoning('r1'), reasoning('r2'), tool('s2'), tool('s3')])];
        const groups = getActivityGroups(messages, false);
        expect(groups.has('r1')).toBe(false);
        expect(groups.has('r2')).toBe(false);
        expect(groups.has('s1')).toBe(false);
        expect(groups.get('s2')?.members.map((member) => member.part.id)).toEqual(['s2', 's3']);
        expect(getActivityGroups(messages, false)).toBe(groups);
        expect(getActivityGroups(messages).get('r1')?.members).toHaveLength(2);
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
