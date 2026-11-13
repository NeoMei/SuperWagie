import React from 'react';

import { getDesktopWindowVisibility, isDesktopShell } from '@/lib/desktop';
import { useProviderLogo } from '@/hooks/useProviderLogo';
import { z } from 'zod';
import type { ActivityTone } from '../lib/turns/activityTone';

interface ChatActivityToneDotProps {
    tone: ActivityTone;
    /** The provider whose mark carries the state in the working row. */
    providerId?: string | null;
}

type ActivityMarkStyle = React.CSSProperties & { '--oc-activity-logo': string };

const nativeVisibilityEventSchema = z.object({ detail: z.boolean() });

const documentIsVisible = (): boolean => !globalThis.document || globalThis.document.visibilityState !== 'hidden';

/** Desktop keeps painting a minimized window, so its own visibility gates the breath. */
const useActivityMarkVisible = (active: boolean): boolean => {
    const [pageVisible, setPageVisible] = React.useState(documentIsVisible);
    const [nativeVisible, setNativeVisible] = React.useState(true);

    React.useEffect(() => {
        if (!active || !globalThis.window) return;
        let cancelled = false;
        let revised = false;
        const onPageVisibility = () => setPageVisible(documentIsVisible());
        const ownerDocument = globalThis.document;
        ownerDocument.addEventListener('visibilitychange', onPageVisibility);
        onPageVisibility();

        const onVisibility = (event: Event) => {
            const parsed = nativeVisibilityEventSchema.safeParse(event satisfies Event);
            if (!parsed.success) return;
            revised = true;
            setNativeVisible(parsed.data.detail);
        };
        if (isDesktopShell()) {
            globalThis.window.addEventListener('openchamber:window-visibility', onVisibility);
            void getDesktopWindowVisibility().then((visible) => {
                if (!cancelled && !revised) setNativeVisible(visible === true);
            }).catch(() => undefined);
        }
        return () => {
            cancelled = true;
            ownerDocument.removeEventListener('visibilitychange', onPageVisibility);
            globalThis.window.removeEventListener('openchamber:window-visibility', onVisibility);
        };
    }, [active]);

    return pageVisible && nativeVisible;
};

/**
 * One decorative status mark shared by the three composer-rider hosts. The
 * floating working row passes the provider id, so its leftmost state light is
 * the active model's provider mark; a provider without a logo keeps the dot.
 */
export const ChatActivityToneDot: React.FC<ChatActivityToneDotProps> = ({ tone, providerId }) => {
    const { src, onError, hasLogo } = useProviderLogo(providerId);
    const breathing = tone === 'working' || tone === 'waiting';
    const visible = useActivityMarkVisible(breathing);
    const markClass = [
        'oc-activity-tone oc-activity-mark shrink-0',
        hasLogo && src ? 'size-4' : 'size-1.5',
        breathing && visible ? 'oc-activity-mark--breathing' : '',
    ].filter(Boolean).join(' ');

    if (hasLogo && src) {
        const logoStyle: ActivityMarkStyle = { '--oc-activity-logo': `url(${JSON.stringify(src)})` };
        return (
            <span aria-hidden="true" data-activity-tone={tone} className={markClass}>
                <img
                    src={src}
                    alt=""
                    draggable={false}
                    className="oc-activity-mark__probe"
                    onError={onError}
                />
                <span
                    className="oc-activity-mark__logo"
                    style={logoStyle}
                />
            </span>
        );
    }

    return (
        <span aria-hidden="true" data-activity-tone={tone} className={markClass}>
            <span className="oc-activity-mark__dot size-1.5 rounded-full" />
        </span>
    );
};
