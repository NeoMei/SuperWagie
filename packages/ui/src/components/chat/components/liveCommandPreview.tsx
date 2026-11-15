import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { BusyDots } from '@/components/ui/busy-dots';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useI18n } from '@/lib/i18n';
import { dispatchRowExpand } from '../lib/scroll/timelineScrollIntent';
import { BlockLine } from '../message/parts/BlockLine';
import { useBackgroundShellOutput } from '../message/parts/useBackgroundShellOutput';
import { LiveActivityCollapse } from './LiveActivityCollapse';
import type { TurnActivityRecord } from '../lib/turns/types';
import { latestShellPreview } from './liveCommandPreviewModel';

const MAX_COMMAND_OUTPUT_HEIGHT = 'max-h-40';

type Props = {
    activities: readonly TurnActivityRecord[];
    directory?: string;
    visible: boolean;
};

/** A command disclosure added below the upstream Activity header when folded. */
export const LiveCommandPreview: React.FC<Props> = ({ activities, directory, visible }) => {
    const shell = React.useMemo(() => latestShellPreview(activities), [activities]);
    if (!visible || !shell) return null;
    return <LiveCommandPreviewBody key={shell.key} shell={shell} directory={directory} />;
};

const LiveCommandPreviewBody: React.FC<{
    shell: NonNullable<ReturnType<typeof latestShellPreview>>;
    directory?: string;
}> = ({ shell, directory }) => {
    const { t } = useI18n();
    const [expanded, setExpanded] = React.useState(shell.running);
    const rowRef = React.useRef<HTMLDivElement>(null);
    const scrollRef = React.useRef<HTMLElement>(null);
    const followEndRef = React.useRef(true);
    const lastScrollTopRef = React.useRef(0);
    const outputFromShell = useBackgroundShellOutput(shell.shellID ?? '', directory, shell.running && shell.shellID !== undefined);
    const output = outputFromShell || shell.output || '';
    const command = shell.command || shell.description || t('chat.liveActivity.ranCommand', { count: 1 });

    React.useEffect(() => {
        setExpanded((previous) => shell.running ? previous : false);
    }, [shell.running]);

    React.useLayoutEffect(() => {
        const element = scrollRef.current;
        if (!element || !followEndRef.current) return;
        element.scrollTop = element.scrollHeight;
        lastScrollTopRef.current = element.scrollTop;
    }, [expanded, output]);

    const handleToggle = () => {
        if (!expanded) dispatchRowExpand(rowRef.current);
        setExpanded((previous) => !previous);
    };
    const handleWheel = (event: React.WheelEvent<HTMLElement>) => {
        if (event.deltaY < 0) followEndRef.current = false;
    };
    const handleScroll = (event: React.UIEvent<HTMLElement>) => {
        const element = event.currentTarget;
        const distanceToEnd = element.scrollHeight - element.clientHeight - element.scrollTop;
        if (distanceToEnd <= 2) followEndRef.current = true;
        else if (element.scrollTop < lastScrollTopRef.current - 1) followEndRef.current = false;
        lastScrollTopRef.current = element.scrollTop;
    };

    return (
        <div ref={rowRef} className="chat-message-column mt-0.5" data-live-command-fold={shell.key}>
            <div
                role="button"
                tabIndex={0}
                aria-expanded={expanded}
                aria-controls={`command-output-${shell.key}`}
                aria-label={expanded ? t('chat.commandTrace.collapseAria') : t('chat.commandTrace.expandAria')}
                className="group/tool flex cursor-pointer items-center gap-1.5 rounded-xl py-1.5 pe-2 ps-px"
                onClick={handleToggle}
                onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    handleToggle();
                }}
            >
                <span className="relative h-3.5 w-3.5 shrink-0" style={{ color: 'var(--tools-icon)' }}>
                    <span className="absolute inset-0 flex items-center justify-center transition-opacity group-hover/tool:opacity-0"><Icon name="terminal" className="h-3.5 w-3.5" /></span>
                    <span className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover/tool:opacity-100">
                        {expanded ? <Icon name="arrow-down-s" className="h-3.5 w-3.5" /> : <Icon name="arrow-right-s" className="h-3.5 w-3.5" />}
                    </span>
                </span>
                <span className="min-w-0 flex-1 truncate typography-meta font-medium" style={{ color: 'var(--tools-title)' }} title={command}>
                    {command}{shell.running ? <BusyDots /> : null}
                </span>
            </div>
            <LiveActivityCollapse expanded={expanded} id={`command-output-${shell.key}`}>
                <div className="relative ms-2 ps-3 pb-1 pt-0.5">
                    <BlockLine onToggle={handleToggle} />
                    {output ? (
                        <ScrollableOverlay ref={scrollRef} as="pre" outerClassName={MAX_COMMAND_OUTPUT_HEIGHT}
                            className="tool-output-surface w-full min-w-0 rounded-xl p-2 typography-micro whitespace-pre-wrap break-words"
                            useScrollShadow scrollShadowSize={20} userIntentOnly data-scrollable="true"
                            aria-label={t('chat.liveActivity.title')} onWheel={handleWheel} onScroll={handleScroll}>
                            {output}
                        </ScrollableOverlay>
                    ) : null}
                </div>
            </LiveActivityCollapse>
        </div>
    );
};
