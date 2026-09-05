import test from 'node:test';
import assert from 'node:assert/strict';

import { createLosslessMarkdownDocument, renderMarkdown } from '../src/renderer/editor/markdown-model.mjs';

test('source mode preserves frontmatter, CRLF, wikilinks and unknown syntax byte-for-byte', () => {
  const source = '---\r\ntags:\r\n  - 项目\r\n---\r\n# 标题\r\n[[页面|别名]]\r\n%%unknown::value%%\r\n';
  const document = createLosslessMarkdownDocument(source);
  assert.equal(document.source(), source);
  assert.equal(document.revision(), 0);
});

test('preview renders known local syntax while raw active HTML stays inert', () => {
  const source = '---\ntitle: 测试\n---\n> [!NOTE] 注意\n> 正文\n\n[[页面|别名]]\n\n<img src="https://attacker.invalid/pixel">';
  const html = renderMarkdown(source, (value) => value);
  assert.match(html, /sw-properties/);
  assert.match(html, /sw-callout/);
  assert.match(html, /sw-wikilink/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});
