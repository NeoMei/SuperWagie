import React from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';
import { captureRuntimeInstance } from '@/lib/runtime-switch';
import type { ChatMessageEntry } from '../lib/turns/types';
import { messageSelectionSegments } from './selectedMessageContent';

export function MessageSelectionToolbar({ ids, readMessages, scope, sessionId, readColumn, onDismiss, height }: {
    ids: ReadonlySet<string>;
    readMessages: () => readonly ChatMessageEntry[];
    scope: React.RefObject<AbortController | null>;
    sessionId: string;
    readColumn: () => HTMLElement | null;
    onDismiss: () => void;
    height: string;
}) {
    const { t } = useI18n();
    const { vscode } = useRuntimeAPIs();
    const [saving, setSaving] = React.useState(false);
    const operation = React.useRef<AbortController | null>(null);
    const abort = React.useCallback(() => {
        operation.current?.abort();
        operation.current = null;
    }, []);
    React.useLayoutEffect(() => abort, [abort]);

    const dismiss = () => {
        abort();
        onDismiss();
    };
    const exportSelected = async (format: 'markdown' | 'image') => {
        const owner = scope.current;
        if (!owner || owner.signal.aborted || operation.current) return;
        const segments = messageSelectionSegments(readMessages(), sessionId, ids, {
            user: t('contextSidebar.breakdown.user'),
            assistant: t('contextSidebar.breakdown.assistant'),
        });
        if (!segments) {
            toast.error(t('chat.messageSelection.unavailable'));
            return;
        }
        const request = new AbortController();
        operation.current = request;
        const ownsRuntime = captureRuntimeInstance();
        const isCurrent = () => !request.signal.aborted && !owner.signal.aborted && ownsRuntime();
        setSaving(true);
        try {
            if (format === 'markdown') {
                const result = await copyTextToClipboard(segments.join('\n\n'));
                if (isCurrent()) toast[result.ok ? 'success' : 'error'](t(
                    result.ok ? 'chat.messageBody.toast.copied' : 'sidebarFilesTree.toast.copyFailed',
                ));
                return;
            }
            const { buildTurnImageExportSource, captureAndSaveMessageImage, resolveMessageImageExportWidth } = await import('./imageExport');
            if (!isCurrent()) return;
            const column = readColumn();
            const width = resolveMessageImageExportWidth(column) || Math.max(240, Math.min(768, window.innerWidth - 32));
            const syntaxStyle = column?.querySelector('[data-markdown-content]')?.getAttribute('style') ?? null;
            const image = await buildTurnImageExportSource(segments, syntaxStyle, isCurrent);
            if (!isCurrent()) return;
            const saved = await captureAndSaveMessageImage(image, {
                width, fileName: 'chat-messages.png', vscode, isCurrent, rejectOversized: true,
            });
            if (saved && isCurrent()) toast.success(t('chat.messageBody.toast.imageSaved'));
        } catch {
            if (isCurrent()) toast.error(t(format === 'image'
                ? 'chat.messageBody.toast.generateImageFailed'
                : 'sidebarFilesTree.toast.copyFailed'));
        } finally {
            if (operation.current === request) {
                operation.current = null;
                setSaving(false);
            }
        }
    };

    return (
        <div role="group" aria-label={t('chat.messageSelection.start')}
            className="absolute inset-x-0 top-0 z-10 flex items-center justify-between gap-2 bg-background px-3"
            style={{ height }}
            onKeyDown={(event) => {
                if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
                event.stopPropagation();
                dismiss();
            }}>
            <span className="min-w-0 truncate typography-meta text-muted-foreground" aria-live="polite">
                {t('chat.messageSelection.count', { count: ids.size })}
            </span>
            <div className="flex shrink-0 items-center gap-1">
                <Button variant="outline" size="sm" disabled={saving || ids.size === 0} onClick={() => void exportSelected('markdown')}
                    aria-label={t('chat.questionCard.copyMarkdown')} title={t('chat.questionCard.copyMarkdown')}>
                    <Icon name="file-copy" className="size-4" />
                    <span className="hidden sm:inline">{t('chat.questionCard.copyMarkdown')}</span>
                </Button>
                <Button variant="outline" size="sm" disabled={saving || ids.size === 0} onClick={() => void exportSelected('image')}
                    aria-label={t('chat.messageBody.actions.saveAsImage')} title={t('chat.messageBody.actions.saveAsImage')}>
                    <Icon name="image-download" className="size-4" />
                    <span className="hidden sm:inline">{t('chat.messageBody.actions.saveAsImage')}</span>
                </Button>
                <Button variant="ghost" size="sm" onClick={dismiss}>{t('dialog.common.actions.cancel')}</Button>
            </div>
        </div>
    );
}
