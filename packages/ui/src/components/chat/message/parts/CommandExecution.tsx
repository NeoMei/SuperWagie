import React from 'react';
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
