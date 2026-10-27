import { describe, expect, test } from 'bun:test';

import { buildMessageLink, findSessionLinks, isSessionDeepLink, parseSessionLink } from './sessionLinks';

describe('buildMessageLink', () => {
    test('builds the native deep link', () => {
        expect(buildMessageLink('ses_a', 'msg_1', { kind: 'deep-link' })).toBe('lingxi://session/ses_a?message=msg_1');
    });

    test('builds the web link on this page, keeping its path', () => {
        expect(buildMessageLink('ses_a', 'msg_1', { kind: 'web', origin: 'https://chamber.example', pathname: '/oc/' }))
            .toBe('https://chamber.example/oc/?session=ses_a&message=msg_1');
    });

    test('refuses identifiers outside the link alphabet', () => {
        expect(buildMessageLink('ses a', 'msg_1', { kind: 'deep-link' })).toBeNull();
        expect(buildMessageLink('ses_a', 'msg"]', { kind: 'deep-link' })).toBeNull();
    });
});

describe('parseSessionLink', () => {
    test('reads native session and message links', () => {
        expect(parseSessionLink('lingxi://session/ses_a?message=msg_1', [])).toEqual({ sessionId: 'ses_a', messageId: 'msg_1' });
        expect(parseSessionLink('lingxi://session/ses_a', [])).toEqual({ sessionId: 'ses_a', messageId: null });
    });

    test('reads web links only on an address of this instance', () => {
        const href = 'https://chamber.example/?session=ses_a&message=msg_1';
        expect(parseSessionLink(href, ['https://chamber.example'])).toEqual({ sessionId: 'ses_a', messageId: 'msg_1' });
        // The desktop page lives on its own scheme; the connected instance's address counts too.
        expect(parseSessionLink(href, ['openchamber-ui://app', 'https://chamber.example'])).toEqual({ sessionId: 'ses_a', messageId: 'msg_1' });
        expect(parseSessionLink(href, ['https://other.example'])).toBeNull();
        expect(parseSessionLink(href, [])).toBeNull();
    });

    test('reads a link that is just a session id', () => {
        expect(parseSessionLink('ses_efdbcde57ffeWPNoQ8p0LyWi3X', [])).toEqual({ sessionId: 'ses_efdbcde57ffeWPNoQ8p0LyWi3X', messageId: null });
        expect(parseSessionLink('/ses_a', [])).toEqual({ sessionId: 'ses_a', messageId: null });
        expect(parseSessionLink('docs/ses_a', [])).toBeNull();
        expect(parseSessionLink('ses_a.md', [])).toBeNull();
        expect(isSessionDeepLink('ses_a')).toBe(false);
    });

    test('ignores other routes and malformed IDs', () => {
        expect(parseSessionLink('openchamber://session/ses_a', [])).toBeNull();
        expect(parseSessionLink('lingxi://connect?v=2&p=x', [])).toBeNull();
        expect(parseSessionLink('lingxi://session/ses_a/extra', [])).toBeNull();
        expect(parseSessionLink('lingxi://session/ses_a?message=bad%22', [])).toBeNull();
        expect(parseSessionLink('not a url', [])).toBeNull();
    });

    test('recognises only session deep links as keepable chat links', () => {
        expect(isSessionDeepLink('lingxi://session/ses_a?message=msg_1')).toBe(true);
        expect(isSessionDeepLink('lingxi://connect?v=2')).toBe(false);
        expect(isSessionDeepLink('https://chamber.example/?session=ses_a')).toBe(false);
    });
});

describe('findSessionLinks', () => {
    test('finds the generated product link with punctuation and keeps the exact range', () => {
        const link = buildMessageLink('ses_a', 'msg_1', { kind: 'deep-link' });
        const text = `See ${link}, then https://chamber.example/?session=ses_b.`;
        expect(findSessionLinks(text, ['https://chamber.example'])).toEqual([
            { start: 4, end: 40, link: 'lingxi://session/ses_a?message=msg_1', target: { sessionId: 'ses_a', messageId: 'msg_1' } },
            { start: 47, end: 85, link: 'https://chamber.example/?session=ses_b', target: { sessionId: 'ses_b', messageId: null } },
        ]);
    });

    test('ignores other applications, privileged product routes and malformed targets', () => {
        expect(findSessionLinks('openchamber://session/ses_a otherlingxi://session/ses_a lingxi://connect?p=secret lingxi://session/ses_a/extra lingxi://session/ses_a?message=bad%22', [])).toEqual([]);
    });
});
