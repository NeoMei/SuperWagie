import { beforeEach, expect, test } from 'bun:test';
import type { CreateTerminalOptions, TerminalSession } from '@/lib/api/types';
import { useTerminalStore } from '@/stores/useTerminalStore';
import { replyTerminalShell, startReplyTerminal } from './replyTerminal';

const directory = '/repo/worktree';
beforeEach(() => useTerminalStore.getState().clearAll());

test('creates one project terminal for a settled shell block and selects the exited tab', async () => {
  const requests: CreateTerminalOptions[] = [];
  const tab = await startReplyTerminal({
    terminal: {
      createSession: async (options) => {
        requests.push(options);
        return { sessionId: options.sessionId ?? 'missing', cols: 80, rows: 24, mode: 'command', status: 'exited' };
      },
      close: async () => { throw new Error('must keep output'); },
    },
    directory, command: ' printf ok\r\n', shell: 'sh', loginShell: false, isCurrent: () => true,
  });
  const active = useTerminalStore.getState().getActiveTab(directory);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    cwd: directory, mode: 'command', command: 'printf ok', shell: 'sh', purpose: { type: 'terminal' },
  });
  expect(active).toMatchObject({ id: tab, mode: 'command', lifecycle: 'exited' });
});

test('closes an unsupported interactive fallback and ignores a stale runtime response', async () => {
  const closed: string[] = [];
  let mode: TerminalSession['mode'] = 'interactive';
  const terminal = {
    createSession: async (options: CreateTerminalOptions): Promise<TerminalSession> =>
      ({ sessionId: options.sessionId ?? 'missing', cols: 80, rows: 24, mode, status: 'running' }),
    close: async (id: string) => { closed.push(id); },
  };
  const params = { terminal, directory, command: 'true', shell: 'auto' as const, loginShell: false };
  await expect(startReplyTerminal({ ...params, isCurrent: () => true })).rejects.toThrow();
  expect(closed).toHaveLength(1);
  mode = 'command';
  let checks = 0;
  expect(await startReplyTerminal({ ...params, isCurrent: () => ++checks === 1 })).toBeNull();
  expect(closed).toHaveLength(1);
  expect(useTerminalStore.getState().getDirectoryState(directory)?.tabs).toBeUndefined();
});

test('ties a tagged block to the appropriate shell and excludes non-shell code', () => {
  expect(replyTerminalShell('shell', 'auto')).toBe('auto');
  expect(replyTerminalShell('pwsh', 'bash')).toBe('pwsh');
  expect(replyTerminalShell('bash', 'pwsh')).toBe('bash');
  expect(replyTerminalShell('python', 'auto')).toBeNull();
});
