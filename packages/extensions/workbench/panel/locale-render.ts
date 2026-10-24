/** A language update redraws copy without discarding in-progress edits. */
export const preserveFormState = (root: Element, redraw: () => void): void => {
  const controls = Array.from(root.querySelectorAll('input, textarea'));
  const drafts = controls.map((control) => {
    if (!(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement)) return null;
    return { value: control.value, start: control.selectionStart, end: control.selectionEnd };
  });
  const focusable = Array.from(root.querySelectorAll<HTMLElement>('button, input, textarea, [tabindex]'));
  const focusedIndex = focusable.findIndex((node) => node === document.activeElement);
  const segments = Array.from(root.querySelectorAll<HTMLElement>('.seg')).map((group) => group.dataset.value);
  const scroll = { x: window.scrollX, y: window.scrollY };
  redraw();
  root.querySelectorAll('input, textarea').forEach((control, index) => {
    const draft = drafts[index];
    if (!draft || !(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement)) return;
    control.value = draft.value;
    if (draft.start !== null && draft.end !== null) control.setSelectionRange(draft.start, draft.end);
  });
  root.querySelectorAll<HTMLElement>('.seg').forEach((group, index) => {
    const value = segments[index];
    if (!value) return;
    group.dataset.value = value;
    for (const button of group.querySelectorAll<HTMLElement>('button')) {
      button.setAttribute('aria-pressed', String(button.dataset.value === value));
    }
  });
  if (focusedIndex >= 0) {
    root.querySelectorAll<HTMLElement>('button, input, textarea, [tabindex]')[focusedIndex]?.focus({ preventScroll: true });
  }
  window.scrollTo(scroll.x, scroll.y);
};
