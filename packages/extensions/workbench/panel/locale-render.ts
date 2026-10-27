/** A language update redraws copy without discarding in-progress edits. */
export const preserveFormState = (root: Element, redraw: () => void): void => {
  const controls = Array.from(root.querySelectorAll('input, textarea'));
  const keyedDrafts = new Map<string, { value: string; start: number | null; end: number | null }>();
  const unkeyedDrafts: Array<{ value: string; start: number | null; end: number | null }> = [];
  for (const control of controls) {
    if (!(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement)) continue;
    const draft = { value: control.value, start: control.selectionStart, end: control.selectionEnd };
    if (control.id) keyedDrafts.set(control.id, draft);
    else unkeyedDrafts.push(draft);
  }
  const focusable = Array.from(root.querySelectorAll<HTMLElement>('button, input, textarea, [tabindex]'));
  const focusedIndex = focusable.findIndex((node) => node === document.activeElement);
  const focusedId = focusable[focusedIndex]?.id;
  const segments = Array.from(root.querySelectorAll<HTMLElement>('.seg')).map((group) => group.dataset.value);
  const scroll = { x: window.scrollX, y: window.scrollY };
  redraw();
  let unkeyedIndex = 0;
  root.querySelectorAll('input, textarea').forEach((control) => {
    if (!(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement)) return;
    const draft = control.id ? keyedDrafts.get(control.id) : unkeyedDrafts[unkeyedIndex++];
    if (!draft) return;
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
    const next = Array.from(root.querySelectorAll<HTMLElement>('button, input, textarea, [tabindex]'));
    const target = focusedId ? next.find((node) => node.id === focusedId) : next[focusedIndex];
    target?.focus({ preventScroll: true });
  }
  window.scrollTo(scroll.x, scroll.y);
};
