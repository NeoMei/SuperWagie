import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openModelStore } from './store.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const directory = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unihub-store-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
};
const fixture = fileURLToPath(new URL('./store-process.fixture.mjs', import.meta.url));
const startWriter = (dir, mode = 'hold') => {
  const child = spawn(process.execPath, [fixture, dir, mode], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  });
  let timer;
  const ready = new Promise((resolve, reject) => {
    let output = '';
    timer = setTimeout(() => reject(new Error('Writer fixture did not answer')), 10_000);
    child.on('error', reject);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('\n')) {
        try { resolve(JSON.parse(output.slice(0, output.indexOf('\n')))); } catch (error) { reject(error); }
      }
    });
    child.once('exit', () => { if (!output.includes('\n')) reject(new Error('Writer fixture exited without an answer')); });
  }).finally(() => clearTimeout(timer));
  return { child, ready, exited };
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
    await expect(openModelStore(dir)).rejects.toMatchObject({ code: 'platform_store_busy' });
    await store.mutate((state) => { state.calls.call = { id: 'call', sessionID: 'session', taskID: 'task', model: 'fixture', digest: 'digest', status: 'DISPATCHED', output: false }; });
    await store.close();
    const next = await openModelStore(dir); cleanups.push(() => next.close());
    expect(next.read().calls.call.status).toBe('DISPATCHED');
    await expect(openModelStore(dir)).rejects.toThrow('platform_store_busy');
  });
  it('leaves malformed locks intact under competing startup attempts', async () => {
    const dir = await directory(); const folder = path.join(dir, 'unihub-model');
    await fs.mkdir(folder); const filename = path.join(folder, 'writer.lock');
    await fs.writeFile(filename, '999999999:stale');
    const attempts = await Promise.allSettled([openModelStore(dir), openModelStore(dir)]);
    expect(attempts.map((attempt) => attempt.status)).toEqual(['rejected', 'rejected']);
    expect(await fs.readFile(filename, 'utf8')).toBe('999999999:stale');
  });
  it('recovers a killed writer without changing committed unknown calls', async () => {
    const dir = await directory();
    const previous = startWriter(dir, 'record');
    expect(await previous.ready).toMatchObject({ state: 'owned' });
    const filename = path.join(dir, 'unihub-model', 'state.json');
    const before = await fs.readFile(filename, 'utf8');
    previous.child.kill('SIGKILL'); await previous.exited;
    const next = await openModelStore(dir); cleanups.push(() => next.close());
    expect(next.read().calls.call.status).toBe('UNKNOWN');
    expect(await fs.readFile(filename, 'utf8')).toBe(before);
    await expect(openModelStore(dir)).rejects.toThrow('platform_store_busy');
  });
  it('allows exactly one process to recover a valid legacy dead-owner lock', async () => {
    const dir = await directory(); const folder = path.join(dir, 'unihub-model');
    await fs.mkdir(folder); await fs.writeFile(path.join(folder, 'writer.lock'), `999999999:${randomUUID()}`);
    const attempts = [startWriter(dir), startWriter(dir), startWriter(dir)];
    const results = await Promise.all(attempts.map((attempt) => attempt.ready));
    expect(results.filter((result) => result.state === 'owned')).toHaveLength(1);
    expect(results.filter((result) => result.error === 'platform_store_busy')).toHaveLength(2);
  });
  it('preserves an existing live legacy owner and an incomplete owner record', async () => {
    const dir = await directory(); const folder = path.join(dir, 'unihub-model');
    await fs.mkdir(folder); const filename = path.join(folder, 'writer.lock');
    const owner = `${process.pid}:${randomUUID()}`;
    await fs.writeFile(filename, owner);
    await expect(openModelStore(dir)).rejects.toThrow('platform_store_busy');
    expect(await fs.readFile(filename, 'utf8')).toBe(owner);
    await fs.writeFile(filename, '');
    await expect(openModelStore(dir)).rejects.toThrow('platform_store_busy');
    expect(await fs.readFile(filename, 'utf8')).toBe('');
  });
  it('retains process ownership after another local connection is refused', async () => {
    const dir = await directory(); const store = await openModelStore(dir); cleanups.push(() => store.close());
    await expect(openModelStore(dir)).rejects.toMatchObject({ code: 'platform_store_busy' });
    const contender = startWriter(dir);
    expect(await contender.ready).toEqual({ state: 'refused', error: 'platform_store_busy' });
    await contender.exited;
    await store.mutate((state) => { state.calls.call = { id: 'call', sessionID: 'session', taskID: 'task', model: 'fixture', digest: 'digest', status: 'UNKNOWN', output: true }; });
    expect(store.read().calls.call.status).toBe('UNKNOWN');
  });
  it('refuses an unsafe guard path before creating or changing the legacy lock', async () => {
    const dir = await directory(); const folder = path.join(dir, 'unihub-model');
    await fs.mkdir(folder); await fs.mkdir(path.join(folder, 'writer-guard.sqlite'));
    await expect(openModelStore(dir)).rejects.toThrow('platform_store_unsafe');
    await expect(fs.stat(path.join(folder, 'writer.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('keeps a corrupt guard and the legacy owner intact when ownership cannot be established', async () => {
    const dir = await directory(); const folder = path.join(dir, 'unihub-model'); await fs.mkdir(folder);
    const owner = `999999999:${randomUUID()}`;
    await fs.writeFile(path.join(folder, 'writer.lock'), owner);
    await fs.writeFile(path.join(folder, 'writer-guard.sqlite'), 'invalid guard database');
    await expect(openModelStore(dir)).rejects.toMatchObject({ code: 'platform_store_unavailable' });
    expect(await fs.readFile(path.join(folder, 'writer.lock'), 'utf8')).toBe(owner);
  });
  it('refuses corrupt state without replacing it and releases its startup lock', async () => {
    const dir = await directory(); const folder = path.join(dir, 'unihub-model');
    await fs.mkdir(folder); await fs.writeFile(path.join(folder, 'state.json'), '{broken');
    await expect(openModelStore(dir)).rejects.toThrow();
    expect(await fs.readFile(path.join(folder, 'state.json'), 'utf8')).toBe('{broken');
    await expect(fs.stat(path.join(folder, 'writer.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.writeFile(path.join(folder, 'state.json'), JSON.stringify({ version: 1, tasks: {}, calls: {} }));
    const restored = await openModelStore(dir); cleanups.push(() => restored.close());
    expect(restored.read().calls).toEqual({});
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
