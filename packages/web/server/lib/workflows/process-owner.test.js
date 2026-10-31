import { describe, expect, it, vi } from 'vitest';

import { readWorkflowProcessStart } from './process-owner.js';

describe('workflow process identity', () => {
  it('reads a stable identity for the real current process', async () => {
    const first = await readWorkflowProcessStart(process.pid);
    expect(first).toEqual(expect.stringMatching(/^(linux|darwin|win32):.+/));
    expect(await readWorkflowProcessStart(process.pid)).toBe(first);
  });

  it('combines Linux boot identity and start ticks, even with parentheses in the command', async () => {
    const stat = `123 (node (worker)) ${['S', ...Array(18).fill('0'), '123456', '0'].join(' ')}`;
    const readFile = vi.fn(async (file) => file.endsWith('boot_id') ? 'boot-a\n' : stat);
    expect(await readWorkflowProcessStart(123, { platform: 'linux', readFile })).toBe('linux:boot-a:123456');
    expect(readFile).toHaveBeenCalledWith('/proc/123/stat', 'utf8');
    const rebooted = async (file) => file.endsWith('boot_id') ? 'boot-b\n' : stat;
    expect(await readWorkflowProcessStart(123, { platform: 'linux', readFile: rebooted })).toBe('linux:boot-b:123456');
  });

  it('reads macOS start time with a fixed locale and timezone', async () => {
    const executeFile = vi.fn(async () => ({ stdout: 'Fri Oct  30 20:00:00 2026\n' }));
    expect(await readWorkflowProcessStart(123, { platform: 'darwin', executeFile })).toBe('darwin:Fri Oct 30 20:00:00 2026');
    expect(executeFile).toHaveBeenCalledWith('/bin/ps', ['-p', '123', '-o', 'lstart='], expect.objectContaining({
      timeout: 5_000, maxBuffer: 16_384, env: expect.objectContaining({ LC_ALL: 'C', TZ: 'UTC' }),
    }));
  });

  it('reads Windows UTC start ticks without a shell or visible window', async () => {
    const executeFile = vi.fn(async () => ({ stdout: '639000000000000000\r\n' }));
    expect(await readWorkflowProcessStart(123, { platform: 'win32', executeFile })).toBe('win32:639000000000000000');
    const [file, args, options] = executeFile.mock.calls[0];
    expect(file).toMatch(/\\WindowsPowerShell\\v1.0\\powershell.exe$/);
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
    expect(Buffer.from(args[3], 'base64').toString('utf16le')).toContain('(Get-Process -Id 123 -ErrorAction Stop).StartTime.ToUniversalTime().Ticks');
    expect(options).toMatchObject({ timeout: 5_000, maxBuffer: 16_384, windowsHide: true });
  });

  it.each(['linux', 'darwin', 'win32'])('returns unknown when %s process metadata is inaccessible', async (platform) => {
    const fail = async () => { throw new Error('access denied or process gone'); };
    expect(await readWorkflowProcessStart(123, { platform, readFile: fail, executeFile: fail })).toBeNull();
  });

  it.each(['linux', 'darwin', 'win32'])('returns unknown for empty %s metadata', async (platform) => {
    expect(await readWorkflowProcessStart(123, {
      platform, readFile: async () => '', executeFile: async () => ({ stdout: '' }),
    })).toBeNull();
  });

  it('returns unknown when a bounded OS command times out', async () => {
    const executeFile = vi.fn(async () => { throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }); });
    expect(await readWorkflowProcessStart(123, { platform: 'darwin', executeFile })).toBeNull();
    expect(executeFile.mock.calls[0][2]).toMatchObject({ timeout: 5_000, maxBuffer: 16_384 });
  });

  it('rejects malformed Linux process statistics', async () => {
    const readFile = async (file) => file.endsWith('boot_id') ? 'boot' : Array(30).fill('123').join(' ');
    expect(await readWorkflowProcessStart(123, { platform: 'linux', readFile })).toBeNull();
  });

  it('rejects invalid PIDs before inspecting the OS', async () => {
    const executeFile = vi.fn();
    for (const pid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '123', '123; exit']) {
      expect(await readWorkflowProcessStart(pid, { platform: 'win32', executeFile })).toBeNull();
    }
    expect(executeFile).not.toHaveBeenCalled();
  });
});
