import { z } from 'zod';
import { isCapacitorMobileApp } from '@/apps/mobileNativeChrome';
import { shareFileFromNativeApp } from '@/lib/nativeFileShare';
import type { VSCodeAPI } from '@/lib/api/types';
import { isVSCodeRuntime } from '@/lib/desktop';

export const MESSAGE_IMAGE_EXPORT_EXCLUDE_ATTRIBUTE = 'data-message-image-export-exclude';

/** `html-to-image` squashes a canvas past this size instead of failing. */
const MESSAGE_IMAGE_EXPORT_MAX_CANVAS_PX = 16384;

/** Uses the visible column because a detached turn source has no layout width. */
export const resolveMessageImageExportWidth = (element: HTMLElement | null): number => {
    const width = element?.getBoundingClientRect().width ?? 0;
    return width > 0 ? Math.round(width) : 0;
};

/** Reduces canvas scaling near the squash limit, with a minimum density of 0.5. */
export const resolveMessageImageExportPixelRatio = (
    width: number,
    height: number,
    preferred = 2,
): number => {
    const limit = MESSAGE_IMAGE_EXPORT_MAX_CANVAS_PX / Math.max(1, width, height);
    return Math.max(0.5, Math.min(preferred, Math.floor(limit * 100) / 100));
};

const isPainted = (element: HTMLElement, root: HTMLElement): boolean => {
    for (let current: HTMLElement | null = element; current; current = current.parentElement) {
        const style = window.getComputedStyle(current);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        // KaTeX keeps a clipped MathML twin of every formula; its boxes are wider
        // than the painted formula and would inflate the canvas on their own.
        if (style.clip && style.clip !== 'auto') return false;
        if (style.clipPath && style.clipPath !== 'none') return false;
        if (current === root) break;
    }
    return true;
};

/** Reveals wide blocks, then measures both edges after their layout changes. */
export const widenMessageImageExportOverflow = (root: HTMLElement) => {
    const content = root.getBoundingClientRect();
    const elements = Array.from(root.querySelectorAll<HTMLElement>('*')).filter(element => isPainted(element, root));
    const overflowing = elements.filter(element => {
        const bounds = element.getBoundingClientRect();
        return content.left - bounds.left > 1 || bounds.right - content.right > 1;
    });
    overflowing.forEach((element) => {

        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
            const parentStyle = window.getComputedStyle(parent);
            if (parentStyle.overflowX !== 'visible' || parentStyle.overflowY !== 'visible') {
                // A hidden y axis makes visible x overflow compute back to auto.
                parent.style.overflowX = 'visible';
                parent.style.overflowY = 'visible';
                if (parent !== root) {
                    // KaTeX caps its display wrapper at max-width: 100%.
                    parent.style.width = 'max-content';
                    parent.style.maxWidth = 'none';
                }
            }
            if (parent === root) break;
        }
    });
    let left = 0;
    let right = 0;
    elements.forEach((element) => {
        const bounds = element.getBoundingClientRect();
        left = Math.max(left, content.left - bounds.left);
        right = Math.max(right, bounds.right - content.right);
    });
    return { left: left > 1 ? Math.ceil(left) : 0, right: right > 1 ? Math.ceil(right) : 0 };
};

/** The canvas grows in physical coordinates while text keeps its own direction. */
export const fitMessageImageExportLayout = (wrapper: HTMLElement, clone: HTMLElement, width: number): void => {
    clone.style.direction = window.getComputedStyle(clone).direction;
    wrapper.style.direction = 'ltr';
    clone.style.width = `${width}px`;
    clone.style.marginLeft = '0';
    clone.style.marginRight = 'auto';
    const overflow = widenMessageImageExportOverflow(clone);
    clone.style.marginLeft = `${overflow.left}px`;
    wrapper.style.width = `${width + overflow.left + overflow.right}px`;
};

export const cloneMessageImageExportSource = (source: HTMLElement): HTMLElement => {
    // SAFETY: cloneNode preserves the concrete type of an HTMLElement source.
    const clone = source.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(`[${MESSAGE_IMAGE_EXPORT_EXCLUDE_ATTRIBUTE}="true"], [data-export-ignore]`).forEach((element) => {
        element.remove();
    });
    return clone;
};

/** Renders every text part, including folded and unmounted earlier messages. */
export const buildTurnImageExportSource = async (
    segments: readonly string[],
    syntaxStyle: string | null,
    isCurrent: () => boolean = () => true,
): Promise<HTMLElement> => {
    const { renderMarkdownForExport } = await import('../markdown/renderMarkdownForExport');
    const source = document.createElement('div');
    for (const text of segments) {
        if (!isCurrent()) break;
        const markdown = await renderMarkdownForExport(text, { purpose: 'image', syntaxStyle });
        const segment = document.createElement('div');
        segment.className = 'relative break-words my-1';
        segment.appendChild(markdown);
        source.appendChild(segment);
    }
    return source;
};

const saveImageResult = z.object({
    saved: z.boolean().optional(),
    canceled: z.boolean().optional(),
    error: z.string().optional(),
});

export async function captureAndSaveMessageImage(source: HTMLElement, options: {
    width: number;
    fileName: string;
    vscode?: VSCodeAPI;
    isCurrent?: () => boolean;
    rejectOversized?: boolean;
}): Promise<boolean> {
    const { width, fileName, vscode, rejectOversized } = options;
    const isCurrent = options.isCurrent ?? (() => true);
    const { toPng } = await import('html-to-image');
    if (!isCurrent()) return false;
    const computedStyle = window.getComputedStyle(source);
    const rootStyle = window.getComputedStyle(document.documentElement);
    const backgroundColor = rootStyle.getPropertyValue('--surface-background').trim()
        || computedStyle.backgroundColor || window.getComputedStyle(document.body).backgroundColor;

    const host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'position: fixed; left: -100000px; top: 0; pointer-events: none;';
    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-message-image-export', 'true');
    wrapper.style.cssText = `
        padding: 24px;
        ${width ? `width: ${width}px; box-sizing: content-box;` : ''}
        background-color: ${backgroundColor};
        display: inline-block;
    `;
    const exportStyle = document.createElement('style');
    exportStyle.textContent = `
        [data-message-image-export] * { scrollbar-width: none; }
        [data-message-image-export] *::-webkit-scrollbar { display: none; }
    `;
    const clone = cloneMessageImageExportSource(source);
    clone.style.cssText = `${computedStyle.cssText} transform: none; contain: none;`;
    clone.querySelectorAll('[data-code-wrap]').forEach((root) => root.setAttribute('data-code-wrap', 'true'));
    clone.querySelectorAll<HTMLElement>('[data-message-actions="true"], [data-message-action-group="true"]')
        .forEach((row) => { row.style.display = 'none'; });

    clone.querySelectorAll('[aria-label^="Message time:"]').forEach((element) => {
        const timestamp = element.getAttribute('aria-label')?.replace('Message time:', '').trim();
        if (!timestamp || element.textContent?.includes(timestamp)) return;
        const time = document.createElement('span');
        time.style.marginLeft = '4px';
        time.textContent = timestamp;
        element.appendChild(time);
        const footer = element.parentElement?.parentElement;
        if (footer) footer.style.justifyContent = 'flex-start';
    });

    host.append(wrapper);
    wrapper.append(exportStyle, clone);
    document.body.appendChild(host);
    try {
        if (width) fitMessageImageExportLayout(wrapper, clone, width);
        const bounds = wrapper.getBoundingClientRect();
        const canvasWidth = Math.ceil(bounds.width);
        const canvasHeight = Math.ceil(bounds.height);
        const pixelRatio = resolveMessageImageExportPixelRatio(canvasWidth, canvasHeight);
        if (rejectOversized && Math.max(canvasWidth, canvasHeight) * pixelRatio > MESSAGE_IMAGE_EXPORT_MAX_CANVAS_PX) {
            throw new Error('Selected messages exceed the image size limit');
        }
        const dataUrl = await toPng(wrapper, { quality: 1, width: canvasWidth, height: canvasHeight, pixelRatio, backgroundColor });
        if (!isCurrent()) return false;
        if (isVSCodeRuntime()) {
            const result = saveImageResult.safeParse(await vscode?.saveImage?.({ fileName, dataUrl }));
            if (result.success && result.data.saved) return true;
            if (result.success && result.data.canceled) return false;
            throw new Error(result.success ? result.data.error || 'Failed to save image in VS Code' : 'Failed to save image in VS Code');
        }
        const blob = await fetch(dataUrl).then((response) => response.blob());
        if (!isCurrent()) return false;
        if (isCapacitorMobileApp()) {
            await shareFileFromNativeApp(new File([blob], fileName, { type: blob.type || 'image/png' }));
        } else {
            // A Blob URL keeps the image data out of Electron's save dialog title.
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.download = fileName;
            link.href = url;
            document.body.appendChild(link);
            try { link.click(); } finally {
                link.remove();
                URL.revokeObjectURL(url);
            }
        }
        return true;
    } finally {
        host.remove();
    }
}
