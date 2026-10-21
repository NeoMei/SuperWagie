import type { GuestProject, HostClient } from '@openchamber/sdk';

import { isCreationProject } from './sessions.ts';

export type Deliverable = {
    name: string;
    path: string;
    folder: string;
    projectId: string;
    projectName: string;
    category: string;
    mtime: number;
    source?: 'session' | 'filesystem';
};

const OUTPUT_EXTENSIONS = new Set(['docx', 'pdf', 'pptx', 'mp4', 'html', 'htm']);
const OUTPUT_FOLDERS = new Set(['导出', '交付']);
// A deliverable can live under the work root or a task folder such as
// task-01/交付. Do not walk into generation/planning: those trees hold drafts,
// screenshots and previews that are not results.
const SKIP_FOLDERS = new Set([
    'generation', 'planning', 'jobs', 'images', 'assets', 'output',
    'node_modules', '.git', '.superppt', 'dist', 'build', 'renders',
]);
const MAX_SCAN_DEPTH = 4;

const extensionOf = (name: string): string => {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

const isOutputFile = (name: string): boolean => (
    !name.startsWith('~$')
    && !name.startsWith('.')
    && OUTPUT_EXTENSIONS.has(extensionOf(name))
);

const categoryOf = (directory: string): string => {
    const match = directory.replace(/\\/g, '/').match(/\/Documents\/SuperWagie\/(文档|PPT|视频|网页)\//);
    return match?.[1] ?? '';
};

const relativeFolder = (root: string, directory: string): string => {
    const relative = directory.slice(root.length).replace(/^\/+/, '');
    return relative || '根目录';
};

/**
 * Files under a work's 交付/导出 folders (at the work root or inside a task
 * folder), plus output files at the work root. Only a few well-known formats
 * are listed; briefs, state and internal renders stay out of the dashboard.
 */
export const collectDeliverables = async (
    host: Pick<HostClient, 'listDir' | 'stat'>,
    projects: readonly GuestProject[],
): Promise<Deliverable[]> => {
    const found = new Map<string, Deliverable>();

    const addFile = async (project: GuestProject, path: string, folder: string): Promise<void> => {
        const name = path.slice(path.lastIndexOf('/') + 1);
        const key = `${project.id}:${name}`;
        const existing = found.get(key);
        const info = await host.stat(path).catch(() => null);
        if (!info || info.kind !== 'file') return;
        // The same deliverable is often copied from 导出 to 交付. Keep the
        // newest copy, not both rows.
        if (existing && existing.mtime >= info.mtime) return;
        found.set(key, {
            name,
            path,
            folder,
            projectId: project.id,
            projectName: project.name,
            category: categoryOf(project.directory),
            mtime: info.mtime,
        });
    };

    const walk = async (
        project: GuestProject,
        directory: string,
        depth: number,
        inOutputFolder: boolean,
    ): Promise<void> => {
        const listing = await host.listDir(directory).catch(() => null);
        if (!listing) return;
        for (const entry of listing.entries) {
            const path = `${directory}/${entry.name}`;
            if (entry.kind === 'file') {
                if ((inOutputFolder || depth === 0) && isOutputFile(entry.name)) {
                    await addFile(project, path, relativeFolder(project.directory, directory));
                }
                continue;
            }
            if (entry.kind !== 'directory' || entry.name.startsWith('.') || depth >= MAX_SCAN_DEPTH) continue;
            const output = inOutputFolder || OUTPUT_FOLDERS.has(entry.name);
            if (!output && SKIP_FOLDERS.has(entry.name)) continue;
            await walk(project, path, depth + 1, output);
        }
    };

    // ponytail: one folder listing at a time; parallelize if the creation root grows past dozens of works.
    for (const project of projects) {
        if (!isCreationProject(project)) continue;
        await walk(project, project.directory, 0, false);
    }
    return [...found.values()].sort((left, right) => right.mtime - left.mtime).slice(0, 8);
};
