import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { BusyDots } from '@/components/ui/busy-dots';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { activityRowParts } from '../lib/turns/activityRows';
import type { ChatMessageEntry, TurnRecord } from '../lib/turns/types';
import { getLiveFinalMessage, getShownInteractions } from '../lib/turns/liveActivity';
import { summarizeLiveActivity } from '../lib/turns/liveActivitySummary';
import { latestRunningTool } from '../lib/turns/liveActivityStatus';
import { LiveActivityCollapse } from './LiveActivityCollapse';
import { LiveActivityInlineContentContext, LiveActivityToolsHiddenContext, LiveFinalActivityContext, LiveTurnHoistedInteractionsContext } from './liveActivityContext';
import { ShownToolCard } from '../message/parts/ShownToolCard';
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
import { ClockPausedContext } from '@/hooks/clockPausedContext';
import { isShimmerAllowed, watchHeaderShimmer } from '@/hooks/liveHeaderShimmer';
import { normalizePath } from '@/lib/pathNormalization';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import {
    getRevealedText,
    getRevealedTextVersion,
    readTextPartContent,
    readTextPartGeneration,
    selectRevealedTextForMessage,
    subscribeRevealedText,
} from '../lib/turns/revealedText';
import { RevealedTextTurnContext, type LivePinnedMessagePresentation } from './revealedTextContext';
import { PinnedMessage } from './withPinnedMessage';
import { LiveCommandPreview } from './liveCommandPreview';
import { LiveReasoningPreview } from './liveReasoningPreview';

const SHIMMER_STABLE_DELAY_MS = 1000;
const subscribeRuntimeKey = (notify: () => void): (() => void) => subscribeRuntimeEndpointChanged(() => notify());

/** The shimmer starts only after the whole folded header has held still for one second. */
const useStableHeaderShimmer = (identity: string, active: boolean) => {
    const clockPaused = React.useContext(ClockPausedContext);
    const [allowed, setAllowed] = React.useState(isShimmerAllowed);
    const headerRef = React.useRef<HTMLButtonElement>(null);
    const [readyIdentity, setReadyIdentity] = React.useState<string | null>(null);
    const canShimmer = active && !clockPaused && allowed;

    React.useEffect(() => {
        return watchHeaderShimmer(headerRef.current, setAllowed);
    }, []);

    React.useEffect(() => {
        setReadyIdentity(null);
        if (!canShimmer) return;
        const timer = window.setTimeout(() => setReadyIdentity(identity), SHIMMER_STABLE_DELAY_MS);
        return () => window.clearTimeout(timer);
    }, [identity, canShimmer]);

    return { ready: readyIdentity === identity && canShimmer, headerRef };
};

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
    const { t, locale } = useI18n();
    const contentId = React.useId();
    const finalContentId = React.useId();
    const belowInteractionsContentId = React.useId();
    const finalMessage = getLiveFinalMessage(turn.assistantMessages);
    const turnId = turn.turnId;
    const directory = useEffectiveDirectory();
    const runtimeKey = React.useSyncExternalStore(subscribeRuntimeKey, getRuntimeKey, getRuntimeKey);
    const sessionId = turn.userMessage.info.sessionID;
    const revealIdentity = React.useMemo(() => ({
        runtimeKey,
        directory: normalizePath(directory) ?? '',
        sessionId,
        turnId,
    }), [runtimeKey, directory, sessionId, turnId]);
    React.useSyncExternalStore(subscribeRevealedText, getRevealedTextVersion, getRevealedTextVersion);
    const revealedRecords = getRevealedText(revealIdentity);
    const messageOrderById = React.useMemo(() => new Map(
        turn.assistantMessages.map((message, order) => [message.info.id, order] as const),
    ), [turn.assistantMessages]);
    const activityMessages = React.useMemo(
        () => (finalMessage ? turn.assistantMessages.filter((message) => message !== finalMessage) : turn.assistantMessages),
        [finalMessage, turn.assistantMessages],
    );
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
    // One Activity header owns the outer disclosures and one inner disclosure
    // per pinned original message. The former fallback opened every tool and
    // reasoning row while a turn was running, which made the transcript grow
    // with each step and pushed the answer out of focus. A reader can open all
    // disclosures explicitly; the live header carries the current state and
    // latest running tool.
    const isExpanded = expanded ?? false;
    const liveTool = React.useMemo(
        () => latestRunningTool(turn.activityParts.map((activity) => activity.part)),
        [turn.activityParts],
    );
    const liveShell = React.useMemo(() => turn.activityParts.some((activity) => (
        activity.part.type === 'tool'
        && isShellTool(activity.part.tool)
        && (activity.part.state.status === 'pending' || activity.part.state.status === 'running')
    )), [turn.activityParts]);
    const liveThought = React.useMemo(() => {
        if (settled || liveTool) return undefined;
        const parts = turn.assistantMessages.at(-1)?.parts ?? [];
        for (let index = parts.length - 1; index >= 0; index -= 1) {
            const part = parts[index];
            if (part.type === 'reasoning' && part.time?.end === undefined) return part;
        }
        return undefined;
    }, [liveTool, settled, turn.assistantMessages]);
    // One latest progress update remains readable while the execution log is
    // folded between live steps. A live shell or thought owns the priority
    // preview instead; opening the fold shows the historical work without a
    // second copy in the transcript.
    const progressMessage = React.useMemo(() => {
        // The priority preview owns the live thought/command region. Keeping
        // the same progress text outside it duplicates the current content
        // directly below the folded header.
        if (finalMessage || isExpanded || liveShell || liveThought || (!isWorking && !waitingForUser) || hasLaterAssistant) return null;
        for (let index = turn.assistantMessages.length - 1; index >= 0; index -= 1) {
            const message = turn.assistantMessages[index];
            if (message.info.role !== 'assistant') continue;
            const parts = message.parts.filter((part) => part.type === 'text' && !isInvisibleText(part.text));
            if (parts.length > 0) return { ...message, parts };
        }
        return null;
    }, [finalMessage, isExpanded, isWorking, liveShell, liveThought, waitingForUser, hasLaterAssistant, turn.assistantMessages]);
    const foregroundMessage = finalMessage ?? progressMessage;
    const foregroundMessageId = foregroundMessage?.info.id;
    // Runtime-local revealed prose stays in the original ChatMessage root
    // above the Activity header. A rewritten foreground keeps retired text and
    // the current authoritative answer in one export-source wrapper outside
    // its pinned inner fold; only unrevealed work renders inside that fold.
    // Cold-loaded history has no runtime records and stays folded.
    const rewrittenForeground = foregroundMessage
        ? foregroundMessage.parts.some((part) => {
            if (part.type !== 'text') return false;
            const records = selectRevealedTextForMessage(revealedRecords, foregroundMessage.info.id)
                .filter((record) => record.partId === part.id);
            if (records.length === 0) return false;
            const authoritativeText = readTextPartContent(part);
            const generation = readTextPartGeneration(part, foregroundMessage.info.role === 'assistant'
                ? foregroundMessage.info.time.created
                : undefined);
            return records.some((record) => (
                !record.active
                || record.generation !== generation
                || !authoritativeText.startsWith(record.displayText)
            ));
        })
        : false;
    const pinnedForegroundMessage = rewrittenForeground ? foregroundMessage : null;
    const pinnedForegroundMessageId = pinnedForegroundMessage?.info.id;
    const foregroundToRender = pinnedForegroundMessageId ? null : foregroundMessage;
    const pinnedMessages = React.useMemo(() => turn.assistantMessages.filter((message) => (
        (message.info.id !== foregroundMessageId || Boolean(pinnedForegroundMessageId))
        && selectRevealedTextForMessage(revealedRecords, message.info.id).length > 0
    )), [foregroundMessageId, pinnedForegroundMessageId, revealedRecords, turn.assistantMessages]);
    const pinnedMessageIds = React.useMemo(() => new Set(pinnedMessages.map((message) => message.info.id)), [pinnedMessages]);
    const foldedMessages = React.useMemo(() => activityMessages.filter((message) => !pinnedMessageIds.has(message.info.id)),
        [activityMessages, pinnedMessageIds]);
    // The turn owns one effective state for all outer and pinned inner
    // disclosures. An absent choice follows execution; explicit reader choices
    // survive it.
    const showReasoningTraces = useUIStore((state) => state.showReasoningTraces);
    const reasoningText = useStreamingTextThrottle({
        text: !isExpanded && showReasoningTraces && liveThought?.type === 'reasoning' ? liveThought.text : '',
        isStreaming: Boolean(liveThought) && !isExpanded && showReasoningTraces,
        identityKey: liveThought?.id,
        allowTextReplacement: true,
    });
    const reasoningPreview = React.useMemo(() => getCompactReasoningSummary(reasoningText), [reasoningText]);
    // The folded header sweeps a soft highlight along its whole text row once
    // the row has stopped changing for a second. The composer status stays
    // still. Permission waits and settled turns carry no shimmer.
    // Questions, pages and proposed workflows remain outside execution,
    // including after the turn ends without a final answer. Each call ID has
    // one card owner: a pinned message, the hoisted list or the final message.
    const interactions = React.useMemo(() => getShownInteractions(turn.assistantMessages), [turn.assistantMessages]);
    // While the turn works, steps after the last interaction and the reply
    // being written stay below it in the order they happened. When the answer
    // arrives, later work folds below the retained prose and the answer.
    const foldedInteractions = React.useMemo(() => interactions.filter((part) => !pinnedMessageIds.has(part.messageID)),
        [interactions, pinnedMessageIds]);
    const lastInteractionMessageId = !finalMessage && foldedInteractions.length > 0
        ? foldedInteractions[foldedInteractions.length - 1]?.messageID
        : undefined;
    const [messagesAboveInteractions, messagesBelowInteractions] = React.useMemo(() => {
        const interactionIndex = lastInteractionMessageId ? foldedMessages.findIndex((message) => message.info.id === lastInteractionMessageId) : -1;
        if (interactionIndex < 0) return [foldedMessages, NO_MESSAGES];
        const split = interactionIndex + 1;
        return [foldedMessages.slice(0, split), foldedMessages.slice(split)];
    }, [foldedMessages, lastInteractionMessageId]);
    // Suppress in-place cards inside every message body. The owning pinned
    // message, hoisted list or final message draws each call exactly once.
    const hoistedInteractions = React.useMemo(() => new Set(interactions.map((part) => part.id)), [interactions]);
    const finalInteractions = React.useMemo(
        () => interactions.filter((part) => !pinnedMessageIds.has(part.messageID)),
        [interactions, pinnedMessageIds],
    );
    const finalContext = React.useMemo(() => finalMessage && foregroundToRender ? {
        messageId: finalMessage.info.id, expanded: isExpanded, contentId: finalContentId,
        animate: expanded !== undefined, interactions: finalInteractions,
    } : null, [finalMessage, foregroundToRender, isExpanded, finalContentId, expanded, finalInteractions]);
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
    const headerTitle = t(settled ? 'chat.liveActivity.title'
        : waitingPermission ? 'chat.toolPart.status.waitingPermission'
            : waitingAnswer ? 'chat.toolPart.status.waitingAnswer'
                : liveThought ? 'chat.reasoningTrace.thinking' : 'chat.liveActivity.title');
    const label = (
        <>
            <span className="live-activity-icon inline-flex shrink-0" data-running={liveTool ? 'true' : undefined}>
                <Icon name="stack" className="size-3.5 text-[var(--tools-icon)]" />
            </span>
            <span className="oc-activity-title shrink-0 font-semibold text-[var(--tools-title)]">
                {headerTitle}
                {!settled ? <BusyDots /> : null}
            </span>
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
    const headerIdentity = React.useMemo(() => [
        locale, headerTitle, String(settled), String(isExpanded), String(waitingPermission), String(waitingAnswer),
        String(terminalFailed), String(terminalStopped), liveTool?.label ?? '', liveTool?.description ?? '',
        reasoningPreview ?? '', fileLabel ?? '', details, String(showReasoningTraces),
    ].join('\u0000'), [locale, headerTitle, settled, isExpanded, waitingPermission, waitingAnswer,
        terminalFailed, terminalStopped, liveTool?.label, liveTool?.description, reasoningPreview,
        fileLabel, details, showReasoningTraces]);
    const shimmer = useStableHeaderShimmer(headerIdentity, !settled && !waitingForUser && !isExpanded);
    const windowStore = React.useContext(TurnMessageWindowContext);
    // The fold opens below its header, which stays where the reader clicked
    // it, and mounts its first steps (see openedFoldMessageWindow), so a very
    // long turn opens at once.
    const handleToggle = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
        if (!isExpanded) {
            dispatchRowExpand(event.currentTarget);
            if (windowStore) {
                const rowCount = foldedMessages.reduce(
                    (total, message) => total + activityRowParts(message.parts, showReasoningTraces).length,
                    0,
                );
                windowStore.setRange(turn.turnId, settled ? openedFoldMessageWindow(rowCount) : initialMessageWindow(rowCount));
            }
        }
        onToggle(!isExpanded);
    }, [foldedMessages, isExpanded, onToggle, settled, showReasoningTraces, turn.turnId, windowStore]);
    const headerClass = 'oc-activity-header w-full justify-start normal-case !ps-px !pe-2 text-[var(--tools-description)] hover:!bg-transparent active:!bg-transparent';
    const turnScope = React.useMemo(() => ({
        ...revealIdentity, messageOrderById, outsideFold: false,
    }), [revealIdentity, messageOrderById]);
    const outsideFoldScope = React.useMemo(() => ({
        ...revealIdentity, messageOrderById, outsideFold: true,
    }), [revealIdentity, messageOrderById]);
    const pinnedForegroundContext = React.useMemo(() => (
        pinnedForegroundMessageId ? { ...outsideFoldScope } : null
    ), [outsideFoldScope, pinnedForegroundMessageId]);
    const pinnedPresentations: LivePinnedMessagePresentation[] = React.useMemo(() => pinnedMessages.map((message, index) => ({
        messageId: message.info.id,
        contentId: 'pinned-' + contentId + '-' + index,
        expanded: isExpanded,
        animate: expanded !== undefined,
        interactions: message.info.id === pinnedForegroundMessageId
            ? interactions.filter((part) => (
                part.messageID === message.info.id
                || (Boolean(finalMessage) && finalInteractions.some((entry) => entry.id === part.id))
            ))
            : interactions.filter((part) => part.messageID === message.info.id),
        records: selectRevealedTextForMessage(revealedRecords, message.info.id),
        foreground: message.info.id === pinnedForegroundMessageId,
        revealTurnScope: message.info.id === pinnedForegroundMessageId ? pinnedForegroundContext : null,
    })), [contentId, expanded, finalInteractions, finalMessage, interactions, isExpanded, pinnedForegroundContext,
        pinnedForegroundMessageId, pinnedMessages, revealedRecords]);
    return (
        <LiveTurnHoistedInteractionsContext.Provider value={hoistedInteractions}>
            <LiveActivityInlineContentContext.Provider value>
            <LiveActivityToolsHiddenContext.Provider value={!isExpanded}>
            <RevealedTextTurnContext.Provider value={turnScope}>
            <div className="relative z-0" data-live-turn-activity={turn.turnId}>
                {pinnedMessages.map((message, index) => (
                    <PinnedMessage key={message.info.id} message={message} turnScope={turnScope}
                        presentation={pinnedPresentations[index]}
                        renderMessage={renderMessage} />
                ))}
                <div className="chat-message-column @container">
                    <div className="mt-1">
                        {/* The control names every rendered outer and pinned inner fold. */}
                        <Button variant="ghost" size="sm" className={headerClass} onClick={handleToggle}
                            ref={shimmer.headerRef}
                            data-shimmer={shimmer.ready ? 'ready' : undefined}
                            aria-expanded={isExpanded}
                            aria-controls={[contentId, ...(foregroundToRender && finalMessage ? [finalContentId] : []), ...(messagesBelowInteractions.length > 0 ? [belowInteractionsContentId] : []), ...pinnedPresentations.map((presentation) => presentation.contentId)].join(' ')}>
                            {label}
                            {shimmer.ready ? (
                                <span key={headerIdentity} className="oc-live-header-shimmer" aria-hidden="true">{label}</span>
                            ) : null}
                        </Button>
                    </div>
                </div>
                <LiveCommandPreview activities={turn.activityParts} directory={directory} visible={!isExpanded} />
                {!liveTool ? <LiveReasoningPreview text={reasoningText} visible={!isExpanded && Boolean(liveThought)} /> : null}
                <LiveActivityCollapse expanded={isExpanded} id={contentId} animate={expanded !== undefined}>
                    <div>
                        <TurnMessageWindow turnId={turn.turnId} messages={messagesAboveInteractions} renderMessage={renderMessage} />
                    </div>
                </LiveActivityCollapse>
                {!finalMessage && foldedInteractions.length > 0 ? (
                    <div className="chat-message-column">
                        {foldedInteractions.map((part) => <ShownToolCard key={part.id} part={part} />)}
                    </div>
                ) : null}
                {messagesBelowInteractions.length > 0 ? (
                    <LiveActivityCollapse expanded={isExpanded} id={belowInteractionsContentId} animate={expanded !== undefined}>
                        <div>
                            {messagesBelowInteractions.map((message) => (
                                <React.Fragment key={message.info.id}>{renderMessage(message)}</React.Fragment>
                            ))}
                        </div>
                    </LiveActivityCollapse>
                ) : null}
                <RevealedTextTurnContext.Provider value={outsideFoldScope}>
                    <LiveFinalActivityContext.Provider value={finalContext}>
                        {foregroundToRender ? renderMessage(foregroundToRender) : null}
                    </LiveFinalActivityContext.Provider>
                </RevealedTextTurnContext.Provider>
            </div>
            </RevealedTextTurnContext.Provider>
            </LiveActivityToolsHiddenContext.Provider>
            </LiveActivityInlineContentContext.Provider>
        </LiveTurnHoistedInteractionsContext.Provider>
    );
}
