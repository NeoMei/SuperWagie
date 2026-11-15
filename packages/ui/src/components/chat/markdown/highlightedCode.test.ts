import { expect, test } from 'bun:test';
import { getHighlightedCode, highlightCode } from './highlightedCode';
import { resolveHighlights } from './highlightsEngine';

test('ANSI tool output drops colours, cursor escapes and terminal hyperlinks', async () => {
  const esc = String.fromCharCode(27);
  const bell = String.fromCharCode(7);
  const source = `${esc}[32mok${esc}[0m ${esc}]8;;https://example.test${bell}link${esc}]8;;${esc}\\ <b>${esc}[2K`;
  const result = await highlightCode(source, 'ansi');
  expect(result).toContain('<code>ok link &lt;b&gt;</code>');
  expect(result).not.toContain(esc);
  expect(result).not.toContain('example.test');
});

test('a tool language without a lexer uses its supported relative before plain text', async () => {
  const source = 'const greeting: string = "hello";';
  const expected = await highlightCode(source, 'typescript');
  expect(expected).toContain('var(--md-token-storageModifier)');
  expect(await highlightCode(source, 'typespec')).toBe(expected);
  expect(getHighlightedCode(source, 'typespec')).toBe(expected);
});

test('unknown tool languages stay escaped plain text while Markdown keeps its grammar fallback', async () => {
  expect(await highlightCode('a <b>', 'no-such-language')).toContain('<code>a &lt;b&gt;</code>');
  expect(await resolveHighlights('coffee')).toBeNull();
});
