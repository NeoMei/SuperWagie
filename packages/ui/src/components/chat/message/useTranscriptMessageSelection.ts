import React from 'react';
import type { ChatMessageEntry } from '../lib/turns/types';
import { MessageSelectionToolbar } from './MessageSelectionToolbar';
import { readExportMessage, selectionMessageSource, toggleSelectedMessage, type MessageSelection } from './selectedMessageContent';

export const MESSAGE_SELECTION_BAR_HEIGHT = '2.75rem';

type MessageSelectionActions = {
    ids: ReadonlySet<string> | null;
    start: (id: string) => void;
    toggle: (id: string, range: boolean) => void;
};

export const MessageSelectionContext = React.createContext<MessageSelectionActions | null>(null);

export function useTranscriptMessageSelection(
    enabled: boolean,
    sessionId: string,
    directory: string | undefined,
    messages: readonly ChatMessageEntry[],
    readLiveMessages: () => readonly ChatMessageEntry[],
    readColumn: () => HTMLElement | null,
) {
    const [selection, setSelection] = React.useState<MessageSelection | null>(null);
    const source = React.useRef(messages);
    const scope = React.useRef<AbortController | null>(null);
    React.useLayoutEffect(() => { source.current = messages; }, [messages]);
    const readMessages = React.useCallback(() => selectionMessageSource(source.current, readLiveMessages()), [readLiveMessages]);

    React.useLayoutEffect(() => {
        const owner = new AbortController();
        scope.current = owner;
        return () => {
            owner.abort();
            setSelection(null);
        };
    }, [sessionId, directory, enabled]);

    const dismiss = React.useCallback(() => setSelection(null), []);

    const start = React.useCallback((id: string) => {
        if (!enabled || !scope.current || scope.current.signal.aborted) return;
        const row = readMessages().find((entry) => entry.info.id === id);
        if (row && readExportMessage(row, sessionId)) setSelection((previous) => previous ?? { ids: new Set([id]), anchorId: id });
    }, [enabled, readMessages, sessionId]);

    const toggle = React.useCallback((id: string, range: boolean) => {
        if (!scope.current || scope.current.signal.aborted) return;
        const orderedIds = range ? readMessages().flatMap((entry) => readExportMessage(entry, sessionId)?.id ?? []) : [id];
        setSelection((previous) => previous ? toggleSelectedMessage(previous, orderedIds, id, range) : previous);
    }, [readMessages, sessionId]);

    const context = React.useMemo(() => enabled ? { ids: selection?.ids ?? null, start, toggle } : null, [enabled, selection, start, toggle]);
    const toolbar = enabled && selection ? React.createElement(MessageSelectionToolbar, {
        ids: selection.ids, readMessages, scope, sessionId, readColumn, onDismiss: dismiss, height: MESSAGE_SELECTION_BAR_HEIGHT,
    }) : null;
    return { context, toolbar };
}
