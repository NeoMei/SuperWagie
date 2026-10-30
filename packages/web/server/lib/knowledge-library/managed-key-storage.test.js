import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createManagedKeyStorage } from './managed-key-storage.js';

const cleanups = [];
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0)) await cleanup(); });

function windowsStorage({ response = '{"created":true}\n', code = 0, failure = false, pending = false, written = '{"written":true}\n', writePending = false, temporary = 'C:\\Users\\test\\AppData\\Local\\Temp' } = {}) {
  const calls = []; const input = []; let killed = 0; let opened = 0; let exited = false;
  const storage = createManagedKeyStorage({
    platform: 'win32', environment: { SystemRoot: 'C:\\Windows', TMP: temporary, TEMP: temporary, PRIVATE_PROVIDER_TOKEN: 'must-never-inherit' },
    fileSystem: { open: async () => { opened++; throw new Error('Windows must keep its verified native handle'); } },
    spawnProcess(executable, args, options) {
      calls.push({ executable, args, options });
      const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough();
      const operation = () => { const lines = Buffer.concat(input).toString().split('\n'); return lines[1] ? JSON.parse(lines[1]).operation : ''; };
      const exit = (exitCode) => { if (!exited) { exited = true; child.emit('close', exitCode); } };
      child.kill = () => { killed++; queueMicrotask(() => exit(1)); };
      child.stdin.on('data', (chunk) => { input.push(Buffer.from(chunk)); });
      child.stdin.on('finish', () => {
        if (!writePending && operation() === 'create-file' && response === '{"created":true}\n') queueMicrotask(() => { child.stdout.write(written); exit(code); });
      });
      queueMicrotask(() => {
        if (failure) child.emit('error', new Error('private child diagnostic'));
        else if (!pending) {
          child.stdout.write(response);
          if (operation() !== 'create-file' || response !== '{"created":true}\n') exit(code);
        }
      });
      return child;
    },
  });
  return { storage, calls, input: () => Buffer.concat(input), counters: () => ({ killed, opened }) };
}

it('keeps the verified native file open and sends key bytes only after readiness', async () => {
  const f = windowsStorage(); const filename = "C:\\Users\\test\\private'$()\\callback.key";
  const file = await f.storage.createFile(filename);
  const { executable, args, options } = f.calls[0];
  expect(executable).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  expect(args.slice(0, 6)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand']);
  expect(args).not.toContain(filename);
  expect(options).toEqual({ windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'], env: { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', TMP: 'C:\\Users\\test\\AppData\\Local\\Temp', TEMP: 'C:\\Users\\test\\AppData\\Local\\Temp' } });
  const before = f.input(); const lines = before.toString().trimEnd().split('\n');
  expect(lines).toHaveLength(2);
  expect(JSON.parse(lines[1])).toEqual({ operation: 'create-file', path: filename });
  const secret = Buffer.alloc(32, 0x7f);
  expect(before.includes(secret)).toBe(false);
  expect(JSON.stringify(f.calls)).not.toContain(secret.toString('hex'));
  await file.writeFile(secret); await file.sync(); await file.close();
  expect(f.input().subarray(before.length)).toEqual(secret);
  expect(f.counters()).toEqual({ killed: 0, opened: 0 });
});

it.each([null, 'relative\\Temp', '\\\\server\\Temp', 'C:\\private\\..\\Temp'])('requires a canonical user compiler temp path before spawning: %j', async (temporary) => {
  const f = windowsStorage({ temporary });
  await expect(f.storage.prepareDirectory('C:\\private\\keys')).rejects.toMatchObject({ code: 'knowledge_work_storage_unavailable' });
  expect(f.calls).toHaveLength(0);
});

it.each([{ response: '{"created":true}\n', expected: true }, { response: '{"created":false}\n', expected: false }])('reports directory ownership only from a successful native result: %j', async ({ response, expected }) => {
  const f = windowsStorage({ response });
  expect(await f.storage.prepareDirectory('C:\\private\\keys')).toBe(expected);
  expect(f.counters().opened).toBe(0);
});

it('checks an existing key without opening it for writing or repairing its ACL', async () => {
  const f = windowsStorage({ response: '{"created":false}\n' });
  await expect(f.storage.createFile('C:\\private\\key-v1')).rejects.toMatchObject({ code: 'EEXIST' });
  expect(f.counters().opened).toBe(0);
  const reader = windowsStorage({ response: '{"created":false}\n' });
  await reader.storage.verifyFile('C:\\private\\key-v1');
  expect(JSON.parse(reader.input().toString().trimEnd().split('\n')[1])).toEqual({ operation: 'verify-file', path: 'C:\\private\\key-v1' });
  expect(reader.counters().opened).toBe(0);
});

it.each([
  { response: '{"created":true,"extra":"ignored"}\n' }, { response: 'true\n' },
  { response: '{"created":false}\n', code: 1 }, { response: 'x'.repeat(129) }, { failure: true },
])('refuses unknown process results before a key can be written: %j', async (options) => {
  const f = windowsStorage(options);
  await expect(f.storage.createFile('C:\\private\\callback.key')).rejects.toMatchObject({ code: 'knowledge_work_storage_unavailable' });
  expect(f.input().toString().trimEnd().split('\n')).toHaveLength(2);
  expect(f.counters().opened).toBe(0);
});

it.each([{ written: '' }, { written: '{"written":true}\n', code: 1 }, { written: '{"written":false}\n' }])('requires durable write acknowledgement and successful process exit: %j', async (options) => {
  const f = windowsStorage(options); const file = await f.storage.createFile('C:\\private\\callback.key');
  await expect(file.writeFile(Buffer.alloc(32))).rejects.toMatchObject({ code: 'knowledge_work_storage_unavailable' });
  await file.close();
});

it('rejects invalid key length before sending any key bytes', async () => {
  const f = windowsStorage(); const file = await f.storage.createFile('C:\\private\\callback.key'); const before = f.input();
  await expect(file.writeFile(Buffer.alloc(31))).rejects.toMatchObject({ code: 'knowledge_work_storage_unavailable' });
  await file.close();
  expect(f.input()).toEqual(before); expect(f.counters().killed).toBe(1);
});

it('closes an abandoned empty creation without leaving the owned helper running', async () => {
  const f = windowsStorage(); const file = await f.storage.createFile('C:\\private\\callback.key'); const before = f.input();
  await file.close(); await file.close();
  await expect(file.writeFile(Buffer.alloc(32))).rejects.toMatchObject({ code: 'knowledge_work_storage_unavailable' });
  expect(f.input()).toEqual(before); expect(f.counters().killed).toBe(1);
});

it.each([{ pending: true }, { writePending: true }])('bounds both preparation and the held write process without retrying: %j', async (options) => {
  vi.useFakeTimers(); const f = windowsStorage(options);
  const result = options.pending ? f.storage.createFile('C:\\private\\callback.key') : (await f.storage.createFile('C:\\private\\callback.key')).writeFile(Buffer.alloc(32));
  const rejected = expect(result).rejects.toMatchObject({ message: 'knowledge_work_storage_unavailable' });
  await vi.advanceTimersByTimeAsync(10_000); await rejected;
  expect(f.counters()).toEqual({ killed: 1, opened: 0 }); expect(f.calls).toHaveLength(1);
});

it.each(['relative\\key', '\\\\server\\share\\key', 'C:\\private\\..\\key'])('rejects an ambiguous host address without a subprocess: %s', async (filename) => {
  const f = windowsStorage();
  await expect(f.storage.createFile(filename)).rejects.toMatchObject({ code: 'knowledge_work_storage_unavailable' }); expect(f.calls).toHaveLength(0);
});

it('keeps Unix exclusive creation, no-follow flags and permissions', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-key-posix-'));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  const storage = createManagedKeyStorage({ platform: 'darwin', spawnProcess: () => { throw new Error('unexpected subprocess'); } });
  const privateDirectory = path.join(directory, 'private');
  await storage.prepareDirectory(privateDirectory);
  const filename = path.join(privateDirectory, 'key-v1'); const key = Buffer.alloc(32, 0x31);
  const file = await storage.createFile(filename);
  await file.writeFile(key); await file.close();
  await storage.verifyFile(filename);
  expect((await fs.stat(privateDirectory)).mode & 0o077).toBe(0);
  expect((await fs.stat(filename)).mode & 0o077).toBe(0);
  await expect(storage.createFile(filename)).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await fs.readFile(filename)).toEqual(key);
  const symlink = path.join(privateDirectory, 'link'); await fs.symlink(filename, symlink);
  await expect(storage.createFile(symlink)).rejects.toThrow();
});
