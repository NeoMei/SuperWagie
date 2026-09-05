import { isolateHistory } from '@codemirror/commands';
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorSelection, Text } from '@codemirror/state';

const inline = {
  bold: ['StrongEmphasis', '**', '加粗文字'],
  italic: ['Emphasis', '*', '斜体文字'],
  strike: ['Strikethrough', '~~', '删除线文字'],
  code: ['InlineCode', '`', '代码'],
};
const overlaps = (range, from, to) => range.empty
  ? range.head >= from && range.head < to
  : range.from < to && range.to > from;

function enclosing(state, name) {
  const range = state.selection.main;
  const tree = ensureSyntaxTree(state, range.to, 40);
  for (let node = tree?.resolveInner(range.from, 1); node; node = node.parent) {
    if (node.name === name && node.to >= range.to) return node;
  }
  return null;
}

export function formattingAllowed(state, action = 'bold') {
  if (state.readOnly || state.selection.ranges.length !== 1) return false;
  const range = state.selection.main;
  if (state.doc.line(1).text === '---') {
    let end = state.doc.length;
    for (let n = 2; n <= state.doc.lines; n++) {
      if (/^(---|\.\.\.)$/.test(state.doc.line(n).text)) { end = state.doc.line(n).to; break; }
    }
    if (overlaps(range, 0, end + 1)) return false;
  }
  const tree = ensureSyntaxTree(state, range.to, 40);
  if (!tree) return false;
  let allowed = true;
  tree.iterate({ from: Math.max(0, range.from - 1), to: range.to, enter(node) {
    if (/^(FencedCode|CodeBlock|HTMLBlock|Table)$/.test(node.name)
      || (node.name === 'InlineCode' && action !== 'code')) {
      if (overlaps(range, node.from, node.to) || (node.name !== 'InlineCode' && range.empty && range.head === node.to)) allowed = false;
    }
  } });
  return allowed;
}

function selectedLines(state) {
  const { from, to, empty } = state.selection.main;
  const end = !empty && state.doc.lineAt(to).from === to ? to - 1 : to;
  const lines = [];
  for (let n = state.doc.lineAt(from).number; n <= state.doc.lineAt(end).number; n++) lines.push(state.doc.line(n));
  return lines;
}

function inlineLineStates(state) {
  const range = state.selection.main;
  return selectedLines(state).map((line) => {
    const from = Math.max(line.from, range.from);
    const to = Math.min(line.to, range.to);
    const text = state.sliceDoc(from, to);
    if (!text.trim()) return null;
    return state.update({ selection: { anchor: from + /^\s*/.exec(text)[0].length, head: to - /\s*$/.exec(text)[0].length } }).state;
  }).filter(Boolean);
}

function prefixes(text) {
  const indent = /^\s*/.exec(text)[0];
  let offset = indent.length;
  const quote = /^(?:> ?)+/.exec(text.slice(offset))?.[0] || '';
  offset += quote.length;
  const list = /^(?:[-+*] |\d+[.)] )(?:\[[ xX]\] )?/.exec(text.slice(offset))?.[0] || '';
  const listFrom = offset;
  offset += list.length;
  const heading = /^#{1,6} /.exec(text.slice(offset))?.[0] || '';
  return { indent, quote, list, listFrom, heading, headingFrom: offset };
}

export function linkAtSelection(state) {
  const node = enclosing(state, 'Link');
  if (!node) return null;
  const marks = [];
  let url;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === 'LinkMark') marks.push(child);
    if (child.name === 'URL') url = state.sliceDoc(child.from, child.to).replace(/^<|>$/g, '');
  }
  if (!url || marks.length < 2) return null;
  const sourceText = state.sliceDoc(marks[0].to, marks[1].from);
  return { from: node.from, to: node.to, sourceText, text: sourceText.replace(/\\([\\[\]*_`~])/g, '$1'), url };
}

export function formattingState(state) {
  const lines = selectedLines(state).map((line) => prefixes(line.text));
  const same = (get) => lines.every((line) => get(line) === get(lines[0])) ? get(lines[0]) : 'mixed';
  const inlineStates = lines.length > 1 ? inlineLineStates(state) : [state];
  return {
    ...Object.fromEntries(Object.entries(inline).map(([key, [name]]) => [key, inlineStates.length > 0 && inlineStates.every((lineState) => Boolean(enclosing(lineState, name)))])),
    paragraph: same((line) => line.heading ? `h${line.heading.trim().length}` : 'body'),
    bullet: lines.every((line) => /^[-+*] $/.test(line.list)),
    ordered: lines.every((line) => /^\d+[.)] $/.test(line.list)),
    task: lines.every((line) => /\[[ xX]\]/.test(line.list)),
    quote: lines.every((line) => Boolean(line.quote)),
    link: Boolean(linkAtSelection(state)),
  };
}

function transaction(state, changes, selection) {
  const changeSet = state.changes((Array.isArray(changes) ? changes : [changes]).map((change) => ({
    ...change, insert: Text.of(change.insert.split('\n')),
  })));
  return {
    changes: changeSet,
    selection: selection || state.selection.map(changeSet, 1),
    annotations: isolateHistory.of('full'), userEvent: 'input.format', scrollIntoView: true,
  };
}

const selectionFor = (range, from, to) => EditorSelection.single(
  range.anchor <= range.head ? from : to, range.anchor <= range.head ? to : from,
);
function wrap(text, marker) {
  const leading = /^\s*/.exec(text)[0];
  const trailing = /\s*$/.exec(text)[0];
  const content = text.slice(leading.length, text.length - trailing.length);
  return content ? leading + marker + content + marker + trailing : text;
}

function inlineTransaction(state, action) {
  const range = state.selection.main;
  const [name, defaultMarker, starter] = inline[action];
  const existing = enclosing(state, name);
  if (!existing && selectedLines(state).length > 1) {
    const lines = inlineLineStates(state);
    const remove = lines.every((lineState) => enclosing(lineState, name));
    const changes = [];
    for (const lineState of lines) {
      if (!remove && enclosing(lineState, name)) continue;
      const spec = inlineTransaction(lineState, action);
      spec?.changes.iterChanges((from, to, _fromB, _toB, insert) => changes.push({ from, to, insert: insert.toString() }));
    }
    if (!changes.length) return null;
    const spec = transaction(state, changes);
    spec.selection = selectionFor(range, spec.changes.mapPos(range.from, -1), spec.changes.mapPos(range.to, 1));
    return spec;
  }
  if (existing) {
    let from = existing.firstChild.to;
    let to = existing.lastChild.from;
    const marker = state.sliceDoc(existing.from, from);
    if (action === 'code' && /^ .+ $/.test(state.sliceDoc(from, to)) && state.sliceDoc(from, to).trim()) { from++; to--; }
    // A caret toggles the containing span; a partial selection preserves the
    // surrounding words' formatting. Only this source span is rewritten.
    const start = range.empty ? from : Math.max(from, range.from);
    const end = range.empty ? to : Math.min(to, range.to);
    const before = wrap(state.doc.sliceString(from, start, '\n'), marker);
    const middle = state.doc.sliceString(start, end, '\n');
    const insert = before + middle + wrap(state.doc.sliceString(end, to, '\n'), marker);
    const anchor = existing.from + before.length;
    const selected = range.empty
      ? EditorSelection.single(existing.from + Math.max(0, Math.min(to - from, range.head - from)))
      : selectionFor(range, anchor, anchor + middle.length);
    return transaction(state, { from: existing.from, to: existing.to, insert }, selected);
  }
  let replaceFrom = range.from;
  let replaceTo = range.to;
  const marks = [];
  if (!range.empty && action !== 'code') {
    const tree = ensureSyntaxTree(state, range.to, 40);
    // If a selection starts/ends inside an existing span, that span's outside
    // words already have this format. Include it when merging markers without
    // broadening the user's visible selection.
    tree?.iterate({ from: range.from, to: range.to, enter(node) {
      if (node.name === name && overlaps(range, node.from, node.to)) {
        replaceFrom = Math.min(replaceFrom, node.from);
        replaceTo = Math.max(replaceTo, node.to);
      }
    } });
    tree?.iterate({ from: replaceFrom, to: replaceTo, enter(node) {
      if (node.name === name && node.from >= replaceFrom && node.to <= replaceTo) {
        marks.push([node.from, node.node.firstChild.to], [node.node.lastChild.from, node.to]);
      }
    } });
  }
  let content = range.empty ? starter : state.doc.sliceString(replaceFrom, replaceTo, '\n');
  for (const [from, to] of marks.sort((a, b) => b[0] - a[0])) content = content.slice(0, from - replaceFrom) + content.slice(to - replaceFrom);
  let marker = defaultMarker;
  if (action === 'code') {
    marker = '`'.repeat(Math.max(0, ...[...content.matchAll(/`+/g)].map((m) => m[0].length)) + 1);
  }
  const insert = content.split('\n').map((line) => {
    if (action === 'code' && /^`|`$/.test(line)) return `${marker} ${line} ${marker}`;
    return wrap(line, marker);
  }).join('\n');
  if (insert === content) return null;
  const leading = /^\s*/.exec(content)[0].length;
  const mapContent = (position) => position - replaceFrom - marks.reduce((sum, [from, to]) => sum + Math.max(0, Math.min(position, to) - from), 0);
  const start = range.empty ? leading : Math.max(leading, mapContent(range.from));
  const end = range.empty ? content.trimEnd().length : Math.min(content.trimEnd().length, mapContent(range.to));
  const padding = action === 'code' && /^`|`$/.test(content) ? 1 : 0;
  const from = replaceFrom + start + marker.length + padding;
  const to = replaceFrom + end + marker.length + padding;
  return transaction(state, { from: replaceFrom, to: replaceTo, insert }, selectionFor(range, from, to));
}

function blockTransaction(state, action) {
  const lines = selectedLines(state);
  const active = formattingState(state)[action];
  let number = 0;
  const changes = lines.filter((line) => line.text.trim() || lines.length === 1).map((line) => {
    const p = prefixes(line.text);
    if (action === 'body' || /^h[123]$/.test(action)) {
      return { from: line.from + p.headingFrom, to: line.from + p.headingFrom + p.heading.length, insert: action === 'body' ? '' : '#'.repeat(Number(action[1])) + ' ' };
    }
    if (action === 'quote') {
      return { from: line.from + p.indent.length, to: line.from + p.indent.length + (active ? /^> ?/.exec(p.quote)[0].length : 0), insert: active ? '' : '> ' };
    }
    const marker = { bullet: '- ', ordered: `${++number}. `, task: '- [ ] ' }[action];
    return { from: line.from + p.listFrom, to: line.from + p.listFrom + p.list.length, insert: active ? '' : marker };
  });
  return changes.length ? transaction(state, changes) : null;
}

function safeLinkUrl(value) {
  const url = value.trim();
  if (/[\u0000-\u0020\u007f]/.test(url.replaceAll(' ', '')) || !/^(https?:\/\/|mailto:)/i.test(url)) {
    throw new Error('请输入完整的 http、https 或 mailto 链接地址');
  }
  try { new URL(url); } catch { throw new Error('网址格式不正确，请检查链接地址'); }
  return url.replaceAll(' ', '%20').replaceAll('<', '%3C').replaceAll('>', '%3E');
}

export function formatTransaction(state, action, payload = {}) {
  if (!formattingAllowed(state, action)) return null;
  if (inline[action]) return inlineTransaction(state, action);
  if (['body', 'h1', 'h2', 'h3', 'bullet', 'ordered', 'task', 'quote'].includes(action)) return blockTransaction(state, action);
  const range = state.selection.main;
  if (action === 'link' || action === 'unlink') {
    const existing = linkAtSelection(state);
    if (action === 'unlink' && !existing) return null;
    const from = existing?.from ?? range.from;
    const to = existing?.to ?? range.to;
    const rawText = payload.text || existing?.text || state.sliceDoc(range.from, range.to) || '链接文字';
    if (/[\r\n]/.test(rawText)) throw new Error('链接文字请使用单行文本');
    const label = rawText.replace(/[\\[\]*_`~]/g, '\\$&');
    const insert = action === 'unlink' ? existing.sourceText : `[${label}](<${safeLinkUrl(payload.url || '')}>)`;
    return transaction(state, { from, to, insert }, selectionFor(range, from + (action === 'link' ? 1 : 0), from + (action === 'link' ? 1 + label.length : insert.length)));
  }
  if (action === 'divider') {
    const end = state.doc.lineAt(range.to).to;
    const insert = `${end ? '\n\n' : ''}---\n${end < state.doc.length ? '' : '\n'}`;
    return transaction(state, { from: end, insert }, EditorSelection.single(end + insert.length));
  }
  return null;
}
