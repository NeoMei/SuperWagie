import React from 'react';
import type { Part } from '@/lib/opencode/model';
import { MarkdownRenderer } from '../../MarkdownRenderer';
import type { StreamPhase, ToolPopupContent } from '../types';
import { useStreamingTextThrottle } from '../../hooks/useStreamingTextThrottle';
import { resolveAssistantDisplayText, resolveAssistantTextStreaming } from './assistantTextVisibility';
import { isInvisibleText } from '@/lib/invisibleText';
import { streamPerfCount, streamPerfObserve } from '@/stores/utils/streamDebug';
import { GeneratedJsonResultCard } from './GeneratedJsonResultCard';
import { parseGeneratedJsonResult } from './generatedJsonResult';
import { LiveActivityInlineContentContext } from '../../components/liveActivityContext';
import { RevealedTextPartContext, RevealedTextTurnContext } from '../../components/revealedTextContext';
import {
    readTextPartContent,
    readTextPartGeneration,
    recordRevealedText,
} from '../../lib/turns/revealedText';
import type { RevealedTextPresentation } from '../../lib/turns/revealedText';

type PartWithText = Part & { text?: string; content?: string; value?: string; time?: { start?: number; end?: number } };

// A streaming reply is read a block at a time (see streamTextCommit.ts); taking
// new text at most this often lets the blocks finished in between land, and
// move the chat, together.
const REPLY_REVEAL_INTERVAL_MS = 400;

interface AssistantTextPartProps {
    part: Part;
    sessionId?: string;
    messageId: string;
    streamPhase: StreamPhase;
    onShowPopup?: (content: ToolPopupContent) => void;
}

const AssistantTextPart: React.FC<AssistantTextPartProps> = ({
    part,
    sessionId,
    messageId,
    streamPhase,
    onShowPopup,
}) => {
    const inlineActivity = React.useContext(LiveActivityInlineContentContext);
    const turnScope = React.useContext(RevealedTextTurnContext);
    const partScope = React.useContext(RevealedTextPartContext);
    // Use part directly from props — parent provides the latest version from the store.
    // No store subscription here to avoid re-render cascade from unrelated delta events.
    const partWithText = part as PartWithText;
    const rawText = typeof partWithText.text === 'string' ? partWithText.text : '';
    const contentText = typeof partWithText.content === 'string' ? partWithText.content : '';
    const valueText = typeof partWithText.value === 'string' ? partWithText.value : '';
    const textContent = [rawText, contentText, valueText].reduce((best, candidate) => {
        return candidate.length > best.length ? candidate : best;
    }, '');
    const time = partWithText.time;
    const isFinalized = Boolean(time && typeof time.end !== 'undefined');
    const isStreaming = resolveAssistantTextStreaming({
        streamPhase,
        isFinalized,
    });

    streamPerfCount('ui.assistant_text_part.render');
    if (isStreaming) {
        streamPerfCount('ui.assistant_text_part.render.streaming');
    }

    const throttledTextContent = useStreamingTextThrottle({
        text: textContent,
        isStreaming,
        throttleMs: inlineActivity ? 100 : REPLY_REVEAL_INTERVAL_MS,
        identityKey: `${messageId}:${part.id ?? 'text'}`,
    });

    const displayTextContent = inlineActivity ? throttledTextContent : resolveAssistantDisplayText({
        textContent,
        throttledTextContent,
        isStreaming,
    });

    streamPerfObserve('ui.assistant_text_part.display_len', displayTextContent.length);

    const isRenderableTextPart = part.type === 'text' || part.type === 'reasoning';
    const generatedResult = !isStreaming && isFinalized ? parseGeneratedJsonResult(displayTextContent) : null;
    const presentation: RevealedTextPresentation = generatedResult ? 'generated-result' : 'markdown';
    const canRecordRevealedText = Boolean(
        isRenderableTextPart
        && part.type === 'text'
        && turnScope?.outsideFold
        && partScope
        && !partScope.pinnedCopy
        && !isInvisibleText(displayTextContent),
    );
    const revealSessionId = sessionId || part.sessionID;
    const revealMessageOrder = messageId ? turnScope?.messageOrderById.get(messageId) : undefined;
    const revealAuthoritativeText = canRecordRevealedText ? readTextPartContent(part) : '';
    const revealGeneration = canRecordRevealedText ? readTextPartGeneration(part, partScope?.messageCreatedAt) : 0;

    React.useLayoutEffect(() => {
        if (!canRecordRevealedText || !turnScope || !partScope || revealMessageOrder === undefined) return;
        recordRevealedText({
            runtimeKey: turnScope.runtimeKey,
            directory: turnScope.directory,
            sessionId: revealSessionId,
            turnId: turnScope.turnId,
            messageId,
            partId: part.id,
            generation: revealGeneration,
            messageOrder: revealMessageOrder,
            partIndex: partScope.partIndex,
            displayText: displayTextContent,
            authoritativeText: revealAuthoritativeText,
            presentation,
        });
    }, [
        canRecordRevealedText, displayTextContent, messageId, part.id, partScope, presentation,
        revealAuthoritativeText, revealGeneration, revealMessageOrder, revealSessionId, turnScope,
    ]);

    if (!isRenderableTextPart) {
        return null;
    }

    if (isInvisibleText(displayTextContent)) {
        return null;
    }

    if (generatedResult) {
        return (
            <div
                className="group/assistant-text relative my-1 break-words"
                key={part.id || `${messageId}-text`}
            >
                <GeneratedJsonResultCard result={generatedResult} />
            </div>
        );
    }

    return (
        <div
            className="group/assistant-text relative my-1 break-words"
            key={part.id || `${messageId}-text`}
            // The chat scroll stops following once the start of the reply
            // being written would leave the screen (useChatTimelineScroll).
            data-streaming-reply={isStreaming && part.type === 'text' ? '' : undefined}
        >
            <MarkdownRenderer
                content={displayTextContent}
                part={part}
                messageId={messageId}
                isAnimated={false}
                isStreaming={isStreaming}
                variant={part.type === 'reasoning' ? 'reasoning' : 'assistant'}
                enableFileReferences={isFinalized}
                onShowPopup={onShowPopup}
            />
        </div>
    );
};

export default React.memo(AssistantTextPart);
