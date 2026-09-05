export function renderDocumentTab(element, documentState, onClose) {
  element.replaceChildren();
  if (!documentState) return;
  const tab = document.createElement('div');
  tab.className = 'document-tab';
  tab.setAttribute('role', 'tab');
  tab.setAttribute('aria-selected', 'true');
  const label = document.createElement('span');
  label.textContent = documentState.logicalPath;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'tab-close';
  close.setAttribute('aria-label', `关闭 ${documentState.logicalPath}`);
  close.textContent = '×';
  close.addEventListener('click', onClose);
  tab.append(label, close);
  element.append(tab);
}
