import { expect, test } from 'bun:test';

import type { AttachedFile } from '@/stores/types/sessionTypes';
import { selectComposerAttachments, prepareAttachmentDelivery } from './attachmentSubmission';

const file = (filename: string, options: Partial<AttachedFile> = {}): AttachedFile => ({
    id: filename,
    filename,
    file: new File([new Uint8Array([1, 2, 3])], filename),
    size: 3,
    mimeType: 'image/png',
    dataUrl: 'data:image/png;base64,AQID',
    source: 'local',
    ...options,
});

const screenshot = file('shot.png', { composerAnchor: 'shot.png' });
const report = file('report.txt', { composerAnchor: 'report.pdf', mimeType: 'text/plain' });
const embedded = file('figure.png', { composerAnchor: 'report.pdf' });
const legacy = file('legacy.png');

const names = (files: readonly AttachedFile[]) => files.map(({ filename }) => filename);

test('removing a citation detaches its group and putting it back restores it', () => {
    const attachments = [screenshot, report, embedded, legacy];
    expect(names(selectComposerAttachments('Review [report.pdf] and [shot.png].', attachments)))
        .toEqual(['shot.png', 'report.txt', 'figure.png', 'legacy.png']);
    expect(names(selectComposerAttachments('Review [shot.png].', attachments)))
        .toEqual(['shot.png', 'legacy.png']);
    expect(names(selectComposerAttachments('Review [report.pdf] and [shot.png].', attachments)))
        .toEqual(['shot.png', 'report.txt', 'figure.png', 'legacy.png']);
});

test('replaces the selected image citation in place and preserves other attachments', async () => {
    const writes: Array<{ filename: string; bytes: Uint8Array }> = [];
    const result = await prepareAttachmentDelivery({
        text: 'Look at [shot.png], then read the report.',
        attachments: [screenshot, report],
        inputModalities: ['text'],
        isCurrent: () => true,
        write: async (files) => {
            writes.push(...files);
            return [{ filename: 'shot.png', path: '/kernel folder/shot.png' }];
        },
    });
    expect(writes.map(({ filename, bytes }) => [filename, [...bytes]])).toEqual([['shot.png', [1, 2, 3]]]);
    expect(result).toEqual({ status: 'ready', text: 'Look at [shot.png](</kernel folder/shot.png>), then read the report.', attachments: [report] });
});

test('keeps image attachments for vision or unknown models and uses server-owned paths without a write', async () => {
    const onDisk = file('server.png', { source: 'server', serverPath: '/work/server.png' });
    const input = { text: 'Look here', attachments: [onDisk], isCurrent: () => true, write: async () => { throw new Error('Unexpected write'); } };
    for (const inputModalities of [undefined, ['text', 'image']]) {
        expect(await prepareAttachmentDelivery({ ...input, inputModalities }))
            .toEqual({ status: 'ready', text: input.text, attachments: [onDisk] });
    }
    expect(await prepareAttachmentDelivery({ ...input, inputModalities: ['text'] }))
        .toEqual({ status: 'ready', text: 'Look here\n\n[server.png](/work/server.png)', attachments: [] });
});

test('a failed write cannot produce a partially stripped message and a runtime switch retires the operation', async () => {
    let current = true;
    const input = { text: '', attachments: [screenshot], inputModalities: ['text'], isCurrent: () => current };
    expect(await prepareAttachmentDelivery({ ...input, write: async () => [{ filename: 'shot.png', error: new Error('offline') }] }))
        .toEqual({ status: 'failed', filenames: ['shot.png'] });
    expect(await prepareAttachmentDelivery({ ...input, write: async () => {
        current = false;
        return [{ filename: 'shot.png', path: '/retired/shot.png' }];
    } })).toEqual({ status: 'retired' });
});

test('saves an opted-in copy at delivery and retains compatible inline image bytes', async () => {
    const copy = { ...screenshot, saveCopy: true };
    const result = await prepareAttachmentDelivery({
        text: '[shot.png]',
        attachments: [copy],
        inputModalities: ['text', 'image'],
        isCurrent: () => true,
        write: async ([{ filename, bytes }]) => {
            expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
            return [{ filename, path: '/kernel/shot.png' }];
        },
    });
    expect(result).toEqual({ status: 'ready', text: '[shot.png](/kernel/shot.png)', attachments: [copy] });
});
