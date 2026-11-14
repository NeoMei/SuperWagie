import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { opencodeClient } from '@/lib/opencode/client';
import * as runtime from '@/lib/runtime-switch';
import { replaceGlobalSessionStatusById } from './global-session-status';
import { readSessionsLiveActivity } from './session-actions';

afterEach(() => replaceGlobalSessionStatusById(new Map()));

describe('retention activity authority', () => {
  test('successful empty native coverage grants idle, failed coverage remains unknown', async () => {
    const read = spyOn(opencodeClient, 'readSessionActivity').mockResolvedValue('idle');
    try {
      expect(await readSessionsLiveActivity(['session'], '/worktree')).toBe('idle');
      expect(read.mock.calls[0]?.slice(0, 2)).toEqual([['session'], '/worktree']);
      read.mockRejectedValue(new Error('native unavailable'));
      expect(await readSessionsLiveActivity(['session'], '/worktree')).toBe('unknown');
    } finally { read.mockRestore(); }
  });
  test('a newer live event blocks migration despite an idle read', async () => {
    const read = spyOn(opencodeClient, 'readSessionActivity').mockImplementation(async () => {
      replaceGlobalSessionStatusById(new Map([['session', { status: { type: 'busy' }, directory: '/worktree' }]]));
      return 'idle';
    });
    try {
      expect(await readSessionsLiveActivity(['session'], '/worktree')).toBe('active');
    } finally { read.mockRestore(); }
  });
  test('runtime replacement rejects old idle coverage', async () => {
    let current = true;
    const captured = spyOn(runtime, 'captureRuntimeInstance').mockImplementation(() => () => current);
    const read = spyOn(opencodeClient, 'readSessionActivity').mockImplementation(async () => { current = false; return 'idle'; });
    try {
      expect(await readSessionsLiveActivity(['session'], '/worktree')).toBe('unknown');
    } finally { read.mockRestore(); captured.mockRestore(); }
  });
});
