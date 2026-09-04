import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { Compartment, EditorState } from '@codemirror/state';
import { Decoration, EditorView, keymap, ViewPlugin, WidgetType } from '@codemirror/view';
import DOMPurify from 'dompurify';
import { createDocumentSwitchCoordinator, createDraftSaveQueue } from './document-switch.mjs';
import { buildDocumentIndex, renderMarkdown, resolveWikiTarget, resolveWorkspaceReference } from './markdown-model.mjs';

const bridge = window.superwagieWorkspace;
const editorHost = document.querySelector('#editor');
const readingHost = document.querySelector('#reading');
const status = document.querySelector('#save-status');
const conflict = document.querySelector('#conflict');
const liveProperties = document.querySelector('#live-properties');
const modeCompartment = new Compartment();
let currentPath = '';
let currentRevision = '';
let mode = 'live';
let externalChanged = false;
let saveTimer = null;
let draftSaves = null;
let compositionStartCount = 0;
let compositionEndCount = 0;
let readingGeneration = 0;

class WikiLinkWidget extends WidgetType {
  constructor(raw, embed) { super(); this.raw = raw; this.embed = embed; }
  eq(other) { return other.raw === this.raw && other.embed === this.embed; }
  toDOM() {
    const target = resolveWikiTarget(this.raw);
    const element = document.createElement(this.embed ? 'span' : 'a');
    element.className = this.embed ? 'cm-live-embed' : 'cm-live-wikilink';
    element.textContent = this.embed ? `▧ ${target.label}` : target.label;
    if (!this.embed) {
      element.href = '#';
      element.addEventListener('click', (event) => {
        event.preventDefault();
        open(resolveWorkspaceReference(currentPath, target.path)).catch(showError);
      });
    }
    return element;
  }
  ignoreEvent() { return false; }
}

function liveDecorations(view) {
  const ranges = [];
  const selectedLine = view.state.doc.lineAt(view.state.selection.main.head).number;
  let frontmatterEnd = 0;
  if (view.state.doc.line(1).text === '---') {
    for (let number = 2; number <= view.state.doc.lines; number += 1) {
      if (view.state.doc.line(number).text === '---') { frontmatterEnd = number; break; }
    }
  }
  for (let number = 1; number <= view.state.doc.lines; number += 1) {
    const line = view.state.doc.line(number);
    const text = line.text;
    if (frontmatterEnd && number <= frontmatterEnd) {
      ranges.push(Decoration.line({ class: 'cm-live-frontmatter' }).range(line.from));
      continue;
    }
    const heading = text.match(/^(#{1,6})\s/);
    if (heading) ranges.push(Decoration.line({ class: `cm-live-heading-${Math.min(heading[1].length, 2)}` }).range(line.from));
    if (/^> \[!/.test(text)) ranges.push(Decoration.line({ class: 'cm-live-callout' }).range(line.from));
    if (/^- \[x\]/i.test(text)) ranges.push(Decoration.line({ class: 'cm-live-task-done' }).range(line.from));
    if (number !== selectedLine) {
      if (heading) ranges.push(Decoration.replace({}).range(line.from, line.from + heading[0].length));
      for (const match of text.matchAll(/(!?)\[\[([^\]]+)\]\]/g)) {
        ranges.push(Decoration.replace({ widget: new WikiLinkWidget(match[2], match[1] === '!') }).range(line.from + match.index, line.from + match.index + match[0].length));
      }
      for (const match of text.matchAll(/\*\*([^*]+)\*\*/g)) {
        const start = line.from + match.index;
        ranges.push(Decoration.replace({}).range(start, start + 2));
        ranges.push(Decoration.mark({ class: 'cm-live-strong' }).range(start + 2, start + match[0].length - 2));
        ranges.push(Decoration.replace({}).range(start + match[0].length - 2, start + match[0].length));
      }
      for (const match of text.matchAll(/(?<!\*)\*([^*]+)\*(?!\*)/g)) {
        const start = line.from + match.index;
        ranges.push(Decoration.replace({}).range(start, start + 1));
        ranges.push(Decoration.mark({ class: 'cm-live-em' }).range(start + 1, start + match[0].length - 1));
        ranges.push(Decoration.replace({}).range(start + match[0].length - 1, start + match[0].length));
      }
      for (const match of text.matchAll(/`([^`]+)`/g)) {
        const start = line.from + match.index;
        ranges.push(Decoration.replace({}).range(start, start + 1));
        ranges.push(Decoration.mark({ class: 'cm-live-code' }).range(start + 1, start + match[0].length - 1));
        ranges.push(Decoration.replace({}).range(start + match[0].length - 1, start + match[0].length));
      }
    }
  }
  return Decoration.set(ranges, true);
}

const livePreview = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = liveDecorations(view); }
  update(update) { if (update.docChanged || update.selectionSet || update.viewportChanged) this.decorations = liveDecorations(update.view); }
}, { decorations: (value) => value.decorations });

const editor = new EditorView({
  state: EditorState.create({
    doc: '',
    extensions: [
      markdown(),
      history(),
      syntaxHighlighting(defaultHighlightStyle),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      EditorView.lineWrapping,
      modeCompartment.of(livePreview),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        draftSaves.markChanged();
        externalChanged = false;
        conflict.hidden = true;
        status.textContent = '正在保存…';
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => save().catch(showError), 450);
      }),
    ],
  }),
  parent: editorHost,
});
editor.contentDOM.addEventListener('compositionstart', () => { compositionStartCount += 1; });
editor.contentDOM.addEventListener('compositionend', () => { compositionEndCount += 1; });

draftSaves = createDraftSaveQueue({
  captureDraft: () => ({
    path: currentPath,
    content: editor.state.doc.toString(),
    expectedRevision: currentRevision,
  }),
  persistDraft: (draft) => bridge.writeText(draft),
  onPersisted: async ({ result, current }) => {
    currentRevision = result.revision;
    status.textContent = current ? '已保存' : '正在保存…';
    if (current) await updateReading();
  },
  onConflict: () => {
    externalChanged = true;
    conflict.hidden = false;
    status.textContent = '存在外部修改';
  },
});

function referencedPath(path) { return resolveWorkspaceReference(currentPath, path); }
function assetUrl(path) { return `superwagie-asset://file/${encodeURIComponent(referencedPath(path))}`; }
async function readOptional(path) {
  try { return (await bridge.readText(referencedPath(path))).content; } catch { return null; }
}
async function updateReading() {
  const generation = ++readingGeneration;
  const source = editor.state.doc.toString();
  const html = await renderMarkdown(source, { readText: readOptional, assetUrl });
  if (generation !== readingGeneration) return;
  readingHost.innerHTML = DOMPurify.sanitize(html, {
    ADD_ATTR: ['data-wikilink', 'data-heading', 'data-block', 'data-source-frontmatter', 'data-source'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|superwagie-asset):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
  });
  readingHost.querySelectorAll('[data-wikilink]').forEach((link) => link.addEventListener('click', (event) => {
    event.preventDefault();
    open(referencedPath(link.dataset.wikilink)).catch(showError);
  }));
}
function updateChrome(path) {
  document.querySelector('#tab-name').textContent = path;
  document.querySelector('#document-path').textContent = path;
  document.querySelectorAll('.file').forEach((file) => file.classList.toggle('active', file.dataset.open === path));
  const heading = editor.state.doc.toString().match(/^#\s+(.+)$/m);
  document.querySelector('#document-title').textContent = heading?.[1] || path.replace(/\.md$/, '');
}
function updateProperties() {
  const properties = buildDocumentIndex(editor.state.doc.toString()).properties;
  liveProperties.replaceChildren(...Object.entries(properties).map(([key, value]) => {
    const row = document.createElement('div');
    row.className = 'live-property';
    const label = document.createElement('span');
    label.textContent = key;
    const content = document.createElement('strong');
    content.textContent = Array.isArray(value) ? value.join(', ') : value;
    row.append(label, content);
    return row;
  }));
  liveProperties.hidden = Object.keys(properties).length === 0;
}
const switchDocument = createDocumentSwitchCoordinator({
  hasPendingChanges: draftSaves.isDirty,
  persistPending: save,
  getChangeGeneration: draftSaves.generation,
  loadTarget: (path) => bridge.readText(path),
  applyTarget: async (path, loaded) => {
  currentPath = path;
  currentRevision = loaded.revision;
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: loaded.content } });
  draftSaves.markClean();
  externalChanged = false;
  conflict.hidden = true;
  status.textContent = '已保存';
  updateChrome(path);
  updateProperties();
  await updateReading();
  },
});
async function open(path) {
  if (!path.endsWith('.md')) return false;
  clearTimeout(saveTimer);
  return switchDocument(path);
}
async function save() {
  clearTimeout(saveTimer);
  return draftSaves.save();
}
async function setMode(nextMode) {
  mode = nextMode;
  document.body.dataset.mode = mode;
  readingHost.hidden = mode !== 'reading';
  editorHost.hidden = mode === 'reading';
  liveProperties.hidden = mode !== 'live' || Object.keys(buildDocumentIndex(editor.state.doc.toString()).properties).length === 0;
  document.querySelectorAll('[data-mode]').forEach((button) => button.setAttribute('aria-selected', String(button.dataset.mode === mode)));
  editor.dispatch({ effects: modeCompartment.reconfigure(mode === 'live' ? livePreview : []) });
  if (mode === 'reading') await updateReading();
}
function showError(error) { status.textContent = `错误：${error?.message || error}`; }

document.querySelectorAll('.mode-switch button').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.mode).catch(showError)));
document.querySelectorAll('.file[data-open$=".md"]').forEach((button) => button.addEventListener('click', () => open(button.dataset.open).catch(showError)));
bridge.onFileChanged(({ path, revision }) => {
  if (path !== currentPath || revision === currentRevision) return;
  externalChanged = true;
  conflict.hidden = false;
  status.textContent = '检测到外部修改';
});

const boot = await bridge.boot();
readingHost.hidden = true;
editorHost.hidden = false;
await open(boot.initialFile);
window.__superwagieTest = Object.freeze({
  snapshot: () => ({
    path: currentPath,
    content: editor.state.doc.toString(),
    mode,
    dirty: draftSaves.isDirty(),
    externalChanged,
    codeMirror6: Boolean(editor.dom.querySelector('.cm-content')),
    sandbox: boot.sandbox,
  }),
  setMode,
  open,
  save,
  append: (text) => editor.dispatch({ changes: { from: editor.state.doc.length, insert: text } }),
  compose: (text) => {
    editor.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    editor.dispatch({ changes: { from: editor.state.doc.length, insert: text }, selection: { anchor: editor.state.doc.length + text.length } });
    editor.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { data: text }));
    return { compositionEvents: compositionStartCount + compositionEndCount, textPresent: editor.state.doc.toString().includes(text.trim()) };
  },
  openFirstWikiLink: async () => {
    const link = readingHost.querySelector('[data-wikilink]');
    return link ? open(referencedPath(link.dataset.wikilink)) : false;
  },
});
window.__SUPERWAGIE_READY__ = true;
