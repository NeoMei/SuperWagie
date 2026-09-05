import { syntaxTree } from '@codemirror/language';
import { EditorSelection, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { safePreview } from './safe-preview.mjs';

// Decorations change presentation only. All positions address the original
// CodeMirror document; no rendered DOM is serialized back into Markdown.
const composition = StateEffect.define();
const hide = Decoration.replace({ inclusive: false });
const intersects = (ranges, from, to) => ranges.some((range) => (
  range.empty ? range.head >= from && range.head <= to : range.from <= to && range.to >= from
));

class MarkerWidget extends WidgetType {
  constructor(text, kind) { super(); this.text = text; this.kind = kind; }
  eq(other) { return this.text === other.text && this.kind === other.kind; }
  toDOM() {
    const span = document.createElement('span');
    span.className = `sw-md-${this.kind}`;
    span.textContent = this.text;
    span.setAttribute('aria-hidden', 'true');
    return span;
  }
  ignoreEvent() { return false; }
}

class TaskWidget extends WidgetType {
  constructor(from, checked) { super(); this.from = from; this.checked = checked; }
  eq(other) { return this.from === other.from && this.checked === other.checked; }
  toDOM(view) {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'sw-md-task';
    input.checked = this.checked;
    input.setAttribute('aria-label', this.checked ? '标记为未完成' : '标记为完成');
    input.addEventListener('mousedown', (event) => event.preventDefault());
    input.addEventListener('click', (event) => {
      event.preventDefault();
      if (view.state.readOnly) return;
      const marker = view.state.sliceDoc(this.from, this.from + 3);
      if (!/^\[[ xX]\]$/.test(marker)) return;
      view.dispatch({
        changes: { from: this.from + 1, to: this.from + 2, insert: this.checked ? ' ' : 'x' },
        userEvent: 'input',
      });
    });
    return input;
  }
}

class BlockWidget extends WidgetType {
  constructor(from, source, kind, cells = []) {
    super(); Object.assign(this, { from, source, kind, cells });
  }
  eq(other) { return this.from === other.from && this.source === other.source && this.kind === other.kind; }
  toDOM(view) {
    const block = document.createElement('div');
    block.className = `sw-md-block sw-md-${this.kind}`;
    block.innerHTML = safePreview(this.source);
    block.setAttribute('aria-label', this.kind === 'table' ? '表格，点击编辑' : '文档属性，点击编辑');
    block.querySelectorAll('th, td').forEach((cell, index) => {
      if (this.cells[index]) cell.dataset.sourceOffset = String(this.cells[index].from);
    });
    block.addEventListener('mousedown', (event) => {
      if (event.button !== 0 || event.shiftKey) return;
      event.preventDefault();
      const cell = event.target.closest('[data-source-offset]');
      let anchor = cell ? Number(cell.dataset.sourceOffset) : this.from;
      // Keep the click's text offset when a rendered table cell unfolds.
      const caret = document.caretRangeFromPoint?.(event.clientX, event.clientY);
      if (cell && caret && cell.contains(caret.startContainer)) {
        const prefix = document.createRange();
        prefix.selectNodeContents(cell);
        prefix.setEnd(caret.startContainer, caret.startOffset);
        anchor += prefix.toString().length;
      }
      view.dispatch({ selection: { anchor: Math.min(anchor, this.from + this.source.length) } });
      view.focus();
    });
    return block;
  }
  ignoreEvent() { return true; }
}

function decorate(state, composing) {
  const doc = state.doc;
  const ranges = state.selection.ranges;
  const decorations = [];
  const replaced = [];
  const active = (from, to) => intersects(ranges, from, to);
  const addMark = (from, to, name) => {
    if (from < to) decorations.push(Decoration.mark({ class: `sw-md-${name}` }).range(from, to));
  };
  const replace = (from, to, widget, block = false) => {
    if (from < to) decorations.push((widget ? Decoration.replace({ widget, block, inclusive: block }) : hide).range(from, to));
  };
  const lineStyle = (line, name) => decorations.push(Decoration.line({ class: `sw-md-${name}` }).range(line.from));
  const activeLine = (line) => active(line.from, line.to);
  const protectedComposition = (from, to) => composing && ranges.some((r) => (
    doc.lineAt(r.head).from <= to && doc.lineAt(r.head).to >= from
  ));
  const reveal = (from, to) => active(from, to) || protectedComposition(from, to);
  const text = doc.toString();
  const frontmatter = /^---\n[\s\S]*?\n---(?=\n|$)/.exec(text);
  if (frontmatter) {
    const end = frontmatter[0].length;
    replaced.push({ from: 0, to: end });
    if (!reveal(0, end)) replace(0, end, new BlockWidget(0, frontmatter[0], 'properties'), true);
    else for (let n = 1; n <= doc.lineAt(end).number; n++) lineStyle(doc.line(n), 'frontmatter');
  }

  const tree = syntaxTree(state);
  // Obsidian extensions are recognized only in prose, never inside code/HTML.
  const prose = [];
  tree.iterate({ enter(ref) {
    const node = ref.node;
    const { from, to, name } = node;
    if (replaced.some((r) => from >= r.from && to <= r.to)) return false;
    if (name === 'FencedCode' || name === 'CodeBlock') {
      const editing = reveal(from, to);
      for (let n = doc.lineAt(from).number; n <= doc.lineAt(to).number; n++) {
        const line = doc.line(n);
        lineStyle(line, 'code-line');
      }
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (!editing && ['CodeMark', 'CodeInfo'].includes(child.name)) replace(child.from, child.to);
      }
      return false;
    }
    if (name === 'HTMLBlock' || name === 'HTMLTag' || name === 'CommentBlock') return false;
    if (name === 'Table') {
      if (!reveal(from, to)) {
        const cells = [];
        const cursor = node.cursor();
        do { if (cursor.name === 'TableCell') cells.push({ from: cursor.from, to: cursor.to }); } while (cursor.next());
        replace(from, to, new BlockWidget(from, state.sliceDoc(from, to), 'table', cells), true);
        return false;
      }
    }
    if (/^(Paragraph|ATXHeading\d|SetextHeading\d|TableCell)$/.test(name)) prose.push({ from, to });
    const heading = /^(?:ATX|Setext)Heading(\d)$/.exec(name);
    if (heading) {
      lineStyle(doc.lineAt(from), `h${heading[1]}`);
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.name === 'HeaderMark' && !reveal(from, to)) {
          const line = doc.lineAt(child.from);
          replace(child.from, Math.min(line.to, child.to + (text[child.to] === ' ' ? 1 : 0)));
        }
      }
    }
    const inline = { StrongEmphasis: 'strong', Emphasis: 'em', Strikethrough: 'strike', InlineCode: 'inline-code' }[name];
    if (inline) {
      addMark(from, to, inline);
      if (!reveal(from, to)) {
        for (let child = node.firstChild; child; child = child.nextSibling) {
          if (/^(EmphasisMark|StrikethroughMark|CodeMark)$/.test(child.name)) replace(child.from, child.to);
        }
      }
      if (name === 'InlineCode') return false;
    }
    if (name === 'Link' && text.slice(from, from + 2) !== '[[' && text[from - 1] !== '[') {
      const children = [];
      for (let child = node.firstChild; child; child = child.nextSibling) children.push(child);
      const url = children.find((c) => c.name === 'URL');
      if (url) {
        const labelEnd = children.find((c) => c.name === 'LinkMark' && text[c.from] === ']');
        if (labelEnd) {
          addMark(from + 1, labelEnd.from, 'link');
          if (!reveal(from, to)) { replace(from, from + 1); replace(labelEnd.from, to); }
        }
      }
    }
    if (name === 'ListMark') {
      const line = doc.lineAt(from);
      if (!activeLine(line) && !protectedComposition(from, to) && /^[-+*]$/.test(state.sliceDoc(from, to))) {
        replace(from, to, new MarkerWidget('•', 'bullet'));
      }
    }
    if (name === 'TaskMarker' && !reveal(from, to)) replace(from, to, new TaskWidget(from, /[xX]/.test(state.sliceDoc(from, to))));
    if (name === 'QuoteMark') {
      const line = doc.lineAt(from);
      lineStyle(line, 'quote');
      if (!activeLine(line)) replace(from, Math.min(to + 1, line.to));
    }
    if (name === 'HorizontalRule' && !reveal(from, to)) replace(from, to, new MarkerWidget(' ', 'rule'));
  }});

  const seen = new Set();
  for (const range of prose) {
    const source = text.slice(range.from, range.to);
    for (const match of source.matchAll(/\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]|==([^=\n]+)==/g)) {
      const from = range.from + match.index;
      const to = from + match[0].length;
      if (seen.has(from)) continue;
      seen.add(from);
      let ancestor = tree.resolveInner(from, 1);
      let isCode = false;
      for (; ancestor; ancestor = ancestor.parent) if (/^(InlineCode|FencedCode|CodeBlock|HTMLTag)$/.test(ancestor.name)) isCode = true;
      if (isCode || text[from - 1] === '\\') continue;
      const start = match[3] ? from + 2 : match[2] ? from + match[0].indexOf('|') + 1 : from + 2;
      addMark(start, to - 2, match[3] ? 'highlight' : 'wikilink');
      if (!reveal(from, to)) { replace(from, start); replace(to - 2, to); }
    }
  }
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    const callout = /^(\s*>\s*)\[!([\w-]+)\][+-]?\s*/.exec(line.text);
    if (!callout) continue;
    let ancestor = tree.resolveInner(line.from + callout[1].length, 1);
    let isQuote = false;
    for (; ancestor; ancestor = ancestor.parent) if (ancestor.name === 'Blockquote') isQuote = true;
    if (!isQuote) continue;
    lineStyle(line, 'callout-title');
    if (!activeLine(line)) {
      const from = line.from + callout[1].length;
      replace(from, line.from + callout[0].length, new MarkerWidget(`${callout[2]}  `, 'callout-label'));
    }
  }
  return Decoration.set(decorations, true);
}

const previewState = StateField.define({
  create(state) { return { composing: false, decorations: decorate(state, false) }; },
  update(value, transaction) {
    let composing = value.composing;
    for (const effect of transaction.effects) if (effect.is(composition)) composing = effect.value;
    if (transaction.docChanged || transaction.selection || composing !== value.composing
      || syntaxTree(transaction.startState) !== syntaxTree(transaction.state)) {
      return { composing, decorations: decorate(transaction.state, composing) };
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

function mouseSelection(view, startEvent) {
  if (startEvent.button !== 0 || view.composing) return null;
  const position = (event) => {
    const caret = view.dom.ownerDocument.caretRangeFromPoint?.(event.clientX, event.clientY);
    if (caret && view.contentDOM.contains(caret.startContainer)) {
      return view.posAtDOM(caret.startContainer, caret.startOffset);
    }
    return view.posAtCoords({ x: event.clientX, y: event.clientY });
  };
  let start = position(startEvent);
  if (start == null) return null;
  let original = view.state.selection;
  const unit = (pos) => startEvent.detail >= 3
    ? view.state.doc.lineAt(pos)
    : startEvent.detail === 2 ? view.state.wordAt(pos) : null;
  return {
    get(event, extend, multiple) {
      // Resolve the initial click against the DOM before revealing markers.
      // Reusing that source position prevents mouseup from chasing shifted text.
      const head = event.clientX === startEvent.clientX && event.clientY === startEvent.clientY
        ? start : position(event) ?? start;
      const first = unit(start), last = unit(head);
      const anchor = extend ? original.main.anchor : first ? (head < start ? first.to : first.from) : start;
      const end = last ? (head < start ? last.from : last.to) : head;
      const range = EditorSelection.range(anchor, end);
      return multiple ? original.addRange(range) : EditorSelection.create([range]);
    },
    update(update) {
      if (update.docChanged) { start = update.changes.mapPos(start); original = original.map(update.changes); }
    },
  };
}

export function livePreview() {
  return [previewState, EditorView.editorAttributes.of({ class: 'sw-live-preview' }),
    EditorView.mouseSelectionStyle.of(mouseSelection),
    EditorView.domEventHandlers({
      compositionstart(_event, view) { view.dispatch({ effects: composition.of(true) }); },
      compositionend(_event, view) {
        // Reconcile after CodeMirror commits the browser's composition DOM.
        queueMicrotask(() => { if (view.dom.isConnected) view.dispatch({ effects: composition.of(false) }); });
      },
    }),
  ];
}
