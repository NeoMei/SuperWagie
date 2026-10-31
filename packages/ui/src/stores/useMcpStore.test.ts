import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { opencodeClient } from '@/lib/opencode/client';
import type { McpServerStatus } from '@/lib/opencode/model';
import { useMcpStore } from './useMcpStore';

const DIRECTORY = '/workspace/project';

type ServerState = McpServerStatus['status'];

// OpenCode's transitions as a real 2.2.0 host shows them: connect starts the
// server, disconnect leaves it `disabled` until someone connects it again.
let server: ServerState | null;
const spies: Array<{ mockRestore: () => void }> = [];
let disconnects = 0;
let connectError: string | null = null;
let disconnectError: string | null = null;

beforeEach(() => {
  disconnects = 0;
  connectError = null;
  disconnectError = null;
  useMcpStore.getState().resetForRuntimeSwitch();
  spies.push(
    spyOn(opencodeClient, 'listMcpServers').mockImplementation(async () => (server ? [{ name: 'lab', status: server }] : [])),
    spyOn(opencodeClient, 'connectMcpServer').mockImplementation(async () => {
      if (connectError) throw new Error(connectError);
      server = { status: 'connected' };
    }),
    spyOn(opencodeClient, 'disconnectMcpServer').mockImplementation(async () => {
      disconnects += 1;
      if (disconnectError) throw new Error(disconnectError);
      server = { status: 'disabled' };
    }),
  );
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

const testFrom = async (before: ServerState | null) => {
  server = before;
  await useMcpStore.getState().refresh({ directory: DIRECTORY, silent: true });
  const result = await useMcpStore.getState().testConnection('lab', DIRECTORY);
  return { result, after: useMcpStore.getState().getStatusForDirectory(DIRECTORY).lab?.status.status };
};

describe('testConnection', () => {
  test('a failed connect keeps the server failure and reports the error', async () => {
    connectError = 'Service unavailable';
    const { result, after } = await testFrom({ status: 'failed', error: 'Service unavailable' });
    expect(result.error).toBe('Service unavailable');
    expect(after).toBe('failed');
    expect(disconnects).toBe(0);
  });

  test('a failed disconnect reports cleanup failure without hiding a successful test', async () => {
    disconnectError = 'Service unavailable';
    const { result, after } = await testFrom({ status: 'disabled' });
    expect(result.status?.status.status).toBe('connected');
    expect(result.warning).toContain('cleanup disconnect failed');
    expect(after).toBe('connected');
  });

  const repairable: ServerState[] = [
    { status: 'failed', error: 'process exited with code 1' },
    { status: 'needs_auth', error: 'sign in required' },
    { status: 'pending' },
  ];
  for (const before of repairable) {
    test(`a ${before.status} server that now connects stays connected`, async () => {
      const { result, after } = await testFrom(before);

      expect(result.status?.status.status).toBe('connected');
      expect(disconnects).toBe(0);
      expect(after).toBe('connected');
    });
  }

  test('a server with no status held yet stays connected', async () => {
    const { after } = await testFrom(null);

    expect(disconnects).toBe(0);
    expect(after).toBe('connected');
  });

  test('a server the user turned off is turned off again after the test', async () => {
    const { result, after } = await testFrom({ status: 'disabled' });

    expect(result.status?.status.status).toBe('connected');
    expect(disconnects).toBe(1);
    expect(after).toBe('disabled');
  });

  test('a connected server is left connected', async () => {
    const { after } = await testFrom({ status: 'connected' });

    expect(disconnects).toBe(0);
    expect(after).toBe('connected');
  });
});
