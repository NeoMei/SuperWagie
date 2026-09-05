import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import DOMPurify from 'dompurify';

import { createDraftSaveQueue } from './document-switch.mjs';
import { renderMarkdown } from './markdown-model.mjs';

const trustedPolicy = globalThis.trustedTypes?.createPolicy('superwagie-markdown', {
  createHTML: (value) => value,
});

function safePreview(source) {
  const sanitized = DOMPurify.sanitize(renderMarkdown(source, (value) => value), {
    ALLOWED_TAGS: ['a', 'aside', 'blockquote', 'br', 'button', 'code', 'div', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'li', 'ol', 'p', 'pre', 'section', 'span', 'strong', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul'],
    ALLOWED_ATTR: ['aria-label', 'class', 'data-callout', 'data-wikilink', 'href', 'role', 'type'],
    ALLOW_DATA_ATTR: true,
  });
  return trustedPolicy ? trustedPolicy.createHTML(sanitized) : sanitized;
}

export function createEditorHost({
  element,
  previewElement,
  readDocument,
  saveDraft,
  onStatus = () => {},
  onDocument = () => {},
}) {
  let current = null;
  let saveQueue = null;
  let debounceTimer;
  let openGeneration = 0;
  let mode = 'edit';

  const updatePreview = () => {
    previewElement.innerHTML = safePreview(view.state.doc.toString());
  };

  const persist = async (content, generation) => {
    if (!current) return { ok: true };
    onStatus({ status: 'saving', label: '保存中…' });
    try {
      const result = await saveDraft({
        documentId: current.documentId,
        baseRevision: current.revision,
        content,
        changeGeneration: generation,
      });
      if (result.status === 'conflict') {
        current.conflictId = result.conflict_id;
        current.draftHandleId = result.draft_handle_id;
        onStatus({ status: 'conflict', label: '检测到外部修改', conflictId: result.conflict_id });
        return { ok: false, code: 'SW_WORKSPACE_REVISION_CONFLICT', ...result };
      }
      current.revision = result.revision;
      current.conflictId = null;
      current.draftHandleId = null;
      onStatus({ status: 'saved', label: '已保存' });
      return { ok: true, ...result };
    } catch (error) {
      onStatus({ status: 'recovery_pending', label: '已保留恢复点', error: error.message });
      return { ok: false, code: error.message };
    }
  };

  const createQueue = () => createDraftSaveQueue({
    captureDraft: () => view.state.doc.toString(),
    persistDraft: persist,
  });

  const extensions = [
    lineNumbers(),
    history(),
    markdown(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    EditorView.lineWrapping,
    EditorView.updateListener.of((update) => {
      if (!update.docChanged || !current) return;
      updatePreview();
      saveQueue.markChanged();
      onStatus({ status: 'draft_pending', label: '草稿待持久化' });
      clearTimeout(debounceTimer);
      if (!update.view.composing) {
        debounceTimer = setTimeout(() => saveQueue.save(), 180);
      }
    }),
  ];

  const view = new EditorView({
    state: EditorState.create({ doc: '', extensions }),
    parent: element,
  });

  function applyLoaded(loaded) {
    current = {
      documentId: loaded.document_id,
      fileIdentity: loaded.file_identity,
      logicalPath: loaded.logical_path,
      revision: loaded.revision,
      conflictId: null,
      draftHandleId: null,
    };
    view.setState(EditorState.create({ doc: loaded.content, extensions }));
    saveQueue = createQueue();
    updatePreview();
    onDocument({ ...current });
    onStatus({ status: 'saved', label: '已保存' });
  }

  async function open(documentId) {
    const requested = ++openGeneration;
    if (saveQueue?.isDirty()) {
      const result = await saveQueue.save();
      if (!result?.ok || requested !== openGeneration) return false;
    }
    const loaded = await readDocument(documentId);
    if (requested !== openGeneration) return false;
    applyLoaded(loaded);
    return true;
  }

  async function flush() {
    clearTimeout(debounceTimer);
    if (!saveQueue?.isDirty()) return { ok: true, unchanged: true };
    return saveQueue.save();
  }

  async function refreshIfClean() {
    if (!current || saveQueue?.isDirty() || current.conflictId) return false;
    const latest = await readDocument(current.documentId);
    if (latest.revision === current.revision) return false;
    return open(current.documentId);
  }

  function setMode(nextMode) {
    if (!['edit', 'split', 'preview'].includes(nextMode)) return;
    mode = nextMode;
    element.parentElement.dataset.mode = mode;
    if (mode !== 'edit') updatePreview();
    if (mode !== 'preview') view.focus();
  }

  return Object.freeze({
    open,
    flush,
    refreshIfClean,
    applyLoaded,
    async close() {
      const result = await flush();
      if (!result?.ok) return false;
      current = null;
      saveQueue = null;
      view.setState(EditorState.create({ doc: '', extensions }));
      previewElement.replaceChildren();
      onDocument(null);
      onStatus({ status: 'idle', label: '等待打开文件' });
      return true;
    },
    setMode,
    mode: () => mode,
    current: () => current && { ...current },
    content: () => view.state.doc.toString(),
    isDirty: () => Boolean(saveQueue?.isDirty()),
    focus: () => view.focus(),
    replaceContent(content) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
    },
    destroy() {
      clearTimeout(debounceTimer);
      view.destroy();
    },
  });
}
