import type { parseDelimitedText } from './delimitedText';

export type TableCell = { row: number; column: number };
export type TableQuote = { range: string; values: string };
const columnName = (index: number): string => {
  let name = '';
  for (let number = index + 1; number > 0; number = Math.floor((number - 1) / 26)) name = String.fromCharCode(65 + (number - 1) % 26) + name;
  return name;
};

export function tableSelection(table: ReturnType<typeof parseDelimitedText>, anchor: TableCell, end: TableCell):
  | { status: 'ready'; quote: TableQuote }
  | { status: 'too-large' | 'unavailable' } {
  const firstRow = Math.min(anchor.row, end.row);
  const lastRow = Math.max(anchor.row, end.row);
  const firstColumn = Math.min(anchor.column, end.column);
  const lastColumn = Math.max(anchor.column, end.column);
  if (!table.coordinatesReliable || firstRow < 0 || lastRow >= table.rows.length || firstColumn < 0 || lastColumn >= table.columnCount) return { status: 'unavailable' };
  // Skipped blank records must never make a discontinuous selection claim a rectangle.
  if (table.sourceRows[lastRow] - table.sourceRows[firstRow] !== lastRow - firstRow) return { status: 'unavailable' };
  if ((lastRow - firstRow + 1) * (lastColumn - firstColumn + 1) > 1_000) return { status: 'too-large' };
  const values = JSON.stringify(table.rows.slice(firstRow, lastRow + 1).map((row) => (
    Array.from({ length: lastColumn - firstColumn + 1 }, (_, offset) => row[firstColumn + offset] ?? '')
  )));
  if (new TextEncoder().encode(values).byteLength > 64 * 1024) return { status: 'too-large' };
  return { status: 'ready', quote: {
    range: `${columnName(firstColumn)}${table.sourceRows[firstRow]}:${columnName(lastColumn)}${table.sourceRows[lastRow]}`,
    values,
  } };
}
