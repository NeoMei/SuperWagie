import { z } from 'zod';
import type { Database, SqlValue } from 'sql.js/dist/sql-wasm-browser.js';
import type { FileMetaData } from 'hyparquet';
import { DataPreviewError } from './dataFilePreview';
import { DATA_TABLE_CELL_CHARS, DATA_TABLE_COLUMNS, DATA_TABLE_INPUT_LIMIT, DATA_TABLE_ROWS, DATA_TABLE_TEXT_CHARS, type DataTable, type DataTableRequest } from './dataTableProtocol';

const scalarSchema = z.union([z.string(), z.number(), z.bigint(), z.boolean(), z.date(), z.instanceof(Uint8Array), z.null(), z.undefined()]);
const numericScalarSchema = z.union([z.number(), z.boolean()]);
type DataValue = z.infer<typeof scalarSchema> | DataValue[] | { [key: string]: DataValue };
const dataValueSchema: z.ZodType<DataValue> = z.lazy(() => z.union([scalarSchema, z.array(dataValueSchema), z.record(z.string(), dataValueSchema)]));
const collectionSchema = z.union([z.array(dataValueSchema), z.record(z.string(), dataValueSchema)]);
const nameSchema = z.string().min(1).max(256);
const quoteName = (name: string) => `"${name.replace(/"/g, '""')}"`;
type TextBudget = { nodes: number; truncated: boolean };

/** The decoder boundary emits bounded text, including bounded nested Parquet values. */
const cellText = (raw: DataValue, budget: TextBudget, depth = 0): string => {
  const nested = depth > 0;
  if (++budget.nodes > 100 || depth > 4) { budget.truncated = true; return nested ? '"…"' : '…'; }
  const scalar = scalarSchema.safeParse(raw);
  if (scalar.success) {
    const value = scalar.data;
    if (value === null || value === undefined) return nested ? 'null' : '';
    const text = value instanceof Uint8Array ? `[${value.byteLength} B]` : value instanceof Date ? value.toISOString() : String(value);
    const shortened = text.length > DATA_TABLE_CELL_CHARS ? `${text.slice(0, DATA_TABLE_CELL_CHARS)}…` : text;
    budget.truncated ||= shortened !== text;
    const literal = numericScalarSchema.safeParse(value);
    return nested ? literal.success ? String(literal.data) : JSON.stringify(shortened) : shortened;
  }
  const collection = collectionSchema.safeParse(raw);
  if (!collection.success) throw new DataPreviewError('unsupported');
  const value = collection.data;
  const pairs = Array.isArray(value) ? value.slice(0, 20).map((item) => cellText(item, budget, depth + 1)) : Object.entries(value).slice(0, 20).map(([key, item]) => `${JSON.stringify(key)}:${cellText(item, budget, depth + 1)}`);
  if ((Array.isArray(value) ? value.length : Object.keys(value).length) > 20) { pairs.push('"…"'); budget.truncated = true; }
  const text = Array.isArray(value) ? `[${pairs.join(',')}]` : `{${pairs.join(',')}}`;
  if (text.length <= DATA_TABLE_CELL_CHARS) return text;
  budget.truncated = true;
  return `${text.slice(0, DATA_TABLE_CELL_CHARS)}…`;
};
const textRows = (rows: unknown[][]) => {
  let totalCharacters = 0;
  let cellsTruncated = false;
  const result = rows.map((row) => row.map((value) => {
    const budget = { nodes: 0, truncated: false };
    const parsed = dataValueSchema.safeParse(value);
    if (!parsed.success) throw new DataPreviewError('unsupported');
    const text = cellText(parsed.data, budget);
    cellsTruncated ||= budget.truncated;
    totalCharacters += text.length;
    if (totalCharacters > DATA_TABLE_TEXT_CHARS) throw new DataPreviewError('tooLarge');
    return text;
  }));
  return { rows: result, cellsTruncated };
};
const values = (database: Database, query: string, params: SqlValue[] = []): SqlValue[][] => {
  const statement = database.prepare(query, params);
  try {
    const rows: SqlValue[][] = [];
    while (statement.step()) rows.push(statement.get(null, { useBigInt: true }));
    return rows;
  } finally { statement.free(); }
};
const sqliteTable = async ({ bytes, wasmBinary, table, page }: DataTableRequest): Promise<DataTable> => {
  if (new TextDecoder().decode(bytes.subarray(0, 16)) !== 'SQLite format 3\0') throw new DataPreviewError('invalid');
  // A standalone preview cannot certify a database whose committed state needs a WAL sidecar.
  if (!wasmBinary || bytes[18] === 2 || bytes[19] === 2) throw new DataPreviewError('unsupported');
  const { default: initSqlJs } = await import('sql.js/dist/sql-wasm-browser.js');
  const sql = await initSqlJs({ wasmBinary });
  const database = new sql.Database(bytes);
  try {
    database.run('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');
    // Modules absent from SQL.js may report their shadow tables as ordinary tables.
    const virtualNames = values(database, "SELECT name FROM sqlite_schema WHERE type='table' AND rootpage=0 LIMIT 201").map((row) => nameSchema.parse(row[0]));
    if (virtualNames.length > 200) throw new DataPreviewError('tooLarge');
    const tables = values(database, "SELECT name FROM pragma_table_list WHERE schema='main' AND type='table' AND substr(name,1,7)<>'sqlite_' ORDER BY name LIMIT 201")
      .map((row) => nameSchema.parse(row[0]))
      .filter((name) => !virtualNames.some((virtual) => name === virtual || name.startsWith(`${virtual}_`)));
    if (tables.length > 200) throw new DataPreviewError('tooLarge');
    const selectedTable = table ?? tables[0] ?? null;
    if (selectedTable !== null && !tables.includes(selectedTable)) throw new DataPreviewError('unsupported');
    if (selectedTable === null) return { tables, selectedTable, columns: [], columnTypes: [], rows: [], page, totalRows: null, hasMore: false, cellsTruncated: false };
    // Generated and hidden columns can evaluate file-supplied expressions, so only physical columns are selected.
    const info = values(database, 'SELECT name,type FROM pragma_table_xinfo(?) WHERE hidden=0 ORDER BY cid LIMIT 65', [selectedTable]);
    if (info.length > DATA_TABLE_COLUMNS) throw new DataPreviewError('tooLarge');
    const columns = info.map((row) => nameSchema.parse(row[0]));
    const columnTypes = info.map((row) => z.string().max(128).parse(row[1]));
    if (columns.length === 0) throw new DataPreviewError('unsupported');
    const rows = values(database, `SELECT ${columns.map(quoteName).join(',')} FROM ${quoteName(selectedTable)} LIMIT ${DATA_TABLE_ROWS + 1} OFFSET ?`, [page * DATA_TABLE_ROWS]);
    const text = textRows(rows.slice(0, DATA_TABLE_ROWS));
    return { tables, selectedTable, columns, columnTypes, ...text, page, totalRows: null, hasMore: rows.length > DATA_TABLE_ROWS };
  } finally { database.close(); }
};

const MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_COLUMN_BYTES = 16 * 1024 * 1024;
const MAX_COLUMN_VALUES = 1_000_000;
const parquetColumns = (metadata: FileMetaData) => {
  if (metadata.schema.length > 1000 || metadata.row_groups.length > 1000 || metadata.metadata_length > 1024 * 1024) throw new DataPreviewError('tooLarge');
  const columns: string[] = [];
  const columnTypes: string[] = [];
  let index = 1;
  const visit = (depth: number): void => {
    if (depth > 8 || index >= metadata.schema.length) throw new DataPreviewError('unsupported');
    const item = metadata.schema[index++];
    if (depth === 0) { columns.push(nameSchema.parse(item.name)); columnTypes.push(item.type ?? item.logical_type?.type ?? 'STRUCT'); }
    const children = item.num_children ?? 0;
    if (!Number.isSafeInteger(children) || children < 0 || children > 1000) throw new DataPreviewError('invalid');
    for (let child = 0; child < children; child += 1) visit(depth + 1);
  };
  while (index < metadata.schema.length) visit(0);
  if (columns.length > DATA_TABLE_COLUMNS) throw new DataPreviewError('tooLarge');
  return { columns, columnTypes };
};
const parquetTable = async ({ bytes, page }: DataTableRequest): Promise<DataTable> => {
  if (bytes.byteLength < 12 || new TextDecoder().decode(bytes.subarray(0, 4)) !== 'PAR1') throw new DataPreviewError('invalid');
  const [{ parquetMetadata, parquetRead }, { parquetHeader }, codec] = await Promise.all([import('hyparquet'), import('hyparquet/src/column.js'), import('hyparquet-compressors')]);
  const file = new Uint8Array(bytes).buffer;
  const metadata = parquetMetadata(file, { geoparquet: false });
  const { columns, columnTypes } = parquetColumns(metadata);
  const totalRows = Number(metadata.num_rows);
  if (!Number.isSafeInteger(totalRows) || totalRows < 0) throw new DataPreviewError('tooLarge');
  let decompressed = 0;
  let pageDecompressed = 0;
  let pageValues = 0;
  for (const group of metadata.row_groups) {
    for (const column of group.columns) {
      const meta = column.meta_data;
      if (column.file_path || !meta) throw new DataPreviewError('unsupported');
      const size = Number(meta.total_compressed_size);
      const plainSize = Number(meta.total_uncompressed_size);
      const valueCount = Number(meta.num_values);
      if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(plainSize) || plainSize < 0 || !Number.isSafeInteger(valueCount) || valueCount < 0) throw new DataPreviewError('invalid');
      decompressed += plainSize;
      if (plainSize > MAX_COLUMN_BYTES || valueCount > MAX_COLUMN_VALUES || decompressed > MAX_DECOMPRESSED_BYTES) throw new DataPreviewError('tooLarge');
      const start = Number(meta.dictionary_page_offset ?? meta.data_page_offset);
      const end = start + size;
      if (!Number.isSafeInteger(start) || start < 4 || end > file.byteLength - metadata.metadata_length - 8) throw new DataPreviewError('invalid');
      const reader = { view: new DataView(file, start, size), offset: 0 };
      let pages = 0;
      let columnDecompressed = 0;
      while (reader.offset < size) {
        if (++pages > 10_000) throw new DataPreviewError('tooLarge');
        const header = parquetHeader(reader);
        const pageSize = Number(header.uncompressed_page_size);
        const compressedSize = Number(header.compressed_page_size);
        const count = header.data_page_header?.num_values ?? header.data_page_header_v2?.num_values ?? header.dictionary_page_header?.num_values ?? 0;
        if (!Number.isSafeInteger(pageSize) || pageSize < 0 || !Number.isSafeInteger(compressedSize) || compressedSize < 0 || !Number.isSafeInteger(count) || count < 0) throw new DataPreviewError('invalid');
        if (pageSize > MAX_COLUMN_BYTES || count > MAX_COLUMN_VALUES) throw new DataPreviewError('tooLarge');
        columnDecompressed += pageSize;
        pageDecompressed += pageSize;
        pageValues += count;
        if (columnDecompressed > MAX_COLUMN_BYTES || pageDecompressed > MAX_DECOMPRESSED_BYTES || pageValues > 4_000_000) throw new DataPreviewError('tooLarge');
        reader.offset += compressedSize;
        if (reader.offset > size) throw new DataPreviewError('invalid');
      }
    }
  }
  // Fixed output buffers keep codec frame headers from allocating beyond the page budget.
  const bounded = (decode: (input: Uint8Array, length: number) => Uint8Array) => (input: Uint8Array, length: number) => {
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_COLUMN_BYTES) throw new DataPreviewError('tooLarge');
    return decode(input, length);
  };
  const compressors = {
    ...codec.compressors,
    ZSTD: bounded((input, length) => codec.decompressZstd(input, new Uint8Array(length))),
  };
  const rowStart = page * DATA_TABLE_ROWS;
  let decoded: unknown[][] = [];
  await parquetRead({ file, metadata, compressors, geoparquet: false, columns, rowStart, rowEnd: Math.min(rowStart + DATA_TABLE_ROWS, totalRows), onComplete: (rows) => { decoded = rows; } });
  if (decoded.length > DATA_TABLE_ROWS || decoded.some((row) => row.length > DATA_TABLE_COLUMNS)) throw new DataPreviewError('tooLarge');
  return { tables: [], selectedTable: null, columns, columnTypes, ...textRows(decoded), page, totalRows, hasMore: rowStart + DATA_TABLE_ROWS < totalRows };
};

/** Runs only in the disposable worker. No external URL, arbitrary SQL or disk writer is accepted. */
export const decodeDataTable = async (request: DataTableRequest): Promise<DataTable> => {
  if (request.bytes.byteLength > DATA_TABLE_INPUT_LIMIT) throw new DataPreviewError('tooLarge');
  if (!Number.isInteger(request.page) || request.page < 0 || request.page > 10_000) throw new DataPreviewError('unsupported');
  try { return await (request.kind === 'sqlite' ? sqliteTable(request) : parquetTable(request)); }
  catch (error) { if (error instanceof DataPreviewError) throw error; throw new DataPreviewError('invalid'); }
};
