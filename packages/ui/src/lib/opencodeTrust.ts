import { z } from 'zod';
import { runtimeFetch } from './runtime-fetch';
import { captureRuntimeInstance, getRuntimeApiBaseUrl, subscribeRuntimeEndpointWillChange } from './runtime-switch';
import { normalizePath } from './pathNormalization';

const route = '/api/opencode/trust';
const assessmentSchema = z.object({
    directory: z.string().min(1),
    fingerprint: z.string().min(1).nullable(),
    trusted: z.boolean(),
    items: z.array(z.object({
        kind: z.enum(['plugin', 'package', 'mcp', 'lsp', 'formatter', 'shell', 'config', 'env', 'file', 'permission']),
        source: z.string(),
        name: z.string(),
        detail: z.string(),
    })),
});
const refusalSchema = z.object({ code: z.literal('opencode_trust_required'), directory: z.string().min(1) });

export type FolderAssessment = z.infer<typeof assessmentSchema>;
type FolderAnswer = { ok: boolean; assessment: FolderAssessment };
type FolderPrompt = { assessment: FolderAssessment; trust: () => Promise<boolean>; decline: () => void };

export function createFolderTrustCoordinator({ read, save }: {
    read: (directory: string) => Promise<FolderAssessment>;
    save: (assessment: FolderAssessment) => Promise<FolderAnswer>;
}) {
    const listeners = new Set<() => void>();
    const active = new Map<string, Promise<boolean>>();
    const declined = new Map<string, string | null>();
    const pausedDirectories = new Map<string, string>();
    let pending: FolderPrompt | null = null;
    let tail: Promise<boolean> = Promise.resolve(false);
    let generation = 0;
    const notify = () => listeners.forEach((listener) => listener());
    const show = (prompt: FolderPrompt | null) => {
        pending = prompt;
        notify();
    };

    const aliasesFor = new Map<string, Set<string>>();
    const ask = (directory: string, deliberate: boolean, isCurrent: () => boolean, alias?: string): Promise<boolean> => {
        const existing = active.get(directory);
        if (alias && existing) aliasesFor.get(directory)?.add(normalizePath(alias) ?? alias);
        if (existing) return existing;
        const aliases = new Set([normalizePath(directory) ?? directory, ...(alias ? [normalizePath(alias) ?? alias] : [])]);
        aliasesFor.set(directory, aliases);
        const owner = generation;
        const current = () => generation === owner && isCurrent();
        const unpause = (resolved: string) => {
            declined.delete(resolved);
            for (const [name, canonical] of pausedDirectories) {
                if (canonical === resolved || aliases.has(name)) pausedDirectories.delete(name);
            }
            notify();
        };
        const pause = (resolved: string, fingerprint: string | null) => {
            declined.set(resolved, fingerprint);
            pausedDirectories.set(normalizePath(resolved) ?? resolved, resolved);
            for (const name of aliases) pausedDirectories.set(name, resolved);
        };
        const confirm = async () => {
            if (!current()) return false;
            const assessment = await read(directory);
            if (!current()) return false;
            if (assessment.trusted) {
                unpause(assessment.directory);
                return true;
            }
            if (!deliberate && declined.get(assessment.directory) === assessment.fingerprint) {
                pause(assessment.directory, assessment.fingerprint);
                notify();
                return false;
            }
            return new Promise<boolean>((resolve) => {
                const display = (shown: FolderAssessment) => {
                    let saving = false;
                    const answerable = () => current() && pending === prompt;
                    const finish = (trusted: boolean) => {
                        if (pending === prompt) show(null);
                        resolve(trusted);
                    };
                    const prompt: FolderPrompt = {
                        assessment: shown,
                        decline: () => {
                            if (answerable()) pause(shown.directory, shown.fingerprint);
                            finish(false);
                        },
                        trust: async () => {
                            if (saving || !answerable()) return false;
                            saving = true;
                            try {
                                const answer = await save(shown);
                                if (!answerable()) return false;
                                if (answer.ok || answer.assessment.trusted) {
                                    unpause(answer.assessment.directory);
                                    finish(true);
                                } else display(answer.assessment);
                                return true;
                            } catch {
                                return false;
                            } finally {
                                saving = false;
                            }
                        },
                    };
                    show(prompt);
                };
                display(assessment);
            });
        };
        const request = tail.then(confirm).catch(() => false).finally(() => {
            if (active.get(directory) === request) {
                active.delete(directory);
                aliasesFor.delete(directory);
            }
        });
        tail = request;
        active.set(directory, request);
        return request;
    };

    return {
        ask,
        getPrompt: () => pending,
        isPaused: (directory: string | null | undefined) => {
            const key = normalizePath(directory);
            return key !== null && pausedDirectories.has(key);
        },
        pausedTarget: (directory: string) => pausedDirectories.get(normalizePath(directory) ?? directory) ?? directory,
        subscribe: (notify: () => void) => {
            listeners.add(notify);
            return () => { listeners.delete(notify); };
        },
        reset: () => {
            generation++;
            pending?.decline();
            active.clear();
            aliasesFor.clear();
            declined.clear();
            pausedDirectories.clear();
            tail = Promise.resolve(false);
            notify();
        },
    };
}

export const folderTrust = createFolderTrustCoordinator({
    read: async (directory) => {
        const response = await runtimeFetch(route, { query: { directory }, directory, cache: 'no-store' });
        if (!response.ok) throw new Error('Folder assessment is unavailable');
        return assessmentSchema.parse(await response.json());
    },
    save: async ({ directory, fingerprint }) => {
        const response = await runtimeFetch(route, {
            method: 'POST',
            directory,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ directory, fingerprint }),
        });
        if (!response.ok && response.status !== 409) throw new Error('Folder trust answer could not be saved');
        return { ok: response.ok, assessment: assessmentSchema.parse(await response.json()) };
    },
});

subscribeRuntimeEndpointWillChange(folderTrust.reset);

const captureFolderTrustRuntime = (): (() => boolean) => {
    const endpoint = getRuntimeApiBaseUrl();
    const currentRuntime = captureRuntimeInstance();
    return () => currentRuntime() && endpoint === getRuntimeApiBaseUrl();
};

export const reviewOpenCodeFolder = (directory: string): Promise<boolean> => (
    folderTrust.ask(folderTrust.pausedTarget(directory), true, captureFolderTrustRuntime(), directory)
);

export const withFolderTrust = (attempt: typeof fetch, configuredDirectory?: string): typeof fetch => async (input, init) => {
    const current = captureFolderTrustRuntime();
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const replayable = !(init?.body instanceof ReadableStream);
    const backup = replayable && input instanceof Request && input.body !== null ? input.clone() : null;
    try {
        let response = await attempt(input, init);
        while (response.status === 403 && current() && !signal?.aborted) {
            const parsed = refusalSchema.safeParse(await response.clone().json().catch(() => null));
            if (!parsed.success || !current() || signal?.aborted) return response;
            const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
            const allowed = await folderTrust.ask(parsed.data.directory, method === 'POST', current, configuredDirectory);
            if (!allowed || !replayable || !current() || signal?.aborted) return response;
            response = await attempt(backup?.clone() ?? input, init);
        }
        return response;
    } finally {
        void backup?.body?.cancel().catch(() => {});
    }
};
