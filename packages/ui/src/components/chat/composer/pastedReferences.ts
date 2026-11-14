import type { ReferenceLinkTarget } from '@/components/references/resolveComposerReferences';
import type { ComposerReference } from './composerReferences';
import { findWebLinks, referenceLinksInText } from './referenceLinks';

type PastedLink = { link: string; target: ReferenceLinkTarget };

/** One visible draft owns pending clipboard reads and its resolved references. */
export class PastedReferences {
    private references = new Map<string, ComposerReference>();
    private pending = new Map<string, Promise<void>>();
    private waitingToSend = false;

    constructor(private readonly owner: {
        current: () => boolean;
        text: () => string;
        find: (text: string) => PastedLink[];
        read: (target: ReferenceLinkTarget) => Promise<ComposerReference>;
        publish: (references: ReadonlyMap<string, ComposerReference>) => void;
        failed: (links: string[], reason: string) => void;
        timeout: () => string;
        limited: () => void;
    }) {}

    readPaste(text: string): void {
        if (!this.owner.current()) return;
        const found = this.owner.find(text).filter(({ link }) => !this.pending.has(link));
        const links = found.slice(0, 16);
        if (found.length > links.length) this.owner.limited();
        if (links.length === 0) return;
        for (const { link } of links) this.references.delete(link);
        this.owner.publish(new Map(this.references));
        const read = Promise.allSettled(links.map(({ target }) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const deadline = new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(this.owner.timeout())), 15_000);
            });
            return Promise.race([this.owner.read(target), deadline]).finally(() => clearTimeout(timer));
        })).then((results) => {
            if (!this.owner.current()) return;
            const visible = new Set(findWebLinks(this.owner.text()).map(({ link }) => link));
            const failures: string[] = [];
            let reason = '';
            for (const [index, result] of results.entries()) {
                const link = links[index].link;
                if (!visible.has(link)) continue;
                if (result.status === 'fulfilled') this.references.set(link, result.value);
                else {
                    failures.push(link);
                    reason ||= result.reason instanceof Error ? result.reason.message : String(result.reason);
                }
            }
            this.owner.publish(new Map(this.references));
            if (failures.length > 0) this.owner.failed(failures, reason);
        }).finally(() => {
            for (const { link } of links) if (this.pending.get(link) === read) this.pending.delete(link);
        });
        for (const { link } of links) this.pending.set(link, read);
    }

    inText(text: string): ComposerReference[] {
        return this.owner.current() ? referenceLinksInText(text, this.references) : [];
    }

    /** A repeated Enter while resolution is pending cannot admit another send. */
    async beforeSend(text: string): Promise<boolean> {
        if (!this.owner.current() || this.waitingToSend) return false;
        const pending = findWebLinks(text).flatMap(({ link }) => this.pending.get(link) ?? []);
        if (pending.length === 0) return true;
        this.waitingToSend = true;
        try {
            await Promise.all(pending);
            return this.owner.current() && this.owner.text() === text;
        } finally {
            this.waitingToSend = false;
        }
    }
}
