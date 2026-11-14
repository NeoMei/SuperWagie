import React from 'react';
import { useReadReferenceLink } from '@/components/references/useAttachReferences';
import { useRepositoryReadContext } from '@/components/references/referenceSources';
import { useRuntimeInstance } from '@/hooks/useRuntimeInstance';
import { useRepositoryUrlMatcher } from '@/lib/source-control/repositoryUrlMatcher';
import { useTrackerUrlMatcher } from '@/lib/trackers/matchTrackerUrl';
import { useTrackerAuthStore } from '@/stores/useTrackerAuthStore';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/components/ui';
import type { ComposerReference } from './composerReferences';
import { findReferenceLinks, referenceLinkChip } from './referenceLinks';
import { PastedReferences } from './pastedReferences';

const EMPTY_REFERENCES: ReadonlyMap<string, ComposerReference> = new Map();

export function usePastedReferences(options: { directory: string | null; scopeKey: string | null; enabled: boolean; text: () => string; remove: (link: string) => void }) {
    const { t } = useI18n();
    const translate = React.useRef(t);
    translate.current = t;
    const runtime = useRuntimeInstance();
    const repository = useRepositoryReadContext(options.enabled ? options.directory : null);
    const trackers = useTrackerAuthStore((state) => state.entries);
    const repositoryUrls = useRepositoryUrlMatcher();
    const trackerUrls = useTrackerUrlMatcher();
    const read = useReadReferenceLink(options.enabled ? options.directory : null);
    const text = React.useRef(options.text);
    text.current = options.text;
    const remove = React.useRef(options.remove);
    remove.current = options.remove;
    // Identity includes every owner whose change retires a pending lookup.
    const scope = React.useMemo(() => ({ runtime, enabled: options.enabled, directory: options.directory, scopeKey: options.scopeKey,
        read, repository, trackers, repositoryUrls, trackerUrls }),
        [options.directory, options.scopeKey, options.enabled, runtime, read, repository, trackers, repositoryUrls, trackerUrls]);
    const activeScope = React.useRef<typeof scope | null>(scope);
    activeScope.current = scope;
    React.useLayoutEffect(() => {
        activeScope.current = scope;
        return () => { if (activeScope.current === scope) activeScope.current = null; };
    }, [scope]);
    const [published, publish] = React.useState<{ scope: typeof scope; references: ReadonlyMap<string, ComposerReference> } | null>(null);
    const manager = React.useMemo(() => new PastedReferences({
        current: () => scope.enabled && activeScope.current === scope && scope.runtime(),
        text: () => text.current(),
        find: (value) => findReferenceLinks(value, scope.repositoryUrls, scope.trackerUrls).filter(({ target }) => target.source === 'tracker'
            ? scope.trackers[target.provider]?.status?.connected === true
            : Boolean(scope.repository && scope.repository !== 'missing' && target.provider === scope.repository.provider && target.instance === scope.repository.instance)),
        read: scope.read,
        publish: (references) => publish({ scope, references }),
        failed: (links, error) => toast.error(translate.current('references.picker.error.attachFailed', { items: links.join(', '), error })),
        timeout: () => translate.current('references.picker.error.lookupTimeout'),
        limited: () => toast.error(translate.current('references.picker.error.pasteLimit')),
    }), [scope]);
    const references = published?.scope === scope ? published.references : EMPTY_REFERENCES;
    const [preview, setPreview] = React.useState<{ scope: typeof scope; reference: ComposerReference; link: string } | null>(null);
    const closePreview = () => setPreview(null);
    const chips = React.useMemo(() => new Map([...references].map(([link, reference]) =>
        [link, { ...referenceLinkChip(reference, repositoryUrls), open: () => {
            if (activeScope.current === scope && scope.runtime()) setPreview({ scope, reference, link });
        } }] as const)), [references, repositoryUrls, scope]);
    const currentPreview = preview?.scope === scope && scope.runtime() ? preview : null;
    return { manager, chips, preview: currentPreview?.reference ?? null, closePreview, removePreview: () => {
        if (currentPreview && activeScope.current === scope && scope.runtime()) remove.current(currentPreview.link);
        closePreview();
    } };
}
