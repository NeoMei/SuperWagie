import { describe, expect, test } from 'bun:test';
import { spawn } from 'bun-pty';

const captureInitialOutput = async (text: string) => {
  const terminal = spawn(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(text)})`], {
    cols: 80, rows: 24, cwd: process.cwd(), env: process.env,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('PTY fixture did not exit')), 10_000);
      terminal.onExit(() => { clearTimeout(timer); resolve(); });
    });
    let first = '';
    let second = '';
    terminal.onData((data) => { first += data; });
    terminal.onData((data) => { second += data; });
    return { first, second };
  } finally {
    terminal.kill();
  }
};

describe('bun-pty initial replay', () => {
  test('limits multibyte output to 512 KiB and replays it only to the first listener', async () => {
    const { first, second } = await captureInitialOutput('─'.repeat(200_000));
    expect(Buffer.byteLength(first, 'utf8')).toBeLessThanOrEqual(512 * 1024);
    expect(first).toBe('─'.repeat(174_762));
    expect(second).toBe('');
  }, 15_000);

  test('retains whole emoji and leaves short output intact', async () => {
    const { first } = await captureInitialOutput('😀'.repeat(150_000));
    expect(first).toBe('😀'.repeat(131_072));
    expect(first).not.toContain('�');
    expect((await captureInitialOutput('犇马 ready')).first).toBe('犇马 ready');
  }, 15_000);
});
