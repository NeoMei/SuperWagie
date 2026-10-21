import { describe, expect, test } from 'bun:test';

import { DAILY_SOUP, SOUP_AUTHOR, soupFor } from './soup.ts';

describe('daily soup', () => {
    test('keeps one line for the whole day', () => {
        expect(soupFor(new Date(2026, 9, 21, 0, 1))).toBe(soupFor(new Date(2026, 9, 21, 23, 59)));
    });

    test('moves to another line the next day', () => {
        expect(soupFor(new Date(2026, 9, 22))).not.toBe(soupFor(new Date(2026, 9, 21)));
    });

    test('only picks lines from the list', () => {
        for (let day = 1; day <= 40; day += 1) {
            expect(DAILY_SOUP).toContain(soupFor(new Date(2026, 0, day)));
        }
    });

    test('signs every line with the product name', () => {
        expect(SOUP_AUTHOR).toBe('犇马');
    });
});
