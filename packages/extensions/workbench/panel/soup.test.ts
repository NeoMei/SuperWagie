import { describe, expect, test } from 'bun:test';

import { DAILY_SOUP, SOUP_AUTHOR, soupAuthor, soupFor } from './soup.ts';

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
        expect(soupAuthor('en')).toBe('SuperWagie');
    });

    test('switches the same daily quote to English and back without changing the day', () => {
        const english = new Set<string>();
        for (let day = 1; day <= DAILY_SOUP.length; day += 1) {
            const date = new Date(2026, 0, day);
            const chinese = soupFor(date, 'zh-CN');
            const translation = soupFor(date, 'en');
            expect(translation).not.toMatch(/\p{Script=Han}/u);
            expect(translation.trim().length).toBeGreaterThan(10);
            expect(soupFor(date, 'en-US')).toBe(translation);
            expect(soupFor(date, 'zh-CN')).toBe(chinese);
            english.add(translation);
        }
        expect(english.size).toBe(DAILY_SOUP.length);
    });
});
