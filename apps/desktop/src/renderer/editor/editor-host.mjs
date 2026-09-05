import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';

import { createDraftSaveQueue } from './document-switch.mjs';
import { safePreview } from './safe-preview.mjs';
import { livePreview } from './live-preview.mjs';

export function createEditorHost({
  element,
  previewElement,
  readDocument,
  saveDraft,
  onStatus = () => {},
  onDocument = () => {},
  onMode = () => {},
}) {
  let current = null;
  let saveQueue = null;
  let debounceTimer;
  let openGeneration = 0;
  let mode = 'live';
  let editingMode = 'live';
  const presentation = new Compartment();
  const modeExtensions = () => mode === 'source' ? lineNumbers() : livePreview();

  const updatePreview = () => {
    previewElement.innerHTML = safePreview(view.state.sliceDoc());
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
    captureDraft: () => view.state.sliceDoc(),
    persistDraft: persist,
  });

  const extensions = [
    presentation.of(modeExtensions()),
    history(),
    markdown({ base: markdownLanguage }),
    keymap.of([{ key: 'Mod-e', run() { setMode(mode === 'reading' ? editingMode : 'reading'); return true; } }, ...defaultKeymap, ...historyKeymap]),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ 'aria-label': 'Markdown 编辑器', 'aria-multiline': 'true' }),
    EditorView.domEventHandlers({
      compositionend() {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => { if (saveQueue?.isDirty()) saveQueue.save(); }, 180);
      },
    }),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged || !current) return;
      if (mode === 'reading') updatePreview();
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
  const readingShortcut = (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'e' && !event.isComposing) {
      event.preventDefault();
      setMode(editingMode);
    }
  };
  previewElement.addEventListener('keydown', readingShortcut);

  function applyLoaded(loaded) {
    current = {
      documentId: loaded.document_id,
      fileIdentity: loaded.file_identity,
      logicalPath: loaded.logical_path,
      revision: loaded.revision,
      conflictId: null,
      draftHandleId: null,
    };
    view.setState(EditorState.create({
      doc: loaded.content,
      extensions: [extensions, EditorState.lineSeparator.of(loaded.content.includes('\r\n') ? '\r\n' : '\n')],
    }));
    view.dispatch({ effects: presentation.reconfigure(modeExtensions()) });
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
    if (!['live', 'source', 'reading'].includes(nextMode)) return;
    mode = nextMode;
    if (mode !== 'reading') editingMode = mode;
    element.parentElement.dataset.mode = mode;
    view.dispatch({ effects: presentation.reconfigure(modeExtensions()) });
    if (mode === 'reading') { updatePreview(); previewElement.focus(); }
    else view.focus();
    onMode(mode);
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
    content: () => view.state.sliceDoc(),
    isDirty: () => Boolean(saveQueue?.isDirty()),
    focus: () => view.focus(),
    replaceContent(content) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
    },
    destroy() {
      clearTimeout(debounceTimer);
      previewElement.removeEventListener('keydown', readingShortcut);
      view.destroy();
    },
  });
}
