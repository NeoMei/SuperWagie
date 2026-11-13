import { describe, expect, test } from 'bun:test';
import { sqliteFixture } from './sqliteFixtures.fixture';
import { readFile } from 'node:fs/promises';
import { decodeDataTable } from './dataTableDecoder';

const wasmBinary = new Uint8Array(await readFile(new URL(import.meta.resolve('sql.js/dist/sql-wasm-browser.wasm'))));
const fixture = async (name: string) => new Uint8Array(await readFile(new URL(`./__fixtures__/${name}`, import.meta.url)));

describe('bounded data table decoder', () => {
  test('reads local SQLite WASM, quotes table names and pages without changing original bytes', async () => {
    const bytes = await sqliteFixture('quoted');
    const before = new Uint8Array(bytes);
    const table = await decodeDataTable({ kind: 'sqlite', bytes, wasmBinary, table: '报价表', page: 0 });
    expect(table.tables).toEqual(['second', '报价表']);
    expect(table.columns).toEqual(['id', 'note']);
    expect(table.rows).toEqual([['9007199254740993', '中文']]);
    expect(table.hasMore).toBe(false);
    expect(bytes).toEqual(before);
  });
  test('excludes views, virtual/shadow tables and generated expressions from read paths', async () => {
    const bytes = await sqliteFixture('unsafe');
    const table = await decodeDataTable({ kind: 'sqlite', bytes, wasmBinary, table: null, page: 0 });
    expect(table.tables).toEqual(['safe']);
    expect(table.columns).toEqual(['id']);
    expect(table.rows).toEqual([['7']]);
    await expect(decodeDataTable({ kind: 'sqlite', bytes, wasmBinary, table: 'endless', page: 0 })).rejects.toThrow('unsupported');
  });
  test('caps rows and cell text and preserves the page boundary', async () => {
    const bytes = await sqliteFixture('rows');
    const first = await decodeDataTable({ kind: 'sqlite', bytes, wasmBinary, table: null, page: 0 });
    const second = await decodeDataTable({ kind: 'sqlite', bytes, wasmBinary, table: null, page: 1 });
    expect(first.rows).toHaveLength(100);
    expect(first.rows[0]?.[1]?.length).toBeLessThanOrEqual(1001);
    expect(first.cellsTruncated).toBe(true);
    expect(first.hasMore).toBe(true);
    expect(second.rows[0]?.[0]).toBe('100');
    expect(second.rows).toHaveLength(5);
  });
  test('reads real compressed and nested Parquet fixtures entirely from local bytes', async () => {
    const compressed = await decodeDataTable({ kind: 'parquet', bytes: await fixture('small-gzip.parquet'), table: null, page: 0 });
    expect(compressed.columns).toEqual(['id', 'name']);
    expect(compressed.rows).toEqual([['1', '预算'], ['2', '报价'], ['3', '验收']]);
    expect(compressed.totalRows).toBe(3);
    const nested = await decodeDataTable({ kind: 'parquet', bytes: await fixture('nested.parquet'), table: null, page: 0 });
    expect(nested.columns).toEqual(['id', 'details']);
    expect(nested.rows[0]).toEqual(['1', '{"label":"预算"}']);
  });
  test('rejects oversized columns and claimed Parquet decompression before decoding pages', async () => {
    const bytes = await sqliteFixture('wide');
    await expect(decodeDataTable({ kind: 'sqlite', bytes, wasmBinary, table: null, page: 0 })).rejects.toThrow('tooLarge');
    await expect(decodeDataTable({ kind: 'parquet', bytes: await fixture('oversized-page.parquet'), table: null, page: 0 })).rejects.toThrow('tooLarge');
  });
  test('rejects damaged, oversized, missing-WASM and incomplete WAL inputs', async () => {
    await expect(decodeDataTable({ kind: 'parquet', bytes: new Uint8Array([1]), table: null, page: 0 })).rejects.toThrow('invalid');
    await expect(decodeDataTable({ kind: 'sqlite', bytes: new Uint8Array(20 * 1024 * 1024 + 1), wasmBinary, table: null, page: 0 })).rejects.toThrow('tooLarge');
    const bytes = await sqliteFixture('plain');
    await expect(decodeDataTable({ kind: 'sqlite', bytes, table: null, page: 0 })).rejects.toThrow('unsupported');
    bytes[18] = 2;
    await expect(decodeDataTable({ kind: 'sqlite', bytes, wasmBinary, table: null, page: 0 })).rejects.toThrow('unsupported');
  });
});
