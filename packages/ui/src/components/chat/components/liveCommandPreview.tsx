import React from 'react';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useI18n } from '@/lib/i18n';
import { useBackgroundShellOutput } from '../message/parts/useBackgroundShellOutput';
import type { TurnActivityRecord } from '../lib/turns/types';
import { latestRunningShellPreview, shouldRenderLiveCommandPreview } from './liveCommandPreviewModel';

const LIVE_COMMAND_PREVIEW_MAX_HEIGHT = 'max-h-40';

type LiveCommandPreviewProps = {
    activities: readonly TurnActivityRecord[];
    directory?: string;
    visible: boolean;
};

export const LiveCommandPreview: React.FC<LiveCommandPreviewProps> = ({ activities, directory, visible }) => {
    const shell = React.useMemo(() => latestRunningShellPreview(activities), [activities]);
    if (!visible || !shell) return null;

    return <LiveCommandPreviewBody key={shell.shellID} shellID={shell.shellID} directory={directory} />;
};

const LiveCommandPreviewBody: React.FC<{ shellID: string; directory?: string }> = ({ shellID, directory }) => {
    const { t } = useI18n();
    const output = useBackgroundShellOutput(shellID, directory, true);
    const scrollRef = React.useRef<HTMLElement>(null);
    const followEndRef = React.useRef(true);
    const lastScrollTopRef = React.useRef(0);

    React.useLayoutEffect(() => {
        const element = scrollRef.current;
        if (!element || !followEndRef.current) return;
        element.scrollTop = element.scrollHeight;
        lastScrollTopRef.current = element.scrollTop;
    }, [output]);

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

    if (!shouldRenderLiveCommandPreview(true, { shellID }, output)) return null;

    return (
        <div className="chat-message-column mt-0.5" data-live-command-preview="true">
            <ScrollableOverlay
                ref={scrollRef}
                as="pre"
                outerClassName={LIVE_COMMAND_PREVIEW_MAX_HEIGHT}
                className="tool-output-surface w-full min-w-0 rounded-xl p-2 typography-micro whitespace-pre-wrap break-words"
                useScrollShadow
                scrollShadowSize={20}
                userIntentOnly
                data-scrollable="true"
                aria-label={t('chat.liveActivity.title')}
                onWheel={handleWheel}
                onScroll={handleScroll}
            >
                {output}
            </ScrollableOverlay>
        </div>
    );
};
