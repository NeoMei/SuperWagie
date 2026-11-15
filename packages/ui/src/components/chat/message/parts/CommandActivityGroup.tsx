import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { ToolPart as ToolPartData } from '@/lib/opencode/model';
import { hasTextSelectionInside } from '@/lib/textSelection';
import { dispatchRowExpand } from '@/components/chat/lib/scroll/timelineScrollIntent';
import type { ToolPopupContent } from '../types';
import { BlockLine } from './BlockLine';
import { CommandExecutionScroller, CommandExecutionTitle } from './CommandExecution';
import { CommandGroupContext, type CommandMemberState, type CommandMemberStatus } from './commandGroupContext';
import ToolPart, { LiveDuration, ToolRowStatusText } from './ToolPart';
import { useCommandDisclosure } from './useCommandDisclosure';

type CommandActivityGroupProps = {
    id: string;
    parts: readonly ToolPartData[];
    isExpanded: boolean;
    onToggle: (id: string) => void;
    isMobile: boolean;
    alwaysShowActions?: boolean;
    onShowPopup?: (content: ToolPopupContent) => void;
    animateTailText?: boolean;
};

const isActiveStatus = (status: CommandMemberStatus) => status === 'pending' || status === 'running'
    || status === 'stopping' || status === 'waitingPermission' || status === 'waitingAnswer' || status === 'retrying';

const aggregateStatus = (states: readonly CommandMemberState[]): CommandMemberStatus => {
    const active = states.find((state) => isActiveStatus(state.status));
    if (active) return active.status;
    if (states.some((state) => state.status === 'failed')) return 'failed';
    if (states.some((state) => state.status === 'unknown')) return 'unknown';
    if (states.some((state) => state.status === 'stopped')) return 'stopped';
    return 'completed';
};

/** Consecutive calls share disclosure while each call retains its runtime authority. */
export const CommandActivityGroup: React.FC<CommandActivityGroupProps> = ({
    id, parts, isExpanded, onToggle, isMobile, alwaysShowActions, onShowPopup, animateTailText,
}) => {
    const { t } = useI18n();
    const rowRef = React.useRef<HTMLDivElement>(null);
    const contentId = React.useId();
    const [reported, setReported] = React.useState<ReadonlyMap<string, CommandMemberState>>(() => new Map());
    const report = React.useCallback((partId: string, state: CommandMemberState) => {
        setReported((previous) => {
            const current = previous.get(partId);
            if (current?.status === state.status && current.start === state.start && current.end === state.end) return previous;
            const next = new Map(previous);
            next.set(partId, state);
            return next;
        });
    }, []);
    const states = parts.map((part): CommandMemberState => reported.get(part.id) ?? {
        status: part.state.status === 'error' ? 'failed' : part.state.status,
        start: 'time' in part.state ? part.state.time?.start : undefined,
        end: part.state.status === 'completed' || part.state.status === 'error' ? part.state.time.end : undefined,
    });
    const status = aggregateStatus(states);
    const active = isActiveStatus(status);
    const disclosure = useCommandDisclosure({ id, expanded: isExpanded, onToggle });
    const expanded = disclosure.choice ?? active;
    const context = React.useMemo(() => ({ expanded, report }), [expanded, report]);
    const starts = states.flatMap((state) => state.start === undefined ? [] : [state.start]);
    const ends = states.flatMap((state) => state.end === undefined ? [] : [state.end]);
    const start = starts.length ? Math.min(...starts) : undefined;
    const end = !active && ends.length === states.length ? Math.max(...ends) : undefined;
    const toggle = () => {
        if (!expanded) dispatchRowExpand(rowRef.current);
        disclosure.toggle(expanded);
    };
    return <CommandGroupContext.Provider value={context}>
        <div ref={rowRef} data-command-fold={id}>
            <div className="group/tool flex min-w-0 cursor-pointer items-center gap-1.5 rounded-xl py-1.5 pe-2 ps-px"
                role="button" tabIndex={0} data-command-header="true" aria-expanded={expanded}
                aria-controls={contentId} aria-label={t(expanded ? 'chat.commandTrace.collapseAria' : 'chat.commandTrace.expandAria')}
                onClick={(event) => { if (!hasTextSelectionInside(event.currentTarget)) toggle(); }}
                onKeyDown={(event) => {
                    if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
                    event.preventDefault();
                    toggle();
                }}>
                <Icon name={expanded ? 'arrow-down-s' : 'arrow-right-s'} className="size-3.5 shrink-0" />
                <span className="typography-meta shrink-0 font-medium !text-[length:var(--text-meta)] !leading-5 tracking-normal sm:!leading-6"
                    style={{ color: status === 'failed' ? 'var(--status-error)' : 'var(--tools-title)' }}>
                    <CommandExecutionTitle running={active} />
                </span>
                {start !== undefined && status !== 'unknown' ? <span className="typography-meta shrink-0 tabular-nums text-muted-foreground/80">
                    <LiveDuration start={start} end={end} active={active} />
                </span> : null}
                <ToolRowStatusText status={status} />
            </div>
            <div id={contentId} hidden={!expanded} aria-hidden={!expanded} className="relative ms-2 ps-3" style={{ overflowAnchor: 'none' }}>
                {expanded ? <BlockLine onToggle={toggle} topOffset={1} /> : null}
                <CommandExecutionScroller group expanded={expanded}>
                    <div className="space-y-3">
                        {parts.map((part) => <ToolPart key={part.id} part={part} isExpanded={expanded}
                            onToggle={onToggle} isMobile={isMobile} alwaysShowActions={alwaysShowActions}
                            onShowPopup={onShowPopup} animateTailText={animateTailText} />)}
                    </div>
                </CommandExecutionScroller>
            </div>
        </div>
    </CommandGroupContext.Provider>;
};
