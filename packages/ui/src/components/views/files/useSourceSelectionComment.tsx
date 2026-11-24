import React from 'react';
import { createPortal } from 'react-dom';
import type { EditorState } from '@codemirror/state';
import { showTooltip } from '@codemirror/view';
import { InlineCommentInput } from '@/components/comments/InlineCommentInput';
import { captureMainComposerDraftAttachment } from '@/components/chat/composer/comment/mainComposerDraftTarget';
import { focusChatInput } from '@/components/chat/composer/editor/dom';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { useDeviceInfo } from '@/lib/device';
import { captureRuntimeInstance, getRuntimeKey } from '@/lib/runtime-switch';

export function sourceSelectionQuote(state: EditorState) {
  const { ranges, main } = state.selection;
  if (ranges.length !== 1 || main.empty) return null;
  return {
    code: state.doc.sliceString(main.from, main.to),
    startLine: state.doc.lineAt(main.from).number,
    endLine: state.doc.lineAt(main.to - 1).number,
  };
}

export function useSourceSelectionComment(filePath: string, directory: string, visible: boolean) {
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  const [comment, setComment] = React.useState<{
    filePath: string;
    quote: NonNullable<ReturnType<typeof sourceSelectionQuote>>;
    attach: NonNullable<ReturnType<typeof captureMainComposerDraftAttachment>>;
    left: number;
    top: number;
  } | null>(null);
  const label = t('chat.textSelection.actions.comment');

  React.useEffect(() => {
    if (!visible || comment?.filePath !== filePath) setComment(null);
  }, [comment?.filePath, filePath, visible]);

  const extension = React.useMemo(() => {
    const isCurrentRuntime = captureRuntimeInstance();
    const runtimeKey = getRuntimeKey();
    return showTooltip.compute(['selection'], (state) => {
      if (!visible || !filePath || !directory || state.selection.ranges.length !== 1 || state.selection.main.empty) return null;
      return {
        pos: state.selection.main.from,
        above: true,
        create(view) {
          const dom = document.createElement('button');
          dom.type = 'button';
          dom.className = 'rounded px-2 py-1 typography-ui text-foreground';
          dom.textContent = label;
          dom.addEventListener('mousedown', (event) => event.preventDefault());
          dom.addEventListener('click', () => {
            const quote = sourceSelectionQuote(view.state);
            if (!quote?.code.trim() || !isCurrentRuntime()) return;
            const attach = captureMainComposerDraftAttachment(runtimeKey, directory);
            if (!attach) {
              toast.error(t('inlineComment.toast.selectSessionToSave'));
              return;
            }
            const rect = dom.getBoundingClientRect();
            setComment({ filePath, quote, attach, left: rect.left, top: rect.bottom });
          });
          return { dom };
        },
      };
    });
  }, [directory, filePath, label, t, visible]);

  const field = visible && comment && comment.filePath === filePath && (
    <InlineCommentInput
      floating
      fileLabel={comment.filePath}
      lineRange={{ start: comment.quote.startLine, end: comment.quote.endLine }}
      onCancel={() => setComment(null)}
      onSave={(text) => {
        if (!comment.attach({ source: 'file-quote', fileLabel: comment.filePath, language: '', text, ...comment.quote })) {
          toast.error(t('chat.textSelection.comment.attachFailed'));
          return;
        }
        setComment(null);
        queueMicrotask(focusChatInput);
      }}
    />
  );
  const overlay = comment && field && createPortal(isMobile ? (
    <div className="oc-keyboard-inset-surface fixed inset-x-0 bottom-0 z-50 mx-auto max-w-[420px] px-3 pb-3">
      {field}
    </div>
  ) : (
    <div className="fixed z-50 w-[min(420px,calc(100vw-24px))]" style={{
      left: Math.max(12, Math.min(comment.left, window.innerWidth - 432)),
      top: Math.max(12, Math.min(comment.top + 4, window.innerHeight - 160)),
    }}>
      {field}
    </div>
  ), document.body);

  return { extension, overlay };
}
