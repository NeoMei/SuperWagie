import { isInvisibleText } from '@/lib/invisibleText';
import type { Part, TextPart } from '@/lib/opencode/model';
import { normalizePath } from '@/lib/pathNormalization';

export type RevealedTextPresentation = 'markdown' | 'generated-result';

export interface RevealedTextTurnIdentity {
    readonly runtimeKey: string;
    readonly directory: string | undefined;
    readonly sessionId: string;
    readonly turnId: string;
}

export interface RevealedTextRecord extends RevealedTextTurnIdentity {
    readonly revealId: number;
    readonly messageId: string;
    readonly partId: string;
    readonly generation: number;
    readonly messageOrder: number;
    readonly partIndex: number;
    readonly displayText: string;
    readonly authoritativeText: string;
    readonly presentation: RevealedTextPresentation;
    readonly active: boolean;
}

export type RevealedTextInput = Omit<RevealedTextRecord, 'revealId' | 'active'>;

interface RevealedPartCrop {
    readonly records: readonly RevealedTextRecord[];
    readonly active: RevealedTextRecord | null;
    readonly tail: string;
    readonly visibleTail: boolean;
    readonly generation: number;
    readonly authoritativeText: string;
}

interface TurnRevealState {
    records: RevealedTextRecord[];
    snapshot: readonly RevealedTextRecord[];
}

const MAX_REVEALED_TURNS = 4000;
const EMPTY_RECORDS: readonly RevealedTextRecord[] = Object.freeze([]);
const turnStates = new Map<string, TurnRevealState>();
const listeners = new Set<() => void>();
let snapshotVersion = 0;
let nextRevealId = 1;

const turnKey = (identity: RevealedTextTurnIdentity): string => [
    identity.runtimeKey,
    normalizePath(identity.directory) ?? '',
    identity.sessionId,
    identity.turnId,
].join('\u0000');

const chainKey = (record: Pick<RevealedTextRecord, 'sessionId' | 'turnId' | 'messageId' | 'partId' | 'generation'>): string => [
    record.sessionId, record.turnId, record.messageId, record.partId, String(record.generation),
].join('\u0000');

const compareRecords = (left: RevealedTextRecord, right: RevealedTextRecord): number => (
    left.messageOrder - right.messageOrder
    || left.partIndex - right.partIndex
    || left.revealId - right.revealId
);

const notify = (): void => {
    snapshotVersion += 1;
    for (const listener of listeners) listener();
};

const readTurnState = (identity: RevealedTextTurnIdentity): TurnRevealState => {
    const key = turnKey(identity);
    const existing = turnStates.get(key);
    if (existing) {
        turnStates.delete(key);
        turnStates.set(key, existing);
        return existing;
    }
    const state: TurnRevealState = { records: [], snapshot: EMPTY_RECORDS };
    turnStates.set(key, state);
    if (turnStates.size > MAX_REVEALED_TURNS) {
        const oldest = turnStates.keys().next().value;
        if (oldest !== undefined) turnStates.delete(oldest);
    }
    return state;
};

const settleTurnState = (state: TurnRevealState): void => {
    state.snapshot = Object.freeze([...state.records].sort(compareRecords));
};

/** Records the exact prose that reached a reader outside the execution fold. */
export const recordRevealedText = (input: RevealedTextInput): void => {
    if (input.displayText.length === 0 || isInvisibleText(input.displayText)) return;
    const state = readTurnState(input);
    const key = chainKey(input);
    const matching = state.records.filter((record) => chainKey(record) === key);
    const extendable = matching
        .filter((record) => input.authoritativeText.startsWith(record.authoritativeText))
        .sort((left, right) => (
            Number(right.active) - Number(left.active)
            || right.displayText.length - left.displayText.length
        ))
        .find((record) => input.displayText.startsWith(record.displayText));

    if (extendable) {
        if (extendable.active
            && extendable.displayText === input.displayText
            && extendable.authoritativeText === input.authoritativeText
            && extendable.presentation === input.presentation
            && extendable.messageOrder === input.messageOrder
            && extendable.partIndex === input.partIndex) return;
        state.records = state.records.map((record) => {
            if (chainKey(record) !== key) return record;
            return record.revealId === extendable.revealId ? {
                ...record,
                displayText: input.displayText,
                authoritativeText: input.authoritativeText,
                presentation: input.presentation,
                messageOrder: input.messageOrder,
                partIndex: input.partIndex,
                active: true,
            } : { ...record, active: false };
        });
        settleTurnState(state);
        notify();
        return;
    }

    // A throttled display can briefly repeat an older prefix. That prefix is
    // already represented by a retained record; starting another chain would
    // pin the same prose twice.
    if (matching.some((record) => record.displayText.startsWith(input.displayText))) return;

    state.records = [
        ...state.records.map((record) => (
            chainKey(record) === key && record.active ? { ...record, active: false } : record
        )),
        { ...input, revealId: nextRevealId++, active: true },
    ];
    settleTurnState(state);
    notify();
};

export const subscribeRevealedText = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
};

export const getRevealedTextVersion = (): number => snapshotVersion;

export const getRevealedText = (identity: RevealedTextTurnIdentity): readonly RevealedTextRecord[] => (
    turnStates.get(turnKey(identity))?.snapshot ?? EMPTY_RECORDS
);

export const selectRevealedTextForMessage = (
    records: readonly RevealedTextRecord[],
    messageId: string,
): readonly RevealedTextRecord[] => records.filter((record) => record.messageId === messageId);

export const resetRevealedTextForTests = (): void => {
    turnStates.clear();
    nextRevealId = 1;
    notify();
};

/** The displayable text of a text part, including the legacy content aliases. */
export const readTextPartContent = (part: Part): string => {
    // SAFETY: legacy parts may carry content/value aliases; every other field keeps its Part type.
    const legacy = part as Part & { text?: string; content?: string; value?: string };
    const text = legacy.text ?? '';
    const content = legacy.content ?? '';
    const value = legacy.value ?? '';
    return [text, content, value].reduce((best, candidate) => candidate.length > best.length ? candidate : best, '');
};

export const readTextPartGeneration = (part: Part, messageCreatedAt?: number): number => (
    part.type === 'text' && part.time?.start !== undefined ? part.time.start : messageCreatedAt ?? 0
);

/** A sealed copy of prose the reader already saw, drawn without streaming behavior. */
export const buildRevealedTextPart = (record: RevealedTextRecord): TextPart => ({
    type: 'text',
    id: record.partId + ':revealed:' + record.messageId + ':' + record.revealId,
    sessionID: record.sessionId,
    messageID: record.messageId,
    text: record.displayText,
    time: { start: record.generation, end: record.generation },
});

/** The authoritative tail that has not yet been revealed outside the fold. */
export const buildRevealedTailPart = (
    part: Part,
    tail: string,
    shownLength: number,
    generation: number,
): TextPart => ({
    type: 'text',
    id: part.id + ':revealed-tail:' + generation + ':' + shownLength,
    sessionID: part.sessionID,
    messageID: part.messageID,
    text: tail,
    time: part.type === 'text' && part.time
        ? { start: part.time.start, end: part.time.end }
        : { start: generation, end: generation },
    metadata: part.type === 'text' ? part.metadata : undefined,
});

/** Splits a text part into pinned records and the still-foldable authoritative tail. */
export const cropRevealedPart = (
    records: readonly RevealedTextRecord[],
    part: Part,
    messageCreatedAt?: number,
    messageId: string = part.messageID,
): RevealedPartCrop => {
    const generation = readTextPartGeneration(part, messageCreatedAt);
    const partRecords = records
        .filter((record) => (
            record.messageId === messageId
            && record.partId === part.id
            && record.generation === generation
        ))
        .sort(compareRecords);
    const authoritativeText = readTextPartContent(part);
    let active: RevealedTextRecord | null = null;
    for (const record of partRecords) {
        if (!record.active || !authoritativeText.startsWith(record.displayText)) continue;
        if (!active || record.displayText.length > active.displayText.length) active = record;
    }
    const tail = active ? authoritativeText.slice(active.displayText.length) : authoritativeText;
    return {
        records: partRecords,
        active,
        tail,
        visibleTail: !isInvisibleText(tail),
        generation,
        authoritativeText,
    };
};

/**
 * Displayed history includes every earlier rewrite of this text part.
 * Only a record of the current generation can crop its authoritative tail.
 */
export const cropPinnedRevealedPart = (
    records: readonly RevealedTextRecord[],
    part: Part,
    messageCreatedAt?: number,
    messageId: string = part.messageID,
): RevealedPartCrop => {
    const current = cropRevealedPart(records, part, messageCreatedAt, messageId);
    const retired = records
        .filter((record) => (
            record.messageId === messageId
            && record.partId === part.id
            && record.generation !== current.generation
        ))
        .sort(compareRecords);
    return {
        ...current,
        records: [...retired, ...current.records].sort(compareRecords),
    };
};
