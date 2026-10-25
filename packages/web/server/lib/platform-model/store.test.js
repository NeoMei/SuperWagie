import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
