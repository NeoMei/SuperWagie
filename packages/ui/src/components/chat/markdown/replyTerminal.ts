import type { TerminalAPI, TerminalShell } from '@/lib/api/types';
import { normalizeTerminalDirectory } from '@/lib/pathNormalization';
import { useTerminalStore } from '@/stores/useTerminalStore';

export function replyTerminalShell(language: string, fallback: TerminalShell): TerminalShell | null {
  switch (language.toLowerCase()) {
    case 'shell':
    case 'shellscript': return fallback;
    case 'bash': return 'bash';
    case 'sh': return 'sh';
    case 'zsh': return 'zsh';
    case 'fish': return 'fish';
    case 'dash': return 'dash';
    case 'ksh': return 'ksh';
    case 'nu':
    case 'nushell': return 'nu';
    case 'pwsh':
    case 'ps1':
    case 'powershell': return 'pwsh';
    case 'cmd':
    case 'bat':
    case 'batch': return 'cmd';
    default: return null;
  }
}

export async function startReplyTerminal({ terminal, directory, command, shell, loginShell, isCurrent }: {
  terminal: Pick<TerminalAPI, 'createSession' | 'close'>;
  directory: string;
  command: string;
  shell: TerminalShell;
  loginShell: boolean;
  isCurrent: () => boolean;
}): Promise<string | null> {
  const cwd = normalizeTerminalDirectory(directory);
  const source = command.trim();
  if (!cwd || !source || !isCurrent()) return null;

  const session = await terminal.createSession({
    cwd, mode: 'command', command: source, shell, loginShell, purpose: { type: 'terminal' },
  });
  if (!isCurrent()) return null;
  if (session.mode !== 'command' || session.status === 'error') {
    await terminal.close(session.sessionId, cwd).catch(() => {});
    throw new Error('Command terminal unavailable');
  }

  const store = useTerminalStore.getState();
  const tabId = store.createTab(cwd, { sessionId: session.sessionId, status: session.status });
  store.setActiveTab(cwd, tabId);
  return tabId;
}
