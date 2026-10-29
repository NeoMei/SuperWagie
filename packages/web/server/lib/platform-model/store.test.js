import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { openModelStore } from './store.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const directory = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unihub-store-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
};

describe('platform model journal ownership', () => {
  it('recovers a crashed writer while fencing other live processes', async () => {
    const dir = await directory();
    const source = `import {openModelStore} from ${JSON.stringify(new URL('./store.js', import.meta.url).href)};
      const store = await openModelStore(process.argv[1]);
      await store.mutate(state => { state.calls.saved = {id:'saved',sessionID:'session',taskID:'task',model:'fixture',digest:'d',status:'DISPATCHED',output:false}; });
      process.stdout.write('ready\\n'); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
    cleanups.push(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    const [output] = await once(child.stdout, 'data');
    expect(output.toString()).toContain('ready');
    await expect(openModelStore(dir)).rejects.toThrow('platform_store_busy');
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    const attempts = await Promise.allSettled([openModelStore(dir), openModelStore(dir)]);
    const opened = attempts.filter((result) => result.status === 'fulfilled');
    expect(opened).toHaveLength(1);
    expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(opened[0].value.read().calls.saved.status).toBe('DISPATCHED');
    await opened[0].value.close();
  });
  it('admits one writer, preserves committed intent and allows a graceful reopen', async () => {
    const dir = await directory(); const store = await openModelStore(dir); cleanups.push(() => store.close());
    await expect(openModelStore(dir)).rejects.toThrow('platform_store_busy');
    await store.mutate((state) => { state.calls.call = { id: 'call', sessionID: 'session', taskID: 'task', model: 'fixture', digest: 'digest', status: 'DISPATCHED', output: false }; });
    await store.close();
    const next = await openModelStore(dir); cleanups.push(() => next.close());
    expect(next.read().calls.call.status).toBe('DISPATCHED');
    await expect(openModelStore(dir)).rejects.toThrow('platform_store_busy');
  });
  it('leaves stale locks intact under competing startup attempts', async () => {
    const dir = await directory(); const folder = path.join(dir, 'unihub-model');
    await fs.mkdir(folder); const filename = path.join(folder, 'writer.lock');
    await fs.writeFile(filename, '999999999:stale');
    const attempts = await Promise.allSettled([openModelStore(dir), openModelStore(dir)]);
    expect(attempts.map((attempt) => attempt.status)).toEqual(['rejected', 'rejected']);
    expect(await fs.readFile(filename, 'utf8')).toBe('999999999:stale');
  });
  it('refuses corrupt state without replacing it and releases its startup lock', async () => {
    const dir = await directory(); const folder = path.join(dir, 'unihub-model');
    await fs.mkdir(folder); await fs.writeFile(path.join(folder, 'state.json'), '{broken');
    await expect(openModelStore(dir)).rejects.toThrow();
    expect(await fs.readFile(path.join(folder, 'state.json'), 'utf8')).toBe('{broken');
    await expect(fs.stat(path.join(folder, 'writer.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('seals mutation admission before waiting for queued writes and releasing the lock', async () => {
    const dir = await directory(); const store = await openModelStore(dir);
    const started = Promise.withResolvers(); const finish = Promise.withResolvers();
    const pending = store.mutate(async (state) => {
      started.resolve(); await finish.promise;
      state.calls.call = { id: 'call', sessionID: 'session', taskID: 'task', model: 'fixture', digest: 'digest', status: 'DISPATCHED', output: false };
    });
    await started.promise;
    const closing = store.close(); expect(store.close()).toBe(closing);
    await expect(store.mutate(() => {})).rejects.toThrow('platform_store_closed');
    await expect(openModelStore(dir)).rejects.toThrow('platform_store_busy');
    finish.resolve(); await pending; await closing;
    const next = await openModelStore(dir); cleanups.push(() => next.close());
    expect(next.read().calls.call.status).toBe('DISPATCHED');
    await expect(store.mutate((state) => { state.calls = {}; })).rejects.toThrow('platform_store_closed');
    expect(next.read().calls.call.status).toBe('DISPATCHED');
  });
});
