import type { AttachedFile } from '@/stores/types/sessionTypes';
import { getAttachmentInputModality } from '@/sync/attachment-files';
import { allocateAttachmentAnchor, buildImagePathCitationText, findAttachmentCitationRanges, findLocalImagePathCitationRanges } from '../../attachmentCitations';
import { isLikelyAbsolutePath } from './filePaths';

export function selectComposerAttachments(text: string, files: readonly AttachedFile[]): AttachedFile[] {
    const anchors = files.flatMap(({ composerAnchor }) => composerAnchor ? [composerAnchor] : []);
    if (anchors.length === 0) return [...files];
    const names = new Set(findAttachmentCitationRanges(text, anchors).map(({ start, end }) => text.slice(start + 1, end - 1).trim().toLowerCase()));
    for (const { filename } of findLocalImagePathCitationRanges(text)) names.add(filename.toLowerCase());
    return files.filter(({ composerAnchor }) => !composerAnchor || names.has(composerAnchor.toLowerCase()));
}

type TempFile = { filename: string; bytes: Uint8Array };
type TempFileResult = { filename: string; path: string } | { filename: string; error: Error };
type DeliverySource = Pick<AttachedFile, 'filename' | 'dataUrl' | 'mimeType'>
    & Partial<Pick<AttachedFile, 'file' | 'source' | 'serverPath' | 'composerAnchor' | 'saveCopy' | 'deliverAsPath'>>;
type AttachmentPreparation<T> =
    | { status: 'ready'; text: string; attachments: T[] }
    | { status: 'retired' }
    | { status: 'failed'; filenames: string[] };

const INLINE_MEDIA = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']);
const INLINE_IMAGES = /\.(png|jpe?g|gif|webp)$/i;
const BINARY_FILE = /\.(7z|bin|docx?|epub|gz|odp|ods|odt|pptx?|rar|tar|xls[xm]?|zip)$/i;
const NON_INLINE_MEDIA = /\.(aac|avif|avi|bmp|flac|heic|heif|m4a|m4v|mkv|mov|mp[34]|mpeg|mpg|ogg|opus|tiff?|wav|webm|wma)$/i;
const pathIsUsable = (path: string): boolean => isLikelyAbsolutePath(path) && !/[<>\p{Cc}]/u.test(path);

const attachmentModality = (file: DeliverySource) => {
    if (file.dataUrl.startsWith('file:')) {
        if (/\.pdf$/i.test(file.filename)) return 'pdf';
        if (INLINE_IMAGES.test(file.filename)) return 'image';
        if (BINARY_FILE.test(file.filename) || NON_INLINE_MEDIA.test(file.filename)) return undefined;
    }
    return getAttachmentInputModality(file.mimeType);
};

const shouldUsePath = (file: DeliverySource, supported: Set<string> | undefined): boolean => {
    const modality = attachmentModality(file);
    if (!modality) return file.dataUrl.startsWith('data:') || file.dataUrl.startsWith('file:');
    if (modality !== 'text' && !file.dataUrl.startsWith('file:')
        && !INLINE_MEDIA.has(file.mimeType.toLowerCase().split(';', 1)[0])) return true;
    if (!supported) return file.deliverAsPath === true;
    return !supported.has(modality);
};

const readAttachmentBytes = async (file: DeliverySource): Promise<Uint8Array> => {
    if (file.file && file.file.size > 0) return new Uint8Array(await file.file.arrayBuffer());
    const comma = file.dataUrl.indexOf(',');
    if (!file.dataUrl.startsWith('data:') || comma < 0) throw new Error('Attachment has no readable bytes');
    const payload = file.dataUrl.slice(comma + 1);
    return file.dataUrl.slice(0, comma).toLowerCase().endsWith(';base64')
        ? Uint8Array.from(atob(payload), (value) => value.charCodeAt(0))
        : new TextEncoder().encode(decodeURIComponent(payload));
};

export async function prepareAttachmentDelivery<T extends DeliverySource>(input: {
    text: string;
    attachments: readonly T[];
    inputModalities: readonly string[] | undefined;
    isCurrent: () => boolean;
    write: (files: TempFile[]) => Promise<TempFileResult[]>;
}): Promise<AttachmentPreparation<T>> {
    const { text, attachments, inputModalities, isCurrent, write } = input;
    if (!isCurrent()) return { status: 'retired' };
    const supported = inputModalities && new Set(inputModalities.map((value) => value.trim().toLowerCase()));
    const pathOnly = new Set(attachments.filter((file) => shouldUsePath(file, supported)));
    const saved = attachments.filter((file) => pathOnly.has(file) || file.saveCopy);
    if (saved.length === 0) return { status: 'ready', text, attachments: [...attachments] };

    const filenames: string[] = [];
    for (const file of saved) filenames.push(allocateAttachmentAnchor(file.filename, filenames));
    const paths = new Map<string, string>();
    try {
        const writes: TempFile[] = [];
        for (const [index, file] of saved.entries()) {
            const filename = filenames[index];
            if (!isCurrent()) return { status: 'retired' };
            if (file.source === 'server' && file.serverPath && pathIsUsable(file.serverPath)) {
                paths.set(filename, file.serverPath);
                continue;
            }
            const bytes = await readAttachmentBytes(file);
            if (bytes.length === 0 && file.mimeType !== 'text/plain') throw new Error('Attachment is empty');
            writes.push({ filename, bytes });
        }
        if (!isCurrent()) return { status: 'retired' };
        if (writes.length > 0) {
            for (const result of await write(writes)) {
                if ('path' in result && pathIsUsable(result.path)) paths.set(result.filename, result.path);
            }
        }
    } catch {
        return isCurrent() ? { status: 'failed', filenames: saved.map((file) => file.filename) } : { status: 'retired' };
    }
    if (!isCurrent()) return { status: 'retired' };

    const links = new Map<string, string>();
    const extra: string[] = [];
    const failures: string[] = [];
    for (const [index, file] of saved.entries()) {
        const path = paths.get(filenames[index]);
        if (!path) {
            failures.push(file.filename);
            continue;
        }
        const link = buildImagePathCitationText([{ filename: filenames[index], path }]);
        const key = (file.composerAnchor ?? file.filename).toLowerCase();
        // An extracted image shares its document's citation. Retain that
        // citation and put the image path after the message.
        if ((file.composerAnchor && key !== file.filename.toLowerCase()) || links.has(key)) extra.push(link);
        else links.set(key, link);
    }
    if (failures.length > 0) return { status: 'failed', filenames: failures };
    const ranges = [
        ...findAttachmentCitationRanges(text, [...links.keys()]).map(({ start, end }) => ({
            start, end, filename: text.slice(start + 1, end - 1).trim(),
        })),
        ...findLocalImagePathCitationRanges(text),
    ].sort((left, right) => right.start - left.start);
    const cited = new Set<string>();
    let result = text;
    for (const { start, end, filename } of ranges) {
        const key = filename.toLowerCase();
        const link = links.get(key);
        if (!link) continue;
        result = result.slice(0, start) + link + result.slice(end);
        cited.add(key);
    }
    for (const [key, link] of links) if (!cited.has(key)) extra.push(link);
    if (extra.length > 0) result = [result, extra.join(' ')].filter(Boolean).join('\n\n');
    return { status: 'ready', text: result, attachments: attachments.filter((file) => !pathOnly.has(file)) };
}
