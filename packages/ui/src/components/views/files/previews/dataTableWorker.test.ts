import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { sqliteFixture } from './sqliteFixtures.fixture';
import { decodeTableInWorker } from './dataTableWorker';

// The runtime worker owns CPU and the supplied WASM; no browser adapter or decoder is mocked.
Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis });
const wasmBinary = new Uint8Array(await readFile(new URL(import.meta.resolve('sql.js/dist/sql-wasm-browser.wasm'))));
describe('data decoder worker ownership', () => {
  test('decodes actual local SQLite WASM in the worker without transferring the caller bytes', async () => {
    const bytes = await sqliteFixture('invoice');
    const original = new Uint8Array(bytes);
    const table = await decodeTableInWorker({ kind: 'sqlite', bytes, wasmBinary, table: null, page: 0 }, new AbortController().signal);
    expect(table.rows).toEqual([['预算']]);
    expect(bytes.byteLength).toBe(original.byteLength);
    expect(Array.from(bytes)).toEqual(Array.from(original));
  });
  test('reads a compressed Parquet fixture through the real worker', async () => {
    const bytes = new Uint8Array(await readFile(new URL('./__fixtures__/small-gzip.parquet', import.meta.url)));
    expect((await decodeTableInWorker({ kind: 'parquet', bytes, table: null, page: 0 }, new AbortController().signal)).rows[2]).toEqual(['3', '验收']);
  });
  test('abort terminates an unfinished request and yields no result', async () => {
    const controller = new AbortController();
    const bytes = new Uint8Array(await readFile(new URL('./__fixtures__/nested.parquet', import.meta.url)));
    const pending = decodeTableInWorker({ kind: 'parquet', bytes, table: null, page: 0 }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
  test('a stalled decoder cannot block the UI and is terminated at the CPU deadline', async () => {
    const OriginalWorker = globalThis.Worker;
    let terminated = 0;
    class HungWorker extends OriginalWorker {
      constructor() { super(new URL('./__fixtures__/hung-data.worker.fixture.ts', import.meta.url), { type: 'module' }); }
      terminate() { terminated += 1; super.terminate(); }
    }
    globalThis.Worker = HungWorker;
    let mainThreadTicked = false;
    const heartbeat = setTimeout(() => { mainThreadTicked = true; }, 10);
    try {
      const bytes = new Uint8Array(await readFile(new URL('./__fixtures__/nested.parquet', import.meta.url)));
      await expect(decodeTableInWorker({ kind: 'parquet', bytes, table: null, page: 0 }, new AbortController().signal)).rejects.toThrow('timeout');
      expect(mainThreadTicked).toBe(true);
      expect(terminated).toBe(1);
    } finally { globalThis.Worker = OriginalWorker; clearTimeout(heartbeat); }
  }, 12_000);

});
