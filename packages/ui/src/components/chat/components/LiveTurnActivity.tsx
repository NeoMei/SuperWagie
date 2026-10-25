import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { BusyDots } from '@/components/ui/busy-dots';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { activityRowParts } from '../lib/turns/activityRows';
import type { ChatMessageEntry, TurnRecord } from '../lib/turns/types';
import { getLiveFinalMessage, getShownPages } from '../lib/turns/liveActivity';
import { summarizeLiveActivity } from '../lib/turns/liveActivitySummary';
import { latestRunningTool } from '../lib/turns/liveActivityStatus';
import { LiveActivityCollapse } from './LiveActivityCollapse';
import { LiveActivityInlineContentContext, LiveActivityToolsHiddenContext, LiveFinalActivityContext, LiveTurnHoistedPagesContext } from './liveActivityContext';
import { ShownPage } from '../message/parts/HtmlRenderFrame';
import { TurnMessageWindow } from './TurnMessageWindow';
import { TurnMessageWindowContext, initialMessageWindow, openedFoldMessageWindow } from '../lib/turns/turnMessageWindow';
import { dispatchRowExpand } from '../lib/scroll/timelineScrollIntent';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useChildStoreManager, useScopedBlockingForms, useScopedBlockingPermissions, useSessionBlockingRequests, useSessionMessages } from '@/sync/sync-context';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { useBackgroundShellsStore } from '@/sync/background-shells';
import { readBackgroundSubagentChildID, readSubagentRun } from '@/lib/opencode/subagent-run';
import { readBackgroundShellID, readShellCompletion } from '@/lib/opencode/background-shell';
import { isShellTool } from '@/lib/opencode/tools';
import { useGlobalBlockingRequestsStore } from '@/sync/global-blocking-requests';
import { isStoppedTurnError } from '@/lib/messages/assistantError';
import { findLiveSession } from '@/sync/live-aggregate';
import { isInvisibleText } from '@/lib/invisibleText';
import { getCompactReasoningSummary } from '../lib/reasoningSummary';
import { useStreamingTextThrottle } from '../hooks/useStreamingTextThrottle';

const NO_MESSAGES: ChatMessageEntry[] = [];

interface LiveTurnActivityProps {
    turn: TurnRecord;
    hasLaterAssistant: boolean;
    isWorking: boolean;
    expanded?: boolean;
    onToggle: (expanded: boolean) => void;
    renderMessage: (message: ChatMessageEntry) => React.ReactNode;
}

export function LiveTurnActivity({ turn, hasLaterAssistant, isWorking, expanded, onToggle, renderMessage }: LiveTurnActivityProps) {
    const { t } = useI18n();
    const contentId = React.useId();
    const finalContentId = React.useId();
    const belowPagesContentId = React.useId();
    const finalMessage = getLiveFinalMessage(turn.assistantMessages);
    const activityMessages = React.useMemo(
        () => (finalMessage ? turn.assistantMessages.filter((message) => message !== finalMessage) : turn.assistantMessages),
        [finalMessage, turn.assistantMessages],
    );
    const directory = useEffectiveDirectory();
    const backgroundCalls = React.useMemo(() => {
        const children = new Set<string>();
        const shells = new Set<string>();
        for (const activity of turn.activityParts) {
            if (activity.part.type !== 'tool') continue;
            const child = readBackgroundSubagentChildID(activity.part);
            if (child) children.add(child);
            const shell = isShellTool(activity.part.tool) ? readBackgroundShellID(activity.part) : undefined;
            if (shell) shells.add(shell);
        }
        return { children, shells };
    }, [turn.activityParts]);
    const parentSessionID = turn.userMessage.info.sessionID;
    const activeBackgroundChild = useGlobalSessionStatusStore((state) => {
        for (const id of backgroundCalls.children) if (state.activeSessionIds.has(id)) return true;
        return false;
    });
    const activeBackgroundShell = useBackgroundShellsStore((state) => {
        for (const id of backgroundCalls.shells) if (state.byId.has(id)) return true;
        return false;
    });
    const backgroundWaitIndexed = useGlobalBlockingRequestsStore((state) => {
        for (const id of backgroundCalls.children) {
            const pending = state.bySession.get(id);
            if (pending && (pending.permissions.length > 0 || pending.forms.length > 0 || pending.pages.length > 0)) return true;
        }
        return false;
    });
    const backgroundMessages = useSessionMessages(
        activeBackgroundChild || activeBackgroundShell || backgroundWaitIndexed ? parentSessionID : '', directory,
    );
    const pendingBackground = React.useMemo(() => {
        const children = new Set(backgroundCalls.children);
        const shells = new Set(backgroundCalls.shells);
        for (const message of backgroundMessages) {
            const child = readSubagentRun(message);
            if (child) children.delete(child.childSessionID);
            const shell = readShellCompletion(message);
            if (shell) shells.delete(shell.shellID);
        }
        return { children, shells };
    }, [backgroundCalls, backgroundMessages]);
    const childRunning = useGlobalSessionStatusStore((state) => {
        for (const id of pendingBackground.children) if (state.activeSessionIds.has(id)) return true;
        return false;
    });
    const shellRunning = useBackgroundShellsStore((state) => {
        for (const id of pendingBackground.shells) if (state.byId.has(id)) return true;
        return false;
    });
    const backgroundChildIDs = React.useMemo(() => [...pendingBackground.children], [pendingBackground.children]);
    const childStores = useChildStoreManager();
    const liveDirectorySnapshot = React.useRef<readonly (string | undefined)[]>([]);
    const readLiveDirectories = React.useCallback(() => {
        const states = backgroundChildIDs.length > 0 ? Array.from(childStores.children.values(), (store) => store.getState()) : [];
        const next = backgroundChildIDs.map((id) => findLiveSession(states, id)?.directory);
        const previous = liveDirectorySnapshot.current;
        if (next.length === previous.length && next.every((value, index) => value === previous[index])) return previous;
        liveDirectorySnapshot.current = next;
        return next;
    }, [backgroundChildIDs, childStores]);
    const subscribeLiveDirectories = React.useCallback((notify: () => void) => (
        backgroundChildIDs.length > 0 ? childStores.subscribeAllSelected((state) => state.session, notify) : () => undefined
    ), [backgroundChildIDs, childStores]);
    const backgroundLiveDirectories = React.useSyncExternalStore(subscribeLiveDirectories, readLiveDirectories, readLiveDirectories);
    const backgroundRequestDirectories = useGlobalBlockingRequestsStore(useShallow((state) => (
        backgroundChildIDs.map((id) => state.bySession.get(id)?.directory ?? directory)
    )));
    const backgroundBlockingScopes = React.useMemo(() => backgroundChildIDs.flatMap((id, index) => {
        const childDirectory = backgroundLiveDirectories[index] ?? backgroundRequestDirectories[index];
        return childDirectory ? [{ directory: childDirectory, sessionIDs: [id] }] : [];
    }), [backgroundChildIDs, backgroundLiveDirectories, backgroundRequestDirectories]);
    const childBlocking = useSessionBlockingRequests(backgroundBlockingScopes);
    const waitingSessionID = !finalMessage && !hasLaterAssistant ? parentSessionID : null;
    const permissions = useScopedBlockingPermissions(waitingSessionID, directory);
    const forms = useScopedBlockingForms(waitingSessionID, directory);
    const waitingPermission = permissions.length > 0 || childBlocking.hasPermission;
    const waitingAnswer = forms.length > 0 || childBlocking.hasForm;
    const waitingForUser = waitingPermission || waitingAnswer;
    const settled = !(childRunning || shellRunning || waitingForUser || (isWorking && !finalMessage && !hasLaterAssistant));
    const lastAssistant = turn.assistantMessages.at(-1)?.info;
    const terminalError = settled && lastAssistant?.role === 'assistant' ? lastAssistant.error : undefined;
    const terminalFailed = settled && lastAssistant?.role === 'assistant' && (lastAssistant.finish === 'error' || Boolean(terminalError));
    const terminalStopped = terminalError && isStoppedTurnError(terminalError.type, terminalError.message);
    // Keep execution detail behind one activity summary. The former fallback
    // opened every tool and reasoning row while a turn was running, which made
    // the transcript grow with each step and pushed the answer out of focus.
    // A reader can still open the fold explicitly; the live header carries the
    // current state and latest running tool.
    const isExpanded = expanded ?? false;
    // One latest progress update remains readable while the execution log is
    // folded. Its original message stays in that log, so opening the fold
    // shows the complete sequence without a second copy in the transcript.
    const progressMessage = React.useMemo(() => {
        if (finalMessage || isExpanded || !isWorking || hasLaterAssistant) return null;
        for (let index = turn.assistantMessages.length - 1; index >= 0; index -= 1) {
            const message = turn.assistantMessages[index];
            if (message.info.role !== 'assistant') continue;
            const parts = message.parts.filter((part) => part.type === 'text' && !isInvisibleText(part.text));
            if (parts.length > 0) return { ...message, parts };
        }
        return null;
    }, [finalMessage, isExpanded, isWorking, hasLaterAssistant, turn.assistantMessages]);
    const liveTool = React.useMemo(
        () => latestRunningTool(turn.activityParts.map((activity) => activity.part)),
        [turn.activityParts],
    );
    const liveThought = React.useMemo(() => {
        if (settled || liveTool) return undefined;
        const parts = turn.assistantMessages.at(-1)?.parts ?? [];
        for (let index = parts.length - 1; index >= 0; index -= 1) {
            const part = parts[index];
            if (part.type === 'reasoning' && part.time?.end === undefined) return part;
        }
        return undefined;
    }, [liveTool, settled, turn.assistantMessages]);
    // The turn owns disclosure for prose, reasoning and tools together. An
    // absent choice follows execution; explicit reader choices survive it.
    const showReasoningTraces = useUIStore((state) => state.showReasoningTraces);
    const reasoningText = useStreamingTextThrottle({
        text: !isExpanded && showReasoningTraces && liveThought?.type === 'reasoning' ? liveThought.text : '',
        isStreaming: Boolean(liveThought) && !isExpanded && showReasoningTraces,
        identityKey: liveThought?.id,
        allowTextReplacement: true,
    });
    const reasoningPreview = React.useMemo(() => getCompactReasoningSummary(reasoningText), [reasoningText]);
    // A page the agent showed is never folded away: it sits below the fold,
    // above the answer once one arrives, and stays there in a turn that ended
    // without one. The fold no longer holds it, so it moves at most from the
    // bottom of the fold to the top of the answer.
    const pages = React.useMemo(() => getShownPages(turn.assistantMessages), [turn.assistantMessages]);
    // While the turn works, what the agent does after its last page (more
    // steps, the reply it is still writing) is drawn below the page, in the
    // order it happened; drawn inside the fold, it sat above the page until
    // the answer was marked final, and the page then jumped over it. Once the
    // answer arrives everything but the answer folds away as before.
    const lastPageMessageId = !finalMessage && pages.length > 0 ? pages[pages.length - 1]?.messageID : undefined;
    const [messagesAbovePages, messagesBelowPages] = React.useMemo(() => {
        const pageIndex = lastPageMessageId ? activityMessages.findIndex((message) => message.info.id === lastPageMessageId) : -1;
        if (pageIndex < 0) return [activityMessages, NO_MESSAGES];
        const split = pageIndex + 1;
        return [activityMessages.slice(0, split), activityMessages.slice(split)];
    }, [activityMessages, lastPageMessageId]);
    const hoistedPages = React.useMemo(() => new Set(pages.map((part) => part.id)), [pages]);
    const finalContext = React.useMemo(() => finalMessage ? {
        messageId: finalMessage.info.id, expanded: isExpanded, contentId: finalContentId, animate: expanded !== undefined, pages,
    } : null, [finalMessage, isExpanded, finalContentId, expanded, pages]);
    // No diff parsing at token frequency. The report is only shown once the
    // turn settles; later authoritative tool metadata can refine it.
    const summary = React.useMemo(() => settled ? summarizeLiveActivity(turn.assistantMessages) : null,
        [settled, turn.assistantMessages]);
    const fileLabel = summary && summary.files > 0
        ? t(summary.files === 1 ? 'chat.liveActivity.changedFile' : 'chat.liveActivity.changedFiles', { count: summary.files })
        : null;
    const details = summary ? [
        summary.explored ? t('chat.liveActivity.explored') : null,
        summary.commands > 0 ? t(summary.commands === 1 ? 'chat.liveActivity.ranCommand' : 'chat.liveActivity.ranCommands', { count: summary.commands }) : null,
        summary.researched ? t('chat.liveActivity.researched') : null,
        summary.subagents > 0 ? t(summary.subagents === 1 ? 'chat.liveActivity.usedSubagent' : 'chat.liveActivity.usedSubagents', { count: summary.subagents }) : null,
    ].filter(Boolean).join(' · ') : '';
    const label = (
        <>
            <span className="live-activity-icon inline-flex shrink-0" data-running={liveTool ? 'true' : undefined}>
                <Icon name="stack" className="size-3.5 text-[var(--tools-icon)]" />
            </span>
            <span className="shrink-0 font-semibold text-[var(--tools-title)]">{t(settled ? 'chat.liveActivity.title'
                : waitingPermission ? 'chat.toolPart.status.waitingPermission'
                    : waitingAnswer ? 'chat.toolPart.status.waitingAnswer'
                        : liveThought ? 'chat.reasoningTrace.thinking' : 'chat.liveActivity.title')}{!settled ? <BusyDots /> : null}</span>
            <Icon name={isExpanded ? 'arrow-down-s' : 'arrow-right-s'} className="size-3 shrink-0" />
            {terminalFailed ? (
                <span className={terminalStopped ? 'typography-meta' : 'typography-meta text-[var(--status-error-text)]'}>
                    {t(terminalStopped ? 'chat.toolPart.status.stopped' : 'chat.toolPart.status.failed')}
                </span>
            ) : null}
            {liveTool && !isExpanded ? (
                <span className="flex min-w-0 flex-1 items-center gap-1 typography-meta" data-live-tool="true">
                    <span className="shrink-0 font-medium" style={{ color: 'var(--tools-title)' }}>{liveTool.label}</span>
                    {liveTool.description ? (
                        <span className="min-w-0 truncate font-mono" style={{ color: 'var(--tools-description)' }} title={liveTool.description}>
                            {liveTool.description}
                        </span>
                    ) : null}
                </span>
            ) : null}
            {liveThought && !isExpanded && showReasoningTraces && reasoningPreview ? (
                <span className="min-w-0 flex-1 truncate text-start typography-meta" dir="auto" title={reasoningPreview}>
                    {reasoningPreview}
                </span>
            ) : null}
            {fileLabel ? (
                <span className="flex min-w-0 items-center gap-1 typography-meta @min-[560px]:shrink-0">
                    <span className="truncate">{fileLabel}</span>
                    {summary?.hasCompleteDiff && (summary.additions > 0 || summary.deletions > 0) ? (
                        <span className="shrink-0 tabular-nums">
                            <span className="text-[var(--status-success)]">+{summary.additions}</span>
                            <span aria-hidden="true">/</span>
                            <span className="text-[var(--status-error)]">-{summary.deletions}</span>
                        </span>
                    ) : null}
                </span>
            ) : null}
            {details ? <span className="hidden min-w-0 flex-1 truncate text-start typography-meta @min-[560px]:inline" title={details}>{fileLabel ? '· ' : ''}{details}</span> : null}
        </>
    );
    const windowStore = React.useContext(TurnMessageWindowContext);
    // The fold opens below its header, which stays where the reader clicked
    // it, and mounts its first steps (see openedFoldMessageWindow), so a very
    // long turn opens at once.
    const handleToggle = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
        if (!isExpanded) {
            dispatchRowExpand(event.currentTarget);
            if (windowStore) {
                const rowCount = activityMessages.reduce(
                    (total, message) => total + activityRowParts(message.parts, showReasoningTraces).length,
                    0,
                );
                windowStore.setRange(turn.turnId, settled ? openedFoldMessageWindow(rowCount) : initialMessageWindow(rowCount));
            }
        }
        onToggle(!isExpanded);
    }, [activityMessages, isExpanded, onToggle, settled, showReasoningTraces, turn.turnId, windowStore]);
    const headerClass = 'w-full justify-start normal-case !ps-px !pe-2 text-[var(--tools-description)] hover:!bg-transparent active:!bg-transparent';
    return (
        <LiveTurnHoistedPagesContext.Provider value={hoistedPages}>
            <LiveActivityInlineContentContext.Provider value>
            <LiveActivityToolsHiddenContext.Provider value={!isExpanded}>
            <div className="relative z-0" data-live-turn-activity={turn.turnId}>
                <div className="chat-message-column @container">
                    <div className="mt-1">
                        <Button variant="ghost" size="sm" className={headerClass} onClick={handleToggle}
                            aria-expanded={isExpanded}
                            aria-controls={[contentId, ...(finalMessage ? [finalContentId] : []), ...(messagesBelowPages.length > 0 ? [belowPagesContentId] : [])].join(' ')}>
                            {label}
                        </Button>
                    </div>
                </div>
                <LiveActivityCollapse expanded={isExpanded} id={contentId} animate={expanded !== undefined}>
                    <div>
                        <TurnMessageWindow turnId={turn.turnId} messages={messagesAbovePages} renderMessage={renderMessage} />
                    </div>
                </LiveActivityCollapse>
                {!finalMessage && pages.length > 0 ? (
                    <div className="chat-message-column">
                        {pages.map((part) => <ShownPage key={part.id} part={part} />)}
                    </div>
                ) : null}
                {messagesBelowPages.length > 0 ? (
                    <LiveActivityCollapse expanded={isExpanded} id={belowPagesContentId} animate={expanded !== undefined}>
                        <div>
                            {messagesBelowPages.map((message) => (
                                <React.Fragment key={message.info.id}>{renderMessage(message)}</React.Fragment>
                            ))}
                        </div>
                    </LiveActivityCollapse>
                ) : null}
                <LiveFinalActivityContext.Provider value={finalContext}>
                    {finalMessage ? renderMessage(finalMessage) : progressMessage ? renderMessage(progressMessage) : null}
                </LiveFinalActivityContext.Provider>
            </div>
            </LiveActivityToolsHiddenContext.Provider>
            </LiveActivityInlineContentContext.Provider>
        </LiveTurnHoistedPagesContext.Provider>
    );
}
