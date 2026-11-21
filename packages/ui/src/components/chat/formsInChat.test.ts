import { describe, expect, test } from 'bun:test';

import { resolveFormDockMode, resolveFormsInChat } from './formsInChat';

describe('resolveFormDockMode', () => {
    test('keeps in-chat forms in the transcript while reading state is active', () => {
        expect(resolveFormDockMode(true, true)).toBe('in-chat');
    });

    test('collapses the dock while reading history', () => {
        expect(resolveFormDockMode(false, true)).toBe('reading');
        expect(resolveFormDockMode(false, false)).toBe('dock');
    });
});

describe('resolveFormsInChat', () => {
    test('shows forms in the main transcript when the transcript is visible', () => {
        expect(resolveFormsInChat({ enabled: true, pinned: false, transcriptShown: true })).toBe(true);
    });

    test('keeps forms in the dock for pinned or hidden surfaces', () => {
        expect(resolveFormsInChat({ enabled: true, pinned: true, transcriptShown: true })).toBe(false);
        expect(resolveFormsInChat({ enabled: true, pinned: false, transcriptShown: false })).toBe(false);
        expect(resolveFormsInChat({ enabled: false, pinned: false, transcriptShown: true })).toBe(false);
    });
});
