import React from 'react';
import { cn } from '@/lib/utils';

/**
 * The busy composer's stop control: a neutral coin with a red square and a
 * highlight travelling clockwise around the rim. The rim rotates in CSS; the
 * button and its label stay still.
 */
const useStopCoinPaused = (): boolean => {
    const [reduceMotion, setReduceMotion] = React.useState(
        () => globalThis.window?.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
    );
    const [hidden, setHidden] = React.useState(
        () => globalThis.document?.hidden === true
    );

    React.useEffect(() => {
        const preference = globalThis.window?.matchMedia?.('(prefers-reduced-motion: reduce)');
        const browserDocument = globalThis.document;
        const updateMotion = () => setReduceMotion(preference?.matches === true);
        const updateVisibility = () => setHidden(globalThis.document?.hidden === true);
        updateMotion();
        updateVisibility();
        preference?.addEventListener('change', updateMotion);
        browserDocument?.addEventListener('visibilitychange', updateVisibility);
        return () => {
            preference?.removeEventListener('change', updateMotion);
            browserDocument?.removeEventListener('visibilitychange', updateVisibility);
        };
    }, []);

    return reduceMotion || hidden;
};

export const ComposerStopCoin: React.FC<{ className?: string }> = ({ className }) => {
    const paused = useStopCoinPaused();

    return (
        <span
            data-composer-stop-coin=""
            data-composer-stop-coin-paused={paused ? '' : undefined}
            aria-hidden="true"
            className={cn('relative inline-flex shrink-0 items-center justify-center rounded-full', className)}
        >
            <span
                data-composer-stop-coin-base=""
                className="absolute inset-0 rounded-full"
                style={{
                    backgroundColor: 'color-mix(in srgb, var(--foreground) 22%, var(--surface-elevated))',
                    boxShadow: 'inset 0 0 0 1px var(--interactive-border)',
                }}
            />
            <span data-composer-stop-coin-orbit="" className="oc-stop-coin-orbit absolute inset-0 rounded-full" />
            <span data-composer-stop-coin-square="" className="relative h-1/3 w-1/3 rounded-[2px] bg-[var(--status-error)]" />
        </span>
    );
};
