import React from 'react';
import { useMobileAppActions } from '@/apps/mobileAppContext';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { resolveEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/components/ui/toast';
import { reviewCommentDestination, type ContextPartPayload } from '@/lib/messages/contextParts';
import { captureRuntimeInstance } from '@/lib/runtime-switch';
import { spaceIdOfDirectory } from '@/lib/spaces/space-route';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';

/** Uses the comment's directory for its anchor and the active panel's directory for its tab. */
export function useReviewCommentSource(directory: string | null | undefined) {
  const { t } = useI18n();
  const apis = React.useContext(RuntimeAPIContext);
  const mobile = useMobileAppActions();

  return (payload: ContextPartPayload) => {
    if (!directory) return undefined;
    const destination = reviewCommentDestination(payload, directory);
    if (!destination) return undefined;
    const { kind, path, line } = destination;
    if (apis?.runtime.isVSCode && (kind === 'diff' || !apis.editor)) return undefined;

    return {
      label: t(kind === 'diff' ? 'chat.message.context.openReviewDiff' : 'chat.message.context.openReviewFile'),
      onReveal: () => {
        if (apis?.runtime.isVSCode) {
          void apis.editor?.openFile(path, line);
          return;
        }
        const panelDirectory = normalizeContextPanelDirectoryKey(resolveEffectiveDirectory() || directory);
        const ui = useUIStore.getState();
        if (destination.kind === 'diff') {
          if (mobile) mobile.openChanges();
          else {
            const tab = ui.contextPanelByDirectory[panelDirectory]?.tabs.find((item) => item.mode === 'diff');
            if (tab) ui.setActiveContextPanelTab(panelDirectory, tab.id);
            else ui.openContextPanelTab(panelDirectory, { mode: 'diff' });
          }
          ui.setReviewDiffRequest({ panelDirectory, sourceDirectory: directory, destination, isCurrentRuntime: captureRuntimeInstance() });
          return;
        }
        // Files belong to the panel's runtime directory. A separate isolated
        // space can reveal its file only from that space's own panel.
        if (spaceIdOfDirectory(directory) !== spaceIdOfDirectory(panelDirectory)) {
          toast.error(t('chat.message.context.openReviewFileInChat'));
          return;
        }
        if (line) ui.openContextFileAtLine(panelDirectory, path, line);
        else ui.openContextFile(panelDirectory, path);
        mobile?.openFiles();
      },
    };
  };
}
