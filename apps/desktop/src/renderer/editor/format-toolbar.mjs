import { redo, redoDepth, undo, undoDepth } from '@codemirror/commands';
import { formattingAllowed, formattingState, formatTransaction, linkAtSelection } from './format-commands.mjs';

function node(tag, attributes = {}, text) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  if (text) element.textContent = text;
  return element;
}

// UI only: commands dispatch ordinary CodeMirror transactions so revisioned
// autosave, live preview and history stay owned by the existing EditorHost.
export function createFormatToolbar({ element, view, canEdit }) {
  const controls = new Map();
  const disposers = [];
  const listen = (target, type, handler) => {
    target.addEventListener(type, handler);
    disposers.push(() => target.removeEventListener(type, handler));
  };
  const status = node('span', { class: 'format-feedback', role: 'status' });
  const paragraph = node('select', { 'aria-label': '段落格式', title: '段落格式：正文或标题' });
  for (const [value, label] of [['body', '正文'], ['h1', '一级标题'], ['h2', '二级标题'], ['h3', '三级标题'], ['mixed', '混合格式']]) {
    const option = node('option', { value }, label);
    option.disabled = value === 'mixed';
    paragraph.append(option);
  }
  element.append(paragraph);
  const makeButton = (action, label, glyph, parent = element, toggle = true) => {
    const button = node('button', { type: 'button', 'aria-label': label, title: label, 'data-format': action }, glyph);
    if (toggle) button.setAttribute('aria-pressed', 'false');
    // Do not let a pointer click replace the editor's source selection.
    listen(button, 'mousedown', (event) => { if (event.button === 0) event.preventDefault(); });
    listen(button, 'click', () => execute(action));
    controls.set(action, button);
    parent.append(button);
    return button;
  };
  const separator = () => element.append(node('span', { class: 'format-separator', 'aria-hidden': 'true' }));
  separator();
  makeButton('bold', '加粗', 'B');
  makeButton('italic', '斜体', 'I');
  makeButton('strike', '删除线', 'S');
  separator();
  makeButton('bullet', '无序列表', '• ≡');
  makeButton('ordered', '有序列表', '1. ≡');
  makeButton('task', '待办清单', '☑');
  makeButton('quote', '引用', '❝');
  makeButton('link', '链接', '链接');
  const more = node('button', { type: 'button', 'aria-label': '更多格式', title: '更多格式', 'aria-expanded': 'false', 'aria-controls': 'format-more' }, '···');
  element.append(more);
  const extra = node('span', { id: 'format-more', class: 'format-more', hidden: '' });
  makeButton('code', '行内代码', '行内代码', extra);
  makeButton('divider', '分割线', '分割线', extra, false);
  element.append(extra);
  separator();
  makeButton('undo', '撤销', '↶', element, false);
  makeButton('redo', '重做', '↷', element, false);
  element.append(status);

  const dialog = node('dialog', { class: 'format-link-dialog', 'aria-labelledby': 'format-link-title' });
  const title = node('h2', { id: 'format-link-title' }, '编辑链接');
  const form = node('form');
  const textLabel = node('label', {}, '显示文字');
  const textInput = node('input', { type: 'text', 'aria-label': '显示文字', autocomplete: 'off', required: '' });
  const urlLabel = node('label', {}, '链接地址');
  const urlInput = node('input', { type: 'text', 'aria-label': '链接地址', placeholder: 'https://example.com', autocomplete: 'off', required: '' });
  textLabel.append(textInput); urlLabel.append(urlInput);
  const error = node('p', { role: 'alert', class: 'format-link-error' });
  const actions = node('div', { class: 'format-link-actions' });
  const cancel = node('button', { type: 'button' }, '取消');
  const remove = node('button', { type: 'button' }, '移除链接');
  const submit = node('button', { type: 'submit' }, '应用链接');
  actions.append(remove, cancel, submit);
  form.append(textLabel, urlLabel, node('p', { class: 'format-link-hint' }, '支持网页和邮箱地址；不会在插入时访问链接。'), error, actions);
  dialog.append(title, form);
  element.parentElement.append(dialog);
  let linkSnapshot;

  function closeLink(restore = true) {
    dialog.close();
    linkSnapshot = undefined;
    if (restore && canEdit()) view.focus();
  }
  function openLink() {
    const existing = linkAtSelection(view.state);
    const range = view.state.selection.main;
    linkSnapshot = { doc: view.state.doc, selection: view.state.selection };
    textInput.value = existing?.text || view.state.sliceDoc(range.from, range.to) || '链接文字';
    urlInput.value = existing?.url || '';
    remove.hidden = !existing;
    error.textContent = '';
    dialog.showModal();
    urlInput.focus();
  }
  function applyLink(action) {
    if (!linkSnapshot || view.state.doc !== linkSnapshot.doc || !canEdit() || view.composing) {
      closeLink(false);
      status.textContent = '文档已变化，请重新选择文字后编辑链接。';
      return;
    }
    try {
      view.dispatch({ selection: linkSnapshot.selection });
      const spec = formatTransaction(view.state, action, { text: textInput.value, url: urlInput.value });
      if (!spec) return;
      // Close before dispatch: a document update invalidates open dialogs.
      closeLink();
      view.dispatch(spec);
      view.focus();
    } catch (failure) { error.textContent = failure.message; }
  }
  listen(form, 'submit', (event) => { event.preventDefault(); applyLink('link'); });
  listen(remove, 'click', () => applyLink('unlink'));
  listen(cancel, 'click', () => closeLink());
  listen(dialog, 'cancel', (event) => { event.preventDefault(); closeLink(); });
  listen(paragraph, 'change', () => execute(paragraph.value));
  listen(more, 'mousedown', (event) => event.preventDefault());
  listen(more, 'click', () => {
    extra.hidden = !extra.hidden;
    more.setAttribute('aria-expanded', String(!extra.hidden));
  });
  listen(element, 'keydown', (event) => {
    if (event.key === 'Escape' && !extra.hidden) {
      extra.hidden = true; more.setAttribute('aria-expanded', 'false'); more.focus(); event.preventDefault();
    }
    if (event.target.tagName !== 'BUTTON' || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...element.querySelectorAll('button')].filter((button) => !button.disabled && button.getClientRects().length);
    const index = buttons.indexOf(event.target);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus(); event.preventDefault();
  });

  function execute(action) {
    if (!canEdit() || view.composing) return;
    status.textContent = '';
    if (action === 'link') { if (formattingAllowed(view.state, action)) openLink(); return; }
    if (action === 'undo' || action === 'redo') (action === 'undo' ? undo : redo)(view);
    else {
      const spec = formatTransaction(view.state, action);
      if (!spec) { status.textContent = '此位置不适用该格式'; return; }
      view.dispatch(spec);
    }
    extra.hidden = true; more.setAttribute('aria-expanded', 'false');
    view.focus();
    update();
  }

  function update() {
    const enabled = Boolean(canEdit()) && !view.composing;
    if (dialog.open && (!enabled || linkSnapshot?.doc !== view.state.doc)) closeLink(false);
    const flags = formattingState(view.state);
    paragraph.value = flags.paragraph;
    paragraph.disabled = !enabled || !formattingAllowed(view.state, 'body');
    more.disabled = !enabled;
    for (const [action, button] of controls) {
      button.disabled = !enabled || (action === 'undo' ? !undoDepth(view.state)
        : action === 'redo' ? !redoDepth(view.state) : !formattingAllowed(view.state, action));
      if (button.hasAttribute('aria-pressed')) button.setAttribute('aria-pressed', String(Boolean(flags[action])));
      button.title = button.disabled && enabled && !['undo', 'redo'].includes(action)
        ? `${button.getAttribute('aria-label')}：属性、代码或受保护内容不可应用此格式` : button.getAttribute('aria-label');
    }
  }
  update();
  return { update, destroy() { for (const dispose of disposers) dispose(); dialog.remove(); element.replaceChildren(); } };
}
