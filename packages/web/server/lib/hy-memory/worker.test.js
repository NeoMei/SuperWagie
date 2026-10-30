import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { createHyMemoryWorker } from './worker.js';

describe('owned Hy worker transport', () => {
  test('dispatches reverse model requests and closes its child', async () => {
    const worker = createHyMemoryWorker({ command: process.execPath, script: fileURLToPath(new URL('./fixtures/worker.mjs', import.meta.url)),
      handlers: { 'host.generate': async (params) => ({ content: `generated:${params.prompt}` }) } });
    try {
      expect((await worker.capabilities()).engine).toBe('hy-memory');
      expect(await worker.call('organize', { context: { jobId: 'one' } })).toEqual({ text: 'generated:fixture' });
    } finally { await worker.stop(); }
    expect(worker.status().state).toBe('stopped');
  });
  test('aborts a stuck generation without returning an empty success', async () => {
    const worker = createHyMemoryWorker({ command: process.execPath, script: fileURLToPath(new URL('./fixtures/worker.mjs', import.meta.url)) });
    const abort = new AbortController();
    try {
      const pending = worker.call('stuck', {}, { signal: abort.signal });
      setTimeout(() => abort.abort(), 30);
      await expect(pending).rejects.toThrow();
    } finally { await worker.stop(); }
  });
});

const capabilities = { engine: 'hy-memory', version: '2.0.8', source_sha: '988667cd876fb80bee6d618482f78a2fe426402c' };
const fixtureChild = ({ handshake = capabilities, autoHandshake = true, exitOnKill = true, onRequest = null } = {}) => {
  const child = new EventEmitter(); const writes = []; const kills = [];
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.stdin = { writable: true, write: (line) => {
    const message = JSON.parse(line); writes.push(message);
    if (message.method === 'capabilities' && autoHandshake) queueMicrotask(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: message.id, result: handshake })}\n`)));
    else onRequest?.(message, child);
  } };
  child.kill = (signal) => { kills.push(signal ?? 'SIGTERM'); if (exitOnKill) queueMicrotask(() => child.emit('exit', 0, signal)); return true; };
  return { child, writes, kills };
};

test('kills an invalid handshake child before restarting and ignores its later exit', async () => {
  const first = fixtureChild({ handshake: { ...capabilities, source_sha: 'wrong' }, exitOnKill: false });
  const second = fixtureChild({ onRequest: (message, child) => queueMicrotask(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: message.id, result: { ok: true } })}\n`))) });
  let spawns = 0;
  const worker = createHyMemoryWorker({ spawnImpl: () => (++spawns === 1 ? first.child : second.child) });
  try {
    await expect(worker.capabilities()).rejects.toThrow();
    expect(first.kills.length).toBeGreaterThan(0);
    const restart = worker.capabilities();
    first.child.emit('exit', 0); await restart;
    first.child.emit('exit', 0);
    expect(await worker.call('organize', {})).toEqual({ ok: true });
    expect(spawns).toBe(2);
  } finally { await worker.stop(); }
});

test('corrupt protocol closes its child and a fresh call performs a new handshake', async () => {
  const children = [fixtureChild(), fixtureChild()]; let spawns = 0;
  const worker = createHyMemoryWorker({ spawnImpl: () => children[spawns++].child });
  try {
    await worker.capabilities();
    const request = worker.call('stuck', {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    children[0].child.stdout.emit('data', Buffer.from('corrupt-json\n'));
    await expect(request).rejects.toThrow('hy_protocol_invalid');
    expect(children[0].kills.length).toBeGreaterThan(0);
    await worker.capabilities(); expect(spawns).toBe(2);
  } finally { await worker.stop(); }
});

test('a cancelled child host request cannot send its eventual result into a replacement child', async () => {
  let entered; let release;
  const started = new Promise((resolve) => { entered = resolve; }); const delayed = new Promise((resolve) => { release = resolve; });
  const first = fixtureChild({ onRequest: (message, child) => {
    if (message.method === 'organize') queueMicrotask(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: 'host-old', method: 'host.generate', params: {} })}\n`)));
  } });
  const second = fixtureChild(); let spawns = 0;
  const worker = createHyMemoryWorker({ spawnImpl: () => (++spawns === 1 ? first.child : second.child),
    handlers: { 'host.generate': async () => { entered(); await delayed; return { content: 'old result' }; } } });
  try {
    const controller = new AbortController(); const request = worker.call('organize', {}, { signal: controller.signal });
    await started; controller.abort(); await expect(request).rejects.toThrow('hy_cancelled');
    await worker.capabilities(); release(); await new Promise((resolve) => setTimeout(resolve, 0));
    expect(second.writes.some((message) => message.id === 'host-old')).toBe(false);
  } finally { release(); await worker.stop(); }
});

test('decodes a multibyte response split across stdout chunks without changing its text', async () => {
  const fixture = fixtureChild({ onRequest: (message, child) => {
    const response = Buffer.from(`${JSON.stringify({ id: message.id, result: { text: '长期记忆' } })}\n`);
    const offset = response.indexOf(Buffer.from('长')) + 1;
    queueMicrotask(() => { child.stdout.emit('data', response.subarray(0, offset)); child.stdout.emit('data', response.subarray(offset)); });
  } });
  const worker = createHyMemoryWorker({ spawnImpl: () => fixture.child });
  try { expect(await worker.call('organize', {})).toEqual({ text: '长期记忆' }); }
  finally { await worker.stop(); }
});

test('stop during handshake rejects pending startup and late messages keep the stopped state', async () => {
  const fixture = fixtureChild({ autoHandshake: false }); let spawns = 0;
  const worker = createHyMemoryWorker({ spawnImpl: () => { spawns++; return fixture.child; } });
  const pending = worker.capabilities();
  const rejected = pending.catch((error) => error);
  await new Promise((resolve) => setTimeout(resolve, 0)); await worker.stop();
  expect((await rejected).code).toBe('hy_worker_stopped');
  fixture.child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: fixture.writes[0].id, result: capabilities })}\n`));
  fixture.child.emit('exit', 0);
  expect(worker.status()).toMatchObject({ state: 'stopped', error: null });
  await expect(worker.capabilities()).rejects.toThrow('hy_worker_stopped'); expect(spawns).toBe(1);
});
