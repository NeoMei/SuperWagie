export function renderFileExplorer(element, entries, onOpen) {
  element.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = '这个 Project 还没有 Markdown 文件';
    element.append(empty);
    return;
  }
  for (const entry of entries) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'file-entry';
    button.dataset.documentId = entry.document_id;
    button.textContent = entry.logical_path;
    button.addEventListener('click', () => onOpen(entry));
    element.append(button);
  }
}
