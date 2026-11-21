import type { AttachedFile } from '@/stores/types/sessionTypes';
import { getAttachmentInputModality } from '@/sync/attachment-files';
import { assignImageAttachmentFilenames, buildImagePathCitationText, findAttachmentCitationRanges, findLocalImagePathCitationRanges } from '../../attachmentCitations';
import { isLikelyAbsolutePath } from './filePaths';

export function selectComposerAttachments(text: string, files: readonly AttachedFile[]): AttachedFile[] {
    const anchors = files.flatMap(({ composerAnchor }) => composerAnchor ? [composerAnchor] : []);
    if (anchors.length === 0) return [...files];
    const names = new Set(findAttachmentCitationRanges(text, anchors).map(({ start, end }) => text.slice(start + 1, end - 1).trim().toLowerCase()));
    for (const { filename } of findLocalImagePathCitationRanges(text)) names.add(filename.toLowerCase());
    return files.filter(({ composerAnchor }) => !composerAnchor || names.has(composerAnchor.toLowerCase()));
}

type TempImage = { filename: string; bytes: Uint8Array };
type TempImageResult = { filename: string; path: string } | { filename: string; error: Error };
type ImageSource = Pick<AttachedFile, 'filename' | 'dataUrl' | 'mimeType'>
    & Partial<Pick<AttachedFile, 'file' | 'source' | 'serverPath' | 'composerAnchor'>>;
type ImagePreparation<T> =
    | { status: 'ready'; text: string; attachments: T[]; imageNames: string[] }
    | { status: 'retired' }
    | { status: 'failed'; imageNames: string[] };

const pathIsUsable = (path: string): boolean => isLikelyAbsolutePath(path) && !/[\r\n<>]/.test(path);

// Only a known text-capable model marks its unsupported image input. Unknown
// catalog entries, including Auto before routing, retain their original parts.
export const needsImagePathFallback = (modalities: readonly string[] | undefined): boolean => {
    const values = modalities?.map((value) => value.trim().toLowerCase());
    return values?.includes('text') === true && !values.includes('image');
};

const imageBytes = async (file: ImageSource): Promise<Uint8Array> => {
    if (file.file && file.file.size > 0) return new Uint8Array(await file.file.arrayBuffer());
    const prefix = /^data:image\/[\w.+-]+;base64,/i.exec(file.dataUrl)?.[0];
    if (!prefix) throw new Error('Image attachment has no readable bytes');
    return Uint8Array.from(atob(file.dataUrl.slice(prefix.length)), (value) => value.charCodeAt(0));
};

export async function prepareTextModelImagePaths<T extends ImageSource>(input: {
    text: string;
    attachments: readonly T[];
    inputModalities: readonly string[] | undefined;
    isCurrent: () => boolean;
    write: (files: TempImage[]) => Promise<TempImageResult[]>;
}): Promise<ImagePreparation<T>> {
    const { text, attachments, inputModalities, isCurrent, write } = input;
    if (!isCurrent()) return { status: 'retired' };
    const images = needsImagePathFallback(inputModalities)
        ? attachments.filter((file) => getAttachmentInputModality(file.mimeType) === 'image') : [];
    if (images.length === 0) return { status: 'ready', text, attachments: [...attachments], imageNames: [] };
    const imageNames = images.map((file) => file.filename);
    const filenames = assignImageAttachmentFilenames(images.map((file) => ({ name: file.filename, type: file.mimeType })), []);
    const paths = new Map<string, string>();
    try {
        const writes: TempImage[] = [];
        for (const [index, image] of images.entries()) {
            const filename = filenames[index];
            if (!isCurrent()) return { status: 'retired' };
            if (image.source === 'server' && image.serverPath && pathIsUsable(image.serverPath)) {
                paths.set(filename, image.serverPath);
            } else {
                const bytes = await imageBytes(image);
                if (bytes.length === 0) throw new Error('Image attachment is empty');
                writes.push({ filename, bytes });
            }
        }
        if (!isCurrent()) return { status: 'retired' };
        if (writes.length > 0) {
            for (const result of await write(writes)) {
                if ('path' in result && pathIsUsable(result.path)) paths.set(result.filename, result.path);
            }
        }
    } catch {
        return isCurrent() ? { status: 'failed', imageNames } : { status: 'retired' };
    }
    if (!isCurrent()) return { status: 'retired' };

    const links = new Map<string, string>();
    const extra: string[] = [];
    const failures: string[] = [];
    for (const [index, image] of images.entries()) {
        const path = paths.get(filenames[index]);
        if (!path) {
            failures.push(image.filename);
            continue;
        }
        const link = buildImagePathCitationText([{ filename: filenames[index], path }]);
        const key = image.filename.toLowerCase();
        // Embedded images belong to a document anchor. Keep that anchor's
        // text, and include paths to its extracted images after the prompt.
        if ((image.composerAnchor && image.composerAnchor.toLowerCase() !== key) || links.has(key)) extra.push(link);
        else links.set(key, link);
    }
    if (failures.length > 0) return { status: 'failed', imageNames: failures };
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
    const converted = new Set(images);
    return { status: 'ready', text: result, attachments: attachments.filter((file) => !converted.has(file)), imageNames };
}
