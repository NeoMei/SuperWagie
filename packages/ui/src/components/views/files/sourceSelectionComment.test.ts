import { EditorState } from '@codemirror/state';
import { expect, test } from 'bun:test';
import { sourceSelectionQuote } from './useSourceSelectionComment';

test('quotes exact reversed selection ending at the next line boundary', () => {
  const state = EditorState.create({ doc: 'first\nsecond\nthird', selection: { anchor: 13, head: 2 } });
  expect(sourceSelectionQuote(state)).toEqual({ code: 'rst\nsecond\n', startLine: 1, endLine: 2 });
  expect(sourceSelectionQuote(EditorState.create({ doc: 'first' }))).toBeNull();
});
