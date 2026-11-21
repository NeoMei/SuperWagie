import { isInvisibleText } from '@/lib/invisibleText';
import { assistantTextSegments, flattenUserTextParts } from '@/lib/messages/messageText';
import { readSessionNotice } from '@/lib/opencode/session-notices';
import { readSourceControlProvider } from '@/lib/source-control/providers/registry';
import { isBackgroundReportEntry, isSkippedTimelineMessage } from '../lib/timelineRoles';
import type { ChatMessageEntry } from '../lib/turns/types';
import { normalizeUserDisplayParts } from './normalizeUserDisplayParts';

export type MessageSelection = { ids: ReadonlySet<string>; anchorId: string };

type ExportMessage = {
    id: string;
    role: 'user' | 'assistant';
    segments: string[];
};

/** The live tail can be newer than the loaded list. Refresh parts without changing transcript order or ownership. */
export function selectionMessageSource(
    messages: readonly ChatMessageEntry[],
    liveMessages: readonly ChatMessageEntry[],
): readonly ChatMessageEntry[] {
    if (liveMessages.length === 0) return messages;
    const latest = new Map(liveMessages.map((entry) => [entry.info.id, entry]));
    return messages.map((entry) => {
        const live = latest.get(entry.info.id);
        return live?.info.sessionID === entry.info.sessionID ? { ...entry, parts: live.parts } : entry;
    });
}

export function readExportMessage(entry: ChatMessageEntry, sessionId: string): ExportMessage | null {
    const { id, role, sessionID } = entry.info;
    if (sessionID !== sessionId || (role !== 'user' && role !== 'assistant')
        || readSessionNotice(entry.info) || isSkippedTimelineMessage(entry.info) || isBackgroundReportEntry(entry.info)) return null;
    const segments = (role === 'user'
        ? [flattenUserTextParts(normalizeUserDisplayParts(entry.parts, readSourceControlProvider))]
        : assistantTextSegments(entry.parts)).filter((text) => !isInvisibleText(text));
    return segments.length > 0 ? { id, role, segments } : null;
}

export function toggleSelectedMessage(
    selection: MessageSelection,
    orderedIds: readonly string[],
    id: string,
    range: boolean,
): MessageSelection {
    const end = orderedIds.indexOf(id);
    if (end < 0) return selection;
    const ids = new Set(selection.ids);
    const start = range ? orderedIds.indexOf(selection.anchorId) : -1;
    if (start >= 0) {
        for (const member of orderedIds.slice(Math.min(start, end), Math.max(start, end) + 1)) ids.add(member);
        return { ids, anchorId: selection.anchorId };
    }
    if (!ids.delete(id)) ids.add(id);
    return { ids, anchorId: id };
}

/** Resolve exact selected records in transcript order. A retired record never yields a partial export. */
export function messageSelectionSegments(
    messages: readonly ChatMessageEntry[],
    sessionId: string,
    ids: ReadonlySet<string>,
    labels: { user: string; assistant: string },
): string[] | null {
    const segments: string[] = [];
    const remaining = new Set(ids);
    for (const entry of messages) {
        if (!remaining.has(entry.info.id)) continue;
        const record = readExportMessage(entry, sessionId);
        if (!record) continue;
        remaining.delete(record.id);
        segments.push(`### ${labels[record.role]}`, ...record.segments);
        if (remaining.size === 0) break;
    }
    return remaining.size === 0 && segments.length > 0 ? segments : null;
}
