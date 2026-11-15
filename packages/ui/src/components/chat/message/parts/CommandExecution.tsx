import React from 'react';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { ClockPausedContext } from '@/hooks/clockPausedContext';
import { isShimmerAllowed, watchHeaderShimmer } from '@/hooks/liveHeaderShimmer';
import { useI18n } from '@/lib/i18n';

/** The command's header keeps a stable label while its output changes below. */
export const CommandExecutionTitle: React.FC<{ running: boolean }> = ({ running }) => {
    const { t } = useI18n();
    const title = t('chat.commandTrace.title');
    const paused = React.useContext(ClockPausedContext);
    const headerRef = React.useRef<HTMLSpanElement>(null);
    const [allowed, setAllowed] = React.useState(isShimmerAllowed);
    const [ready, setReady] = React.useState(false);
    const active = running && allowed && !paused;
    React.useEffect(() => watchHeaderShimmer(headerRef.current, setAllowed), []);
    React.useEffect(() => {
        setReady(false);
        if (!active) return;
        const timer = window.setTimeout(() => setReady(true), 1000);
        return () => window.clearTimeout(timer);
    }, [active, title]);
    return <span ref={headerRef} className="relative inline-flex items-center" data-command-title="true">
        {title}
        {active && ready ? <span className="oc-live-header-shimmer" aria-hidden="true">{title}</span> : null}
    </span>;
};

type CommandExecutionBodyProps = {
    command: string;
    output: string;
    error?: string;
    children?: React.ReactNode;
};

/** Command and stdout share one capped scroller; the authoritative part retains their text. */
export const CommandExecutionBody: React.FC<CommandExecutionBodyProps> = ({ command, output, error, children }) => {
    const scrollRef = React.useRef<HTMLElement>(null);
    const followEndRef = React.useRef(true);
    const lastTopRef = React.useRef(0);
    const touchYRef = React.useRef<number | null>(null);
    React.useLayoutEffect(() => {
        const node = scrollRef.current;
        if (!node || !followEndRef.current) return;
        node.scrollTop = node.scrollHeight;
        lastTopRef.current = node.scrollTop;
    }, [command, error, output]);
    return <ScrollableOverlay ref={scrollRef} outerClassName="max-h-80" className="tool-output-surface p-0" dir="ltr"
        useScrollShadow scrollShadowSize={24} userIntentOnly data-command-output="true" data-scrollable="true"
        onWheelCapture={(event) => { if (event.deltaY < 0) followEndRef.current = false; }}
        onTouchStart={(event) => { touchYRef.current = event.touches[0]?.clientY ?? null; }}
        onTouchMove={(event) => {
            const touch = event.touches[0];
            if (touchYRef.current !== null && touch && touch.clientY > touchYRef.current + 4) followEndRef.current = false;
        }}
        onScroll={(event) => {
            const node = event.currentTarget;
            if (node.scrollHeight - node.clientHeight - node.scrollTop <= 2) followEndRef.current = true;
            else if (node.scrollTop < lastTopRef.current - 1) followEndRef.current = false;
            lastTopRef.current = node.scrollTop;
        }}>
        <div className="space-y-2">
            {command ? <pre className="tool-input-text typography-code whitespace-pre-wrap break-words text-muted-foreground m-0">{command}</pre> : null}
            {output ? <pre className="typography-code whitespace-pre-wrap break-words m-0">{output}</pre> : null}
            {error ? <pre className="typography-code whitespace-pre-wrap break-words text-[var(--status-error)] m-0">{error}</pre> : null}
            {children}
        </div>
    </ScrollableOverlay>;
};
