import React from 'react';
import { useMobileAppActions } from '@/apps/mobileAppContext';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useRuntimeInstance } from '@/hooks/useRuntimeInstance';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useChatSurfaceMode } from '../useChatSurfaceMode';
import { replyTerminalShell, startReplyTerminal } from './replyTerminal';

export function ReplyTerminalButton({ directory, language, source }: { directory: string; language: string; source: string }) {
  const { t } = useI18n();
  const { terminal, runtime } = useRuntimeAPIs();
  const isCurrent = useRuntimeInstance();
  const mobile = useMobileAppActions();
  const surface = useChatSurfaceMode();
  const starting = React.useRef(false);
  const [pending, setPending] = React.useState(false);
  if (runtime.isVSCode || !terminal?.listSessions || surface !== 'default') return null;

  const run = async () => {
    if (starting.current) return;
    const settings = useUIStore.getState();
    const shell = replyTerminalShell(language, settings.terminalShell);
    if (!shell) return;
    const activeSessionId = useSessionUIStore.getState().currentSessionId;
    starting.current = true;
    setPending(true);
    try {
      const tab = await startReplyTerminal({
        terminal, directory, command: source, shell,
        loginShell: settings.terminalLoginShells.includes(shell),
        isCurrent,
      });
      if (!tab || useSessionUIStore.getState().currentSessionId !== activeSessionId) return;
      if (mobile) mobile.openTerminal();
      else useUIStore.getState().openContextPanelTab(directory, { mode: 'terminal' });
    } catch {
      if (isCurrent()) toast.error(t('terminalView.error.startSessionFailed'));
    } finally {
      starting.current = false;
      setPending(false);
    }
  };

  const label = t('markdownRenderer.code.actions.runInTerminalTitle', { directory });
  return (
    <Button type="button" variant="ghost" size="xs" disabled={pending} data-export-ignore title={label} aria-label={label}
      onClick={() => void run()}>
      <Icon name="terminal" className="size-3.5" />
    </Button>
  );
}
