import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Part, TextPart } from '@/lib/opencode/model';
import {
    buildRevealedTailPart,
    buildRevealedTextPart,
    cropRevealedPart,
    getRevealedText,
    getRevealedTextVersion,
    readTextPartContent,
    readTextPartGeneration,
    recordRevealedText,
    resetRevealedTextForTests,
    selectRevealedTextForMessage,
    subscribeRevealedText,
    type RevealedTextInput,
    type RevealedTextTurnIdentity,
} from './revealedText';

const textPart = (id: string, messageID: string, text: string, generation?: number): Part => ({
    id,
    sessionID: 'session',
    messageID,
    type: 'text',
    text,
    time: generation === undefined ? undefined : { start: generation, end: generation + 1 },
    metadata: { source: 'live' },
});

const legacyTextPart = (id: string, alias: string, content: string): Part => {
    // SAFETY: the extra field stands in for a persisted legacy alias; the
    // object is otherwise the complete canonical TextPart shape.
    const legacy: TextPart & { [key: string]: string } = {
        id,
        sessionID: 'session',
        messageID: 'message',
        type: 'text',
        text: '',
        [alias]: content,
    };
    return legacy;
};

const reveal = (overrides: Partial<RevealedTextInput> = {}): RevealedTextInput => ({
    runtimeKey: 'runtime-a',
    directory: '/project-a',
    sessionId: 'session',
    turnId: 'turn',
    messageId: 'message',
    partId: 'part',
    generation: 10,
    messageOrder: 0,
    partIndex: 0,
    displayText: 'Hello',
    authoritativeText: 'Hello',
    presentation: 'markdown',
    ...overrides,
});

const identity = (overrides: Partial<RevealedTextTurnIdentity> = {}): RevealedTextTurnIdentity => ({
    runtimeKey: 'runtime-a',
    directory: '/project-a',
    sessionId: 'session',
    turnId: 'turn',
    ...overrides,
});

const records = (overrides: Partial<RevealedTextTurnIdentity> = {}) => getRevealedText(identity(overrides));

describe('revealed text store', () => {
    beforeEach(() => {
        resetRevealedTextForTests();
    });

    afterEach(() => {
        resetRevealedTextForTests();
    });

    test('extends one display chain with stable identity and keeps only its latest prefix', () => {
        recordRevealedText(reveal());
        const first = records();
        expect(first).toHaveLength(1);
        expect(first[0]).toMatchObject({
            revealId: 1,
            displayText: 'Hello',
            authoritativeText: 'Hello',
            active: true,
        });

        const versionBeforeDuplicate = getRevealedTextVersion();
        recordRevealedText(reveal());
        expect(getRevealedTextVersion()).toBe(versionBeforeDuplicate);
        expect(records()[0]).toBe(first[0]);

        recordRevealedText(reveal({
            displayText: 'Hello world',
            authoritativeText: 'Hello world',
            presentation: 'generated-result',
        }));
        expect(records()).toHaveLength(1);
        expect(records()[0]).toMatchObject({
            revealId: first[0]?.revealId,
            displayText: 'Hello world',
            authoritativeText: 'Hello world',
            presentation: 'generated-result',
            active: true,
        });
    });

    test('authoritative text can grow while a throttled display prefix stays put', () => {
        recordRevealedText(reveal({ displayText: 'Hello', authoritativeText: 'Hello' }));
        recordRevealedText(reveal({ displayText: 'Hello', authoritativeText: 'Hello world' }));

        expect(records()).toHaveLength(1);
        expect(records()[0]).toMatchObject({
            displayText: 'Hello',
            authoritativeText: 'Hello world',
            active: true,
        });

        const versionBeforeOlderPrefix = getRevealedTextVersion();
        recordRevealedText(reveal({ displayText: 'Hel', authoritativeText: 'Hello world' }));
        expect(getRevealedTextVersion()).toBe(versionBeforeOlderPrefix);
        expect(records()).toHaveLength(1);
        expect(records()[0]?.displayText).toBe('Hello');
    });

    test('a rewrite retains the old shown prose and starts a separate active chain', () => {
        recordRevealedText(reveal({ displayText: 'First answer', authoritativeText: 'First answer' }));
        const firstRevealId = records()[0]?.revealId;
        recordRevealedText(reveal({
            displayText: 'Rewritten answer',
            authoritativeText: 'Rewritten answer',
            messageOrder: 2,
            partIndex: 1,
        }));

        const snapshot = records();
        expect(snapshot).toHaveLength(2);
        expect(snapshot.map(({ displayText, active }) => ({ displayText, active }))).toEqual([
            { displayText: 'First answer', active: false },
            { displayText: 'Rewritten answer', active: true },
        ]);
        expect(snapshot[1]).toMatchObject({ revealId: (firstRevealId ?? 0) + 1, messageOrder: 2, partIndex: 1 });
        expect(snapshot.map(({ displayText }) => displayText)).toEqual(['First answer', 'Rewritten answer']);
    });

    test('keeps chains separate across generation, part, message, and turn identities', () => {
        const identities: Partial<RevealedTextInput>[] = [
            { generation: 11 },
            { partId: 'other-part' },
            { messageId: 'other-message' },
        ];
        for (const identity of identities) {
            recordRevealedText(reveal({ ...identity, displayText: 'Shared prose' }));
        }
        recordRevealedText(reveal({ turnId: 'other-turn', displayText: 'Other turn prose' }));
        recordRevealedText(reveal({ sessionId: 'other-session', displayText: 'Other session prose' }));

        expect(records()).toHaveLength(3);
        expect(records().map(({ displayText }) => displayText)).toEqual([
            'Shared prose', 'Shared prose', 'Shared prose',
        ]);
        expect(new Set(records().map(({ revealId }) => revealId)).size).toBe(3);
        expect(records({ turnId: 'other-turn' })[0]?.displayText).toBe('Other turn prose');
        expect(records({ sessionId: 'other-session' })).toHaveLength(1);
        expect(records({ sessionId: 'other-session' })[0]?.displayText).toBe('Other session prose');
    });

    test('isolates equal session and turn IDs across runtimes and directories', () => {
        recordRevealedText(reveal({ displayText: 'Local prose', authoritativeText: 'Local prose' }));
        recordRevealedText(reveal({
            runtimeKey: 'runtime-b', displayText: 'Remote prose', authoritativeText: 'Remote prose',
        }));
        recordRevealedText(reveal({
            directory: '/project-b', displayText: 'Other project prose', authoritativeText: 'Other project prose',
        }));

        expect(records().map(({ displayText }) => displayText)).toEqual(['Local prose']);
        expect(records({ runtimeKey: 'runtime-b' }).map(({ displayText }) => displayText)).toEqual(['Remote prose']);
        expect(records({ directory: '/project-b' }).map(({ displayText }) => displayText)).toEqual(['Other project prose']);
        recordRevealedText(reveal({
            directory: '/project-a/', displayText: 'Same project prose', authoritativeText: 'Same project prose',
        }));
        expect(records({ directory: '/project-a/' }).map(({ displayText }) => displayText))
            .toEqual(['Local prose', 'Same project prose']);
    });

    test('crops the longest active prefix and reports whether the remaining tail is visible', () => {
        recordRevealedText(reveal({
            displayText: 'First answer',
            authoritativeText: 'First answer',
        }));
        recordRevealedText(reveal({
            displayText: 'Rewritten answer',
            authoritativeText: 'Rewritten answer',
        }));
        const part = textPart('part', 'message', 'Rewritten answer\nSecond line', 10);

        const crop = cropRevealedPart(records(), part);
        expect(crop.active?.displayText).toBe('Rewritten answer');
        expect(crop.records).toHaveLength(2);
        expect(crop.tail).toBe('\nSecond line');
        expect(crop.visibleTail).toBe(true);
        expect(crop.generation).toBe(10);
        expect(crop.authoritativeText).toBe('Rewritten answer\nSecond line');

        const invisibleTail = textPart('part', 'message', 'Rewritten answer\u200B', 10);
        expect(cropRevealedPart(records(), invisibleTail)).toMatchObject({
            tail: '\u200B',
            visibleTail: false,
        });
        expect(cropRevealedPart(records(), textPart('part', 'message', 'Rewritten answer', 11)))
            .toMatchObject({ records: [], active: null, tail: 'Rewritten answer' });
    });

    test('isolates records of two messages sharing a part id by default and by explicit message id', () => {
        const reusedId = 'reused-part';
        recordRevealedText(reveal({
            messageId: 'first-message',
            partId: reusedId,
            displayText: 'First prose',
            authoritativeText: 'First prose',
        }));
        recordRevealedText(reveal({
            messageId: 'second-message',
            partId: reusedId,
            displayText: 'Second prose',
            authoritativeText: 'Second prose',
        }));
        const firstPart = textPart(reusedId, 'first-message', 'First prose', 10);
        const secondPart = textPart(reusedId, 'second-message', 'Second prose', 10);

        const firstRecords = selectRevealedTextForMessage(records(), 'first-message');
        const secondRecords = selectRevealedTextForMessage(records(), 'second-message');
        expect(firstRecords.map(({ messageId }) => messageId)).toEqual(['first-message']);
        expect(secondRecords.map(({ messageId }) => messageId)).toEqual(['second-message']);
        expect(cropRevealedPart(records(), firstPart).records.map(({ messageId }) => messageId))
            .toEqual(['first-message']);
        expect(cropRevealedPart(records(), secondPart).records.map(({ messageId }) => messageId))
            .toEqual(['second-message']);
        expect(cropRevealedPart(firstRecords, secondPart).records).toEqual([]);
        const explicitFirst = cropRevealedPart(records(), firstPart, undefined, 'first-message');
        expect(explicitFirst.records).toEqual(firstRecords);
        expect(explicitFirst.active?.displayText).toBe('First prose');
        expect(cropRevealedPart(records(), secondPart, undefined, 'first-message').records)
            .toEqual(firstRecords);
        expect(cropRevealedPart(records(), firstPart, undefined, 'second-message').records)
            .toEqual(secondRecords);
        expect(cropRevealedPart(records(), secondPart, undefined, 'second-message').active?.displayText)
            .toBe('Second prose');
    });

    test('skips invisible prose, reads legacy aliases and generations, and seals presentation parts', () => {
        recordRevealedText(reveal({ displayText: '' }));
        recordRevealedText(reveal({ displayText: '\u200B\uFEFF' }));
        expect(records()).toEqual([]);
        expect(getRevealedTextVersion()).toBeGreaterThan(0);

        recordRevealedText(reveal({ messageId: 'message-a', displayText: 'Visible', presentation: 'generated-result' }));
        const record = records()[0];
        expect(record).toBeDefined();
        if (!record) return;
        expect(buildRevealedTextPart(record)).toEqual({
            type: 'text',
            id: 'part:revealed:message-a:' + record.revealId,
            sessionID: 'session',
            messageID: 'message-a',
            text: 'Visible',
            time: { start: 10, end: 10 },
        });

        const legacyContent = legacyTextPart('legacy-content', 'content', 'Longer legacy content');
        const legacyValue = legacyTextPart('legacy-value', 'value', 'A value');
        expect(readTextPartContent(legacyContent)).toBe('Longer legacy content');
        expect(readTextPartContent(legacyValue)).toBe('A value');
        expect(readTextPartContent(textPart('short', 'message', 'Short', 7))).toBe('Short');
        expect(readTextPartGeneration(textPart('short', 'message', 'Short', 7), 99)).toBe(7);
        expect(readTextPartGeneration(textPart('short', 'message', 'Short'), 99)).toBe(99);
        expect(readTextPartGeneration(textPart('short', 'message', 'Short'))).toBe(0);

        const part = textPart('part', 'message-a', 'Visible\nTail', 10);
        const tail = buildRevealedTailPart(part, '\nTail', 'Visible'.length, 10);
        expect(tail).toMatchObject({
            id: 'part:revealed-tail:10:7',
            text: '\nTail',
            time: { start: 10, end: 11 },
            metadata: { source: 'live' },
        });
        expect(buildRevealedTailPart(legacyContent, 'tail', 1, 10)).toMatchObject({
            id: 'legacy-content:revealed-tail:10:1',
            time: { start: 10, end: 10 },
        });
    });

    test('notifies subscribers of real changes, holds a stable frozen snapshot, and resets', () => {
        let notified = 0;
        const unsubscribe = subscribeRevealedText(() => { notified += 1; });
        const versionBefore = getRevealedTextVersion();
        recordRevealedText(reveal());
        expect(notified).toBe(1);
        expect(getRevealedTextVersion()).toBe(versionBefore + 1);
        const firstSnapshot = records();
        expect(Object.isFrozen(firstSnapshot)).toBe(true);

        recordRevealedText(reveal());
        expect(notified).toBe(1);
        expect(records()).toBe(firstSnapshot);

        recordRevealedText(reveal({ turnId: 'another-turn' }));
        expect(notified).toBe(2);
        expect(records({ turnId: 'another-turn' })).toHaveLength(1);
        unsubscribe();

        const versionBeforeReset = getRevealedTextVersion();
        resetRevealedTextForTests();
        expect(notified).toBe(2);
        expect(getRevealedTextVersion()).toBe(versionBeforeReset + 1);
        expect(records()).toEqual([]);
        expect(records({ turnId: 'another-turn' })).toEqual([]);
        recordRevealedText(reveal());
        expect(records()[0]?.revealId).toBe(1);
    });

    test('keeps at most 4000 turns, evicts the oldest, and refreshes recency on record', () => {
        recordRevealedText(reveal({ turnId: 'oldest' }));
        for (let index = 1; index < 4000; index += 1) {
            recordRevealedText(reveal({ turnId: `turn-${index}` }));
        }
        expect(records({ turnId: 'oldest' })).toHaveLength(1);
        expect(records({ turnId: 'turn-1' })).toHaveLength(1);

        recordRevealedText(reveal({
            turnId: 'oldest',
            displayText: 'Hello world',
            authoritativeText: 'Hello world',
        }));
        recordRevealedText(reveal({ turnId: 'newest' }));
        expect(records({ turnId: 'oldest' })[0]?.displayText).toBe('Hello world');
        expect(records({ turnId: 'turn-1' })).toEqual([]);
        expect(records({ turnId: 'newest' })).toHaveLength(1);
    });
});
