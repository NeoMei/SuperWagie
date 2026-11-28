import React from 'react';
import { useI18n } from '@/lib/i18n';
import { appToolDisplayName } from '@/lib/toolHelpers';
import type { ReasoningPart as ReasoningPartData, ToolPart as ToolPartData } from '@/lib/opencode/model';
import {
    executeNamespace, isExecuteTool, isExplorationTool, isFileChangeTool, isNavigationTool,
    isShellTool, isSkillTool, isWebTool, normalizeToolName, shellCommandSummary,
} from '@/lib/opencode/tools';
import { useUIStore } from '@/stores/useUIStore';
import type { ToolPopupContent } from '../types';
import { ShownPartStreamPhaseContext } from '../../components/liveActivityContext';
import { useReasoningReveal } from '../../search/reasoningReveal';
import ReasoningPart, { ReasoningTimelineBlock } from './ReasoningPart';
import { CommandExecutionTitle } from './CommandExecution';
import { CommandGroupContext, type CommandMemberState } from './commandGroupContext';
import ToolPart from './ToolPart';
import { StaticToolRow } from './ProgressiveGroup';

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

const COUNT_LABELS = [
    ['edits', 'chat.activityGroup.edit', 'chat.activityGroup.edits'],
    ['commands', 'chat.liveActivity.ranCommand', 'chat.liveActivity.ranCommands'],
    ['reads', 'chat.activityGroup.read', 'chat.activityGroup.reads'],
    ['searches', 'chat.activityGroup.search', 'chat.activityGroup.searches'],
    ['web', 'chat.activityGroup.webCall', 'chat.activityGroup.webCalls'],
    ['skills', 'chat.activityGroup.skill', 'chat.activityGroup.skills'],
] as const;

const describeActivity = (tools: readonly ToolPartData[], t: ReturnType<typeof useI18n>['t']): string => {
    const counts = { edits: 0, commands: 0, reads: 0, searches: 0, web: 0, skills: 0 };
    const other = new Map<string, number>();
    for (const part of tools) {
        const name = normalizeToolName(part.tool);
        if (isFileChangeTool(name)) counts.edits++;
        else if (isShellTool(name)) counts.commands++;
        else if (isSkillTool(name)) counts.skills++;
        else if (isWebTool(name)) counts.web++;
        else if (name === 'read') counts.reads++;
        else if (isExplorationTool(name)) counts.searches++;
        else {
            const namespace = isExecuteTool(name) && part.state.status !== 'pending' ? executeNamespace(part.state.metadata) : undefined;
            const label = appToolDisplayName(namespace ?? part.tool, t) ?? namespace ?? name;
            other.set(label, (other.get(label) ?? 0) + 1);
        }
    }
    const labels: string[] = [];
    for (const [category, one, many] of COUNT_LABELS) {
        const count = counts[category];
        if (count > 0) labels.push(t(count === 1 ? one : many, { count }));
    }
    for (const [tool, count] of other) labels.push(count > 1 ? tool + ' ×' + count : tool);
    return labels.join(' · ');
};

type CommandActivityGroupProps = {
    id: string;
    parts: readonly (ToolPartData | ReasoningPartData)[];
    isExpanded: boolean;
    onToggle: (id: string) => void;
    isMobile: boolean;
    alwaysShowActions?: boolean;
    onShowPopup?: (content: ToolPopupContent) => void;
    animateTailText?: boolean;
};

/** Read and skill rows keep their file links. Other lookups can independently reveal their output. */
const ToolActivity = ({ part, isMobile, alwaysShowActions, onShowPopup }: {
    part: ToolPartData;
} & Pick<CommandActivityGroupProps, 'isMobile' | 'alwaysShowActions' | 'onShowPopup'>) => {
    const [expanded, setExpanded] = React.useState(false);
    const toolName = normalizeToolName(part.tool);
    return <div data-chat-source-message-id={part.messageID} data-chat-quote-root="true">
        {isNavigationTool(toolName)
            ? <StaticToolRow toolName={toolName} animateTailText={false}
                activities={[{ id: part.id, turnId: '', messageId: part.messageID, partIndex: 0, part, kind: 'tool' }]} />
            : <ToolPart part={part} isExpanded={expanded} onToggle={() => setExpanded((open) => !open)}
                isMobile={isMobile} alwaysShowActions={alwaysShowActions} onShowPopup={onShowPopup} />}
    </div>;
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
    const tools = parts.filter((part) => part.type === 'tool');
    const thoughts = parts.filter((part) => part.type === 'reasoning');
    const sources = new Set(thoughts.map((part) => part.messageID));
    const searchRequest = useReasoningReveal((messageId) => sources.has(messageId));
    const streamPhaseOf = React.useContext(ShownPartStreamPhaseContext);
    const mixed = tools.some((part) => !isShellTool(part.tool));
    const activeThought = thoughts.some((part) => {
        const stream = streamPhaseOf(part.messageID);
        return part.time?.end === undefined && (stream === 'streaming' || stream === 'cooldown');
    });
    const active = activeThought || tools.some((part) => {
        const status = reported.get(part.id)?.status ?? part.state.status;
        return status === 'pending' || status === 'running';
    });
    // Native controllers distinguish a finished call from a shell still
    // running in the background. Only completed lifecycle reports count.
    const completed = tools.filter((part) => reported.get(part.id)?.status === 'completed');
    const latestInput = completed.at(-1)?.state.input;
    const summary = React.useMemo(() => shellCommandSummary(latestInput), [latestInput]);
    const action = summary.kind === 'description' ? summary.text
        : summary.kind === 'command' ? t('chat.commandTrace.summary.command', { name: summary.name })
            : summary.kind === 'script' ? t('chat.commandTrace.summary.script', { name: summary.name })
                : t(SUMMARY_KEYS[summary.kind]);
    const completedSummary = completed.length === 0 ? undefined
        : completed.length === 1 ? t('chat.commandTrace.completedSingle', { summary: action })
            : t('chat.commandTrace.completedMultiple', { count: completed.length, summary: action });
    const failed = tools.some((part) => {
        const status = reported.get(part.id)?.status;
        return status ? status === 'failed' : part.state.status === 'error';
    });
    const activityLabel = mixed ? describeActivity(tools, t) : undefined;
    const title = activityLabel ?? <CommandExecutionTitle running={active} />;
    // The existing row-expansion set can request an open after a reader folded
    // the block. Only its rising edge creates a new reveal request.
    const [reveal, setReveal] = React.useState({ id, expanded: isExpanded, searchRequest, request: Number(searchRequest !== 0) });
    let current = reveal;
    if (reveal.id !== id || reveal.expanded !== isExpanded || reveal.searchRequest !== searchRequest) {
        const open = (isExpanded && !reveal.expanded) || (searchRequest !== 0 && searchRequest !== reveal.searchRequest);
        current = { id, expanded: isExpanded, searchRequest, request: reveal.request + Number(open) };
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
            kind: 'command', icon: 'terminal-box', fullTitle: activityLabel,
            title: failed ? <>{title} · <span className="text-[var(--status-error)]">{t('chat.toolPart.status.failed')}</span></> : title,
            completedSummary: mixed ? undefined : completedSummary,
            expandLabel: t(mixed ? 'chat.commandTrace.expandActivity' : 'chat.commandTrace.expandAria'),
            collapseLabel: t(mixed ? 'chat.commandTrace.collapseActivity' : 'chat.commandTrace.collapseAria'),
            markdownVariant: 'tool', maxHeightClassName: 'max-h-80',
        }}
        renderContent={(expanded, renderOutput) => <div className="space-y-3">
            {parts.map((part) => {
                if (part.type === 'tool' && isShellTool(part.tool)) {
                    return <CommandGroupContext.Provider key={part.id} value={{ expanded, renderOutput: expanded && renderOutput, report }}>
                        <ToolPart part={part} isExpanded={expanded} onToggle={onToggle} isMobile={isMobile}
                            alwaysShowActions={alwaysShowActions} onShowPopup={onShowPopup} animateTailText={animateTailText} />
                    </CommandGroupContext.Provider>;
                }
                if (!expanded || !renderOutput) return null;
                if (part.type === 'reasoning') {
                    return <div key={part.id} data-chat-source-message-id={part.messageID} data-chat-quote-root="true">
                        <ReasoningPart part={part} messageId={part.messageID} streamPhase={streamPhaseOf(part.messageID)} />
                    </div>;
                }
                return <ToolActivity key={part.id} part={part} isMobile={isMobile}
                    alwaysShowActions={alwaysShowActions} onShowPopup={onShowPopup} />;
            })}
        </div>}
    />;
};
