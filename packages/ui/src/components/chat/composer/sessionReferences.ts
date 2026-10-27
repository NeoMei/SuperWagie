/**
 * Other sessions and their messages, mentioned in the composer's text.
 *
 * A mention is a session link in the text (`lingxi://session/…`, with
 * `?message=` for one message), written by the `@` picker or pasted; the
 * composer draws it as a chip, and the model reads it where the user put it.
 * Beside the text, each one also goes as a context part saying what it is: a
 * session by name, since a whole session is too long to send and the
 * openchamber tool reads it; a message whole, since the tool can list a
 * session's latest messages but cannot fetch one by id. Neither says what to
 * do with it; the user's message says that.
 */

import type { Message, Part, Session } from '@/lib/opencode/model';
import { findSessionLinks, sessionLinkKey, type SessionLinkTarget } from '@/lib/sessionLinks';

import type { ComposerContextReference } from './submit/buildOutgoingMessage';

type SessionReference = Extract<ComposerContextReference, { kind: 'session' | 'session-message' }>;

const EXCERPT_LENGTH = 120;

export const sessionReference = (session: Pick<Session, 'id' | 'title'>): SessionReference => ({
    kind: 'session',
    sessionId: session.id,
    title: session.title,
    contextText: `The user referenced another OpenChamber session, "${session.title}" (${session.id}). `
        + `Its messages can be read with the openchamber tool (session.messages, sessionId ${session.id}).`,
});

/** The text a person reads in a message: its own text parts, without context the app attached or tool output. */
export const messageText = (parts: readonly Part[]): string => parts
    .flatMap((part) => (part.type === 'text' && !part.metadata?.openchamberContext ? [part.text.trim()] : []))
    .filter(Boolean)
    .join('\n\n');

const authorOf = (role: Message['role']): string => {
    if (role === 'user') return 'the user of that session';
    if (role === 'assistant') return 'the agent of that session';
    return 'OpenChamber';
};

export const sessionMessageReference = (
    session: Pick<Session, 'id' | 'title'>,
    message: { info: Pick<Message, 'id' | 'role'>; parts: readonly Part[] },
): SessionReference | null => {
    const text = messageText(message.parts);
    if (!text) return null;
    const excerpt = text.replace(/\s+/g, ' ').trim();
    return {
        kind: 'session-message',
        sessionId: session.id,
        messageId: message.info.id,
        sessionTitle: session.title,
        excerpt: excerpt.length > EXCERPT_LENGTH ? `${excerpt.slice(0, EXCERPT_LENGTH - 1)}…` : excerpt,
        // Who attached it and who wrote it are said apart: the user attaches
        // messages they wrote themselves too, and an agent's words must not
        // read as the user's request.
        contextText: `The user attached a message from another OpenChamber session, "${session.title}" `
            + `(${session.id}, message ${message.info.id}). It was written by ${authorOf(message.info.role)}. The message:\n\n${text}`,
    };
};

/** The key of the link a reference was named by, matching `sessionLinkKey`. */
export const sessionReferenceKey = (reference: { sessionId: string; messageId?: string }): string => sessionLinkKey({
    sessionId: reference.sessionId,
    messageId: reference.messageId ?? null,
});

/** What the text mentions: the references read already, and the links not read yet. */
type MentionsInText = { references: SessionReference[]; unresolved: SessionLinkTarget[] };

/**
 * The references the text mentions, once each, in the order they first
 * appear; a link whose target is not resolved yet is left to the caller.
 */
export const sessionReferencesInText = (
    text: string,
    ownOrigins: readonly string[],
    resolved: ReadonlyMap<string, SessionReference>,
): MentionsInText => {
    const references: SessionReference[] = [];
    const unresolved: SessionLinkTarget[] = [];
    const seen = new Set<string>();
    for (const { target } of findSessionLinks(text, ownOrigins)) {
        const key = sessionLinkKey(target);
        if (seen.has(key)) continue;
        seen.add(key);
        const reference = resolved.get(key);
        if (reference) references.push(reference);
        else unresolved.push(target);
    }
    return { references, unresolved };
};
