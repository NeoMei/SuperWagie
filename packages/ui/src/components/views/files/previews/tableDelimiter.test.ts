import { expect, test } from 'bun:test';
import { parseDelimitedText } from './delimitedText';
import { resolveDelimiter } from './tableDelimiter';

test('reads semicolon CSV with commas, quoted delimiters and embedded lines', () => {
  const content = '\uFEFFName;Value;Note\r\n"甲,乙";"3,5";"one;two\nthree"\r\n二;4;end';
  const delimiter = resolveDelimiter('table.csv', content);
  expect(delimiter).toBe(';');
  expect(parseDelimitedText(content, delimiter).rows).toEqual([['甲,乙', '3,5', 'one;two\nthree'], ['二', '4', 'end']]);
});

test('detects a mislabeled TSV while respecting the explicit TSV extension', () => {
  expect(resolveDelimiter('table.csv', 'A\tB\nC\tD')).toBe('\t');
  expect(resolveDelimiter('table.tsv', 'A,B\nC,D')).toBe('\t');
  expect(resolveDelimiter('table.csv', 'Name\nOne')).toBe(',');
});
