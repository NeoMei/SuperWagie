import React from 'react';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useI18n } from '@/lib/i18n';

const LIVE_REASONING_PREVIEW_MAX_HEIGHT = 'max-h-40';

type LiveReasoningPreviewProps = {
    text: string;
    visible: boolean;
};

/** Keeps the current thought readable without letting it push the answer away. */
export const LiveReasoningPreview: React.FC<LiveReasoningPreviewProps> = ({ text, visible }) => {
    const { t } = useI18n();
    const scrollRef = React.useRef<HTMLElement>(null);
    const followEndRef = React.useRef(true);
    const lastScrollTopRef = React.useRef(0);

    React.useLayoutEffect(() => {
        const element = scrollRef.current;
        if (!element || !followEndRef.current) return;
        element.scrollTop = element.scrollHeight;
        lastScrollTopRef.current = element.scrollTop;
    }, [text]);

    const handleWheel = React.useCallback((event: React.WheelEvent<HTMLElement>) => {
        if (event.deltaY < 0) followEndRef.current = false;
    }, []);

    const handleScroll = React.useCallback((event: React.UIEvent<HTMLElement>) => {
        const element = event.currentTarget;
        const distanceToEnd = element.scrollHeight - element.clientHeight - element.scrollTop;
        if (distanceToEnd <= 2) {
            followEndRef.current = true;
        } else if (element.scrollTop < lastScrollTopRef.current - 1) {
            followEndRef.current = false;
        }
        lastScrollTopRef.current = element.scrollTop;
    }, []);

    if (!visible || text.length === 0) return null;

    return (
        <div className="chat-message-column mt-0.5" data-live-reasoning-preview="true">
            <ScrollableOverlay
                ref={scrollRef}
                as="pre"
                outerClassName={LIVE_REASONING_PREVIEW_MAX_HEIGHT}
                className="tool-output-surface w-full min-w-0 rounded-xl p-2 typography-micro whitespace-pre-wrap break-words"
                useScrollShadow
                scrollShadowSize={20}
                userIntentOnly
                data-scrollable="true"
                aria-label={t('chat.reasoningTrace.thinking')}
                onWheel={handleWheel}
                onScroll={handleScroll}
            >
                {text}
            </ScrollableOverlay>
        </div>
    );
};
