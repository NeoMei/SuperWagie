import { describe, expect, test } from 'bun:test';
import { parseDelimitedText } from './delimitedText';
import { tableSelection } from './tableSelection';

describe('source table selection', () => {
  test('B3:C5 preserves Chinese, spaces, empty values, embedded newlines and formula text', () => {
    const table = parseDelimitedText('id,name,value\n1,first,skip\n2, 中文 ,\n3,"line one\nline two",=1+2\n4, end ,42', ',');
    const selected = tableSelection(table, { row: 1, column: 1 }, { row: 3, column: 2 });
    expect(selected).toEqual({ status: 'ready', quote: { range: 'B3:C5', values: JSON.stringify([[' 中文 ', ''], ['line one\nline two', '=1+2'], [' end ', '42']]) } });
  });
  test('reverse selection and columns beyond Z retain original source positions', () => {
    const table = parseDelimitedText(`${Array.from({ length: 28 }, (_, i) => i).join('\t')}\n${Array.from({ length: 28 }, (_, i) => `value${i}`).join('\t')}`, '\t');
    expect(tableSelection(table, { row: 0, column: 27 }, { row: 0, column: 26 })).toEqual({ status: 'ready', quote: { range: 'AA2:AB2', values: '[["value26","value27"]]' } });
  });
  test('bounds and malformed or discontinuous coordinates refuse a sendable reference', () => {
    const gapped = parseDelimitedText('a,b\n1,2\n\n3,4', ',');
    expect(tableSelection(gapped, { row: 0, column: 0 }, { row: 1, column: 1 }).status).toBe('unavailable');
    expect(tableSelection(gapped, { row: 1, column: 0 }, { row: 1, column: 1 })).toEqual({ status: 'ready', quote: { range: 'A4:B4', values: '[["3","4"]]' } });
    expect(tableSelection(parseDelimitedText('a\n"unterminated', ','), { row: 0, column: 0 }, { row: 0, column: 0 }).status).toBe('unavailable');
    const huge = parseDelimitedText(`a\n${'x'.repeat(66_000)}`, ',');
    expect(tableSelection(huge, { row: 0, column: 0 }, { row: 0, column: 0 }).status).toBe('too-large');
    const wide = parseDelimitedText(`${Array(1001).fill('a').join(',')}\n${Array(1001).fill('b').join(',')}`, ',');
    expect(tableSelection(wide, { row: 0, column: 0 }, { row: 0, column: 1000 }).status).toBe('too-large');
  });
});
