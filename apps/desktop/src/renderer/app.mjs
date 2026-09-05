import { createEditorHost } from './editor/editor-host.mjs';
import { renderDocumentTab } from './workspace/document-tabs.mjs';
import { renderFileExplorer } from './workspace/file-explorer.mjs';
import { showProjectEntry, showWorkspaceShell } from './workspace/project-shell.mjs';

const root = document.querySelector('#app');
let requestCounter = 0;
let project;
let shell;
let editorHost;
let treeEntries = [];
let pollTimer;

function requestId(label) {
  requestCounter += 1;
  return `request:${label}:${requestCounter}`;
}

function query(queryId, params) {
  return window.superwagie.query({
    protocol_version: 1,
    message_type: 'query.execute',
    request_id: requestId(queryId.replace('.', '-')),
    query_id: queryId,
    params,
  });
}

function intent(commandType, payload, permissions = []) {
  const now = new Date();
  return {
    protocol_version: 1,
    request_id: requestId(commandType.replace('.', '-')),
    command_type: commandType,
    resource_refs: [],
    requested_permissions: permissions,
    expected_revision: null,
    payload,
    issued_at: now.toISOString(),
    deadline_at: new Date(now.getTime() + 30_000).toISOString(),
  };
}

async function readDocument(documentId) {
  const snapshot = await query('document.snapshot', { document_id: documentId });
  const content = await window.superwagie.readResource(snapshot.payload.content_handle);
  return { ...snapshot.payload, content };
}

async function persistDraft({ documentId, baseRevision, content, changeGeneration }) {
  const staged = await window.superwagie.stageDraft({
    documentId, baseRevision, content, changeGeneration,
  });
  const result = await window.superwagie.command(intent('document.save', {
    document_id: documentId,
    base_revision: baseRevision,
    draft_handle_id: staged.draft_handle_id,
    change_generation: changeGeneration,
  }, ['workspace.write']));
  return { ...result, draft_handle_id: staged.draft_handle_id };
}

function updateDocumentMeta(documentState) {
  if (!documentState) {
    shell.meta.replaceChildren();
    const dt = document.createElement('dt');
    dt.textContent = '状态';
    const dd = document.createElement('dd');
    dd.textContent = '未打开';
    shell.meta.append(dt, dd);
    renderDocumentTab(shell.tabs, null, () => {});
    return;
  }
  renderDocumentTab(shell.tabs, documentState, closeCurrentTab);
  shell.meta.replaceChildren();
  for (const [label, value] of [
    ['路径', documentState.logicalPath],
    ['Document ID', documentState.documentId],
    ['Revision', `${documentState.revision.slice(0, 19)}…`],
  ]) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    shell.meta.append(dt, dd);
  }
}

function updateStatus(event) {
  if (!shell) return;
  shell.status.textContent = event.label;
  shell.status.dataset.status = event.status;
  shell.conflict.hidden = event.status !== 'conflict';
}

async function openEntry(entry) {
  const opened = await editorHost.open(entry.document_id);
  if (opened) {
    for (const button of shell.fileList.querySelectorAll('.file-entry')) {
      button.classList.toggle('active', button.dataset.documentId === entry.document_id);
    }
  }
}

async function closeCurrentTab() {
  if (await editorHost.close()) {
    for (const button of shell.fileList.querySelectorAll('.file-entry')) button.classList.remove('active');
  }
}

async function loadTree({ openFirst = false } = {}) {
  const snapshot = await query('workspace.tree', { project_id: project.project_id });
  treeEntries = snapshot.payload.items;
  renderFileExplorer(shell.fileList, treeEntries, openEntry);
  if (openFirst && treeEntries[0]) await openEntry(treeEntries[0]);
}

async function resolveConflict(action) {
  const current = editorHost.current();
  if (!current?.conflictId) return;
  const latest = await readDocument(current.documentId);
  let draftHandleId;
  if (action === 'keep_current') {
    draftHandleId = current.draftHandleId;
  } else if (action === 'merge') {
    const mergedContent = `${latest.content}\n\n<!-- SuperWagie 合并分隔 -->\n\n${editorHost.content()}`;
    const staged = await window.superwagie.stageDraft({
      documentId: current.documentId,
      baseRevision: latest.revision,
      content: mergedContent,
      changeGeneration: Date.now(),
    });
    draftHandleId = staged.draft_handle_id;
  }
  const payload = {
    conflict_id: current.conflictId,
    latest_revision: latest.revision,
    action,
    ...(draftHandleId ? { draft_handle_id: draftHandleId } : {}),
  };
  const result = await window.superwagie.command(intent('document.resolve_conflict', payload, ['workspace.write']));
  if (result.status === 'conflict') {
    updateStatus({ status: 'conflict', label: '磁盘再次变化，请重新确认' });
    return;
  }
  editorHost.applyLoaded(await readDocument(current.documentId));
}

function installShortcuts() {
  window.addEventListener('keydown', (event) => {
    if (!(event.metaKey || event.ctrlKey)) return;
    if (event.key.toLowerCase() === 'o') {
      event.preventDefault();
      shell.fileFilter.focus();
      shell.fileFilter.select();
    } else if (event.key.toLowerCase() === 'p') {
      event.preventDefault();
      shell.palette.hidden = !shell.palette.hidden;
      if (!shell.palette.hidden) shell.palette.querySelector('input').focus();
    } else if (event.key.toLowerCase() === 'w') {
      event.preventDefault();
      closeCurrentTab();
    }
  });
}

async function mountWorkspace(selectedProject) {
  project = selectedProject;
  shell = showWorkspaceShell(root);
  editorHost = createEditorHost({
    element: shell.editor,
    previewElement: shell.preview,
    readDocument,
    saveDraft: persistDraft,
    onStatus: updateStatus,
    onDocument: updateDocumentMeta,
  });
  shell.modeButtons.forEach((button) => button.addEventListener('click', () => {
    shell.modeButtons.forEach((candidate) => candidate.classList.toggle('active', candidate === button));
    editorHost.setMode(button.dataset.mode);
  }));
  shell.refreshTree.addEventListener('click', () => loadTree());
  shell.revokeProject.addEventListener('click', async () => {
    const checkpoint = await editorHost.flush();
    if (!checkpoint?.ok) return;
    await window.superwagie.command(intent('project.revoke', {
      project_id: project.project_id,
    }, ['workspace.revoke']));
    clearInterval(pollTimer);
    editorHost.destroy();
    editorHost = undefined;
    project = undefined;
    shell = undefined;
    showProjectEntry(root, chooseProject);
  });
  shell.fileFilter.addEventListener('input', () => {
    const needle = shell.fileFilter.value.trim().toLocaleLowerCase();
    renderFileExplorer(shell.fileList, treeEntries.filter((entry) => (
      entry.logical_path.toLocaleLowerCase().includes(needle)
    )), openEntry);
  });
  shell.conflict.querySelectorAll('[data-conflict]').forEach((button) => {
    button.addEventListener('click', () => resolveConflict(button.dataset.conflict));
  });
  installShortcuts();
  await loadTree({ openFirst: true });
  clearInterval(pollTimer);
  pollTimer = setInterval(() => editorHost.refreshIfClean().catch(() => {}), 2_000);
}

async function chooseProject() {
  const selected = await window.superwagie.chooseProject();
  if (selected.status === 'selected') await mountWorkspace(selected);
}

async function bootstrap() {
  const projects = await query('project.list', {});
  const active = projects.payload.items[0];
  if (active) await mountWorkspace(active);
  else showProjectEntry(root, chooseProject);
  root.dataset.ready = 'true';
}

window.superwagie.onCheckpointRequested(async () => {
  const result = editorHost ? await editorHost.flush() : { ok: true, unchanged: true };
  await window.superwagie.checkpointReady(result);
});

window.superwagie.subscribe({
  protocol_version: 1,
  message_type: 'query.execute',
  request_id: requestId('subscription'),
  query_id: 'project.list',
  params: {},
}, (event) => {
  if (event.message_type === 'subscription.resync_required') {
    updateStatus({ status: 'resync_required', label: 'Core 已重启，正在重新同步…' });
    bootstrap().catch((error) => updateStatus({ status: 'error', label: error.message }));
  }
}).then(() => bootstrap()).catch((error) => {
  root.textContent = `启动失败：${error.message}`;
  root.dataset.ready = 'error';
});
