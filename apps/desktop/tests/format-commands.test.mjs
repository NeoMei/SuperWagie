import assert from 'node:assert/strict';
import test from 'node:test';
import { EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { history, undo, redo } from '@codemirror/commands';

import * as api from '../src/renderer/editor/format-commands.mjs';
const state = (doc, from = 0, to = from) => EditorState.create({
  doc, selection: { anchor: from, head: to },
  extensions: [markdown({ base: markdownLanguage }), history(), EditorState.lineSeparator.of(doc.includes('\r\n') ? '\r\n' : '\n')],
});
function apply(current, action, payload) {
  assert.equal(typeof api.formatTransaction, 'function', 'Formatting must use source-aware editor transactions');
  const spec = api.formatTransaction(current, action, payload);
  assert.ok(spec, `${action} must be available here`);
  return current.update(spec).state;
}

test('bold changes only selected Unicode text and retains a reversed selection', () => {
  const next = apply(state('前面你好🙂后面', 6, 2), 'bold');
  assert.equal(next.sliceDoc(), '前面**你好🙂**后面');
  assert.equal(next.sliceDoc(next.selection.main.from, next.selection.main.to), '你好🙂');
  assert.ok(next.selection.main.anchor > next.selection.main.head);
});
for (const [action, source] of [['bold', '**文字**'], ['italic', '*文字*'], ['strike', '~~文字~~'], ['code', '`文字`']]) {
  test(`${action} toggles off existing syntax instead of nesting duplicate marks`, () => {
    const added = apply(state('文字', 0, 2), action);
    assert.equal(added.sliceDoc(), source);
    assert.equal(apply(added, action).sliceDoc(), '文字');
    assert.equal(apply(state(source, source.indexOf('字')), action).sliceDoc(), '文字');
  });
}
test('removing bold from part of a span keeps the other words bold', () => {
  assert.equal(apply(state('**one two three**', 6, 9), 'bold').sliceDoc(), '**one** two **three**');
});
test('empty selection inserts selected starter text so typing needs no Markdown knowledge', () => {
  const next = apply(state('前后', 1), 'bold');
  assert.equal(next.sliceDoc(), '前**加粗文字**后');
  assert.equal(next.sliceDoc(next.selection.main.from, next.selection.main.to), '加粗文字');
  assert.equal(next.update({ changes: { from: next.selection.main.from, to: next.selection.main.to, insert: '新内容' } }).state.sliceDoc(), '前**新内容**后');
});
test('whitespace and line separators stay outside inline marks', () => {
  assert.equal(apply(state(' 一行 \r\n 二行 ', 0, 9), 'bold').sliceDoc(), ' **一行** \r\n **二行** ');
});
test('headings replace levels and body removes only the heading prefix', () => {
  const changed = apply(state('> ## 标题\n尾部', 6), 'h3');
  assert.equal(changed.sliceDoc(), '> ### 标题\n尾部');
  assert.equal(apply(changed, 'body').sliceDoc(), '> 标题\n尾部');
});
test('list conversion replaces markers and excludes the next line at selection end', () => {
  const next = apply(state('- 甲\n- 乙\n尾部', 0, 8), 'ordered');
  assert.equal(next.sliceDoc(), '1. 甲\n2. 乙\n尾部');
  assert.equal(apply(next, 'task').sliceDoc(), '- [ ] 甲\n- [ ] 乙\n尾部');
});
test('task and quote toggles remove their own prefixes without touching content', () => {
  assert.equal(apply(state('- [x] 完成', 7), 'task').sliceDoc(), '完成');
  assert.equal(apply(state('> - 项目', 5), 'quote').sliceDoc(), '- 项目');
  assert.equal(apply(state('甲\n乙', 0, 3), 'quote').sliceDoc(), '> 甲\n> 乙');
});
test('attributes and code are protected even for a selection crossing their boundary', () => {
  assert.equal(typeof api.formatTransaction, 'function');
  for (const [doc, from, to] of [['---\ntitle: 文档\n---\n正文', 5, 10], ['---\ntitle: 文档\n---\n正文', 0, 20], ['```js\n**原文**\n```', 7, 11]]) {
    assert.equal(api.formatTransaction(state(doc, from, to), 'bold'), null);
  }
});
test('unknown syntax and frontmatter outside the edited span remain byte-identical', () => {
  const doc = '---\r\ncustom: 未知\r\n---\r\n[[页面|别名]]\r\n%%custom%%\r\n正文';
  const next = apply(state(doc, doc.replaceAll('\r\n', '\n').length - 2), 'h2');
  assert.equal(next.sliceDoc(), doc.slice(0, -2) + '## 正文');
});
test('link input is validated and encoded without injecting new Markdown structures', () => {
  assert.equal(apply(state('名称', 0, 2), 'link', { text: '名[称]', url: 'https://example.com/a b?q=(x)' }).sliceDoc(), '[名\\[称\\]](<https://example.com/a%20b?q=(x)>)');
  for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///private/path', 'https://example.com/\n注入']) {
    assert.throws(() => apply(state('名', 0, 1), 'link', { text: '名', url }), /链接|网址/);
  }
});
test('link removal keeps its visible label instead of its URL', () => {
  assert.equal(apply(state('[名称](<https://example.com>)', 2), 'unlink').sliceDoc(), '名称');
});
test('code chooses a delimiter longer than any selected backticks', () => {
  assert.equal(apply(state('a`b', 0, 3), 'code').sliceDoc(), '``a`b``');
});
test('divider starts a standalone block without replacing selected prose', () => {
  assert.equal(apply(state('正文\n尾部', 0, 2), 'divider').sliceDoc(), '正文\n\n---\n\n尾部');
});
test('one toolbar action is isolated from preceding typing for undo and redo', () => {
  let current = state('正文', 2);
  current = current.update({ changes: { from: 2, insert: '追加' }, selection: { anchor: 2, head: 4 }, userEvent: 'input.type' }).state;
  current = apply(current, 'bold');
  const target = { get state() { return current; }, dispatch: (tr) => { current = tr.state; } };
  assert.equal(undo(target), true);
  assert.equal(current.sliceDoc(), '正文追加');
  assert.equal(redo(target), true);
  assert.equal(current.sliceDoc(), '正文**追加**');
});
test('multi-line bold toggles as one selection and reports its active format', () => {
  const next = apply(state('甲\n乙', 0, 3), 'bold');
  assert.equal(next.sliceDoc(), '**甲**\n**乙**');
  assert.equal(api.formattingState(next).bold, true);
  assert.equal(apply(next, 'bold').sliceDoc(), '甲\n乙');
});
test('mixed bold selection applies consistently instead of inverting each line', () => {
  assert.equal(apply(state('**甲**\n乙', 0, 7), 'bold').sliceDoc(), '**甲**\n**乙**');
});
test('editing an existing escaped link label is idempotent', () => {
  const current = state('[名\\[称\\]](<https://example.com>)', 3);
  const link = api.linkAtSelection(current);
  assert.equal(link.text, '名[称]');
  assert.equal(apply(current, 'link', link).sliceDoc(), current.sliceDoc());
});
test('bold across already-bold and plain words does not generate invalid repeated markers', () => {
  assert.equal(apply(state('**甲**乙', 0, 6), 'bold').sliceDoc(), '**甲乙**');
});
test('selection crossing a bold boundary merges formatting but retains the selected words', () => {
  const next = apply(state('**甲乙**丙', 3, 7), 'bold');
  assert.equal(next.sliceDoc(), '**甲乙丙**');
  assert.equal(next.sliceDoc(next.selection.main.from, next.selection.main.to), '乙丙');
  const reverse = apply(state('甲**乙丙**', 5, 0), 'bold');
  assert.equal(reverse.sliceDoc(), '**甲乙丙**');
  assert.equal(reverse.sliceDoc(reverse.selection.main.from, reverse.selection.main.to), '甲乙丙');
});
test('format buttons cannot append markup to a closing metadata or code fence', () => {
  for (const doc of ['---\ntitle: 保留\n---', '```\ncode\n```']) {
    assert.equal(api.formatTransaction(state(doc, doc.length), 'bold'), null);
  }
});
test('removing toolbar-created inline code restores text ending in a backtick without padding', () => {
  const next = apply(state('a`', 0, 2), 'code');
  assert.equal(next.sliceDoc(), '`` a` ``');
  assert.equal(apply(next, 'code').sliceDoc(), 'a`');
});
test('a single emphasis span across a soft line break is removed once with CRLF preserved', () => {
  assert.equal(apply(state('**甲\r\n乙**', 0, 7), 'bold').sliceDoc(), '甲\r\n乙');
});
