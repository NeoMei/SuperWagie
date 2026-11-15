import React from 'react';
import { useI18n } from '@/lib/i18n';
import type { ToolPart as ToolPartData } from '@/lib/opencode/model';
import { useUIStore } from '@/stores/useUIStore';
import type { ToolPopupContent } from '../types';
import { ReasoningTimelineBlock } from './ReasoningPart';
import { CommandExecutionTitle } from './CommandExecution';
import { CommandGroupContext, type CommandMemberState } from './commandGroupContext';
import ToolPart from './ToolPart';

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

/** Commands borrow the upstream thinking disclosure; their native state stays with each call. */
export const CommandActivityGroup: React.FC<CommandActivityGroupProps> = ({
    id, parts, isExpanded, onToggle, isMobile, alwaysShowActions, onShowPopup, animateTailText,
}) => {
    const { t } = useI18n();
    const expandWhileStreaming = useUIStore((state) => state.expandReasoningWhileStreaming);
    const [reported, setReported] = React.useState<ReadonlyMap<string, CommandMemberState>>(() => new Map());
    const report = React.useCallback((partId: string, state: CommandMemberState) => {
        setReported((previous) => {
            if (previous.get(partId)?.status === state.status) return previous;
            const next = new Map(previous);
            next.set(partId, state);
            return next;
        });
    }, []);
    const active = parts.some((part) => {
        const status = reported.get(part.id)?.status ?? part.state.status;
        return status === 'pending' || status === 'running';
    });
    // The existing row-expansion set can request an open after a reader folded
    // the block. Only its rising edge creates a new reveal request.
    const [reveal, setReveal] = React.useState({ id, expanded: isExpanded, request: 0 });
    let current = reveal;
    if (reveal.id !== id || reveal.expanded !== isExpanded) {
        current = { id, expanded: isExpanded, request: reveal.id === id ? reveal.request + Number(isExpanded) : 0 };
        setReveal(current);
    }
    return <ReasoningTimelineBlock
        text=""
        blockId={id}
        isStreaming={active}
        expandWhileStreaming={expandWhileStreaming}
        defaultExpanded={isExpanded ? true : undefined}
        revealRequest={current.request}
        keepContentMounted
        onExpandedChange={(expanded) => { if (expanded !== isExpanded) onToggle(id); }}
        presentation={{
            kind: 'command', icon: 'terminal-box', title: <CommandExecutionTitle running={active} />,
            expandLabel: t('chat.commandTrace.expandAria'), collapseLabel: t('chat.commandTrace.collapseAria'),
            markdownVariant: 'tool', maxHeightClassName: 'max-h-80',
        }}
        renderContent={(expanded, renderOutput) => <CommandGroupContext.Provider value={{ expanded, renderOutput: expanded && renderOutput, report }}>
            <div className="space-y-3">
                {parts.map((part) => <ToolPart key={part.id} part={part} isExpanded={expanded}
                    onToggle={onToggle} isMobile={isMobile} alwaysShowActions={alwaysShowActions}
                    onShowPopup={onShowPopup} animateTailText={animateTailText} />)}
            </div>
        </CommandGroupContext.Provider>}
    />;
};
