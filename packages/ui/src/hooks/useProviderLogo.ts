import { useState, useCallback, useEffect } from 'react';
import productMarkUrl from '@/assets/provider-logos/superwagie.png?url';

type LogoSource = 'local' | 'remote' | 'none';

interface UseProviderLogoReturn {
    src: string | null;
    onError: () => void;
    hasLogo: boolean;
}

// Vite rewrites `import.meta.glob` at build time into the matching modules. A runtime without
// that transform (the bun test runner) throws on the call instead, so keep it failable and let
// the hook fall back to the remote logo URL it already supports.
const loadLocalLogoModules = (): Record<string, string> => {
    try {
        return import.meta.glob<string>('../assets/provider-logos/*.svg', {
            eager: true,
            import: 'default',
        });
    } catch {
        return {};
    }
};

const localLogoModules = loadLocalLogoModules();

const LOCAL_PROVIDER_LOGO_MAP = new Map<string, string>();
const PRELOADED_LOGO_SRCS = new Set<string>();

const LOGO_ALIAS = new Map<string, string>([
    ['codex', 'openai'],
    ['chatgpt', 'openai'],
    ['claude', 'anthropic'],
    ['cline-pass', 'cline'],
    ['gemini', 'google'],
    ['evroc-ai', 'evroc'],
    ['evrocai', 'evroc'],
    ['ollama-cloud', 'ollama'],
    ['wafer-ai', 'wafer.ai'],
    ['wafer', 'wafer.ai'],
    ['copilot', 'github-copilot'],
]);

// Account-backed SuperWagie models keep their provider's rotating operation id
// in the native provider id. The product mark is the provider's logo for every
// one of those instances; making the renderer guess from the model family would
// put another vendor's mark on SuperWagie's account connection.
const SUPERWAGIE_PROVIDER_PREFIX = 'superwagie-account-';
const SUPERWAGIE_LOGO_SRC = productMarkUrl;

const normalizeProviderId = (providerId: string | null | undefined) => {
    return (providerId ?? '')
        .toLowerCase()
        .trim()
        .replace(/^models\./, '')
        .replace(/^provider\./, '')
        .replace(/\s+/g, '-');
};

const isSuperWagieProvider = (providerId: string | null | undefined): boolean => {
    const normalized = normalizeProviderId(providerId);
    return normalized === 'superwagie' || normalized.startsWith(SUPERWAGIE_PROVIDER_PREFIX);
};

const buildLogoCandidates = (providerId: string | null | undefined) => {
    const normalized = normalizeProviderId(providerId);
    if (!normalized) {
        return [] as string[];
    }

    const compact = normalized.replace(/[^a-z0-9_\-./:]/g, '');
    const primary = compact.split(/[/:]/)[0] || compact;
    const prefixAlias = compact.startsWith('exe-') ? 'exe-dev' : undefined;
    const candidates = [prefixAlias, LOGO_ALIAS.get(compact), LOGO_ALIAS.get(primary), compact, primary]
        .filter((value): value is string => Boolean(value && value.length > 0));

    return [...new Set(candidates)];
};

const resolveProviderLogoSrc = (providerId: string | null | undefined): string | null => {
    if (isSuperWagieProvider(providerId)) {
        return SUPERWAGIE_LOGO_SRC;
    }
    const candidates = buildLogoCandidates(providerId);
    const localResolvedId = candidates.find((candidate) => LOCAL_PROVIDER_LOGO_MAP.has(candidate)) ?? null;
    const localLogoSrc = localResolvedId ? LOCAL_PROVIDER_LOGO_MAP.get(localResolvedId) ?? null : null;
    if (localLogoSrc) {
        return localLogoSrc;
    }

    const remoteResolvedId = candidates[0] ?? null;
    return remoteResolvedId ? `https://models.dev/logos/${remoteResolvedId}.svg` : null;
};

const preloadProviderLogo = (providerId: string | null | undefined): void => {
    if (typeof Image === 'undefined') return;
    const src = resolveProviderLogoSrc(providerId);
    if (!src || PRELOADED_LOGO_SRCS.has(src)) return;

    PRELOADED_LOGO_SRCS.add(src);
    const image = new Image();
    image.decoding = 'async';
    image.onerror = () => {
        PRELOADED_LOGO_SRCS.delete(src);
    };
    image.src = src;
    void image.decode?.().catch(() => undefined);
};

export const preloadProviderLogos = (providerIds: readonly (string | null | undefined)[]): void => {
    for (const providerId of providerIds) {
        preloadProviderLogo(providerId);
    }
};

for (const [path, url] of Object.entries(localLogoModules)) {
    const match = path.match(/provider-logos\/([^/]+)\.svg$/i);
    if (match?.[1] && url) {
        LOCAL_PROVIDER_LOGO_MAP.set(match[1].toLowerCase(), url);
    }
}

export function useProviderLogo(providerId: string | null | undefined): UseProviderLogoReturn {
    const superWagieProvider = isSuperWagieProvider(providerId);
    const candidates = superWagieProvider ? [] : buildLogoCandidates(providerId);
    const localResolvedId = candidates.find((candidate) => LOCAL_PROVIDER_LOGO_MAP.has(candidate)) ?? null;
    const remoteResolvedId = candidates[0] ?? null;
    const localLogoSrc = superWagieProvider
        ? productMarkUrl
        : localResolvedId ? LOCAL_PROVIDER_LOGO_MAP.get(localResolvedId) ?? null : null;
    const hasLocalLogo = Boolean(localLogoSrc);

    const [source, setSource] = useState<LogoSource>(hasLocalLogo ? 'local' : 'remote');

    useEffect(() => {
        setSource(hasLocalLogo ? 'local' : 'remote');
    }, [hasLocalLogo, providerId, remoteResolvedId]);

    const handleError = useCallback(() => {
        setSource((current) => (current === 'local' && hasLocalLogo ? 'remote' : 'none'));
    }, [hasLocalLogo]);

    if (!localLogoSrc && !remoteResolvedId) {
        return { src: null, onError: handleError, hasLogo: false };
    }

    if (source === 'local' && localLogoSrc) {
        return {
            src: localLogoSrc,
            onError: handleError,
            hasLogo: true,
        };
    }

    if (source === 'remote' && remoteResolvedId) {
        return {
            src: `https://models.dev/logos/${remoteResolvedId}.svg`,
            onError: handleError,
            hasLogo: true,
        };
    }

    return { src: null, onError: handleError, hasLogo: false };
}
