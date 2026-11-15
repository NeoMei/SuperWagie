import React from 'react';
import { animate, type AnimationPlaybackControls } from 'motion';
import type { ReasoningPart as ReasoningPartData } from '@/lib/opencode/model';
import type { ReasoningActivityGroupMember } from '../../lib/turns/activityGroups';
import { ActivityGroupStreamContext } from '../../components/activityGroupsContext';
import { cn } from '@/lib/utils';
import { isInvisibleText } from '@/lib/invisibleText';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { BusyDots } from '@/components/ui/busy-dots';
import { BlockBody } from './BlockLine';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { MarkdownRenderer } from '../../MarkdownRenderer';
import type { MarkdownVariant } from '../../MarkdownRendererImpl';
import { useStreamingTextThrottle } from '../../hooks/useStreamingTextThrottle';
import { commitStreamedText } from '../../lib/streamTextCommit';
import type { StreamPhase } from '../types';
import { isReasoningRevealTarget, useReasoningReveal } from '@/components/chat/search/reasoningReveal';
import { dispatchRowExpand } from '@/components/chat/lib/scroll/timelineScrollIntent';

const TOOL_ROW_TEXT_CLASS = '!text-[length:var(--text-meta)] !leading-5 sm:!leading-6 tracking-normal';
// A row's name is its label: muted, regular weight, icon included. Thinking
// (and the notices drawn as this row: compaction, waits) has prose as its
// detail, a preview, so the whole row stays muted; tool rows put what they
// acted on in the foreground (ToolPart).
const TOOL_ROW_TITLE_CLASS = cn('typography-meta font-normal', TOOL_ROW_TEXT_CLASS);
const TOOL_ROW_DESCRIPTION_CLASS = cn('typography-meta', TOOL_ROW_TEXT_CLASS);

const cleanReasoningText = (text: string): string => {
    if (typeof text !== 'string' || isInvisibleText(text)) {
        return '';
    }

    return text
        .split('\n')
        .map((line: string) => line.replace(/^>\s?/, '').trimEnd())
        .filter((line: string) => !isInvisibleText(line))
        .join('\n')
        .trim();
};

const SUMMARY_MAX_CHARS = 80;
const SUMMARY_SOURCE_CHARS = 4000;
const EXPANDED_CONTENT_UNMOUNT_DELAY_MS = 200;
const EXPANDED_CONTENT_TRANSITION = { duration: 0.2, ease: 'easeOut' as const };

/** Strip common markdown syntax so the header preview reads as plain text. */
const stripMarkdown = (text: string): string =>
    text
        // Empty HTML comments are frequently appended by model tool wrappers.
        .replace(/<!--\s*-->/g, '')
        // Fenced code blocks → keep inner text on one line
        .replace(/```[\w]*\n?([\s\S]*?)```/g, (_, inner: string) => inner.trim())
        // A fence the excerpt cut before its closing marker
        .replace(/```[\w]*\n?/g, '')
        // Inline code
        .replace(/`([^`]+)`/g, '$1')
        // Bold + italic (*** / __)
        .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
        .replace(/_{1,3}([^_]+)_{1,3}/g, '$1')
        // Headings (# ## ###)
        .replace(/^#{1,6}\s+/gm, '')
        // Links [label](url) → label
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        // Blockquote markers
        .replace(/^>\s?/gm, '')
        // Horizontal rules
        .replace(/^[-*_]{3,}\s*$/gm, '')
        // Remaining leading/trailing punctuation from stripped markers
        .trim();

const getReasoningSummary = (text: string): string => {
    if (!text) {
        return '';
    }

    // The header shows the opening words, so only the start of the text is
    // read: the strip patterns rescan from every unclosed `[`, `_` or `*`, and
    // a long trace full of them took hundreds of milliseconds.
    const cutShort = text.length > SUMMARY_SOURCE_CHARS;
    const source = cutShort ? text.slice(0, SUMMARY_SOURCE_CHARS) : text;
    // Strip markdown, then collapse all whitespace runs into single spaces.
    const flat = stripMarkdown(source).replace(/\s+/g, ' ').trim();

    if (flat.length <= SUMMARY_MAX_CHARS) {
        return cutShort && flat ? `${flat}…` : flat;
    }

    // Cut at a word boundary before the limit, then append ellipsis.
    const cut = flat.lastIndexOf(' ', SUMMARY_MAX_CHARS);
    const end = cut > 0 ? cut : SUMMARY_MAX_CHARS;
    return `${flat.substring(0, end).trimEnd()}…`;
};

type ReasoningTimelineBlockProps = {
    text: string;
    content?: React.ReactNode;
    blockId: string;
    time?: { start?: number; end?: number };
    isStreaming?: boolean;
    actions?: React.ReactNode;
    /** Override the initial expanded state. Defaults to `isStreaming`. */
    defaultExpanded?: boolean;
    /**
     * Opens while it streams and folds when it ends. Off keeps a streaming
     * block folded to its header, so a block closing does not move the chat.
     */
    expandWhileStreaming?: boolean;
    /** Opens the block whenever it changes to a new non-zero value (a search hit in it). */
    revealRequest?: number;
    /** The message this reasoning belongs to; search finds and highlights the block by it. */
    reasoningMessageId?: string;
    revealMessageId?: string;
    /**
     * Presentation for rows that borrow this block for something other than
     * reasoning (a compaction summary): its own icon, title, toggle labels,
     * body typography and box height.
     */
    presentation?: {
        icon: IconName;
        iconClassName?: string;
        title: React.ReactNode;
        expandLabel: string;
        collapseLabel: string;
        markdownVariant: MarkdownVariant;
        maxHeightClassName: string;
    };
};

type ExpansionState = {
    expanded: boolean;
    source: 'auto' | 'user';
};

export const ReasoningTimelineBlock: React.FC<ReasoningTimelineBlockProps> = ({
    text,
    content,
    blockId,
    time,
    isStreaming = false,
    actions,
    defaultExpanded,
    expandWhileStreaming = true,
    revealRequest = 0,
    reasoningMessageId,
    revealMessageId,
    presentation,
}) => {
    const { t } = useI18n();
    const hasEnded = typeof time?.end === 'number';
    const canAutoExpand = expandWhileStreaming && isStreaming && !hasEnded;
    const [expansion, setExpansion] = React.useState<ExpansionState>(() => {
        if (defaultExpanded === true) {
            return { expanded: true, source: 'user' };
        }
        return { expanded: canAutoExpand, source: 'auto' };
    });
    const isExpanded = expansion.source === 'auto'
        ? canAutoExpand && expansion.expanded
        : expansion.expanded;
    const [shouldRenderExpandedContent, setShouldRenderExpandedContent] = React.useState(defaultExpanded === true || canAutoExpand);
    // Adjusted during render so the opened body is in the DOM on the first
    // commit, where the search highlight looks for it.
    const [handledReveal, setHandledReveal] = React.useState(0);
    if (revealRequest !== 0 && revealRequest !== handledReveal) {
        setHandledReveal(revealRequest);
        setExpansion({ expanded: true, source: 'user' });
        setShouldRenderExpandedContent(true);
    }
    const contentId = React.useId();
    const contentRef = React.useRef<HTMLDivElement>(null);
    const contentAnimationRef = React.useRef<AnimationPlaybackControls | null>(null);
    const contentMountedRef = React.useRef(false);

    // The thinking body lives in a capped scroll box in every state. While it
    // streams, the box follows its own end so the newest thought stays in
    // view without growing the timeline; a wheel or drag upward inside the
    // box hands the box to the reader, and returning to its end re-arms the
    // follow. The chat's own end-follow is unaffected: the box keeps a fixed
    // height once capped, so the timeline stops growing underneath it, and an
    // upward wheel over the box scrolls the box first (it is a nested
    // scroller) and only reaches the chat once the box sits at its top.
    const scrollBoxRef = React.useRef<HTMLElement | null>(null);
    const followBoxEndRef = React.useRef(true);
    const lastBoxScrollTopRef = React.useRef(0);
    const touchStartYRef = React.useRef<number | null>(null);
    const releaseBoxFollow = React.useCallback(() => {
        followBoxEndRef.current = false;
    }, []);
    const handleBoxWheel = React.useCallback((event: React.WheelEvent<HTMLElement>) => {
        if (event.deltaY < 0) releaseBoxFollow();
    }, [releaseBoxFollow]);
    const handleBoxTouchStart = React.useCallback((event: React.TouchEvent<HTMLElement>) => {
        touchStartYRef.current = event.touches[0]?.clientY ?? null;
    }, []);
    const handleBoxTouchMove = React.useCallback((event: React.TouchEvent<HTMLElement>) => {
        const startY = touchStartYRef.current;
        const touch = event.touches[0];
        if (startY === null || !touch) return;
        // A downward finger drags the content up: the reader wants history.
        if (touch.clientY > startY + 4) releaseBoxFollow();
    }, [releaseBoxFollow]);
    const handleBoxScroll = React.useCallback((event: React.UIEvent<HTMLElement>) => {
        const node = event.currentTarget;
        const distanceToEnd = node.scrollHeight - node.clientHeight - node.scrollTop;
        // A queued automatic scroll can arrive after markdown has grown again.
        // Only upward movement releases follow; a larger bottom gap does not.
        if (distanceToEnd <= 2) {
            followBoxEndRef.current = true;
        } else if (node.scrollTop < lastBoxScrollTopRef.current - 1) {
            followBoxEndRef.current = false;
        }
        lastBoxScrollTopRef.current = node.scrollTop;
    }, []);

    React.useEffect(() => {
        if (!isStreaming) return;
        followBoxEndRef.current = revealRequest === 0;
        const node = scrollBoxRef.current;
        if (!node || !globalThis.ResizeObserver) return;
        const content = node.firstElementChild;
        if (!content) return;
        const follow = () => {
            if (!followBoxEndRef.current) return;
            const end = node.scrollHeight - node.clientHeight;
            if (end - node.scrollTop > 1) node.scrollTop = end;
            // Record the actual (possibly clamped) position before scroll fires.
            lastBoxScrollTopRef.current = node.scrollTop;
        };
        // Growth lands asynchronously (markdown commits off the render pass),
        // so the content box is observed rather than the text prop.
        const observer = new ResizeObserver(follow);
        observer.observe(content);
        follow();
        return () => observer.disconnect();
    }, [isStreaming, revealRequest, shouldRenderExpandedContent]);

    // Search reveals the source inside the bounded box. Markdown can land
    // after this commit, so keep its source in view until a reader takes over.
    React.useLayoutEffect(() => {
        const box = scrollBoxRef.current;
        const content = box?.firstElementChild;
        if (!revealRequest || !revealMessageId || !isExpanded || !box || !content) return;
        let released = false;
        const reveal = () => {
            if (released) return;
            const target = [...content.querySelectorAll<HTMLElement>('[data-reasoning-message-id]')]
                .find((element) => element.dataset.reasoningMessageId === revealMessageId);
            if (!target) return;
            followBoxEndRef.current = false;
            box.scrollTop += target.getBoundingClientRect().top - box.getBoundingClientRect().top;
            lastBoxScrollTopRef.current = box.scrollTop;
        };
        const resize = new ResizeObserver(reveal);
        const mutation = new MutationObserver(reveal);
        const release = () => {
            released = true;
            resize.disconnect();
            mutation.disconnect();
            box.removeEventListener('wheel', release);
            box.removeEventListener('touchstart', release);
            box.removeEventListener('pointerdown', release);
            box.removeEventListener('keydown', release);
        };
        resize.observe(content);
        mutation.observe(content, { childList: true, subtree: true, characterData: true });
        box.addEventListener('wheel', release, { passive: true });
        box.addEventListener('touchstart', release, { passive: true });
        box.addEventListener('pointerdown', release, { passive: true });
        box.addEventListener('keydown', release);
        reveal();
        return release;
    }, [isExpanded, revealMessageId, revealRequest, shouldRenderExpandedContent]);

    // The header shows no summary while the part streams.
    const summary = React.useMemo(() => (isStreaming ? '' : getReasoningSummary(text)), [isStreaming, text]);
    const toggleAriaLabel = isExpanded
        ? presentation?.collapseLabel ?? t('chat.reasoningTrace.collapseAria')
        : presentation?.expandLabel ?? t('chat.reasoningTrace.expandAria');
    const title = presentation?.title ?? t('chat.reasoningTrace.thinking');

    const rowRef = React.useRef<HTMLDivElement>(null);
    const handleToggle = React.useCallback(() => {
        if (!isExpanded) dispatchRowExpand(rowRef.current);
        setShouldRenderExpandedContent(true);
        setExpansion({ expanded: !isExpanded, source: 'user' });
    }, [isExpanded]);

    const handleKeyDown = React.useCallback((event: React.KeyboardEvent) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            handleToggle();
        }
    }, [handleToggle]);

    React.useLayoutEffect(() => {
        setExpansion((prev) => {
            if (prev.source === 'user') {
                return prev;
            }
            if (prev.expanded === canAutoExpand) {
                return prev;
            }
            return { expanded: canAutoExpand, source: 'auto' };
        });
    }, [canAutoExpand]);

    React.useEffect(() => {
        if (isExpanded || isStreaming) {
            setShouldRenderExpandedContent(true);
            return;
        }

        if (!shouldRenderExpandedContent) {
            return;
        }

        if (typeof window === 'undefined') {
            setShouldRenderExpandedContent(false);
            return;
        }

        const timer = window.setTimeout(() => {
            setShouldRenderExpandedContent(false);
        }, EXPANDED_CONTENT_UNMOUNT_DELAY_MS);

        return () => {
            window.clearTimeout(timer);
        };
    }, [isExpanded, isStreaming, shouldRenderExpandedContent]);

    React.useLayoutEffect(() => {
        const element = contentRef.current;
        if (!element) {
            return;
        }

        contentAnimationRef.current?.stop();

        if (!contentMountedRef.current) {
            contentMountedRef.current = true;
            if (!isExpanded) {
                element.style.height = '0px';
                element.style.overflow = 'hidden';
                return;
            }

            element.style.height = '0px';
            element.style.overflow = 'hidden';

            const animation = animate(
                element,
                { height: 'auto' },
                EXPANDED_CONTENT_TRANSITION,
            );
            contentAnimationRef.current = animation;

            void animation.finished.then(() => {
                if (contentAnimationRef.current !== animation) {
                    return;
                }
                contentAnimationRef.current = null;
                element.style.overflow = 'visible';
                element.style.height = 'auto';
            }).catch(() => undefined);

            return () => {
                animation.stop();
                if (contentAnimationRef.current === animation) {
                    contentAnimationRef.current = null;
                }
            };
        }

        element.style.overflow = 'hidden';

        if (isExpanded) {
            element.style.height = '0px';
        } else {
            element.style.height = `${element.scrollHeight}px`;
        }

        const animation = animate(
            element,
            { height: isExpanded ? 'auto' : '0px' },
            EXPANDED_CONTENT_TRANSITION,
        );
        contentAnimationRef.current = animation;

        void animation.finished.then(() => {
            if (contentAnimationRef.current !== animation) {
                return;
            }
            contentAnimationRef.current = null;
            if (isExpanded) {
                element.style.overflow = 'visible';
                element.style.height = 'auto';
            } else {
                element.style.overflow = 'hidden';
            }
        }).catch(() => undefined);

        return () => {
            animation.stop();
            if (contentAnimationRef.current === animation) {
                contentAnimationRef.current = null;
            }
        };
    }, [isExpanded]);

    React.useEffect(() => {
        return () => {
            contentAnimationRef.current?.stop();
            contentAnimationRef.current = null;
        };
    }, []);

    // While genuinely streaming, the busy header must appear as soon as
    // reasoning starts even before the block-level reveal (commitStreamedText)
    // has committed a first complete line — otherwise "Thinking…" never shows
    // for the first moments of a short, single-paragraph response.
    if (!isStreaming && isInvisibleText(text)) {
        return null;
    }

    const reasoningBody = (
        <>
            {content ?? <div data-message-text-export-source="true">
                <MarkdownRenderer
                    content={text}
                    messageId={blockId}
                    isAnimated={false}
                    isStreaming={isStreaming}
                    variant={presentation?.markdownVariant ?? 'reasoning'}
                />
            </div>}
            {actions ? (
                <div className="mt-2 mb-1 flex items-center justify-start gap-1.5" data-message-actions="true">
                    <div className="flex items-center gap-1.5" data-message-action-group="true">
                        {actions}
                    </div>
                </div>
            ) : null}
        </>
    );

    return (
        <div ref={rowRef} data-reasoning-block-id={blockId} data-reasoning-message-id={reasoningMessageId} data-message-text-export-root="true">
            <div
                role="button"
                tabIndex={0}
                aria-expanded={isExpanded}
                aria-controls={contentId}
                aria-label={toggleAriaLabel}
                className={cn(
                    'group/tool flex gap-1.5 pe-2 ps-px py-1.5 rounded-xl cursor-pointer items-center',
                )}
                onClick={handleToggle}
                onKeyDown={handleKeyDown}
            >
                <div className={cn('flex items-center gap-1.5', presentation ? 'min-w-0 max-w-full' : 'flex-shrink-0')}>
                    <div className="relative h-3.5 w-3.5 flex-shrink-0 cursor-pointer">
                        <div
                            className={cn(
                                'absolute inset-0 transition-opacity',
                                isExpanded && 'opacity-0',
                                !isExpanded && 'group-hover/tool:opacity-0',
                            )}
                            style={{ color: 'var(--tools-icon)' }}
                        >
                            <Icon name={presentation?.icon ?? 'brain-ai-3'} className={cn('h-3.5 w-3.5', presentation?.iconClassName)} />
                        </div>
                        <div
                            className={cn(
                                'absolute inset-0 transition-opacity flex items-center justify-center',
                                isExpanded && 'opacity-100',
                                !isExpanded && 'opacity-0 group-hover/tool:opacity-100',
                            )}
                            style={{ color: 'var(--tools-icon)' }}
                        >
                            {isExpanded ? <Icon name="arrow-down-s" className="h-3.5 w-3.5" /> : <Icon name="arrow-right-s" className="h-3.5 w-3.5" />}
                        </div>
                    </div>

                    {isStreaming ? (
                        <span className={cn('flex items-center gap-1', TOOL_ROW_TITLE_CLASS)} style={{ color: 'var(--tools-description)' }}>
                            <span>{title}</span>
                            <BusyDots />
                        </span>
                    ) : (
                        <span
                            className={TOOL_ROW_TITLE_CLASS}
                            style={{ color: 'var(--tools-description)' }}
                        >
                            {title}
                        </span>
                    )}
                </div>

                <div className={cn('flex items-center gap-1 flex-1 min-w-0', TOOL_ROW_DESCRIPTION_CLASS)} style={{ color: 'var(--tools-description)' }}>
                    {!isStreaming && !isExpanded && summary ? (
                        <span
                            className={cn('min-w-0 truncate', TOOL_ROW_DESCRIPTION_CLASS)}
                            style={{ color: 'var(--tools-description)' }}
                            title={summary}
                        >
                            {summary}
                        </span>
                    ) : (
                        <span className="min-w-0 flex-1" />
                    )}
                </div>
            </div>

            {shouldRenderExpandedContent ? (
                <div
                    ref={contentRef}
                    id={contentId}
                    aria-hidden={!isExpanded}
                    style={{
                        height: isExpanded ? 'auto' : '0px',
                        overflow: isExpanded ? 'visible' : 'hidden',
                        overflowAnchor: 'none',
                    }}
                >
                    <BlockBody
                        onToggle={handleToggle}
                        style={{
                            opacity: isExpanded ? 1 : 0,
                            transform: isExpanded ? 'translateY(0)' : 'translateY(-4px)',
                            transition: 'opacity 180ms ease-out, transform 180ms ease-out',
                        }}
                    >
                        <ScrollableOverlay
                            ref={scrollBoxRef}
                            as="div"
                            outerClassName={presentation?.maxHeightClassName ?? 'max-h-80'}
                            className="p-0"
                            useScrollShadow
                            scrollShadowSize={36}
                            userIntentOnly
                            data-scrollable="true"
                            onWheel={handleBoxWheel}
                            onTouchStart={handleBoxTouchStart}
                            onTouchMove={handleBoxTouchMove}
                            onScroll={handleBoxScroll}
                        >
                            <div>{reasoningBody}</div>
                        </ScrollableOverlay>
                    </BlockBody>
                </div>
            ) : null}
        </div>
    );
};

type ReasoningPartProps = {
    part: ReasoningPartData;
    messageId: string;
    streamPhase?: StreamPhase;
    members?: readonly ReasoningActivityGroupMember[];
};

type ReasoningMember = { part: ReasoningPartData; messageId: string; phase?: StreamPhase };

const isMemberStreaming = ({ part, phase }: ReasoningMember): boolean => (
    (phase === 'streaming' || phase === 'cooldown') && part.time?.end === undefined
);

/** Each source keeps its own throttle, Markdown identity, and search root. */
const ReasoningMemberText = React.memo(({ member }: { member: ReasoningMember }) => {
    const { part, messageId } = member;
    const isStreaming = isMemberStreaming(member);
    const text = React.useMemo(() => cleanReasoningText(part.text), [part.text]);
    const throttled = useStreamingTextThrottle({ text, isStreaming, identityKey: `${messageId}:${part.id}` });
    const content = isStreaming ? commitStreamedText(throttled) : throttled;
    return <div data-reasoning-message-id={messageId} data-reasoning-part-id={part.id} data-chat-source-message-id={messageId} data-chat-quote-root="true" data-message-text-export-root="true">
        <div data-message-text-export-source="true">
            <MarkdownRenderer content={content} messageId={part.id} isAnimated={false} isStreaming={isStreaming} variant="reasoning" />
        </div>
    </div>;
});

const ReasoningPart = React.memo(({ part, messageId, streamPhase, members }: ReasoningPartProps) => {
    const expandWhileStreaming = useUIStore((state) => state.expandReasoningWhileStreaming);
    const live = React.useContext(ActivityGroupStreamContext);
    const sources = React.useMemo<ReasoningMember[]>(() => members
        ? members.map((member) => ({
            part: member.part,
            messageId: member.message.info.id,
            phase: member.message.info.role === 'assistant' && (member.message.info.time.completed ?? 0) > 0
                ? 'completed'
                : live?.messageId === member.message.info.id ? live.phase ?? 'streaming'
                    : member.message.info.id === messageId ? streamPhase : 'completed',
        }))
        : [{ part, messageId, phase: streamPhase }], [live, members, messageId, part, streamPhase]);
    const revealRequest = useReasoningReveal(sources.map((source) => source.messageId));
    const isStreaming = sources.some(isMemberStreaming);
    const text = React.useMemo(() => sources.map((source) => cleanReasoningText(source.part.text)).filter(Boolean).join('\n\n'), [sources]);
    const time = React.useMemo(() => {
        const starts = sources.flatMap((source) => source.part.time ? [source.part.time.start] : []);
        const ends = sources.flatMap((source) => source.part.time?.end === undefined ? [] : [source.part.time.end]);
        return { start: starts.length ? Math.min(...starts) : undefined, end: ends.length === sources.length ? Math.max(...ends) : undefined };
    }, [sources]);

    if (!isStreaming && isInvisibleText(text)) return null;
    return <ReasoningTimelineBlock
        text={text}
        content={<div className="space-y-3">{sources.map((source) => <ReasoningMemberText key={source.part.id} member={source} />)}</div>}
        blockId={part.id || `${messageId}-reasoning`}
        time={time}
        isStreaming={isStreaming}
        expandWhileStreaming={expandWhileStreaming}
        revealRequest={revealRequest}
        revealMessageId={sources.find((source) => isReasoningRevealTarget(source.messageId))?.messageId}
    />;
});

export default ReasoningPart;
