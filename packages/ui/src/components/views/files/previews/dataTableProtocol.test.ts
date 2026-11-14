import { expect, test } from 'bun:test';
import { dataTableRequestSchema, dataTableResponseSchema } from './dataTableProtocol';

test('the decoder protocol accepts only bounded file pages and no SQL or external URL', () => {
  const request = { kind: 'sqlite', bytes: new Uint8Array([1]), table: null, page: 0 };
  expect(dataTableRequestSchema.safeParse(request).success).toBe(true);
  expect(dataTableRequestSchema.safeParse({ ...request, query: 'DELETE FROM invoice' }).success).toBe(false);
  expect(dataTableRequestSchema.safeParse({ ...request, url: 'https://example.test/file' }).success).toBe(false);
  expect(dataTableRequestSchema.safeParse({ ...request, page: -1 }).success).toBe(false);
  expect(dataTableRequestSchema.safeParse({ ...request, bytes: new Uint8Array(20 * 1024 * 1024 + 1) }).success).toBe(false);
});

test('malformed worker results cannot claim table authority', () => {
  const table = { tables: ['invoice'], selectedTable: 'invoice', columns: ['amount'], columnTypes: ['INTEGER'], rows: [['12']], page: 0, totalRows: null, hasMore: false, cellsTruncated: false };
  expect(dataTableResponseSchema.safeParse({ ok: true, table }).success).toBe(true);
  expect(dataTableResponseSchema.safeParse({ ok: true, table: { ...table, rows: [['12', 'hidden']] } }).success).toBe(false);
  expect(dataTableResponseSchema.safeParse({ ok: true, table: { ...table, rows: [['x'.repeat(1002)]] } }).success).toBe(false);
  expect(dataTableResponseSchema.safeParse({ ok: true, table: { ...table, selectedTable: 'unknown' } }).success).toBe(false);
});
