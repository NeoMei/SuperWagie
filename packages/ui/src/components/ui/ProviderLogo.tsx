import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useProviderLogo } from '@/hooks/useProviderLogo';
import { cn } from '@/lib/utils';
import { getProviderLogoFallbackIcon } from './providerLogoFallback';
import { useUIStore } from '@/stores/useUIStore';
import { customProviderIconName } from '@/lib/customProviderIcons';

interface ProviderLogoProps {
    providerId: string;
    alt?: string;
    className?: string;
    onError?: () => void;
    /** Show the provider's own logo even when the user picked an icon for it. */
    ignoreCustomIcon?: boolean;
    /** Shown when this provider has no chosen icon or usable logo; null shows nothing. */
    fallback?: React.ReactNode;
    /** Draw a monochrome metadata mark in the current text colour. */
    tint?: boolean;
}

export const ProviderLogo: React.FC<ProviderLogoProps> = ({
    providerId,
    alt,
    className,
    onError: externalOnError,
    ignoreCustomIcon = false,
    fallback,
    tint = false,
}) => {
    const { src, onError: handleInternalError, hasLogo } = useProviderLogo(providerId);
    const customIcon = useUIStore((state) => state.customProviderIcons[providerId]);
    const fallbackIcon = getProviderLogoFallbackIcon(providerId);

    const handleError = React.useCallback(() => {
        handleInternalError();
        externalOnError?.();
    }, [handleInternalError, externalOnError]);

    if (customIcon && !ignoreCustomIcon) {
        return <Icon name={customProviderIconName(customIcon)} className={cn('text-muted-foreground', className)} />;
    }

    if (!hasLogo || !src) {
        if (fallback !== undefined) return <>{fallback}</>;
        return fallbackIcon ? <Icon name={fallbackIcon} className={cn('text-muted-foreground', className)} /> : null;
    }

    if (tint) {
        return (
            <>
                {/* A mask has no error event; the matching CORS image preserves fallback handling. */}
                <img src={src} alt="" aria-hidden hidden crossOrigin="anonymous" onError={handleError} />
                <span
                    role={alt === '' ? undefined : 'img'}
                    aria-label={alt === '' ? undefined : alt ?? `${providerId} logo`}
                    aria-hidden={alt === '' ? true : undefined}
                    className={cn('inline-block bg-current', className)}
                    style={{
                        maskImage: `url("${src}")`, WebkitMaskImage: `url("${src}")`,
                        maskSize: 'contain', WebkitMaskSize: 'contain',
                        maskRepeat: 'no-repeat', WebkitMaskRepeat: 'no-repeat',
                        maskPosition: 'center', WebkitMaskPosition: 'center',
                    }}
                />
            </>
        );
    }

    return (
        <img
            src={src}
            alt={alt ?? `${providerId} logo`}
            aria-hidden={alt === '' ? true : undefined}
            className={cn('dark:invert object-contain', className)}
            loading="eager"
            decoding="async"
            fetchPriority="high"
            draggable={false}
            onError={handleError}
        />
    );
};
