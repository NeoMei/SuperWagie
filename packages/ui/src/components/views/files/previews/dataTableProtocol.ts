import { z } from 'zod';

export const DATA_TABLE_INPUT_LIMIT = 20 * 1024 * 1024;
export const DATA_TABLE_ROWS = 100;
export const DATA_TABLE_COLUMNS = 64;
export const DATA_TABLE_CELL_CHARS = 1000;
export const DATA_TABLE_TEXT_CHARS = 200_000;
export const DATA_TABLE_TIMEOUT_MS = 8_000;
const nameSchema = z.string().min(1).max(256);
export const dataTableRequestSchema = z.object({
  kind: z.enum(['sqlite', 'parquet']),
  bytes: z.instanceof(Uint8Array).refine((value) => value.byteLength <= DATA_TABLE_INPUT_LIMIT),
  wasmBinary: z.instanceof(Uint8Array).refine((value) => value.byteLength <= 4 * 1024 * 1024).optional(),
  table: nameSchema.nullable(),
  page: z.number().int().min(0).max(10_000),
}).strict();
export type DataTableRequest = z.infer<typeof dataTableRequestSchema>;
const dataTableSchema = z.object({
  tables: z.array(nameSchema).max(200),
  selectedTable: nameSchema.nullable(),
  columns: z.array(nameSchema).max(DATA_TABLE_COLUMNS),
  columnTypes: z.array(z.string().max(128)).max(DATA_TABLE_COLUMNS),
  rows: z.array(z.array(z.string().max(DATA_TABLE_CELL_CHARS + 1)).max(DATA_TABLE_COLUMNS)).max(DATA_TABLE_ROWS),
  page: z.number().int().min(0).max(10_000),
  totalRows: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  hasMore: z.boolean(),
  cellsTruncated: z.boolean(),
}).refine((table) => table.columnTypes.length === table.columns.length && table.rows.every((row) => row.length === table.columns.length) && (table.selectedTable === null || table.tables.includes(table.selectedTable)) && table.rows.reduce((total, row) => total + row.reduce((sum, cell) => sum + cell.length, 0), 0) <= DATA_TABLE_TEXT_CHARS);
export type DataTable = z.infer<typeof dataTableSchema>;
export const dataTableResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), table: dataTableSchema }),
  z.object({ ok: z.literal(false), reason: z.enum(['invalid', 'tooLarge', 'unsupported']) }),
]);
export type DataTableResponse = z.infer<typeof dataTableResponseSchema>;
