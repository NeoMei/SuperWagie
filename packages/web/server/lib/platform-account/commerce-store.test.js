import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { openCommerceStore } from './commerce-store.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const fixture = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sw-commerce-store-'));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await openCommerceStore(directory);
  cleanups.push(() => store.close());
  const intent = { serviceId: 'hub-a', actorId: 'actor-a', accountId: 'account-a', idempotencyKey: crypto.randomUUID(), kind: 'recharge', productId: 'superwagie', amount: '1000000', status: 'UNKNOWN', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  return { directory, store, intent };
};

describe('commerce recovery store', () => {
  it('round-trips uncertain intent and rejects a concurrent writer', async () => {
    const f = await fixture();
    await f.store.mutate((intents) => { intents['entry-a'] = f.intent; });
    await expect(openCommerceStore(f.directory)).rejects.toThrow('platform_commerce_store_busy');
    await f.store.close();
    const reopened = await openCommerceStore(f.directory); cleanups.push(() => reopened.close());
    expect(reopened.read()['entry-a']).toEqual(f.intent);
    if (process.platform !== 'win32') expect((await fs.stat(path.join(f.directory, 'unihub-commerce/state.json'))).mode & 0o777).toBe(0o600);
  });
  it('preserves valid state after failed validation and rejects writes after close', async () => {
    const f = await fixture();
    await f.store.mutate((intents) => { intents['entry-a'] = f.intent; });
    await expect(f.store.mutate((intents) => { intents['entry-a'].amount = '-1'; })).rejects.toThrow();
    expect(f.store.read()['entry-a'].amount).toBe('1000000');
    expect(JSON.parse(await fs.readFile(path.join(f.directory, 'unihub-commerce/state.json'), 'utf8')).intents['entry-a'].amount).toBe('1000000');
    await f.store.close();
    await expect(f.store.mutate(() => {})).rejects.toThrow('platform_commerce_store_closed');
  });
  it('never removes a pre-existing lock while recovering from a crash', async () => {
    const f = await fixture(); await f.store.close();
    const lockPath = path.join(f.directory, 'unihub-commerce/writer.lock');
    await fs.writeFile(lockPath, 'stale-process:preserve');
    await expect(openCommerceStore(f.directory)).rejects.toThrow('platform_commerce_store_busy');
    expect(await fs.readFile(lockPath, 'utf8')).toBe('stale-process:preserve');
  });
  it('rejects symlinked state without writing through the link', async () => {
    const f = await fixture(); await f.store.close();
    const target = path.join(f.directory, 'other.json'); await fs.writeFile(target, '{"private":"untouched"}');
    await fs.symlink(target, path.join(f.directory, 'unihub-commerce/state.json'));
    await expect(openCommerceStore(f.directory)).rejects.toThrow('platform_commerce_store_unsafe');
    expect(await fs.readFile(target, 'utf8')).toBe('{"private":"untouched"}');
  });
});
