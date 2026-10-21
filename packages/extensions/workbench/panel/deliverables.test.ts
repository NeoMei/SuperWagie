import { describe, expect, test } from 'bun:test';

import type { GuestProject, HostClient } from '@openchamber/sdk';

import { collectDeliverables } from './deliverables.ts';

const project = (id: string, directory: string): GuestProject => ({ id, name: id, directory });

const hostFor = (files: Record<string, Array<{ name: string; kind: 'file' | 'directory' }>>, mtimes: Record<string, number>) => ({
    listDir: async (path: string) => {
        const entries = files[path];
        if (!entries) throw new Error('missing');
        return { entries };
    },
    stat: async (path: string) => {
        const mtime = mtimes[path];
        if (mtime === undefined) throw new Error('missing');
        return { kind: 'file' as const, size: 1, mtime };
    },
}) satisfies Pick<HostClient, 'listDir' | 'stat'>;

describe('collectDeliverables', () => {
    test('lists only output files, newest first, across known folders', async () => {
        const work = '/Users/me/Documents/SuperWagie/文档/方案 2026-10-21';
        const host = hostFor({
            [work]: [
                { name: '导出', kind: 'directory' },
                { name: '交付', kind: 'directory' },
                { name: 'index.html', kind: 'file' },
            ],
            [`${work}/导出`]: [
                { name: '方案.docx', kind: 'file' },
                { name: '方案.pdf', kind: 'file' },
                { name: '需求.md', kind: 'file' },
                { name: '图片', kind: 'directory' },
            ],
            [`${work}/交付`]: [{ name: '方案.docx', kind: 'file' }],
        }, {
            [`${work}/导出/方案.docx`]: 10,
            [`${work}/导出/方案.pdf`]: 30,
            [`${work}/交付/方案.docx`]: 20,
            [`${work}/index.html`]: 40,
        });
        const result = await collectDeliverables(host, [project('w', work)]);
        expect(result.map((item) => [item.name, item.folder, item.mtime])).toEqual([
            ['index.html', '根目录', 40],
            ['方案.pdf', '导出', 30],
            ['方案.docx', '交付', 20],
        ]);
        expect(result[1]?.category).toBe('文档');
    });

    test('finds a deliverable inside a task folder', async () => {
        const work = '/Users/me/Documents/SuperWagie/PPT/新 PPT 2026-10-21';
        const task = `${work}/task-20261021-polite-fart`;
        const host = hostFor({
            [work]: [{ name: 'task-20261021-polite-fart', kind: 'directory' }],
            [task]: [{ name: '交付', kind: 'directory' }],
            [`${task}/交付`]: [{ name: '怎么礼貌地放屁.pptx', kind: 'file' }],
        }, {
            [`${task}/交付/怎么礼貌地放屁.pptx`]: 50,
        });
        const result = await collectDeliverables(host, [project('ppt', work)]);
        expect(result.map((item) => [item.name, item.folder, item.category])).toEqual([
            ['怎么礼貌地放屁.pptx', 'task-20261021-polite-fart/交付', 'PPT'],
        ]);
    });

    test('ignores projects outside the creation root', async () => {
        const host = hostFor({}, {});
        expect(await collectDeliverables(host, [project('app', '/Users/me/code/app')])).toEqual([]);
    });
});
