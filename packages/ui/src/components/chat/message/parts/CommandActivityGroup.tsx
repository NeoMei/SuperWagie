import React from 'react';
import { useI18n } from '@/lib/i18n';
import type { ToolPart as ToolPartData } from '@/lib/opencode/model';
import { shellCommandSummary } from '@/lib/opencode/tools';
import { useUIStore } from '@/stores/useUIStore';
import type { ToolPopupContent } from '../types';
import { ReasoningTimelineBlock } from './ReasoningPart';
import { CommandExecutionTitle } from './CommandExecution';
import { CommandGroupContext, type CommandMemberState } from './commandGroupContext';
import ToolPart from './ToolPart';

const SUMMARY_KEYS = {
    generic: 'chat.commandTrace.summary.generic',
    compound: 'chat.commandTrace.summary.compound',
    search: 'chat.commandTrace.summary.search',
    list: 'chat.commandTrace.summary.list',
    read: 'chat.commandTrace.summary.read',
    gitStatus: 'chat.commandTrace.summary.gitStatus',
    gitDiff: 'chat.commandTrace.summary.gitDiff',
    gitHistory: 'chat.commandTrace.summary.gitHistory',
    test: 'chat.commandTrace.summary.test',
    lint: 'chat.commandTrace.summary.lint',
    build: 'chat.commandTrace.summary.build',
    python: 'chat.commandTrace.summary.python',
    node: 'chat.commandTrace.summary.node',
} as const;

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
    // Native controllers distinguish a finished call from a shell still
    // running in the background. Only completed lifecycle reports count.
    const completed = parts.filter((part) => reported.get(part.id)?.status === 'completed');
    const latestInput = completed.at(-1)?.state.input;
    const summary = React.useMemo(() => shellCommandSummary(latestInput), [latestInput]);
    const action = summary.kind === 'description' ? summary.text
        : summary.kind === 'command' ? t('chat.commandTrace.summary.command', { name: summary.name })
            : summary.kind === 'script' ? t('chat.commandTrace.summary.script', { name: summary.name })
                : t(SUMMARY_KEYS[summary.kind]);
    const completedSummary = completed.length === 0 ? undefined
        : completed.length === 1 ? t('chat.commandTrace.completedSingle', { summary: action })
            : t('chat.commandTrace.completedMultiple', { count: completed.length, summary: action });
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
            completedSummary,
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
